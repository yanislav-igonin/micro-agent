import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import type { Journal } from "./journal.js";

function journalWith(
	record: (...args: unknown[]) => unknown,
	finish: (...args: unknown[]) => unknown = vi.fn(),
) {
	return {
		record: async (...args: unknown[]) => await record(...args),
		finish: async (data: unknown) => await finish(data),
	} as unknown as Journal;
}

describe("runCli", () => {
	it("finishes the journal when Ctrl-C interrupts the active question", async () => {
		const record = vi.fn();
		const finish = vi.fn();
		const prompt = Object.assign(new EventEmitter(), {
			question: vi.fn(() => new Promise<string>(() => {})),
			close: vi.fn(),
		});

		const resultPromise = runCli(prompt, journalWith(record, finish));
		prompt.emit("SIGINT");
		const result = await resultPromise;

		expect(result).toEqual({ interrupted: true });
		expect(prompt.close).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledWith({ requestCount: 0 });
	});

	it("keeps exit as a normal journal completion", async () => {
		const record = vi.fn();
		const finish = vi.fn();
		const prompt = Object.assign(new EventEmitter(), {
			question: vi.fn().mockResolvedValue("exit"),
			close: vi.fn(),
		});

		const result = await runCli(prompt, journalWith(record, finish));

		expect(result).toEqual({ interrupted: false });
		expect(prompt.close).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledWith({ requestCount: 0 });
	});

	it("awaits a sealed finish when process SIGINT interrupts a request", async () => {
		let persistFinish = () => {};
		const finish = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					persistFinish = resolve;
				}),
		);
		const record = vi.fn();
		const prompt = Object.assign(new EventEmitter(), {
			question: vi.fn().mockResolvedValue("inspect repository"),
			close: vi.fn(),
		});
		const signals = new EventEmitter();
		const agent = vi.fn(() => new Promise<string>(() => {}));
		let settled = false;

		const resultPromise = runCli(
			prompt,
			journalWith(record, finish),
			agent,
			signals,
		).then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(agent).toHaveBeenCalledOnce());

		signals.emit("SIGINT");
		prompt.emit("SIGINT");
		await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());

		expect(settled).toBe(false);
		persistFinish();
		await expect(resultPromise).resolves.toEqual({ interrupted: true });
		expect(finish).toHaveBeenCalledOnce();
		expect(prompt.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGINT")).toBe(0);
	});

	it("does not mark an unexpected prompt failure as complete", async () => {
		const failure = new Error("stdin failed");
		const record = vi.fn();
		const finish = vi.fn();
		const prompt = Object.assign(new EventEmitter(), {
			question: vi.fn().mockRejectedValue(failure),
			close: vi.fn(),
		});

		await expect(runCli(prompt, journalWith(record, finish))).rejects.toBe(
			failure,
		);

		expect(prompt.close).toHaveBeenCalledOnce();
		expect(finish).not.toHaveBeenCalled();
	});
});
