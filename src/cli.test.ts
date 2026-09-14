import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResponseInput } from "openai/resources/responses/responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunOptions } from "./agent.js";
import { runCli } from "./cli.js";
import { createConversationStore } from "./conversations.js";
import { createJournal, type Journal } from "./journal.js";

const roots: string[] = [];
const clack = vi.hoisted(() => ({
	select: vi.fn(),
	isCancel: vi.fn((value: unknown) => typeof value === "symbol"),
}));

vi.mock("@clack/prompts", () => clack);

function journalWith(
	record: (...args: unknown[]) => unknown = vi.fn(),
	finish: (...args: unknown[]) => unknown = vi.fn(),
) {
	return {
		record: async (...args: unknown[]) => await record(...args),
		finish: async (data: unknown) => await finish(data),
	} as unknown as Journal;
}

function promptWith(answers: string[]) {
	return Object.assign(new EventEmitter(), {
		question: vi.fn(async () => answers.shift() ?? "quit"),
		pause: vi.fn(),
		resume: vi.fn(),
		close: vi.fn(),
	});
}

async function createStore() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "micro-agent-cli-"));
	roots.push(root);
	return { root, store: await createConversationStore(root) };
}

function successfulAgentFactory(initialInput: ResponseInput = []) {
	let checkpoint = structuredClone(initialInput);
	return async (prompt: string) => {
		checkpoint = [...checkpoint, { role: "user", content: prompt }];
		return {
			answer: `answer: ${prompt}`,
			input: structuredClone(checkpoint),
			model: "test-model",
		};
	};
}

beforeEach(() => {
	clack.select.mockReset();
	clack.isCancel.mockClear();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});

describe("runCli", () => {
	it("cancels history without replacing the active conversation", async () => {
		const { store } = await createStore();
		await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "saved request"),
			[{ role: "user", content: "saved request" }],
			"test-model",
		);
		clack.select.mockResolvedValue(Symbol("cancel"));
		const createAgent = vi.fn(successfulAgentFactory);

		await runCli(
			promptWith(["current request", "/history", "continued request", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
		);

		expect(createAgent).toHaveBeenCalledOnce();
		const { conversations } = await store.listConversations();
		expect(conversations).toHaveLength(2);
		expect(conversations).toContainEqual(
			expect.objectContaining({
				input: [
					{ role: "user", content: "current request" },
					{ role: "user", content: "continued request" },
				],
			}),
		);
	});

	it("shows an empty state and the count of invalid conversation files", async () => {
		const { root, store } = await createStore();
		await fs.writeFile(
			path.join(root, "conversations", "aaaaaaaaaaaa.json"),
			"{",
		);

		await runCli(
			promptWith(["/history", "quit"]),
			journalWith(),
			store,
			undefined,
			new EventEmitter(),
		);

		expect(clack.select).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			"WARNING: skipped 1 invalid conversation file(s).",
		);
		expect(console.log).toHaveBeenCalledWith("No saved conversations.");
	});

	it("blocks history and new while the completed checkpoint is unsaved", async () => {
		const { store } = await createStore();
		const failingStore = {
			...store,
			commitCheckpoint: vi.fn().mockRejectedValue(new Error("disk full")),
		};
		const createAgent = vi.fn(successfulAgentFactory);
		const selectConversation = vi.fn();

		await runCli(
			promptWith(["first request", "/history", "/new", "quit"]),
			journalWith(),
			failingStore,
			createAgent,
			new EventEmitter(),
			selectConversation,
		);

		expect(selectConversation).not.toHaveBeenCalled();
		expect(createAgent).toHaveBeenCalledOnce();
		expect(failingStore.commitCheckpoint).toHaveBeenCalledTimes(3);
	});

	it("supports switching conversations more than once in one run", async () => {
		const { store } = await createStore();
		const firstInput = [{ role: "user" as const, content: "first saved" }];
		const secondInput = [{ role: "user" as const, content: "second saved" }];
		const first = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "first saved"),
			firstInput,
			"test-model",
		);
		const second = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "second saved"),
			secondInput,
			"test-model",
		);
		const selections = [first.id, second.id];
		const createAgent = vi.fn(successfulAgentFactory);

		await runCli(
			promptWith(["/history", "/history", "continued", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
			async () => selections.shift(),
		);

		expect(createAgent.mock.calls.map(([input]) => input)).toEqual([
			[],
			firstInput,
			secondInput,
		]);
		expect((await store.loadConversation(second.id)).input).toEqual([
			...secondInput,
			{ role: "user", content: "continued" },
		]);
	});

	it("uses the interactive selector when no test selector is injected", async () => {
		const { store } = await createStore();
		const savedInput = [{ role: "user" as const, content: "saved request" }];
		const saved = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "saved request"),
			savedInput,
			"test-model",
		);
		clack.select.mockResolvedValue(saved.id);
		const createAgent = vi.fn(successfulAgentFactory);

		await runCli(
			promptWith(["/history", "continued request", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
		);

		expect(createAgent.mock.calls.map(([input]) => input)).toEqual([
			[],
			savedInput,
		]);
		expect(clack.select).toHaveBeenCalledWith({
			message: "Select a conversation",
			options: [
				{
					value: saved.id,
					label: expect.stringContaining(saved.id),
				},
			],
		});
	});

	it("shows recovery warnings and resumes only the stable checkpoint", async () => {
		const { store } = await createStore();
		const stableInput = [{ role: "user" as const, content: "stable request" }];
		const completed = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "stable request"),
			stableInput,
			"old-model",
		);
		const pending = await store.markToolFinished(
			await store.markToolStarted(
				await store.markToolStarted(
					await store.startRequest(completed, "unfinished request"),
					{ callId: "call-started", name: "write" },
				),
				{ callId: "call-finished", name: "read" },
			),
			"call-finished",
		);
		const createAgent = vi.fn(successfulAgentFactory);

		await runCli(
			promptWith(["/history", "fresh request", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
			async () => pending.id,
			"current-model",
		);

		expect(createAgent.mock.calls.map(([input]) => input)).toEqual([
			[],
			stableInput,
		]);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("unfinished request"),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("write (call-started): started"),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("read (call-finished): finished"),
		);
		expect(console.error).toHaveBeenCalledWith(
			"WARNING: conversation last used old-model; current model is current-model.",
		);
		expect((await store.loadConversation(pending.id)).input).toEqual([
			...stableInput,
			{ role: "user", content: "fresh request" },
		]);
	});

	it("keeps the active conversation when the selected file changes before loading", async () => {
		const { root, store } = await createStore();
		const target = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "target request"),
			[{ role: "user", content: "target request" }],
			"old-model",
		);
		const createAgent = vi.fn(successfulAgentFactory);
		const selectConversation = vi.fn(async () => {
			await fs.writeFile(
				path.join(root, "conversations", `${target.id}.json`),
				"{",
			);
			return target.id;
		});

		await runCli(
			promptWith(["current request", "/history", "continued request", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
			selectConversation,
		);

		expect(createAgent).toHaveBeenCalledOnce();
		const { conversations } = await store.listConversations();
		expect(conversations).toHaveLength(1);
		expect(conversations.at(0)?.input).toEqual([
			{ role: "user", content: "current request" },
			{ role: "user", content: "continued request" },
		]);
		expect(console.error).toHaveBeenCalledWith(
			"WARNING: selected conversation could not be loaded; current conversation is unchanged.",
		);
	});

	it("keeps the active conversation when the selected file changes to another valid state", async () => {
		const { store } = await createStore();
		let target = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "target request"),
			[{ role: "user", content: "target request" }],
			"old-model",
		);
		const createAgent = vi.fn(successfulAgentFactory);
		const selectConversation = vi.fn(async () => {
			target = await store.startRequest(target, "changed after listing");
			return target.id;
		});

		await runCli(
			promptWith(["current request", "/history", "continued request", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
			selectConversation,
		);

		expect(createAgent).toHaveBeenCalledOnce();
		const { conversations } = await store.listConversations();
		expect(conversations).toContainEqual(
			expect.objectContaining({
				input: [
					{ role: "user", content: "current request" },
					{ role: "user", content: "continued request" },
				],
			}),
		);
		expect(console.error).toHaveBeenCalledWith(
			"WARNING: selected conversation could not be loaded; current conversation is unchanged.",
		);
	});

	it("loads the selected checkpoint and continues it with a recreated agent", async () => {
		const { store } = await createStore();
		const savedInput = [{ role: "user" as const, content: "saved request" }];
		const saved = await store.commitCheckpoint(
			await store.startRequest(store.createConversation(), "saved request"),
			savedInput,
			"old-model",
		);
		const prompt = promptWith(["/history", "continued request", "quit"]);
		const createAgent = vi.fn(successfulAgentFactory);
		const seenChoices: unknown[] = [];
		const selectConversation = vi.fn(async (choices: unknown) => {
			seenChoices.push(choices);
			return saved.id;
		});

		await runCli(
			prompt,
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
			selectConversation,
		);

		expect(prompt.pause).toHaveBeenCalledOnce();
		expect(prompt.resume).toHaveBeenCalledOnce();
		expect(seenChoices).toEqual([
			[
				{
					value: saved.id,
					label: expect.stringContaining(`${saved.id}  saved request`),
				},
			],
		]);
		expect(createAgent.mock.calls.map(([input]) => input)).toEqual([
			[],
			savedInput,
		]);
		expect((await store.loadConversation(saved.id)).input).toEqual([
			...savedInput,
			{ role: "user", content: "continued request" },
		]);
	});

	it("starts a new empty conversation without deleting the previous checkpoint", async () => {
		const { store } = await createStore();
		const createAgent = vi.fn(successfulAgentFactory);

		await runCli(
			promptWith(["first request", "/new", "second request", "quit"]),
			journalWith(),
			store,
			createAgent,
			new EventEmitter(),
		);

		expect(createAgent.mock.calls.map(([input]) => input)).toEqual([[], []]);
		const { conversations } = await store.listConversations();
		expect(conversations.map(({ input }) => input)).toEqual(
			expect.arrayContaining([
				[{ role: "user", content: "first request" }],
				[{ role: "user", content: "second request" }],
			]),
		);
		expect(conversations).toHaveLength(2);
	});

	it("persists pending and tool status before committing exact agent input", async () => {
		const { store } = await createStore();
		const agent = vi.fn(
			async (
				prompt: string,
				_journal: Journal,
				_requestNumber: number,
				options: AgentRunOptions = {},
			) => {
				const pending = await store.loadConversation(
					options.conversationId ?? "",
				);
				expect(pending.pendingRequest?.prompt).toBe(prompt);

				await options.onToolStarted?.({ callId: "call-1", name: "read" });
				const started = await store.loadConversation(
					options.conversationId ?? "",
				);
				expect(started.pendingRequest?.tools).toEqual([
					{ callId: "call-1", name: "read", status: "started" },
				]);

				await options.onToolFinished?.("call-1");
				const finished = await store.loadConversation(
					options.conversationId ?? "",
				);
				expect(finished.pendingRequest?.tools).toEqual([
					{ callId: "call-1", name: "read", status: "finished" },
				]);

				return {
					answer: "done",
					input: [{ role: "user" as const, content: prompt }],
					model: "current-model",
				};
			},
		);

		await runCli(
			promptWith(["inspect", "quit"]),
			journalWith(),
			store,
			() => agent,
			new EventEmitter(),
		);

		const { conversations } = await store.listConversations();
		expect(conversations).toHaveLength(1);
		expect(conversations[0]).toMatchObject({
			revision: 4,
			lastModel: "current-model",
			input: [{ role: "user", content: "inspect" }],
			pendingRequest: null,
		});
	});

	it("does not call the agent when pending state cannot be saved", async () => {
		const { store } = await createStore();
		const agent = vi.fn();
		const failingStore = {
			...store,
			startRequest: vi.fn().mockRejectedValue(new Error("disk full")),
		};

		await runCli(
			promptWith(["inspect", "quit"]),
			journalWith(),
			failingStore,
			() => agent,
			new EventEmitter(),
		);

		expect(agent).not.toHaveBeenCalled();
		expect((await store.listConversations()).conversations).toEqual([]);
	});

	it("blocks later requests until an unsaved checkpoint is persisted", async () => {
		const { store } = await createStore();
		let commitAttempts = 0;
		const flakyStore = {
			...store,
			commitCheckpoint: async (
				...args: Parameters<typeof store.commitCheckpoint>
			) => {
				commitAttempts++;
				if (commitAttempts <= 2) throw new Error("disk full");
				return store.commitCheckpoint(...args);
			},
		};
		const agent = vi.fn(successfulAgentFactory());

		await runCli(
			promptWith(["first", "blocked", "third", "quit"]),
			journalWith(),
			flakyStore,
			() => agent,
			new EventEmitter(),
		);

		expect(agent.mock.calls.map(([prompt]) => prompt)).toEqual([
			"first",
			"third",
		]);
		expect(commitAttempts).toBe(4);
		const { conversations } = await store.listConversations();
		expect(conversations[0]).toMatchObject({
			input: [
				{ role: "user", content: "first" },
				{ role: "user", content: "third" },
			],
			pendingRequest: null,
		});
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("UNSAVED"),
		);
	});

	it("warns when exiting with an unsaved checkpoint", async () => {
		const { store } = await createStore();
		const failingStore = {
			...store,
			commitCheckpoint: vi.fn().mockRejectedValue(new Error("disk full")),
		};

		await runCli(
			promptWith(["first", "quit"]),
			journalWith(),
			failingStore,
			successfulAgentFactory,
			new EventEmitter(),
		);

		expect(console.error).toHaveBeenCalledWith(
			"WARNING: UNSAVED conversation checkpoint will be lost on exit.",
		);
	});

	it("leaves failed request metadata and starts the next request from checkpoint", async () => {
		const { store } = await createStore();
		const agent = vi
			.fn()
			.mockRejectedValueOnce(new Error("model failed"))
			.mockResolvedValueOnce({
				answer: "recovered",
				input: [{ role: "user", content: "fresh" }],
				model: "current-model",
			});

		await runCli(
			promptWith(["failed", "fresh", "quit"]),
			journalWith(),
			store,
			() => agent,
			new EventEmitter(),
		);

		expect(agent.mock.calls.map(([prompt]) => prompt)).toEqual([
			"failed",
			"fresh",
		]);
		const { conversations } = await store.listConversations();
		expect(conversations[0]).toMatchObject({
			input: [{ role: "user", content: "fresh" }],
			pendingRequest: null,
		});
	});

	it("keeps conversation persistence active when the journal is disabled", async () => {
		const { root, store } = await createStore();
		const journal = await createJournal(false, root);

		await runCli(
			promptWith(["persist me", "quit"]),
			journal,
			store,
			successfulAgentFactory,
			new EventEmitter(),
		);

		expect((await store.listConversations()).conversations[0]).toMatchObject({
			input: [{ role: "user", content: "persist me" }],
			pendingRequest: null,
		});
	});

	it("keeps conversation persistence active after journal failure", async () => {
		const { root, store } = await createStore();
		await fs.writeFile(path.join(root, "logs"), "not a directory");
		const journal = await createJournal(true, root);

		await runCli(
			promptWith(["persist me", "quit"]),
			journal,
			store,
			successfulAgentFactory,
			new EventEmitter(),
		);

		expect((await store.listConversations()).conversations[0]).toMatchObject({
			input: [{ role: "user", content: "persist me" }],
			pendingRequest: null,
		});
	});

	it("finishes the journal when Ctrl-C interrupts the active question", async () => {
		const { store } = await createStore();
		const finish = vi.fn();
		const prompt = Object.assign(new EventEmitter(), {
			question: vi.fn(() => new Promise<string>(() => {})),
			pause: vi.fn(),
			resume: vi.fn(),
			close: vi.fn(),
		});

		const resultPromise = runCli(prompt, journalWith(vi.fn(), finish), store);
		prompt.emit("SIGINT");
		const result = await resultPromise;

		expect(result).toEqual({ interrupted: true });
		expect(prompt.close).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledWith({ requestCount: 0 });
		expect((await store.listConversations()).conversations).toEqual([]);
	});

	it("awaits a sealed journal finish when SIGINT interrupts a request", async () => {
		const { store } = await createStore();
		let persistFinish = () => {};
		const finish = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					persistFinish = resolve;
				}),
		);
		const prompt = promptWith(["inspect repository"]);
		const signals = new EventEmitter();
		const agent = vi.fn(() => new Promise<never>(() => {}));
		let settled = false;

		const resultPromise = runCli(
			prompt,
			journalWith(vi.fn(), finish),
			store,
			() => agent,
			signals,
		).then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(agent).toHaveBeenCalledOnce());

		signals.emit("SIGINT");
		await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());

		expect(settled).toBe(false);
		persistFinish();
		await expect(resultPromise).resolves.toEqual({ interrupted: true });
		expect(prompt.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGINT")).toBe(0);
	});

	it("keeps pending metadata when Ctrl-C interrupts a request", async () => {
		const { store } = await createStore();
		const prompt = promptWith(["inspect repository"]);
		const signals = new EventEmitter();
		const agent = vi.fn(() => new Promise<never>(() => {}));

		const resultPromise = runCli(
			prompt,
			journalWith(),
			store,
			() => agent,
			signals,
		);
		await vi.waitFor(() => expect(agent).toHaveBeenCalledOnce());

		signals.emit("SIGINT");
		const result = await resultPromise;

		expect(result).toEqual({ interrupted: true });
		const { conversations } = await store.listConversations();
		expect(conversations[0]).toMatchObject({
			input: [],
			pendingRequest: {
				prompt: "inspect repository",
				tools: [],
			},
		});
	});

	it("keeps exit as a normal journal completion", async () => {
		const { store } = await createStore();
		const finish = vi.fn();
		const prompt = promptWith(["exit"]);

		const result = await runCli(prompt, journalWith(vi.fn(), finish), store);

		expect(result).toEqual({ interrupted: false });
		expect(prompt.close).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledWith({ requestCount: 0 });
	});

	it("does not mark an unexpected prompt failure as complete", async () => {
		const { store } = await createStore();
		const failure = new Error("stdin failed");
		const finish = vi.fn();
		const prompt = Object.assign(new EventEmitter(), {
			question: vi.fn().mockRejectedValue(failure),
			pause: vi.fn(),
			resume: vi.fn(),
			close: vi.fn(),
		});

		await expect(
			runCli(prompt, journalWith(vi.fn(), finish), store),
		).rejects.toBe(failure);

		expect(prompt.close).toHaveBeenCalledOnce();
		expect(finish).not.toHaveBeenCalled();
	});
});
