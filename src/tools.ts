import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeError } from "./journal.js";

const execAsync = promisify(exec);

const ROOT = process.cwd();
const MODEL_OUTPUT_CHARACTERS = 20_000;
const MODEL_OUTPUT_EDGE_CHARACTERS = 10_000;
const READ_LINES = 200;
const READ_CHARACTERS = 20_000;

interface ReadPosition {
	line: number;
	column: number;
}

export interface ToolOutputTruncation {
	strategy: "none" | "head_tail" | "range";
	truncated: boolean;
	originalCharacters: number;
	shownCharacters: number;
	omittedCharacters: number;
}

interface PreparedToolOutput {
	output: string;
	modelOutput: string;
	truncation: ToolOutputTruncation;
}

function exactOutput(output: string): PreparedToolOutput {
	const characters = Array.from(output).length;
	return {
		output,
		modelOutput: output,
		truncation: {
			strategy: "none",
			truncated: false,
			originalCharacters: characters,
			shownCharacters: characters,
			omittedCharacters: 0,
		},
	};
}

export function prepareBoundedOutput(output: string): PreparedToolOutput {
	const characters = Array.from(output);
	if (characters.length <= MODEL_OUTPUT_CHARACTERS) return exactOutput(output);

	const omittedCharacters =
		characters.length - MODEL_OUTPUT_EDGE_CHARACTERS * 2;
	const head = characters.slice(0, MODEL_OUTPUT_EDGE_CHARACTERS).join("");
	const tail = characters.slice(-MODEL_OUTPUT_EDGE_CHARACTERS).join("");
	const modelOutput =
		`[tool_output original_chars=${characters.length} shown_chars=20000 ` +
		`omitted_chars=${omittedCharacters} truncated=true]\n` +
		`${head}\n[... omitted ${omittedCharacters} chars ...]\n${tail}`;

	return {
		output,
		modelOutput,
		truncation: {
			strategy: "head_tail",
			truncated: true,
			originalCharacters: characters.length,
			shownCharacters: MODEL_OUTPUT_CHARACTERS,
			omittedCharacters,
		},
	};
}

function readCoordinate(args: object, name: "startLine" | "startColumn") {
	const value = (args as Record<string, unknown>)[name];
	if (value === undefined) return 1;
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`Tool argument ${name} must be a positive integer`);
	}
	return value as number;
}

function formatPosition(position: ReadPosition | undefined) {
	return position ? `${position.line}:${position.column}` : "none";
}

function prepareReadOutput(
	path: string,
	text: string,
	startLine: number,
	startColumn: number,
): PreparedToolOutput {
	const characters = Array.from(text);
	const lineStarts: number[] = [];
	if (characters.length > 0) lineStarts.push(0);
	for (let index = 0; index < characters.length; index++) {
		if (characters[index] === "\n" && index + 1 < characters.length) {
			lineStarts.push(index + 1);
		}
	}
	const totalLines = lineStarts.length;

	let outOfRange = false;
	let startOffset = characters.length;
	if (startLine <= totalLines) {
		const lineStart = lineStarts[startLine - 1] ?? characters.length;
		const nextLineStart = lineStarts[startLine] ?? characters.length;
		const contentEnd =
			characters[nextLineStart - 1] === "\n"
				? nextLineStart - 1
				: nextLineStart;
		const maximumColumn = contentEnd - lineStart + 1;
		if (startColumn <= maximumColumn) {
			startOffset = lineStart + startColumn - 1;
		} else {
			outOfRange = true;
		}
	} else if (!(startLine === totalLines + 1 && startColumn === 1)) {
		outOfRange = true;
	}

	const positionAt = (offset: number): ReadPosition | undefined => {
		if (offset < 0 || offset >= characters.length) return undefined;
		let lineIndex = 0;
		while (
			lineIndex + 1 < lineStarts.length &&
			(lineStarts[lineIndex + 1] ?? characters.length) <= offset
		) {
			lineIndex++;
		}
		return {
			line: lineIndex + 1,
			column: offset - (lineStarts[lineIndex] ?? 0) + 1,
		};
	};

	if (outOfRange) {
		const header =
			`[read path=${JSON.stringify(path)} from=${startLine}:${startColumn} ` +
			`through=none total_lines=${totalLines} truncated=false next=none ` +
			`out_of_range=true]`;
		return {
			output: "",
			modelOutput: header,
			truncation: {
				strategy: "range",
				truncated: false,
				originalCharacters: 0,
				shownCharacters: 0,
				omittedCharacters: 0,
			},
		};
	}

	const lastAllowedLine = Math.min(totalLines, startLine + READ_LINES - 1);
	const lineLimit =
		lastAllowedLine < totalLines
			? (lineStarts[lastAllowedLine] ?? characters.length)
			: characters.length;
	const endOffset = Math.min(
		startOffset + READ_CHARACTERS,
		lineLimit,
		characters.length,
	);
	const output = characters.slice(startOffset).join("");
	const page = characters.slice(startOffset, endOffset).join("");
	const truncated = endOffset < characters.length;
	const through =
		endOffset > startOffset ? positionAt(endOffset - 1) : undefined;
	const next = truncated ? positionAt(endOffset) : undefined;
	const shownCharacters = endOffset - startOffset;
	const originalCharacters = characters.length - startOffset;
	const header =
		`[read path=${JSON.stringify(path)} from=${startLine}:${startColumn} ` +
		`through=${formatPosition(through)} total_lines=${totalLines} ` +
		`truncated=${truncated} next=${formatPosition(next)} out_of_range=false]`;

	return {
		output,
		modelOutput: page ? `${header}\n${page}` : header,
		truncation: {
			strategy: "range",
			truncated,
			originalCharacters,
			shownCharacters,
			omittedCharacters: originalCharacters - shownCharacters,
		},
	};
}

function resolveInsideRoot(relativePath: string) {
	const fullPath = path.resolve(ROOT, relativePath);

	if (fullPath !== ROOT && !fullPath.startsWith(ROOT + path.sep)) {
		throw new Error("Path is outside project root");
	}

	return fullPath;
}

async function read(args: {
	path: string;
	startLine: number;
	startColumn: number;
}) {
	const fullPath = resolveInsideRoot(args.path);
	const text = await fs.readFile(fullPath, "utf8");
	return prepareReadOutput(args.path, text, args.startLine, args.startColumn);
}

async function write(args: { path: string; content: string }) {
	const fullPath = resolveInsideRoot(args.path);

	await fs.writeFile(fullPath, args.content);
	return exactOutput("OK");
}

async function edit(args: { path: string; content: string }) {
	const fullPath = resolveInsideRoot(args.path);

	await fs.appendFile(fullPath, args.content);
	return exactOutput("OK");
}

async function replace(args: {
	path: string;
	oldText: string;
	newText: string;
}) {
	if (args.oldText.length === 0) {
		throw new Error("Tool argument oldText must not be empty");
	}

	const fullPath = resolveInsideRoot(args.path);
	const content = await fs.readFile(fullPath, "utf8");
	const firstMatch = content.indexOf(args.oldText);
	if (firstMatch === -1) {
		throw new Error("Exact replacement target not found");
	}
	if (content.indexOf(args.oldText, firstMatch + 1) !== -1) {
		throw new Error("Exact replacement target has multiple matches");
	}

	const nextContent =
		content.slice(0, firstMatch) +
		args.newText +
		content.slice(firstMatch + args.oldText.length);
	await fs.writeFile(fullPath, nextContent, "utf8");
	return exactOutput("OK");
}

async function run(args: { command: string }) {
	const { stdout, stderr } = await execAsync(args.command, {
		cwd: ROOT,
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	return prepareBoundedOutput(JSON.stringify({ stdout, stderr }));
}

export const tools = [
	{
		type: "function" as const,
		name: "read",
		description:
			"Read a bounded range of a text file in the current project; follow next coordinates when truncated",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path relative to project root",
				},
				startLine: {
					type: "integer",
					minimum: 1,
					description: "One-based line to start reading; defaults to 1",
				},
				startColumn: {
					type: "integer",
					minimum: 1,
					description:
						"One-based Unicode code-point column within startLine; defaults to 1",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		strict: true,
	},

	{
		type: "function" as const,
		name: "write",
		description: "Write to a text file in the current project",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path relative to project root",
				},
				content: {
					type: "string",
					description: "Content to write to the file",
				},
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		strict: true,
	},

	{
		type: "function" as const,
		name: "edit",
		description: "Append to a text file in the current project",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path relative to project root",
				},
				content: {
					type: "string",
					description: "Content to append to the file",
				},
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		strict: true,
	},

	{
		type: "function" as const,
		name: "replace",
		description:
			"Replace exactly one literal text match in a file without changing unread content",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path relative to project root",
				},
				oldText: {
					type: "string",
					description: "Exact literal text that must occur once",
				},
				newText: {
					type: "string",
					description: "Replacement text",
				},
			},
			required: ["path", "oldText", "newText"],
			additionalProperties: false,
		},
		strict: true,
	},

	{
		type: "function" as const,
		name: "run",
		description: "Execute a shell command",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command to execute",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		strict: true,
	},
];

export type ToolResult = PreparedToolOutput &
	(
		| { status: "ok" }
		| {
				status: "error";
				error: ReturnType<typeof normalizeError>;
		  }
	);

export function createToolErrorResult(
	output: string,
	error: unknown,
): ToolResult {
	return {
		status: "error",
		...prepareBoundedOutput(output),
		error: normalizeError(error),
	};
}

export async function executeTool(
	name: string,
	args: unknown,
): Promise<ToolResult> {
	try {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw new Error("Tool arguments must be an object");
		}
		let prepared: PreparedToolOutput;
		switch (name) {
			case "read": {
				if (!("path" in args) || typeof args.path !== "string") {
					throw new Error("Tool argument path must be a string");
				}
				prepared = await read({
					path: args.path,
					startLine: readCoordinate(args, "startLine"),
					startColumn: readCoordinate(args, "startColumn"),
				});
				break;
			}
			case "write":
			case "edit": {
				if (!("path" in args) || typeof args.path !== "string") {
					throw new Error("Tool argument path must be a string");
				}
				if (!("content" in args) || typeof args.content !== "string") {
					throw new Error("Tool argument content must be a string");
				}
				const fileArgs = { path: args.path, content: args.content };
				prepared =
					name === "write" ? await write(fileArgs) : await edit(fileArgs);
				break;
			}
			case "replace": {
				if (!("path" in args) || typeof args.path !== "string") {
					throw new Error("Tool argument path must be a string");
				}
				if (!("oldText" in args) || typeof args.oldText !== "string") {
					throw new Error("Tool argument oldText must be a string");
				}
				if (!("newText" in args) || typeof args.newText !== "string") {
					throw new Error("Tool argument newText must be a string");
				}
				prepared = await replace({
					path: args.path,
					oldText: args.oldText,
					newText: args.newText,
				});
				break;
			}
			case "run": {
				if (!("command" in args) || typeof args.command !== "string") {
					throw new Error("Tool argument command must be a string");
				}
				prepared = await run({ command: args.command });
				break;
			}
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
		return { status: "ok", ...prepared };
	} catch (error) {
		const normalized = normalizeError(error);
		const fields = error && typeof error === "object" ? error : {};
		// A failed shell command still has useful stdout/stderr; keep both in full.
		const output =
			"stdout" in fields || "stderr" in fields
				? `ERROR: ${JSON.stringify({
						error: normalized.message,
						stdout: "stdout" in fields ? fields.stdout : "",
						stderr: "stderr" in fields ? fields.stderr : "",
					})}`
				: `ERROR: ${normalized.message}`;
		return createToolErrorResult(output, error);
	}
}
