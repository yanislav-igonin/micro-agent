import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeError } from "./journal.js";

const execAsync = promisify(exec);

const ROOT = process.cwd();

function resolveInsideRoot(relativePath: string) {
	const fullPath = path.resolve(ROOT, relativePath);

	if (fullPath !== ROOT && !fullPath.startsWith(ROOT + path.sep)) {
		throw new Error("Path is outside project root");
	}

	return fullPath;
}

async function read(args: { path: string }) {
	const fullPath = resolveInsideRoot(args.path);

	return fs.readFile(fullPath, "utf8");
}

async function write(args: { path: string; content: string }) {
	const fullPath = resolveInsideRoot(args.path);

	return fs.writeFile(fullPath, args.content);
}

async function edit(args: { path: string; content: string }) {
	const fullPath = resolveInsideRoot(args.path);

	return fs.appendFile(fullPath, args.content);
}

async function run(args: { command: string }) {
	const { stdout, stderr } = await execAsync(args.command, {
		cwd: ROOT,
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	return JSON.stringify({ stdout, stderr });
}

export const tools = [
	{
		type: "function" as const,
		name: "read",
		description: "Read the contents of a text file in the current project",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path relative to project root",
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

export type ToolResult =
	| { status: "ok"; output: string }
	| {
			status: "error";
			output: string;
			error: ReturnType<typeof normalizeError>;
	  };

export async function executeTool(
	name: string,
	args: unknown,
): Promise<ToolResult> {
	try {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw new Error("Tool arguments must be an object");
		}
		let output: string | undefined;
		switch (name) {
			case "read":
			case "write":
			case "edit": {
				if (!("path" in args) || typeof args.path !== "string") {
					throw new Error("Tool argument path must be a string");
				}
				if (name === "read") {
					output = await read({ path: args.path });
				} else {
					if (!("content" in args) || typeof args.content !== "string") {
						throw new Error("Tool argument content must be a string");
					}
					const fileArgs = { path: args.path, content: args.content };
					if (name === "write") await write(fileArgs);
					else await edit(fileArgs);
				}
				break;
			}
			case "run":
				if (!("command" in args) || typeof args.command !== "string") {
					throw new Error("Tool argument command must be a string");
				}
				output = await run({ command: args.command });
				break;
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
		return { status: "ok", output: output ?? "OK" };
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
		return { status: "error", output, error: normalized };
	}
}
