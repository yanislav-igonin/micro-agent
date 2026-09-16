import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ResponseInput } from "openai/resources/responses/responses";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation, ConversationStore } from "./conversations.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});

async function createStore() {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "micro-agent-conversations-"),
	);
	roots.push(root);
	return {
		root,
		store: await ConversationStore.open(root),
	};
}

describe("ConversationStore", () => {
	it("atomically replaces old input with a restorable compacted window and retains pending work", async () => {
		const { root, store } = await createStore();
		const old = [{ role: "user" as const, content: "old goal PRI-296" }];
		const committed = store.create();
		await committed.startRequest("old goal");
		await committed.commitCheckpoint(old, "test-model");
		const pending = await committed.startRequest("continue verification");
		const compacted = [
			{
				id: "msg-kept",
				type: "message" as const,
				role: "user" as const,
				status: "completed" as const,
				content: [
					{ type: "input_text" as const, text: "continue verification" },
				],
			},
			{ type: "compaction" as const, id: "cmp-1", encrypted_content: "opaque" },
		] as ResponseInput;
		const saved = await pending.saveCompactionCheckpoint(
			compacted,
			"test-model",
		);
		const restored = await store.load(saved.id);
		expect(restored.input).toEqual(compacted);
		expect(restored.pendingRequest?.prompt).toBe("continue verification");
		expect(JSON.stringify(restored)).not.toContain("old goal PRI-296");
		expect(
			JSON.parse(
				await fs.readFile(
					path.join(root, "conversations", `${saved.id}.json`),
					"utf8",
				),
			).input,
		).toEqual(compacted);
	});

	it("refuses compact checkpoint saves while a tool is started", async () => {
		const { store } = await createStore();
		const started = store.create();
		await started.startRequest("goal");
		await started.markToolStarted({ callId: "call-1", name: "write" });
		await expect(
			started.saveCompactionCheckpoint(
				[{ type: "compaction", id: "cmp", encrypted_content: "opaque" }],
				"test-model",
			),
		).rejects.toThrow("Started tool");
		expect((await store.load(started.id)).input).toEqual([]);
	});
	it("does not create a state file for an empty conversation", async () => {
		const { root, store } = await createStore();

		const conversation = store.create();

		expect(conversation).toMatchObject({
			schemaVersion: 1,
			revision: 0,
			input: [],
			pendingRequest: null,
		});
		expect(conversation.id).toMatch(/^[0-9a-f]{12}$/);
		expect(await fs.readdir(path.join(root, "conversations"))).toEqual([]);
	});

	it("starts the first request with a stable normalized title", async () => {
		const { root, store } = await createStore();
		const conversation = store.create();

		const pending = await conversation.startRequest(
			"  Inspect\n\tthe   failure  ",
		);

		expect(pending.title).toBe("Inspect the failure");
		expect(pending.revision).toBe(1);
		expect(pending.lastModel).toBeNull();
		expect(pending.pendingRequest).toEqual({
			prompt: "  Inspect\n\tthe   failure  ",
			startedAt: pending.updatedAt,
			tools: [],
		});
		const statePath = path.join(root, "conversations", `${pending.id}.json`);
		expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toEqual({
			...pending,
		});
	});

	it("limits the stable title to 50 Unicode code points", async () => {
		const { store } = await createStore();
		const conversation = store.create();

		const firstPending = await conversation.startRequest("😀".repeat(51));
		const secondPending = await firstPending.startRequest("different title");

		expect(firstPending.title).toBe(`${"😀".repeat(49)}…`);
		expect(Array.from(firstPending.title)).toHaveLength(50);
		expect(secondPending.title).toBe(firstPending.title);
	});

	it("persists pending tool started and finished transitions", async () => {
		const { store } = await createStore();
		const conversation = store.create();
		await conversation.startRequest("Inspect project");

		await conversation.markToolStarted({ callId: "call-1", name: "read" });
		expect(conversation.revision).toBe(2);
		expect(conversation.pendingRequest?.tools).toEqual([
			{ callId: "call-1", name: "read", status: "started" },
		]);

		await conversation.markToolFinished("call-1");
		expect(conversation.revision).toBe(3);
		expect(conversation.pendingRequest?.tools).toEqual([
			{ callId: "call-1", name: "read", status: "finished" },
		]);
		expect((await store.load(conversation.id)).pendingRequest?.tools).toEqual([
			{ callId: "call-1", name: "read", status: "finished" },
		]);
	});

	it("round-trips mixed Responses input in a completed checkpoint", async () => {
		const { store } = await createStore();
		const pending = await store.create().startRequest("Read the project");
		const input = [
			{ role: "user", content: "Read the project" },
			{
				type: "reasoning",
				id: "reasoning-1",
				summary: [{ type: "summary_text", text: "Need to inspect a file" }],
				encrypted_content: "opaque",
			},
			{
				type: "function_call",
				call_id: "call-1",
				name: "read",
				arguments: '{"path":"README.md"}',
			},
			{
				type: "function_call_output",
				call_id: "call-1",
				output: "project contents",
			},
			{
				type: "message",
				id: "message-1",
				status: "completed",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "Done",
						annotations: [],
						logprobs: [],
					},
				],
			},
		] as ResponseInput;

		const committed = await pending.commitCheckpoint(input, "gpt-test");
		const loaded = await store.load(committed.id);

		expect(committed).toMatchObject({
			revision: 2,
			lastModel: "gpt-test",
			pendingRequest: null,
		});
		expect(loaded).toEqual({ ...committed });
		expect(loaded.input).toEqual(input);
	});

	it("rejects a stale revision without changing the saved state", async () => {
		const { store } = await createStore();
		const conversation = store.create();
		await conversation.startRequest("First request");
		const stale = new Conversation(store, await store.load(conversation.id));
		const current = await conversation.commitCheckpoint([], "gpt-current");

		await expect(stale.commitCheckpoint([], "gpt-stale")).rejects.toThrow(
			"Conversation revision mismatch: expected 1, found 2",
		);

		expect(await store.load(current.id)).toEqual({ ...current });
	});

	it("keeps the previous checkpoint readable when atomic rename fails", async () => {
		const { store } = await createStore();
		const current = store.create();
		await current.startRequest("First request");
		await current.commitCheckpoint([], "gpt-current");
		vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

		await expect(current.startRequest("Next request")).rejects.toThrow(
			"rename failed",
		);

		vi.restoreAllMocks();
		expect(await store.load(current.id)).toEqual({ ...current });
	});

	it("does not expose a final state file when first publication fails", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const store = await ConversationStore.open(root, {
			createId: () => "aaaaaaaaaaaa",
		});
		vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("publish failed"));
		const conversation = store.create();

		await expect(conversation.startRequest("First request")).rejects.toThrow(
			"publish failed",
		);

		await expect(
			fs.stat(path.join(root, "conversations", "aaaaaaaaaaaa.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a successful first save successful when temp cleanup fails", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const store = await ConversationStore.open(root, {
			createId: () => "aaaaaaaaaaaa",
		});
		vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup failed"));

		const saved = await store.create().startRequest("First request");

		vi.restoreAllMocks();
		expect(saved.id).toBe("aaaaaaaaaaaa");
		expect(await store.load(saved.id)).toEqual({ ...saved });
	});

	it("retries exclusive first-file creation when an ID collides", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
		const store = await ConversationStore.open(root, {
			createId: () => ids.shift() ?? "cccccccccccc",
		});
		const collisionPath = path.join(root, "conversations", "aaaaaaaaaaaa.json");
		await fs.writeFile(collisionPath, "occupied");

		const saved = await store.create().startRequest("First request");

		expect(saved.id).toBe("bbbbbbbbbbbb");
		expect(await fs.readFile(collisionPath, "utf8")).toBe("occupied");
		expect(
			await fs.readFile(
				path.join(root, "conversations", "bbbbbbbbbbbb.json"),
				"utf8",
			),
		).toContain('"id": "bbbbbbbbbbbb"');
	});

	it("lists valid conversations newest-first and ignores temporary files", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const timestamps = [
			"2026-09-12T08:00:00.000Z",
			"2026-09-12T08:01:00.000Z",
			"2026-09-12T08:02:00.000Z",
			"2026-09-12T08:03:00.000Z",
		];
		const store = await ConversationStore.open(root, {
			now: () => new Date(timestamps.shift() ?? "2026-09-12T09:00:00.000Z"),
		});
		const older = await store.create().startRequest("Older");
		const newer = await store.create().startRequest("Newer");
		await fs.writeFile(
			path.join(root, "conversations", ".leftover.tmp"),
			"partial",
		);

		const result = await store.list();

		expect(result.invalidFileCount).toBe(0);
		expect(result.conversations.map(({ id }) => id)).toEqual([
			newer.id,
			older.id,
		]);
	});

	it("skips malformed, mismatched, unsupported, and invalid state files", async () => {
		const { root, store } = await createStore();
		const valid = await store.create().startRequest("Valid");
		const directory = path.join(root, "conversations");
		const invalidFiles = new Map([
			["111111111111.json", "{"],
			["222222222222.json", JSON.stringify({ ...valid, id: "333333333333" })],
			[
				"444444444444.json",
				JSON.stringify({
					...valid,
					id: "444444444444",
					schemaVersion: 2,
				}),
			],
			[
				"555555555555.json",
				JSON.stringify({ ...valid, id: "555555555555", revision: 0 }),
			],
			[
				"666666666666.json",
				JSON.stringify({
					...valid,
					id: "666666666666",
					input: [null, 42],
				}),
			],
			[
				"777777777777.json",
				JSON.stringify({ ...valid, id: "777777777777", input: [{}] }),
			],
			[
				"888888888888.json",
				JSON.stringify({
					...valid,
					id: "888888888888",
					input: [{ type: "bogus" }],
				}),
			],
			[
				"999999999999.json",
				JSON.stringify({
					...valid,
					id: "999999999999",
					input: [{ role: "user" }],
				}),
			],
			[
				"aaaaaaaaaaaa.json",
				JSON.stringify({
					...valid,
					id: "aaaaaaaaaaaa",
					input: [{ type: "function_call" }],
				}),
			],
			[
				"bbbbbbbbbbbb.json",
				JSON.stringify({
					...valid,
					id: "bbbbbbbbbbbb",
					input: [
						{
							type: "message",
							id: "message-1",
							status: "completed",
							role: "assistant",
							content: [{}],
						},
					],
				}),
			],
			[
				"cccccccccccc.json",
				JSON.stringify({
					...valid,
					id: "cccccccccccc",
					input: [
						{
							type: "message",
							id: "message-1",
							status: "completed",
							role: "assistant",
							content: [{ type: "output_text", annotations: [] }],
						},
					],
				}),
			],
			[
				"dddddddddddd.json",
				JSON.stringify({
					...valid,
					id: "dddddddddddd",
					input: [
						{
							type: "reasoning",
							id: "reasoning-1",
							summary: [],
							content: [{}],
						},
					],
				}),
			],
			[
				"eeeeeeeeeeee.json",
				JSON.stringify({
					...valid,
					id: "eeeeeeeeeeee",
					input: [
						{
							type: "function_call_output",
							call_id: "call-1",
							output: [{}],
						},
					],
				}),
			],
		]);
		await Promise.all(
			Array.from(invalidFiles, ([filename, contents]) =>
				fs.writeFile(path.join(directory, filename), contents),
			),
		);

		const result = await store.list();

		expect(result).toEqual({
			conversations: [{ ...valid }],
			invalidFileCount: 13,
		});
		for (const [filename, contents] of invalidFiles) {
			expect(await fs.readFile(path.join(directory, filename), "utf8")).toBe(
				contents,
			);
		}
	});

	it("creates and tightens storage permissions", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const directory = path.join(root, "conversations");
		await fs.mkdir(directory, { mode: 0o777 });
		await fs.chmod(directory, 0o777);
		const store = await ConversationStore.open(root);
		const saved = await store.create().startRequest("Sensitive request");
		const statePath = path.join(directory, `${saved.id}.json`);
		await fs.chmod(statePath, 0o666);

		const reopenedStore = await ConversationStore.open(root);
		await reopenedStore.load(saved.id);

		expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
	});

	it("rejects a conversation directory symlink without changing its target", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		const external = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-external-"),
		);
		roots.push(root, external);
		await fs.chmod(external, 0o755);
		await fs.symlink(external, path.join(root, "conversations"));

		await expect(ConversationStore.open(root)).rejects.toThrow(
			"Conversation storage path must be a directory",
		);
		expect((await fs.stat(external)).mode & 0o777).toBe(0o755);
	});

	it("rejects a conversation file symlink without changing its target", async () => {
		const { root, store } = await createStore();
		const saved = await store.create().startRequest("Sensitive request");
		const statePath = path.join(root, "conversations", `${saved.id}.json`);
		const externalPath = path.join(root, "external.json");
		const contents = await fs.readFile(statePath, "utf8");
		await fs.rm(statePath);
		await fs.writeFile(externalPath, contents, { mode: 0o644 });
		await fs.chmod(externalPath, 0o644);
		await fs.symlink(externalPath, statePath);

		await expect(store.load(saved.id)).rejects.toThrow(
			"Conversation state path must be a regular file",
		);
		expect(await store.list()).toEqual({
			conversations: [],
			invalidFileCount: 1,
		});
		expect((await fs.stat(externalPath)).mode & 0o777).toBe(0o644);
	});

	it("advances updatedAt on every mutation when the clock has not moved", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const store = await ConversationStore.open(root, {
			now: () => new Date("2026-09-12T08:00:00.000Z"),
		});
		const conversation = store.create();
		const created = conversation.updatedAt;

		await conversation.startRequest("Inspect");
		const pending = conversation.updatedAt;
		await conversation.markToolStarted({ callId: "call-1", name: "read" });

		expect([created, pending, conversation.updatedAt]).toEqual([
			"2026-09-12T08:00:00.000Z",
			"2026-09-12T08:00:00.001Z",
			"2026-09-12T08:00:00.002Z",
		]);
		expect(conversation.pendingRequest?.startedAt).toBe(pending);
	});

	it("rejects an invalid generated conversation ID", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-conversations-"),
		);
		roots.push(root);
		const store = await ConversationStore.open(root, {
			createId: () => "../outside",
		});

		expect(() => store.create()).toThrow("Invalid generated conversation ID");
	});

	it("rejects a mutated conversation ID before writing", async () => {
		const { root, store } = await createStore();
		const conversation = store.create();
		conversation.id = "../outside";

		await expect(conversation.startRequest("Inspect")).rejects.toThrow(
			"Invalid conversation ID",
		);
		await expect(
			fs.stat(path.join(root, "outside.json")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("counts an unreadable state file without changing its permissions", async () => {
		const { root, store } = await createStore();
		const saved = await store.create().startRequest("Sensitive request");
		const statePath = path.join(root, "conversations", `${saved.id}.json`);
		await fs.chmod(statePath, 0o000);

		const result = await store.list();

		expect(result).toEqual({ conversations: [], invalidFileCount: 1 });
		expect((await fs.stat(statePath)).mode & 0o777).toBe(0o000);
	});

	it("keeps conversation state files out of Git", async () => {
		const { stdout } = await execFileAsync(
			"git",
			["check-ignore", "conversations/example.json"],
			{ cwd: process.cwd() },
		);

		expect(stdout.trim()).toBe("conversations/example.json");
	});

	it("rejects invalid state before it can replace a valid checkpoint", async () => {
		const { store } = await createStore();
		const conversation = store.create();
		await conversation.startRequest("Valid request");
		const saved = await store.load(conversation.id);
		conversation.title = "";

		await expect(conversation.commitCheckpoint([], "gpt-test")).rejects.toThrow(
			"Invalid conversation state",
		);

		expect(await store.load(conversation.id)).toEqual(saved);
	});

	it("loads a completed checkpoint when pendingRequest is absent", async () => {
		const { root, store } = await createStore();
		const committed = store.create();
		await committed.startRequest("Complete");
		await committed.commitCheckpoint([], "gpt-test");
		const statePath = path.join(root, "conversations", `${committed.id}.json`);
		const withoutPending = JSON.parse(
			await fs.readFile(statePath, "utf8"),
		) as Record<string, unknown>;
		delete withoutPending.pendingRequest;
		await fs.writeFile(statePath, JSON.stringify(withoutPending));

		const loaded = await store.load(committed.id);

		expect(loaded.pendingRequest).toBeNull();
		expect(loaded.input).toEqual([]);
	});
});
