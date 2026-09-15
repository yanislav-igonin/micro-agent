import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { executeTool, prepareBoundedOutput, tools } from "./tools.js";

const artifacts: string[] = [];

async function projectFile(content: string) {
	const path = `.tools-test-${process.pid}-${artifacts.length}.txt`;
	artifacts.push(path);
	await fs.writeFile(path, content);
	return path;
}

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

describe("read", () => {
	it("returns a small file with exact range metadata", async () => {
		const path = await projectFile("alpha\nbeta");

		const result = await executeTool("read", { path });

		expect(result.status).toBe("ok");
		expect(result.output).toBe("alpha\nbeta");
		expect(result.modelOutput).toBe(
			`[read path=${JSON.stringify(path)} from=1:1 through=2:4 total_lines=2 ` +
				`truncated=false next=none out_of_range=false]\nalpha\nbeta`,
		);
		expect(result.truncation).toEqual({
			strategy: "range",
			truncated: false,
			originalCharacters: 10,
			shownCharacters: 10,
			omittedCharacters: 0,
		});
	});

	it("continues after 200 lines without gaps or overlaps", async () => {
		const content = "x\n".repeat(205);
		const path = await projectFile(content);

		const first = await executeTool("read", { path });
		const second = await executeTool("read", {
			path,
			startLine: 201,
			startColumn: 1,
		});

		expect(first.modelOutput).toContain(
			"from=1:1 through=200:2 total_lines=205 truncated=true next=201:1",
		);
		expect(second.modelOutput).toContain(
			"from=201:1 through=205:2 total_lines=205 truncated=false next=none",
		);
		const firstContent = first.modelOutput.slice(
			first.modelOutput.indexOf("\n") + 1,
		);
		const secondContent = second.modelOutput.slice(
			second.modelOutput.indexOf("\n") + 1,
		);
		expect(firstContent + secondContent).toBe(content);
	});

	it("continues inside one line longer than 20,000 characters", async () => {
		const content = "😀".repeat(20_005);
		const path = await projectFile(content);

		const first = await executeTool("read", { path });
		const second = await executeTool("read", {
			path,
			startLine: 1,
			startColumn: 20_001,
		});

		expect(first.modelOutput).toContain(
			"from=1:1 through=1:20000 total_lines=1 truncated=true next=1:20001",
		);
		expect(second.modelOutput).toContain(
			"from=1:20001 through=1:20005 total_lines=1 truncated=false next=none",
		);
		const firstContent = first.modelOutput.slice(
			first.modelOutput.indexOf("\n") + 1,
		);
		const secondContent = second.modelOutput.slice(
			second.modelOutput.indexOf("\n") + 1,
		);
		expect(firstContent + secondContent).toBe(content);
	});

	it("marks empty and out-of-range reads explicitly", async () => {
		const emptyPath = await projectFile("");
		const twoLinePath = await projectFile("one\ntwo");

		const empty = await executeTool("read", { path: emptyPath });
		const pastEnd = await executeTool("read", {
			path: twoLinePath,
			startLine: 4,
		});

		expect(empty.modelOutput).toContain(
			"through=none total_lines=0 truncated=false next=none out_of_range=false",
		);
		expect(pastEnd.modelOutput).toContain(
			"through=none total_lines=2 truncated=false next=none out_of_range=true",
		);
	});

	it.each([
		{ startLine: 0 },
		{ startLine: 1.5 },
		{ startColumn: 0 },
		{ startColumn: "2" },
	])("rejects invalid coordinates: %j", async (coordinates) => {
		const path = await projectFile("text");

		const result = await executeTool("read", { path, ...coordinates });

		expect(result.status).toBe("error");
		expect(result.output).toContain("must be a positive integer");
	});

	it("publishes strict optional read coordinates", () => {
		const readTool = tools.find((tool) => tool.name === "read");

		expect(readTool?.parameters).toMatchObject({
			required: ["path", "startLine", "startColumn"],
			additionalProperties: false,
			properties: {
				startLine: { type: ["integer", "null"], minimum: 1 },
				startColumn: { type: ["integer", "null"], minimum: 1 },
			},
		});
	});

	it("treats nullable read coordinates as defaults", async () => {
		const path = await projectFile("alpha\nbeta");

		const result = await executeTool("read", {
			path,
			startLine: null,
			startColumn: null,
		});

		expect(result.status).toBe("ok");
		expect(result.modelOutput).toContain("from=1:1 through=2:4");
	});
});

it("lists every strict tool property as required", () => {
	for (const tool of tools) {
		if (!tool.strict) continue;
		expect(new Set(tool.parameters.required)).toEqual(
			new Set(Object.keys(tool.parameters.properties)),
		);
	}
});

describe("replace", () => {
	it("replaces one exact match", async () => {
		const path = await projectFile("before target after");

		const result = await executeTool("replace", {
			path,
			oldText: "target",
			newText: "replacement",
		});

		expect(result).toMatchObject({
			status: "ok",
			output: "OK",
			modelOutput: "OK",
		});
		expect(await fs.readFile(path, "utf8")).toBe("before replacement after");
	});

	it.each([
		{ content: "unchanged", oldText: "missing", message: "not found" },
		{ content: "same same", oldText: "same", message: "multiple matches" },
		{ content: "aaa", oldText: "aa", message: "multiple matches" },
		{ content: "unchanged", oldText: "", message: "must not be empty" },
	])(
		"rejects an unsafe target: $message",
		async ({ content, oldText, message }) => {
			const path = await projectFile(content);

			const result = await executeTool("replace", {
				path,
				oldText,
				newText: "changed",
			});

			expect(result.status).toBe("error");
			expect(result.output).toContain(message);
			expect(await fs.readFile(path, "utf8")).toBe(content);
		},
	);

	it("keeps project-root protection", async () => {
		const result = await executeTool("replace", {
			path: "../outside.txt",
			oldText: "old",
			newText: "new",
		});

		expect(result.status).toBe("error");
		expect(result.output).toContain("Path is outside project root");
	});

	it("publishes one strict replace schema", () => {
		const replaceTool = tools.find((tool) => tool.name === "replace");

		expect(replaceTool).toMatchObject({
			type: "function",
			strict: true,
			parameters: {
				required: ["path", "oldText", "newText"],
				additionalProperties: false,
			},
		});
	});
});
