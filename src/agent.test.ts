import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Journal } from "./journal.js";

const openai = vi.hoisted(() => ({
	create: vi.fn(),
	count: vi.fn(),
	compact: vi.fn(),
}));

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: openai.create,
			compact: openai.compact,
			inputTokens: { count: openai.count },
		};
	},
}));

import { Agent } from "./agent.js";

const artifacts: string[] = [];

function assistantMessage(id: string, text: string) {
	return {
		id,
		type: "message" as const,
		status: "completed" as const,
		role: "assistant" as const,
		content: [
			{
				type: "output_text" as const,
				text,
				annotations: [],
				logprobs: [],
			},
		],
	};
}

function journalWith(
	records: Array<{ type: string; data: unknown; context: unknown }> = [],
) {
	return {
		record: async (type: string, data: unknown, context: unknown) => {
			records.push({
				type,
				data: structuredClone(data),
				context: structuredClone(context),
			});
		},
		finish: async () => {},
	} as unknown as Journal;
}

beforeEach(() => {
	openai.create.mockReset();
	openai.count.mockReset();
	openai.compact.mockReset();
});

afterEach(async () => {
	delete process.env.OPENAI_MODEL;
	await Promise.all(
		artifacts.splice(0).map((artifact) => fs.rm(artifact, { force: true })),
	);
});

describe("Agent.run", () => {
	it("never compacts without a configured context budget", async () => {
		openai.create.mockResolvedValue({
			output: [assistantMessage("no-budget", "done")],
			output_text: "done",
			usage: { input_tokens: 90_000 },
		});
		await new Agent().run("goal", {
			journal: journalWith(),
			requestNumber: 1,
			onCompacted: async () => {},
		});
		expect(openai.count).not.toHaveBeenCalled();
		expect(openai.compact).not.toHaveBeenCalled();
		expect(openai.create).toHaveBeenCalledOnce();
	});
	it("compacts complete input after exact 80% preflight and saves before model work", async () => {
		const compacted = [
			{ type: "compaction", id: "cmp-1", encrypted_content: "opaque" },
		];
		const sequence: string[] = [];
		openai.count.mockResolvedValue({ input_tokens: 80 });
		openai.compact.mockImplementation(async () => {
			sequence.push("compact");
			return {
				id: "resp-1",
				object: "response.compaction",
				output: compacted,
				usage: { input_tokens: 80 },
			};
		});
		openai.create.mockImplementation(async (request) => {
			sequence.push("create");
			expect(request.input).toEqual(compacted);
			return {
				output: [assistantMessage("after", "done")],
				output_text: "done",
			};
		});
		const onCompacted = vi.fn(async () => {
			sequence.push("save");
		});
		await new Agent([{ role: "user", content: "old goal PRI-296" }]).run(
			"continue",
			{
				journal: journalWith(),
				requestNumber: 1,
				contextBudget: 100,
				onCompacted,
			},
		);
		expect(sequence).toEqual(["compact", "save", "create"]);
		expect(openai.compact.mock.calls[0]?.[0]).toMatchObject({
			model: expect.any(String),
			instructions: expect.any(String),
			tools: expect.any(Array),
			input: [
				{ role: "user", content: "old goal PRI-296" },
				{ role: "user", content: "continue" },
			],
		});
		expect(onCompacted).toHaveBeenCalledWith(compacted, expect.any(String));
	});

	it("keeps the stable input on compact API failure and makes no model call", async () => {
		openai.count.mockResolvedValue({ input_tokens: 80 });
		openai.compact.mockRejectedValueOnce(new Error("compact failed"));
		const agent = new Agent([{ role: "user", content: "stable" }]);
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		await expect(
			agent.run("first", {
				journal: journalWith(records),
				requestNumber: 1,
				contextBudget: 100,
				onCompacted: async () => {},
			}),
		).rejects.toThrow("compact failed");
		expect(openai.create).not.toHaveBeenCalled();
		expect(
			records.find(({ type }) => type === "compaction_failed")?.data,
		).toMatchObject({
			phase: "compact_api",
			error: { message: "compact failed" },
		});
		expect(
			records.find(({ type }) => type === "user_request_finished")?.data,
		).toMatchObject({ reason: "compaction_error" });
		expect(records.some(({ type }) => type === "model_error")).toBe(false);
		openai.compact.mockResolvedValue({
			id: "resp-2",
			object: "response.compaction",
			output: [
				{ type: "compaction", id: "cmp-2", encrypted_content: "opaque" },
			],
			usage: { input_tokens: 80 },
		});
		openai.create.mockResolvedValue({
			output: [assistantMessage("after", "done")],
			output_text: "done",
		});
		await agent.run("fresh", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: 100,
			onCompacted: async () => {},
		});
		expect(openai.compact.mock.calls[1]?.[0].input).toEqual([
			{ role: "user", content: "stable" },
			{ role: "user", content: "fresh" },
		]);
	});

	it("rejects a malformed compact result before checkpoint mutation", async () => {
		openai.count.mockResolvedValue({ input_tokens: 80 });
		openai.compact.mockResolvedValue({
			id: "resp-bad",
			object: "response.compaction",
			output: [{ type: "compaction", id: "cmp-bad", encrypted_content: "" }],
		});
		const onCompacted = vi.fn();
		await expect(
			new Agent().run("goal", {
				journal: journalWith(),
				requestNumber: 1,
				contextBudget: 100,
				onCompacted,
			}),
		).rejects.toThrow("Invalid compact response");
		expect(onCompacted).not.toHaveBeenCalled();
		expect(openai.create).not.toHaveBeenCalled();
	});

	it("rejects truthy but non-string compaction fields before checkpoint save", async () => {
		openai.count.mockResolvedValue({ input_tokens: 80 });
		openai.compact.mockResolvedValue({
			id: 42,
			object: "response.compaction",
			output: [
				{
					type: "compaction",
					id: { bad: true },
					encrypted_content: { bad: true },
				},
			],
		});
		const onCompacted = vi.fn();
		await expect(
			new Agent().run("goal", {
				journal: journalWith(),
				requestNumber: 1,
				contextBudget: 100,
				onCompacted,
			}),
		).rejects.toThrow("Invalid compact response");
		expect(onCompacted).not.toHaveBeenCalled();
		expect(openai.create).not.toHaveBeenCalled();
	});

	it("retains the exact compact result when checkpoint save fails", async () => {
		const compacted = [
			{ type: "compaction", id: "cmp-save", encrypted_content: "opaque-save" },
		];
		openai.count.mockResolvedValue({ input_tokens: 80 });
		openai.compact.mockResolvedValue({
			id: "resp-save",
			object: "response.compaction",
			output: compacted,
			usage: { input_tokens: 80 },
		});
		const onCompacted = vi.fn().mockRejectedValue(new Error("disk full"));
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		await expect(
			new Agent().run("goal", {
				journal: journalWith(records),
				requestNumber: 1,
				contextBudget: 100,
				onCompacted,
			}),
		).rejects.toMatchObject({
			name: "UnsavedCompactionError",
			input: compacted,
		});
		expect(openai.compact).toHaveBeenCalledOnce();
		expect(openai.create).not.toHaveBeenCalled();
		expect(
			records.find(({ type }) => type === "compaction_failed")?.data,
		).toMatchObject({
			phase: "checkpoint_save",
			response: { id: "resp-save" },
			error: { message: "disk full" },
		});
	});

	it("compacts mid-request only after every emitted tool call has an output", async () => {
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		openai.create
			.mockResolvedValueOnce({
				output: [
					{
						type: "function_call",
						name: "read",
						arguments: "{",
						call_id: "uncertain-call",
					},
				],
				output_text: "",
				usage: { input_tokens: 79_999 },
			})
			.mockResolvedValueOnce({
				output: [assistantMessage("final", "continue done")],
				output_text: "continue done",
			});
		openai.count
			.mockResolvedValueOnce({ input_tokens: 80_000 })
			.mockResolvedValueOnce({ input_tokens: 1_000 });
		const compacted = [
			{ type: "compaction", id: "cmp-mid", encrypted_content: "opaque" },
		];
		openai.compact.mockResolvedValue({
			id: "resp-mid",
			object: "response.compaction",
			output: compacted,
			usage: { input_tokens: 80_000 },
		});
		const onCompacted = vi.fn(async () => {});
		await new Agent().run(
			"Goal: fix PRI-296. Decision: keep existing files. Plan: verify src/agent.ts. Failure: typecheck failed. Side effect of uncertain-call unknown.",
			{
				journal: journalWith(records),
				requestNumber: 1,
				contextBudget: 100_000,
				onCompacted,
			},
		);
		expect(openai.create).toHaveBeenCalledTimes(2);
		expect(openai.compact).toHaveBeenCalledOnce();
		const compactRequest = openai.compact.mock.calls[0]?.[0];
		expect(compactRequest.input).toContainEqual({
			type: "function_call_output",
			call_id: "uncertain-call",
			output: expect.stringContaining("Invalid tool arguments"),
		});
		expect(compactRequest.input[0].content).toContain(
			"Side effect of uncertain-call unknown",
		);
		expect(onCompacted).toHaveBeenCalledWith(compacted, expect.any(String));
		expect(
			records.find(({ type }) => type === "compaction_finished")?.data,
		).toMatchObject({
			beforeTokens: 80_000,
			afterTokens: 1_000,
			response: { id: "resp-mid" },
		});
	});

	it("uses the compacted request size for later local preflight decisions", async () => {
		openai.count
			.mockResolvedValueOnce({ input_tokens: 80_000 })
			.mockResolvedValueOnce({ input_tokens: 100 });
		openai.compact.mockResolvedValue({
			id: "resp-small",
			object: "response.compaction",
			output: [
				{ type: "compaction", id: "cmp-small", encrypted_content: "opaque" },
			],
			usage: { input_tokens: 80_000 },
		});
		openai.create.mockResolvedValue({
			output: [assistantMessage("small-answer", "done")],
			output_text: "done",
			usage: { input_tokens: 100 },
		});
		const agent = new Agent([{ role: "user", content: "x".repeat(90_000) }]);
		await agent.run("first", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100_000,
			onCompacted: async () => {},
		});
		await agent.run("later", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: 100_000,
			onCompacted: async () => {},
		});
		expect(openai.count).toHaveBeenCalledTimes(2);
		expect(openai.compact).toHaveBeenCalledOnce();
	});

	it("blocks the next step when a recorded tool is still started", async () => {
		const onModelStepBoundary = vi
			.fn()
			.mockRejectedValue(new Error("Started tool blocks the next model step"));
		await expect(
			new Agent().run("goal", {
				journal: journalWith(),
				requestNumber: 1,
				contextBudget: 100,
				onModelStepBoundary,
				onCompacted: async () => {},
			}),
		).rejects.toThrow("Started tool");
		expect(openai.count).not.toHaveBeenCalled();
		expect(openai.compact).not.toHaveBeenCalled();
		expect(openai.create).not.toHaveBeenCalled();
	});
	it("skips preflight for a small request with a large budget", async () => {
		openai.create.mockResolvedValue({
			output: [assistantMessage("small", "done")],
			output_text: "done",
			usage: { input_tokens: 120 },
		});
		await new Agent().run("small", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100_000,
		});
		expect(openai.count).not.toHaveBeenCalled();
		expect(openai.create).toHaveBeenCalledOnce();
	});

	it("uses first-step response usage to preflight the next tool step", async () => {
		openai.create
			.mockResolvedValueOnce({
				output: [
					{
						type: "function_call",
						name: "read",
						arguments: "{",
						call_id: "bad-read",
					},
				],
				output_text: "",
				usage: { input_tokens: 79_999 },
			})
			.mockResolvedValueOnce({
				output: [assistantMessage("second", "done")],
				output_text: "done",
			});
		openai.count.mockResolvedValue({ input_tokens: 80_050 });
		await new Agent().run("step", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100_000,
		});
		expect(openai.count).toHaveBeenCalledOnce();
		expect(openai.create).toHaveBeenCalledTimes(2);
	});

	it("uses prior exact usage to skip a safely low follow-up", async () => {
		openai.create.mockImplementation(async () => ({
			output: [assistantMessage("low", "done")],
			output_text: "done",
			usage: { input_tokens: 150 },
		}));
		const agent = new Agent();
		await agent.run("first", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100_000,
		});
		await agent.run("second", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: 100_000,
		});
		expect(openai.count).not.toHaveBeenCalled();
		expect(openai.create).toHaveBeenCalledTimes(2);
	});

	it("preflights when the complete next request reaches the boundary", async () => {
		let firstRequestBytes = 0;
		openai.create.mockImplementation(async (request) => {
			if (firstRequestBytes === 0) {
				firstRequestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
			}
			return {
				output: [assistantMessage("follow-up", "done")],
				output_text: "done",
				usage: { input_tokens: 1 },
			};
		});
		openai.count.mockResolvedValue({ input_tokens: 2 });
		const agent = new Agent();
		await agent.run("first", { journal: journalWith(), requestNumber: 1 });
		const budget = Math.ceil((firstRequestBytes + 1) / 0.8);
		await agent.run("second", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: budget,
		});
		expect(openai.count).toHaveBeenCalledOnce();
	});

	it("preflights after the model changes because the prior count cannot apply", async () => {
		process.env.OPENAI_MODEL = "model-a";
		openai.create.mockImplementation(async () => ({
			output: [assistantMessage("model-change", "done")],
			output_text: "done",
			usage: { input_tokens: 150 },
		}));
		openai.count.mockResolvedValue({ input_tokens: 200 });
		const agent = new Agent();
		await agent.run("first", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100_000,
		});
		process.env.OPENAI_MODEL = "model-b";
		await agent.run("second", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: 100_000,
		});
		expect(openai.count).toHaveBeenCalledOnce();
		expect(openai.count.mock.calls[0]?.[0].model).toBe("model-b");
	});

	it("preflights the complete pending request when the soft boundary is at risk", async () => {
		let countedRequest: unknown;
		let createdRequest: unknown;
		openai.count.mockImplementation(async (request) => {
			countedRequest = structuredClone(request);
			return { input_tokens: 70 };
		});
		openai.create.mockImplementation(async (request) => {
			createdRequest = structuredClone(request);
			return {
				output: [assistantMessage("risky", "done")],
				output_text: "done",
				usage: { input_tokens: 72 },
			};
		});
		const onContextMeasured = vi.fn();
		await new Agent().run("risk", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100,
			onContextMeasured,
		});
		expect(openai.count).toHaveBeenCalledOnce();
		expect(countedRequest).toEqual(createdRequest);
		expect(countedRequest).toMatchObject({
			model: expect.any(String),
			instructions: expect.any(String),
			tools: expect.any(Array),
			input: [{ role: "user", content: "risk" }],
		});
		expect(createdRequest).not.toHaveProperty("truncation");
		expect(onContextMeasured.mock.calls.map(([tokens]) => tokens)).toEqual([
			70, 72,
		]);
	});

	it("blocks an exact count above budget and keeps the stable checkpoint", async () => {
		openai.count
			.mockResolvedValueOnce({ input_tokens: 101 })
			.mockResolvedValueOnce({ input_tokens: 10 });
		let createdInput: unknown;
		openai.create.mockImplementation(async (request) => {
			createdInput = structuredClone(request.input);
			return {
				output: [assistantMessage("recovered", "done")],
				output_text: "done",
			};
		});
		const agent = new Agent([{ role: "user", content: "stable" }]);
		const onContextMeasured = vi.fn();
		await expect(
			agent.run("blocked", {
				journal: journalWith(),
				requestNumber: 1,
				contextBudget: 100,
				onContextMeasured,
			}),
		).rejects.toThrow("Context Budget");
		expect(openai.create).not.toHaveBeenCalled();
		expect(onContextMeasured).toHaveBeenCalledWith(101);
		await agent.run("fresh", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: 100,
		});
		expect(createdInput).toEqual([
			{ role: "user", content: "stable" },
			{ role: "user", content: "fresh" },
		]);
	});

	it("allows an exact count equal to the budget", async () => {
		openai.count.mockResolvedValue({ input_tokens: 100 });
		openai.create.mockResolvedValue({
			output: [assistantMessage("at-budget", "done")],
			output_text: "done",
		});
		await new Agent().run("at budget", {
			journal: journalWith(),
			requestNumber: 1,
			contextBudget: 100,
		});
		expect(openai.create).toHaveBeenCalledOnce();
	});

	it("records failed required preflight and never calls the model", async () => {
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		openai.count
			.mockRejectedValueOnce(new Error("count failed"))
			.mockResolvedValueOnce({ input_tokens: 10 });
		let recoveredInput: unknown;
		openai.create.mockImplementation(async (request) => {
			recoveredInput = structuredClone(request.input);
			return {
				output: [assistantMessage("after-count-failure", "done")],
				output_text: "done",
			};
		});
		const agent = new Agent([{ role: "user", content: "stable" }]);
		await expect(
			agent.run("large", {
				journal: journalWith(records),
				requestNumber: 1,
				contextBudget: 100,
			}),
		).rejects.toThrow("count failed");
		expect(openai.create).not.toHaveBeenCalled();
		expect(
			records.find(({ type }) => type === "model_error")?.data,
		).toMatchObject({
			phase: "input_token_count",
		});
		await agent.run("fresh", {
			journal: journalWith(),
			requestNumber: 2,
			contextBudget: 100,
		});
		expect(recoveredInput).toEqual([
			{ role: "user", content: "stable" },
			{ role: "user", content: "fresh" },
		]);
	});

	it("warns once per high-usage period and resets after an exact low count", async () => {
		openai.count
			.mockResolvedValueOnce({ input_tokens: 80 })
			.mockResolvedValueOnce({ input_tokens: 90 })
			.mockResolvedValueOnce({ input_tokens: 79 })
			.mockResolvedValueOnce({ input_tokens: 80 });
		openai.create.mockImplementation(async () => ({
			output: [assistantMessage("answer", "done")],
			output_text: "done",
		}));
		const onContextWarning = vi.fn();
		const agent = new Agent();
		for (const prompt of ["one", "two", "three", "four"]) {
			await agent.run(prompt, {
				journal: journalWith(),
				requestNumber: 1,
				contextBudget: 100,
				onContextWarning,
			});
		}
		expect(onContextWarning.mock.calls).toEqual([
			[80, 100],
			[80, 100],
		]);
	});

	it("publishes exact input usage from a successful response", async () => {
		openai.create.mockResolvedValue({
			output: [assistantMessage("message-usage", "done")],
			output_text: "done",
			usage: { input_tokens: 321 },
		});
		const onContextMeasured = vi.fn();
		await new Agent().run("measure", {
			journal: journalWith(),
			requestNumber: 1,
			onContextMeasured,
		});
		expect(onContextMeasured).toHaveBeenCalledOnce();
		expect(onContextMeasured).toHaveBeenCalledWith(321);
	});

	it("leaves the last measurement alone when response usage is absent", async () => {
		openai.create.mockResolvedValue({
			output: [assistantMessage("message-no-usage", "done")],
			output_text: "done",
		});
		const onContextMeasured = vi.fn();
		await new Agent().run("measure", {
			journal: journalWith(),
			requestNumber: 1,
			onContextMeasured,
		});
		expect(onContextMeasured).not.toHaveBeenCalled();
	});

	it("continues restored input with current runtime configuration", async () => {
		process.env.OPENAI_MODEL = "current-model";
		const restoredAnswer = assistantMessage("message-old", "old answer");
		const restoredInput = [
			{ role: "user" as const, content: "old request" },
			restoredAnswer,
		];
		const nextAnswer = assistantMessage("message-new", "new answer");
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		let seenRequest: unknown;
		openai.create.mockImplementation(async (request) => {
			seenRequest = structuredClone(request);
			return {
				output: [nextAnswer],
				output_text: "new answer",
			};
		});

		const result = await new Agent(restoredInput).run("new request", {
			journal: journalWith(records),
			requestNumber: 1,
			conversationId: "a1b2c3d4e5f6",
		});

		const expectedInput = [
			...restoredInput,
			{ role: "user", content: "new request" },
			nextAnswer,
		];
		expect(openai.create).toHaveBeenCalledOnce();
		expect(seenRequest).toMatchObject({
			model: "current-model",
			input: expectedInput.slice(0, -1),
		});
		expect(seenRequest).toMatchObject({
			instructions: expect.stringContaining("historical project state"),
		});
		expect(seenRequest).toMatchObject({
			instructions: expect.stringContaining("Prefer exact replace"),
		});
		expect(result).toEqual({
			answer: "new answer",
			input: expectedInput,
			model: "current-model",
		});
		expect(restoredInput).toEqual([
			{ role: "user", content: "old request" },
			restoredAnswer,
		]);
		expect(records.map(({ context }) => context)).toEqual([
			{ conversationId: "a1b2c3d4e5f6", requestNumber: 1 },
			{
				conversationId: "a1b2c3d4e5f6",
				requestNumber: 1,
				stepNumber: 1,
			},
			{
				conversationId: "a1b2c3d4e5f6",
				requestNumber: 1,
				stepNumber: 1,
			},
			{ conversationId: "a1b2c3d4e5f6", requestNumber: 1 },
		]);
	});

	it("discards failed working input before the next user request", async () => {
		const restoredInput = [{ role: "user" as const, content: "stable" }];
		const artifact = `.checkpoint-read-${process.pid}.txt`;
		artifacts.push(artifact);
		await fs.writeFile(artifact, "known");
		const call = {
			type: "function_call" as const,
			name: "read",
			arguments: JSON.stringify({ path: artifact }),
			call_id: "call-1",
		};
		const expectedReadOutput =
			`[read path=${JSON.stringify(artifact)} from=1:1 through=1:5 ` +
			`total_lines=1 truncated=false next=none out_of_range=false]\nknown`;
		const finalAnswer = assistantMessage("message-final", "recovered");
		const seenInputs: unknown[] = [];
		openai.create.mockImplementation(async (request) => {
			seenInputs.push(structuredClone(request.input));
			if (seenInputs.length === 1) {
				return { output: [call], output_text: "" };
			}
			if (seenInputs.length === 2) {
				throw new Error("model failed");
			}
			return { output: [finalAnswer], output_text: "recovered" };
		});
		const agent = new Agent(restoredInput);

		await expect(
			agent.run("failed request", {
				journal: journalWith(),
				requestNumber: 1,
				conversationId: "a1b2c3d4e5f6",
				onToolStarted: async () => {},
				onToolFinished: async () => {},
			}),
		).rejects.toThrow("model failed");
		await agent.run("fresh request", {
			journal: journalWith(),
			requestNumber: 2,
			conversationId: "a1b2c3d4e5f6",
		});

		expect(seenInputs[0]).toEqual([
			...restoredInput,
			{ role: "user", content: "failed request" },
		]);
		expect(seenInputs[1]).toEqual([
			...restoredInput,
			{ role: "user", content: "failed request" },
			call,
			{
				type: "function_call_output",
				call_id: "call-1",
				output: expectedReadOutput,
			},
		]);
		expect(seenInputs[2]).toEqual([
			...restoredInput,
			{ role: "user", content: "fresh request" },
		]);
	});

	it("cancels an active model request without advancing its checkpoint", async () => {
		const controller = new AbortController();
		const agent = new Agent([{ role: "user", content: "stable" }]);
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		let freshRequestInput: unknown;
		openai.create
			.mockImplementationOnce(async (_request, options) => {
				if (!options?.signal) throw new Error("missing abort signal");
				return new Promise((_, reject) => {
					options.signal.addEventListener(
						"abort",
						() => reject(options.signal.reason),
						{ once: true },
					);
				});
			})
			.mockImplementationOnce(async (request) => {
				freshRequestInput = structuredClone(request.input);
				return {
					output: [assistantMessage("message-fresh", "fresh")],
					output_text: "fresh",
				};
			});

		const interrupted = agent.run("interrupted", {
			journal: journalWith(records),
			requestNumber: 1,
			conversationId: "a1b2c3d4e5f6",
			signal: controller.signal,
		});
		const interruptedExpectation =
			expect(interrupted).rejects.toThrow("interrupted");
		await vi.waitFor(() => expect(openai.create).toHaveBeenCalledOnce());
		controller.abort(new Error("interrupted"));

		await interruptedExpectation;
		expect(records.at(-1)?.data).toMatchObject({ reason: "cancelled" });
		await agent.run("fresh", {
			journal: journalWith(),
			requestNumber: 2,
			conversationId: "a1b2c3d4e5f6",
		});
		expect(freshRequestInput).toEqual([
			{ role: "user", content: "stable" },
			{ role: "user", content: "fresh" },
		]);
	});

	it("awaits tool state around execution", async () => {
		const artifact = `.checkpoint-test-${process.pid}.txt`;
		artifacts.push(artifact);
		const call = {
			type: "function_call" as const,
			name: "write",
			arguments: JSON.stringify({ path: artifact, content: "written" }),
			call_id: "call-write",
		};
		openai.create
			.mockResolvedValueOnce({ output: [call], output_text: "" })
			.mockResolvedValueOnce({
				output: [assistantMessage("message-done", "done")],
				output_text: "done",
			});
		const order: string[] = [];

		await new Agent().run("write it", {
			journal: journalWith(),
			requestNumber: 1,
			conversationId: "a1b2c3d4e5f6",
			onToolStarted: async (tool) => {
				order.push(`started:${tool.callId}:${tool.name}`);
				await expect(fs.access(artifact)).rejects.toThrow();
			},
			onToolFinished: async (callId) => {
				order.push(`finished:${callId}`);
				expect(await fs.readFile(artifact, "utf8")).toBe("written");
			},
		});

		expect(order).toEqual(["started:call-write:write", "finished:call-write"]);
	});

	it("does not execute a tool when its started callback fails", async () => {
		const artifact = `.checkpoint-blocked-${process.pid}.txt`;
		artifacts.push(artifact);
		openai.create.mockResolvedValue({
			output: [
				{
					type: "function_call",
					name: "write",
					arguments: JSON.stringify({ path: artifact, content: "forbidden" }),
					call_id: "call-blocked",
				},
			],
			output_text: "",
		});

		await expect(
			new Agent().run("write it", {
				journal: journalWith(),
				requestNumber: 1,
				conversationId: "a1b2c3d4e5f6",
				onToolStarted: async () => {
					throw new Error("state save failed");
				},
			}),
		).rejects.toThrow("state save failed");

		await expect(fs.access(artifact)).rejects.toThrow();
		expect(openai.create).toHaveBeenCalledOnce();
	});

	it("does not execute a tool when interrupted during its started callback", async () => {
		const artifact = `.checkpoint-interrupted-${process.pid}.txt`;
		artifacts.push(artifact);
		const controller = new AbortController();
		let finishStartedSave = () => {};
		const onToolStarted = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishStartedSave = resolve;
				}),
		);
		openai.create.mockResolvedValue({
			output: [
				{
					type: "function_call",
					name: "write",
					arguments: JSON.stringify({ path: artifact, content: "forbidden" }),
					call_id: "call-interrupted",
				},
			],
			output_text: "",
		});

		const interrupted = new Agent().run("write it", {
			journal: journalWith(),
			requestNumber: 1,
			conversationId: "a1b2c3d4e5f6",
			signal: controller.signal,
			onToolStarted,
		});
		const interruptedExpectation =
			expect(interrupted).rejects.toThrow("interrupted");
		await vi.waitFor(() => expect(onToolStarted).toHaveBeenCalledOnce());
		controller.abort(new Error("interrupted"));
		finishStartedSave();

		await interruptedExpectation;
		await expect(fs.access(artifact)).rejects.toThrow();
	});

	it("stops after execution when finished state cannot be saved", async () => {
		const artifact = `.checkpoint-finished-${process.pid}.txt`;
		artifacts.push(artifact);
		const call = {
			type: "function_call" as const,
			name: "write",
			arguments: JSON.stringify({ path: artifact, content: "written" }),
			call_id: "call-finished",
		};
		let freshRequestInput: unknown;
		openai.create
			.mockResolvedValueOnce({ output: [call], output_text: "" })
			.mockImplementationOnce(async (request) => {
				freshRequestInput = structuredClone(request.input);
				return {
					output: [assistantMessage("message-fresh", "fresh")],
					output_text: "fresh",
				};
			});
		const agent = new Agent();

		await expect(
			agent.run("failed", {
				journal: journalWith(),
				requestNumber: 1,
				conversationId: "a1b2c3d4e5f6",
				onToolStarted: async () => {},
				onToolFinished: async () => {
					throw new Error("state save failed");
				},
			}),
		).rejects.toThrow("state save failed");
		expect(await fs.readFile(artifact, "utf8")).toBe("written");
		expect(openai.create).toHaveBeenCalledOnce();

		await agent.run("fresh", {
			journal: journalWith(),
			requestNumber: 2,
			conversationId: "a1b2c3d4e5f6",
		});
		expect(freshRequestInput).toEqual([{ role: "user", content: "fresh" }]);
	});

	it("journals raw tool output but sends only bounded output to the model", async () => {
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
			`process.stdout.write("a".repeat(10001) + "z".repeat(10000))`,
		)}`;
		const call = {
			type: "function_call" as const,
			name: "run",
			arguments: JSON.stringify({ command }),
			call_id: "call-large-run",
		};
		const records: Array<{ type: string; data: unknown; context: unknown }> =
			[];
		let secondRequestInput: unknown[] = [];
		openai.create
			.mockResolvedValueOnce({ output: [call], output_text: "" })
			.mockImplementationOnce(async (request) => {
				secondRequestInput = structuredClone(request.input);
				return {
					output: [assistantMessage("message-done", "done")],
					output_text: "done",
				};
			});

		await new Agent().run("run it", {
			journal: journalWith(records),
			requestNumber: 1,
			onToolStarted: async () => {},
			onToolFinished: async () => {},
		});

		const finished = records.find(({ type }) => type === "tool_finished");
		const data = finished?.data as {
			output: string;
			modelOutput: string;
			truncation: { truncated: boolean; omittedCharacters: number };
		};
		const sent = secondRequestInput.find(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "function_call_output",
		) as { output: string };

		expect(data.output.length).toBeGreaterThan(20_000);
		expect(data.truncation.truncated).toBe(true);
		expect(sent.output).toBe(data.modelOutput);
		expect(sent.output).not.toBe(data.output);
	});
});
