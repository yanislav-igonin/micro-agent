import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import type { Journal } from "./journal.js";

const openai = vi.hoisted(() => ({
	create: vi.fn(),
}));

vi.mock("openai", () => ({
	default: class {
		responses = { create: openai.create };
	},
}));

import { runCli } from "./cli.js";

function journalWith(records: Array<{ type: string; data: unknown }>) {
	return {
		record: async (type: string, data: unknown) => {
			records.push({ type, data: structuredClone(data) });
		},
		finish: async () => {},
	} as unknown as Journal;
}

function promptWith(answers: string[]) {
	return Object.assign(new EventEmitter(), {
		question: vi.fn(async () => answers.shift() ?? "quit"),
		close: vi.fn(),
	});
}

describe("runCli", () => {
	it("keeps complete history after a failed tool turn within one CLI run", async () => {
		const firstReasoning = {
			id: "reasoning-1",
			type: "reasoning",
			summary: [],
		};
		const firstCall = {
			type: "function_call",
			name: "read",
			arguments: JSON.stringify({ path: "README.md" }),
			call_id: "call-1",
		};
		const firstAnswer = {
			id: "message-1",
			type: "message",
			status: "completed",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "first answer",
					annotations: [],
					logprobs: [],
				},
			],
		};
		const failedReasoning = {
			id: "reasoning-2",
			type: "reasoning",
			summary: [],
		};
		const failedCall = {
			type: "function_call",
			name: "read",
			arguments: "{",
			call_id: "call-2",
		};
		const thirdAnswer = {
			id: "message-3",
			type: "message",
			status: "completed",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "third answer",
					annotations: [],
					logprobs: [],
				},
			],
		};
		const freshAnswer = {
			id: "message-fresh",
			type: "message",
			status: "completed",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "fresh answer",
					annotations: [],
					logprobs: [],
				},
			],
		};
		const seenInputs: unknown[] = [];
		const usesPreviousResponseId: boolean[] = [];
		openai.create.mockImplementation(async (request) => {
			seenInputs.push(structuredClone(request.input));
			usesPreviousResponseId.push("previous_response_id" in request);
			const callNumber = seenInputs.length;
			if (callNumber === 1) {
				return { output: [firstReasoning, firstCall], output_text: "" };
			}
			if (callNumber === 2) {
				return { output: [firstAnswer], output_text: "first answer" };
			}
			if (callNumber === 3) {
				return { output: [failedReasoning, failedCall], output_text: "" };
			}
			if (callNumber === 4) {
				throw new Error("model failed");
			}
			if (callNumber === 5) {
				return { output: [thirdAnswer], output_text: "third answer" };
			}
			return { output: [freshAnswer], output_text: "fresh answer" };
		});

		const records: Array<{ type: string; data: unknown }> = [];
		const journal = journalWith(records);
		await runCli(
			promptWith(["first", "second", "third", "quit"]),
			journal,
			undefined,
			new EventEmitter(),
		);

		const toolOutput = (callId: string, output: string) => ({
			type: "function_call_output",
			call_id: callId,
			output,
		});
		const readme = await fs.readFile("README.md", "utf8");
		const historyAfterFirst = [
			{ role: "user", content: "first" },
			firstReasoning,
			firstCall,
			toolOutput("call-1", readme),
			firstAnswer,
		];
		const historyAfterFailure = [
			...historyAfterFirst,
			{ role: "user", content: "second" },
			failedReasoning,
			failedCall,
			toolOutput("call-2", "ERROR: Invalid tool arguments"),
		];

		expect(seenInputs).toEqual([
			[{ role: "user", content: "first" }],
			historyAfterFirst.slice(0, -1),
			[...historyAfterFirst, { role: "user", content: "second" }],
			historyAfterFailure,
			[...historyAfterFailure, { role: "user", content: "third" }],
		]);
		expect(usesPreviousResponseId).toEqual([false, false, false, false, false]);

		const modelRequestInputs = records
			.filter(({ type }) => type === "model_request")
			.map(({ data }) => (data as { input: unknown }).input);
		expect(modelRequestInputs).toEqual(seenInputs);

		await runCli(
			promptWith(["fresh", "quit"]),
			journal,
			undefined,
			new EventEmitter(),
		);
		expect(seenInputs.at(-1)).toEqual([{ role: "user", content: "fresh" }]);
	});
});
