// src/tools.ts

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

async function readFile(args: { path: string }) {
  const fullPath = resolveInsideRoot(args.path);

  return fs.readFile(fullPath, "utf8");
}

async function writeFile(args: { path: string, content: string }) {
  const fullPath = resolveInsideRoot(args.path);

  return fs.writeFile(fullPath, args.content);
}

async function appendFile(args: { path: string, content: string }) {
  const fullPath = resolveInsideRoot(args.path);

  return fs.appendFile(fullPath, args.content);
}

async function listFiles(args: { path: string }) {
  const fullPath = resolveInsideRoot(args.path);

  const entries = await fs.readdir(fullPath, {
    withFileTypes: true,
  });

  return entries
    .map((entry) =>
      entry.isDirectory()
        ? `${entry.name}/`
        : entry.name,
    )
    .join("\n");
}

async function shell(args: { command: string }) {
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
    name: "read_file",
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
    name: "list_files",
    description: "List files and directories",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory relative to project root",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },

  {
    type: "function" as const,
    name: "write_file",
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
    name: "append_file",
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
    name: "shell",
    description:
      "Execute a shell command inside the current project directory",
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
      case "read_file":
        return await readFile(
          args as { path: string },
        );

      case "write_file":
        return await writeFile(
          args as { path: string, content: string },
        );

      case "append_file":
        return await appendFile(
          args as { path: string, content: string },
        );

      case "list_files":
        return await listFiles(
          args as { path: string },
        );

      case "shell":
        return await shell(
          args as { command: string },
        );

      default:
        return `ERROR: Unknown tool: ${name}`;
    }
  } catch (error: any) {
    return `ERROR: ${error.message}`;
  }
}