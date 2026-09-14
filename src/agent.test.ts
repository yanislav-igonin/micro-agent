import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Journal } from "./journal.js";

const openai = vi.hoisted(() => ({
	create: vi.fn(),
}));

vi.mock("openai", () => ({
	default: class {
		responses = { create: openai.create };
	},
}));

import { createAgent } from "./agent.js";

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
});

afterEach(async () => {
	delete process.env.OPENAI_MODEL;
	await Promise.all(
		artifacts.splice(0).map((artifact) => fs.rm(artifact, { force: true })),
	);
});

describe("createAgent", () => {
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

		const result = await createAgent(restoredInput)(
			"new request",
			journalWith(records),
			1,
			{ conversationId: "a1b2c3d4e5f6" },
		);

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
		const call = {
			type: "function_call" as const,
			name: "read",
			arguments: JSON.stringify({ path: "README.md" }),
			call_id: "call-1",
		};
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
		const agent = createAgent(restoredInput);

		await expect(
			agent("failed request", journalWith(), 1, {
				conversationId: "a1b2c3d4e5f6",
				onToolStarted: async () => {},
				onToolFinished: async () => {},
			}),
		).rejects.toThrow("model failed");
		await agent("fresh request", journalWith(), 2, {
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
				output: await fs.readFile("README.md", "utf8"),
			},
		]);
		expect(seenInputs[2]).toEqual([
			...restoredInput,
			{ role: "user", content: "fresh request" },
		]);
	});

	it("cancels an active model request without advancing its checkpoint", async () => {
		const controller = new AbortController();
		const agent = createAgent([{ role: "user", content: "stable" }]);
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

		const interrupted = agent("interrupted", journalWith(records), 1, {
			conversationId: "a1b2c3d4e5f6",
			signal: controller.signal,
		});
		const interruptedExpectation =
			expect(interrupted).rejects.toThrow("interrupted");
		await vi.waitFor(() => expect(openai.create).toHaveBeenCalledOnce());
		controller.abort(new Error("interrupted"));

		await interruptedExpectation;
		expect(records.at(-1)?.data).toMatchObject({ reason: "cancelled" });
		await agent("fresh", journalWith(), 2, {
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

		await createAgent()("write it", journalWith(), 1, {
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
			createAgent()("write it", journalWith(), 1, {
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

		const interrupted = createAgent()("write it", journalWith(), 1, {
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
		const agent = createAgent();

		await expect(
			agent("failed", journalWith(), 1, {
				conversationId: "a1b2c3d4e5f6",
				onToolStarted: async () => {},
				onToolFinished: async () => {
					throw new Error("state save failed");
				},
			}),
		).rejects.toThrow("state save failed");
		expect(await fs.readFile(artifact, "utf8")).toBe("written");
		expect(openai.create).toHaveBeenCalledOnce();

		await agent("fresh", journalWith(), 2, {
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

		await createAgent()("run it", journalWith(records), 1, {
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
