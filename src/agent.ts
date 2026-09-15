import OpenAI from "openai";
import type { InputTokenCountParams } from "openai/resources/responses/input-tokens";
import type {
	Response,
	ResponseCreateParamsNonStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import { type Journal, normalizeError, type StopReason } from "./journal.js";
import {
	createToolErrorResult,
	executeTool,
	type ToolResult,
	tools,
} from "./tools.js";

let openai: OpenAI | undefined;

export class ContextBudgetExceededError extends Error {
	constructor(inputTokens: number, budget: number) {
		super(
			`Context Budget exceeded: ${inputTokens}/${budget} input tokens. Use /new, increase MICRO_AGENT_CONTEXT_BUDGET, or wait for future compaction.`,
		);
		this.name = "ContextBudgetExceededError";
	}
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

export interface AgentRunOptions {
	conversationId?: string;
	signal?: AbortSignal;
	contextBudget?: number;
	onContextMeasured?: (inputTokens: number) => void;
	onContextWarning?: (inputTokens: number, budget: number) => void;
	onToolStarted?: (tool: { callId: string; name: string }) => Promise<void>;
	onToolFinished?: (callId: string) => Promise<void>;
}

export interface AgentResult {
	answer: string;
	input: ResponseInput;
	model: string;
}

export function createAgent(restoredInput: ResponseInput = []) {
	let checkpointInput = structuredClone(restoredInput);
	let exactMeasurement:
		| { inputTokens: number; requestBytes: number; model: string }
		| undefined;
	let highUsageWarningShown = false;

	function publishExactMeasurement(
		inputTokens: number,
		requestBytes: number,
		model: string,
		options: AgentRunOptions,
	) {
		exactMeasurement = { inputTokens, requestBytes, model };
		options.onContextMeasured?.(inputTokens);
		const budget = options.contextBudget;
		if (budget === undefined) return;
		if (inputTokens < budget * 0.8) {
			highUsageWarningShown = false;
		} else if (!highUsageWarningShown) {
			highUsageWarningShown = true;
			options.onContextWarning?.(inputTokens, budget);
		}
	}

	return async (
		userPrompt: string,
		journal: Journal,
		requestNumber: number,
		options: AgentRunOptions = {},
	) => {
		const result = await runAgent(
			checkpointInput,
			userPrompt,
			journal,
			requestNumber,
			options,
			() => exactMeasurement,
			publishExactMeasurement,
		);
		checkpointInput = structuredClone(result.input);
		return result;
	};
}

async function runAgent(
	checkpointInput: ResponseInput,
	userPrompt: string,
	journal: Journal,
	requestNumber: number,
	options: AgentRunOptions,
	getExactMeasurement: () =>
		| { inputTokens: number; requestBytes: number; model: string }
		| undefined,
	publishExactMeasurement: (
		inputTokens: number,
		requestBytes: number,
		model: string,
		options: AgentRunOptions,
	) => void,
) {
	const input = structuredClone(checkpointInput);
	const context = {
		...(options.conversationId
			? { conversationId: options.conversationId }
			: {}),
		requestNumber,
	};
	input.push({ role: "user", content: userPrompt });
	let reason: StopReason = "unexpected_error";
	let failure: ReturnType<typeof normalizeError> | undefined;
	await journal.record("user_request_started", { prompt: userPrompt }, context);
	console.log(`[request ${requestNumber}] started`);

	try {
		for (let stepNumber = 1; stepNumber <= 20; stepNumber++) {
			options.signal?.throwIfAborted();
			const contextualStep = { ...context, stepNumber };
			console.log(`[request ${requestNumber} step ${stepNumber}] started`);
			const model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
			const request: ResponseCreateParamsNonStreaming & InputTokenCountParams =
				{
					model,
					instructions: SYSTEM_PROMPT,
					tools,
					input,
				};
			const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
			await journal.record("model_request", request, contextualStep);
			let response: Response;
			let errorPhase: "input_token_count" | "context_budget" | undefined;
			try {
				// Initialize after the journal so configuration failures are recorded too.
				openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
				const budget = options.contextBudget;
				if (budget !== undefined) {
					const exactMeasurement = getExactMeasurement();
					const softBoundary = budget * 0.8;
					// The full request bound also covers tokenization changes at an
					// append boundary; byte growth alone is not a safe upper bound.
					const upperBound = exactMeasurement
						? Math.max(
								requestBytes,
								exactMeasurement.inputTokens +
									Math.max(0, requestBytes - exactMeasurement.requestBytes),
							)
						: requestBytes;
					const preflightNeeded =
						upperBound >= softBoundary ||
						(exactMeasurement !== undefined &&
							(exactMeasurement.model !== model ||
								requestBytes < exactMeasurement.requestBytes));
					if (preflightNeeded) {
						errorPhase = "input_token_count";
						const count = await openai.responses.inputTokens.count(request, {
							signal: options.signal,
						});
						publishExactMeasurement(
							count.input_tokens,
							requestBytes,
							model,
							options,
						);
						if (count.input_tokens > budget) {
							errorPhase = "context_budget";
							throw new ContextBudgetExceededError(count.input_tokens, budget);
						}
						errorPhase = undefined;
					}
				}
				response = await openai.responses.create(request, {
					signal: options.signal,
				});
			} catch (error) {
				if (options.signal?.aborted) {
					reason = "cancelled";
					throw error;
				}
				reason = "model_error";
				await journal.record(
					"model_error",
					{
						...normalizeError(error),
						...(errorPhase ? { phase: errorPhase } : {}),
					},
					contextualStep,
				);
				throw error;
			}
			options.signal?.throwIfAborted();
			await journal.record("model_response", response, contextualStep);
			if (response.usage) {
				publishExactMeasurement(
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
				return {
					answer: response.output_text,
					input: structuredClone(input),
					model,
				};
			}

			for (const call of toolCalls) {
				const toolContext = { ...contextualStep, callId: call.call_id };
				await journal.record(
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
					result = createToolErrorResult(
						"ERROR: Invalid tool arguments",
						error,
					);
					await journal.record(
						"tool_finished",
						{ name: call.name, phase, ...result },
						toolContext,
					);
					console.log(`[tool ${call.name}] error`);
					input.push({
						type: "function_call_output",
						call_id: call.call_id,
						output: result.modelOutput,
					});
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
				await journal.record(
					"tool_finished",
					{ name: call.name, arguments: args, phase, ...result },
					toolContext,
				);
				console.log(`[tool ${call.name}] ${result.status}`);
				// The original call_id connects this local result to the model's call.
				input.push({
					type: "function_call_output",
					call_id: call.call_id,
					output: result.modelOutput,
				});
			}
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
