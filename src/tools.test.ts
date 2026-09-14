import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { prepareBoundedOutput } from "./tools.js";

const artifacts: string[] = [];

afterEach(async () => {
	await Promise.all(
		artifacts.splice(0).map((artifact) => fs.rm(artifact, { force: true })),
	);
});

describe("prepareBoundedOutput", () => {
	it("keeps small output byte-for-byte", () => {
		expect(prepareBoundedOutput("small\noutput")).toEqual({
			output: "small\noutput",
			modelOutput: "small\noutput",
			truncation: {
				strategy: "none",
				truncated: false,
				originalCharacters: 12,
				shownCharacters: 12,
				omittedCharacters: 0,
			},
		});
	});

	it("counts Unicode code points instead of UTF-16 units", () => {
		const result = prepareBoundedOutput("😀".repeat(20_001));

		expect(result.truncation).toEqual({
			strategy: "head_tail",
			truncated: true,
			originalCharacters: 20_001,
			shownCharacters: 20_000,
			omittedCharacters: 1,
		});
		expect(result.modelOutput).toContain("[... omitted 1 chars ...]");
		expect(Array.from(result.modelOutput.match(/😀/gu) ?? [])).toHaveLength(
			20_000,
		);
	});

	it("keeps the first and last 10,000 characters", () => {
		const result = prepareBoundedOutput(
			`${"a".repeat(10_001)}${"z".repeat(10_000)}`,
		);

		expect(result.modelOutput).toBe(
			`[tool_output original_chars=20001 shown_chars=20000 omitted_chars=1 truncated=true]\n${"a".repeat(10_000)}\n[... omitted 1 chars ...]\n${"z".repeat(10_000)}`,
		);
	});
});
