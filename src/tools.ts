import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const ROOT = process.cwd();

function resolveInsideRoot(relativePath: string) {
  const fullPath = path.resolve(ROOT, relativePath);

  if (
    fullPath !== ROOT &&
    !fullPath.startsWith(ROOT + path.sep)
  ) {
    throw new Error("Path is outside project root");
  }

  return fullPath;
}

async function read(args: { path: string }) {
  const fullPath = resolveInsideRoot(args.path);

  return fs.readFile(fullPath, "utf8");
}

async function write(args: { path: string, content: string }) {
  const fullPath = resolveInsideRoot(args.path);

  return fs.writeFile(fullPath, args.content);
}

async function edit(args: { path: string, content: string }) {
  const fullPath = resolveInsideRoot(args.path);

  return fs.appendFile(fullPath, args.content);
}

async function run(args: { command: string }) {
  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: ROOT,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    return JSON.stringify({
      stdout,
      stderr,
    });
  } catch (error: any) {
    return JSON.stringify({
      error: error.message,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    });
  }
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
    description:
      "Execute a shell command",
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

export async function executeTool(
  name: string,
  args: unknown,
): Promise<string | void> {
  try {
    switch (name) {
      case "read":
        return await read(
          args as { path: string },
        );

      case "write":
        return await write(
          args as { path: string, content: string },
        );

      case "edit":
        return await edit(
          args as { path: string, content: string },
        );

      case "run":
        return await run(
          args as { command: string },
        );

      default:
        return `ERROR: Unknown tool: ${name}`;
    }
  } catch (error: any) {
    return `ERROR: ${error.message}`;
  }
}