import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createJournal } from "./journal.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});

describe("createJournal", () => {
	it("waits for queued writes and seals the journal with cli_finished", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "micro-agent-journal-"),
		);
		roots.push(root);
		const journal = await createJournal(true, root);

		const firstWrite = journal.record("cli_started", {});
		await journal.finish({ requestCount: 0 });
		await firstWrite;
		await journal.record("model_request", { ignored: true });

		const [filename] = await fs.readdir(path.join(root, "logs"));
		const text = await fs.readFile(
			path.join(root, "logs", filename ?? ""),
			"utf8",
		);
		const events = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(events.map((event) => event.type)).toEqual([
			"cli_started",
			"cli_finished",
		]);
	});
});
