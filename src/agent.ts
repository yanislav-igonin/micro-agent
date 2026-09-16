import OpenAI from "openai";
import type { InputTokenCountParams } from "openai/resources/responses/input-tokens";
import type {
	CompactedResponse,
	Response,
	ResponseCompactParams,
	ResponseCreateParamsNonStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import {
	type EventContext,
	type Journal,
	normalizeError,
	type StopReason,
} from "./journal.js";
import {
	createToolErrorResult,
	executeTool,
	type ToolResult,
	tools,
} from "./tools.js";

export const DEFAULT_MODEL = "gpt-5.6-luna";
// A user request ends when it reaches this many model steps without an answer.
const MAX_MODEL_STEPS = 20;
// Compact at this share of the context budget, before the hard limit is reached.
const COMPACTION_THRESHOLD = 0.8;

export class ContextBudgetExceededError extends Error {
	constructor(inputTokens: number, budget: number) {
		super(
			`Context Budget exceeded: ${inputTokens}/${budget} input tokens. Use /new or increase MICRO_AGENT_CONTEXT_BUDGET.`,
		);
		this.name = "ContextBudgetExceededError";
	}
}

export class UnsavedCompactionError extends Error {
	constructor(
		public readonly input: ResponseInput,
		public readonly model: string,
		cause: unknown,
	) {
		super("UNSAVED: compacted checkpoint persistence failed", { cause });
		this.name = "UnsavedCompactionError";
	}
}

function compactedInput(response: unknown): ResponseInput {
	const data = response as CompactedResponse | undefined;
	if (
		data?.object !== "response.compaction" ||
		typeof data.id !== "string" ||
		data.id.length === 0 ||
		!Array.isArray(data.output) ||
		data.output.length === 0
	) {
		throw new Error("Invalid compact response");
	}
	const last = data.output.at(-1);
	if (
		last?.type !== "compaction" ||
		typeof last.id !== "string" ||
		last.id.length === 0 ||
		typeof last.encrypted_content !== "string" ||
		last.encrypted_content.length === 0 ||
		data.output.filter((item) => item.type === "compaction").length !== 1
	) {
		throw new Error("Invalid compact response");
	}
	for (const candidate of data.output.slice(0, -1) as unknown[]) {
		const item = candidate as Record<string, unknown>;
		if (
			item?.type !== "message" ||
			item.role !== "user" ||
			typeof item.id !== "string" ||
			item.status !== "completed" ||
			!Array.isArray(item.content) ||
			!item.content.every(
				(content: unknown) =>
					typeof content === "object" &&
					content !== null &&
					"type" in content &&
					content.type === "input_text" &&
					"text" in content &&
					typeof content.text === "string",
			)
		) {
			throw new Error("Invalid compact response");
		}
	}
	return structuredClone(data.output) as ResponseInput;
}

function hasUnansweredToolCall(input: ResponseInput) {
	const calls = new Set<string>();
	for (const item of input) {
		if (item.type === "function_call" && typeof item.call_id === "string")
			calls.add(item.call_id);
		if (
			item.type === "function_call_output" &&
			typeof item.call_id === "string"
		)
			calls.delete(item.call_id);
	}
	return calls.size > 0;
}

const SYSTEM_PROMPT = `
You are a small coding agent.

You work inside the current project directory.

You can:
- inspect directories
- read files
- execute shell commands

Large file reads are ranged. Follow the returned next coordinates when more
content is needed. Prefer exact replace after a ranged read when a whole-file
write could erase content you have not inspected.

Use tools whenever needed to answer the user's request.
Do not claim that you inspected something unless you actually used a tool.

Tool outputs restored from an earlier CLI run describe historical project state.
Reread relevant files before modifying them or relying on their contents.

When you have enough information, answer the user.
`;

/** Everything one user request needs: the journal, its position, and hooks. */
export interface AgentRunOptions {
	journal: Journal;
	requestNumber: number;
	conversationId?: string;
	signal?: AbortSignal;
	contextBudget?: number;
	onContextMeasured?: (inputTokens: number) => void;
	onContextWarning?: (inputTokens: number, budget: number) => void;
	onToolStarted?: (tool: { callId: string; name: string }) => Promise<void>;
	onToolFinished?: (callId: string) => Promise<void>;
	onModelStepBoundary?: () => Promise<void>;
	onCompacted?: (input: ResponseInput, model: string) => Promise<void>;
}

export interface AgentResult {
	answer: string;
	input: ResponseInput;
	model: string;
}

/** One exact input-token measurement, reused to decide the next preflight. */
interface Measurement {
	inputTokens: number;
	requestBytes: number;
	model: string;
}

/** A model step failing before or during compaction, kept for the stop reason. */
type RequestPhase = "input_token_count" | "context_budget" | "compaction";

// The SDK leaves `model` optional so a count can reuse a previous request; this
// module always sends its own model, so the request type requires it.
type ModelRequest = ResponseCreateParamsNonStreaming &
	InputTokenCountParams & { model: string };

/** The parts of a model-emitted tool call this module uses. */
interface ToolCall {
	call_id: string;
	name: string;
	arguments: string;
}

function toolOutput(callId: string, result: ToolResult) {
	return {
		type: "function_call_output" as const,
		call_id: callId,
		output: result.modelOutput,
	};
}

/**
 * Runs the model and tool loop for one conversation and keeps the last complete
 * model input, so a failed request never advances the conversation.
 */
export class Agent {
	private checkpoint: ResponseInput;
	private measured: Measurement | undefined;
	private warningShown = false;
	private client: OpenAI | undefined;

	constructor(restoredInput: ResponseInput = []) {
		this.checkpoint = structuredClone(restoredInput);
	}

	async run(
		userPrompt: string,
		options: AgentRunOptions,
	): Promise<AgentResult> {
		const journal = options.journal;
		const requestNumber = options.requestNumber;
		const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
		const context: EventContext = {
			...(options.conversationId
				? { conversationId: options.conversationId }
				: {}),
			requestNumber,
		};
		// Work on a copy: only a complete answer or a saved compaction replaces
		// the checkpoint this agent will continue from.
		const input = structuredClone(this.checkpoint);
		input.push({ role: "user", content: userPrompt });
		let reason: StopReason = "unexpected_error";
		let failure: ReturnType<typeof normalizeError> | undefined;
		await journal.record(
			"user_request_started",
			{ prompt: userPrompt },
			context,
		);
		console.log(`[request ${requestNumber}] started`);

		try {
			for (let stepNumber = 1; stepNumber <= MAX_MODEL_STEPS; stepNumber++) {
				options.signal?.throwIfAborted();
				await options.onModelStepBoundary?.();
				if (hasUnansweredToolCall(input))
					throw new Error("Unanswered tool call blocks the next model step");
				const stepContext = { ...context, stepNumber };
				console.log(`[request ${requestNumber} step ${stepNumber}] started`);

				const request: ModelRequest = {
					model,
					instructions: SYSTEM_PROMPT,
					tools,
					input: structuredClone(input),
				};
				let requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
				let phase: RequestPhase | undefined;
				let response: Response;
				try {
					// Initialize after the journal so configuration failures are recorded too.
					const client = this.getClient();
					const budget = options.contextBudget;
					if (budget !== undefined) {
						phase = "input_token_count";
						const exact = this.measured;
						const softBoundary = budget * COMPACTION_THRESHOLD;
						// The full request bound also covers tokenization changes at an
						// append boundary; byte growth alone is not a safe upper bound.
						const upperBound = exact
							? Math.max(
									requestBytes,
									exact.inputTokens +
										Math.max(0, requestBytes - exact.requestBytes),
								)
							: requestBytes;
						const preflightNeeded =
							upperBound >= softBoundary ||
							(exact !== undefined &&
								(exact.model !== model || requestBytes < exact.requestBytes));
						if (preflightNeeded) {
							const count = await client.responses.inputTokens.count(request, {
								signal: options.signal,
							});
							this.publishMeasurement(
								count.input_tokens,
								requestBytes,
								model,
								options,
							);
							if (count.input_tokens >= softBoundary && options.onCompacted) {
								phase = "compaction";
								const compacted = await this.compact(
									request,
									{
										tokens: count.input_tokens,
										bytes: requestBytes,
									},
									budget,
									options,
									stepContext,
								);
								this.checkpoint = structuredClone(compacted.input);
								input.splice(0, input.length, ...compacted.input);
								request.input = structuredClone(compacted.input);
								requestBytes = compacted.requestBytes;
							} else if (count.input_tokens > budget) {
								phase = "context_budget";
								throw new ContextBudgetExceededError(
									count.input_tokens,
									budget,
								);
							}
						}
						phase = undefined;
					}
					await journal.record("model_request", request, stepContext);
					response = await client.responses.create(request, {
						signal: options.signal,
					});
				} catch (error) {
					if (options.signal?.aborted) {
						reason = "cancelled";
						throw error;
					}
					reason = phase === "compaction" ? "compaction_error" : "model_error";
					if (phase !== "compaction")
						await journal.record(
							"model_error",
							{
								...normalizeError(error),
								...(phase ? { phase } : {}),
							},
							stepContext,
						);
					throw error;
				}
				options.signal?.throwIfAborted();
				await journal.record("model_response", response, stepContext);
				if (response.usage) {
					this.publishMeasurement(
						response.usage.input_tokens,
						requestBytes,
						model,
						options,
					);
				}

				// Replay every output item, including reasoning items, on the next step.
				// SDK 7.10.0 gives AdditionalTools incompatible input/output roles.
				// Responses replay requires preserving the returned items unchanged.
				input.push(...(response.output as ResponseInput));
				const toolCalls = response.output.filter(
					(item) => item.type === "function_call",
				);
				if (toolCalls.length === 0) {
					reason = "final_answer";
					this.checkpoint = structuredClone(input);
					return {
						answer: response.output_text,
						input: structuredClone(input),
						model,
					};
				}

				await this.runToolCalls(toolCalls, input, options, stepContext);
			}
			reason = "max_steps";
			throw new Error("Agent exceeded maximum steps");
		} catch (error) {
			if (options.signal?.aborted) reason = "cancelled";
			failure = normalizeError(error);
			throw error;
		} finally {
			await journal.record(
				"user_request_finished",
				{ reason, ...(failure ? { error: failure } : {}) },
				context,
			);
			console.log(`[request ${requestNumber}] stop: ${reason}`);
		}
	}

	private getClient() {
		this.client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
		return this.client;
	}

	private publishMeasurement(
		inputTokens: number,
		requestBytes: number,
		model: string,
		options: AgentRunOptions,
	) {
		this.measured = { inputTokens, requestBytes, model };
		options.onContextMeasured?.(inputTokens);
		const budget = options.contextBudget;
		if (budget === undefined) return;
		if (inputTokens < budget * COMPACTION_THRESHOLD) {
			this.warningShown = false;
		} else if (!this.warningShown) {
			this.warningShown = true;
			options.onContextWarning?.(inputTokens, budget);
		}
	}

	/**
	 * Replaces older model input with the provider's compacted continuation. The
	 * caller only swaps in the returned input after this method saved it.
	 */
	private async compact(
		request: ModelRequest,
		before: { tokens: number; bytes: number },
		budget: number,
		options: AgentRunOptions,
		context: EventContext,
	) {
		const model = request.model;
		const journal = options.journal;
		const diagnostics = {
			trigger: "context_budget_80_percent",
			beforeTokens: before.tokens,
			beforeBytes: before.bytes,
		};
		await journal.record(
			"compaction_started",
			{ ...diagnostics, request: structuredClone(request) },
			context,
		);
		let phase = "compact_api";
		let compactResponse: CompactedResponse | undefined;
		try {
			compactResponse = await this.getClient().responses.compact(
				{ ...request } as ResponseCompactParams & { tools: typeof tools },
				{ signal: options.signal },
			);
			phase = "validation";
			const nextInput = compactedInput(compactResponse);
			phase = "checkpoint_save";
			try {
				await options.onCompacted?.(nextInput, model);
			} catch (error) {
				throw new UnsavedCompactionError(nextInput, model, error);
			}
			const compactedRequest = { ...request, input: nextInput };
			const requestBytes = Buffer.byteLength(
				JSON.stringify(compactedRequest),
				"utf8",
			);
			phase = "post_compaction_preflight";
			const after = await this.getClient().responses.inputTokens.count(
				compactedRequest,
				{ signal: options.signal },
			);
			this.publishMeasurement(after.input_tokens, requestBytes, model, options);
			await journal.record(
				"compaction_finished",
				{
					...diagnostics,
					afterTokens: after.input_tokens,
					afterBytes: requestBytes,
					response: compactResponse,
				},
				context,
			);
			if (after.input_tokens > budget)
				throw new ContextBudgetExceededError(after.input_tokens, budget);
			return { input: nextInput, requestBytes };
		} catch (error) {
			await journal.record(
				"compaction_failed",
				{
					...diagnostics,
					phase,
					...(compactResponse
						? {
								response: compactResponse,
								afterBytes: Buffer.byteLength(
									JSON.stringify({
										...request,
										input: compactResponse.output,
									}),
									"utf8",
								),
							}
						: {}),
					error: normalizeError(
						error instanceof UnsavedCompactionError ? error.cause : error,
					),
				},
				context,
			);
			throw error;
		}
	}

	private async runToolCalls(
		toolCalls: ToolCall[],
		input: ResponseInput,
		options: AgentRunOptions,
		context: EventContext,
	) {
		for (const call of toolCalls) {
			const toolContext = { ...context, callId: call.call_id };
			await options.journal.record(
				"tool_started",
				{ name: call.name, arguments: call.arguments },
				toolContext,
			);
			console.log(`[tool ${call.name}] started`);
			let args: unknown;
			let result: ToolResult;
			let phase = "argument_parsing";
			try {
				args = JSON.parse(call.arguments);
			} catch (error) {
				result = createToolErrorResult("ERROR: Invalid tool arguments", error);
				await options.journal.record(
					"tool_finished",
					{ name: call.name, phase, ...result },
					toolContext,
				);
				console.log(`[tool ${call.name}] error`);
				input.push(toolOutput(call.call_id, result));
				continue;
			}

			phase = "execution";
			options.signal?.throwIfAborted();
			await options.onToolStarted?.({
				callId: call.call_id,
				name: call.name,
			});
			options.signal?.throwIfAborted();
			result = await executeTool(call.name, args);
			await options.onToolFinished?.(call.call_id);
			await options.journal.record(
				"tool_finished",
				{ name: call.name, arguments: args, phase, ...result },
				toolContext,
			);
			console.log(`[tool ${call.name}] ${result.status}`);
			// The original call_id connects this local result to the model's call.
			input.push(toolOutput(call.call_id, result));
		}
	}
}
