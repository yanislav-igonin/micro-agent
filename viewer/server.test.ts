import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listJournals, readJournal, resolveJournalPath } from "./server.js";

function event(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		sequence: 1,
		timestamp: "2026-09-10T10:00:00.000Z",
		type: "cli_started",
		runId: "run-1",
		data: {},
		...overrides,
	};
}

describe("journal server", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "micro-agent-viewer-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it.each([
		"../secret.jsonl",
		"/tmp/secret.jsonl",
		"nested/run.jsonl",
		"nested\\run.jsonl",
		"run.json",
		"",
		".",
	])("rejects unsafe journal name %j", (name) => {
		expect(() => resolveJournalPath(projectRoot, name)).toThrow(
			"Invalid journal name",
		);
	});

	it("accepts a direct JSONL filename", () => {
		expect(
			resolveJournalPath(projectRoot, "2026-09-10T10-00-00.000Z-12.jsonl"),
		).toBe(path.join(projectRoot, "logs", "2026-09-10T10-00-00.000Z-12.jsonl"));
	});

	it("returns an empty list when logs are absent or empty", async () => {
		await expect(listJournals(projectRoot)).resolves.toEqual([]);
		await mkdir(path.join(projectRoot, "logs"));
		await expect(listJournals(projectRoot)).resolves.toEqual([]);
	});

	it("lists JSONL files newest first with size, event time, and status", async () => {
		const logs = path.join(projectRoot, "logs");
		await mkdir(logs);
		const completeText = [
			JSON.stringify(event()),
			JSON.stringify(event({ sequence: 2, type: "cli_finished" })),
		].join("\n");
		const incompleteText = JSON.stringify(
			event({ timestamp: "2026-09-10T11:00:00.000Z" }),
		);
		await writeFile(
			path.join(logs, "2026-09-10T10-00-00.000Z-1.jsonl"),
			completeText,
		);
		await writeFile(
			path.join(logs, "2026-09-10T11-00-00.000Z-2.jsonl"),
			incompleteText,
		);
		await writeFile(path.join(logs, "ignore.txt"), "ignored");
		await mkdir(path.join(logs, "nested.jsonl"));

		await expect(listJournals(projectRoot)).resolves.toEqual([
			{
				name: "2026-09-10T11-00-00.000Z-2.jsonl",
				size: Buffer.byteLength(incompleteText),
				startTimestamp: "2026-09-10T11:00:00.000Z",
				status: "incomplete",
			},
			{
				name: "2026-09-10T10-00-00.000Z-1.jsonl",
				size: Buffer.byteLength(completeText),
				startTimestamp: "2026-09-10T10:00:00.000Z",
				status: "complete",
			},
		]);
	});

	it("falls back from event time to filename time and then mtime", async () => {
		const logs = path.join(projectRoot, "logs");
		await mkdir(logs);
		const malformedName = "custom.jsonl";
		const malformedPath = path.join(logs, malformedName);
		await writeFile(
			path.join(logs, "2026-09-10T09-30-00.000Z-3.jsonl"),
			"not-json",
		);
		await writeFile(malformedPath, "still-not-json");
		const mtime = new Date("2026-09-10T08:00:00.000Z");
		await utimes(malformedPath, mtime, mtime);

		const journals = await listJournals(projectRoot);

		expect(journals).toMatchObject([
			{
				name: "2026-09-10T09-30-00.000Z-3.jsonl",
				startTimestamp: "2026-09-10T09:30:00.000Z",
			},
			{
				name: malformedName,
				startTimestamp: "2026-09-10T08:00:00.000Z",
			},
		]);
	});

	it("returns the original text and reports a removed journal", async () => {
		const logs = path.join(projectRoot, "logs");
		await mkdir(logs);
		const name = "run.jsonl";
		const text = '{"kept":true}\nmalformed\n';
		await writeFile(path.join(logs, name), text);

		await expect(readJournal(projectRoot, name)).resolves.toBe(text);
		await expect(
			readJournal(projectRoot, "missing.jsonl"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a journal symlink that points outside logs", async () => {
		const logs = path.join(projectRoot, "logs");
		await mkdir(logs);
		const secretPath = path.join(projectRoot, "secret.jsonl");
		await writeFile(secretPath, "must not escape");
		await symlink(secretPath, path.join(logs, "escape.jsonl"));

		await expect(readJournal(projectRoot, "escape.jsonl")).rejects.toThrow(
			"Invalid journal name",
		);
	});
});
