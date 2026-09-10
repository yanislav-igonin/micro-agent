import OpenAI from "openai";
import type {
	Response,
	ResponseCreateParamsNonStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import { type Journal, normalizeError, type StopReason } from "./journal.js";
import { executeTool, type ToolResult, tools } from "./tools.js";

let openai: OpenAI | undefined;

const SYSTEM_PROMPT = `
You are a small coding agent.

You work inside the current project directory.

You can:
- inspect directories
- read files
- execute shell commands

Use tools whenever needed to answer the user's request.
Do not claim that you inspected something unless you actually used a tool.

When you have enough information, answer the user.
`;

export async function runAgent(
	userPrompt: string,
	journal: Journal,
	requestNumber: number,
) {
	const context = { requestNumber };
	const input: ResponseInput = [{ role: "user", content: userPrompt }];
	let reason: StopReason = "unexpected_error";
	let failure: ReturnType<typeof normalizeError> | undefined;
	await journal.record("user_request_started", { prompt: userPrompt }, context);
	console.log(`[request ${requestNumber}] started`);

	try {
		for (let stepNumber = 1; stepNumber <= 20; stepNumber++) {
			const stepContext = { requestNumber, stepNumber };
			console.log(`[request ${requestNumber} step ${stepNumber}] started`);
			const request: ResponseCreateParamsNonStreaming = {
				model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
				instructions: SYSTEM_PROMPT,
				tools,
				input,
			};
			await journal.record("model_request", request, stepContext);
			let response: Response;
			try {
				// Initialize after the journal so configuration failures are recorded too.
				openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
				response = await openai.responses.create(request);
			} catch (error) {
				reason = "model_error";
				await journal.record("model_error", normalizeError(error), stepContext);
				throw error;
			}
			await journal.record("model_response", response, stepContext);

			// Replay every output item, including reasoning items, on the next step.
			// SDK 7.10.0 gives AdditionalTools incompatible input/output roles.
			// Responses replay requires preserving the returned items unchanged.
			input.push(...(response.output as ResponseInput));
			const toolCalls = response.output.filter(
				(item) => item.type === "function_call",
			);
			if (toolCalls.length === 0) {
				reason = "final_answer";
				return response.output_text;
			}

			for (const call of toolCalls) {
				const toolContext = { ...stepContext, callId: call.call_id };
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
					result = {
						status: "error",
						output: "ERROR: Invalid tool arguments",
						error: normalizeError(error),
					};
					await journal.record(
						"tool_finished",
						{ name: call.name, phase, ...result },
						toolContext,
					);
					console.log(`[tool ${call.name}] error`);
					input.push({
						type: "function_call_output",
						call_id: call.call_id,
						output: result.output,
					});
					continue;
				}

				phase = "execution";
				result = await executeTool(call.name, args);
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
					output: result.output,
				});
			}
		}
		reason = "max_steps";
		throw new Error("Agent exceeded maximum steps");
	} catch (error) {
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
