# Bounded Tool Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every tool result before it enters Model Input, preserve the complete captured result in the Journal, add deterministic ranged file reads, and add safe exact text replacement for PRI-294.

**Architecture:** Keep tool execution and output shaping together in `src/tools.ts`. Every execution returns one raw `output` for the Journal and one bounded `modelOutput` for `function_call_output`; `src/agent.ts` routes them without adding another service or storage layer. Ranged reads and exact replacement remain ordinary tool implementations behind the existing direct dispatch switch.

**Tech Stack:** TypeScript 7, Node.js `fs/promises` and `child_process`, OpenAI Responses API types, Vitest 5, Biome, pnpm 12.3.4.

**Spec:** `docs/superpowers/specs/2026-09-14-context-management-design.md`

## Global Constraints

- Work only on Linear issue PRI-294 in shared branch `codex/pri-82-context-management`; do not create another branch.
- Keep production changes in `src/tools.ts` and `src/agent.ts`; create only `src/tools.test.ts` for the missing direct tool tests.
- Preserve the current direct tool-dispatch switch and existing project-root path protection.
- Count output limits in Unicode code points, not UTF-16 code units.
- `read` content allowance is 200 distinct lines and 20,000 code points per call.
- Generic model-visible output allowance is 20,000 code points: first 10,000 plus last 10,000 when truncated.
- Metadata headers and omission markers do not reduce content allowances.
- Journal `tool_finished.data.output` remains the complete captured raw output; Conversation Input receives only `modelOutput`.
- With `--no-log` or a failed Journal, omitted raw content is not recoverable elsewhere.
- Add no dependencies, repository index, retrieval system, compaction code, Context Budget code, fuzzy replacement, or placeholder abstraction.
- Use TDD for each behavior change and keep each commit independently passing its focused tests.

---

### Task 1: Separate Raw and Model-visible Tool Output

**Files:**
- Create: `src/tools.test.ts`
- Modify: `src/tools.ts:1-150`
- Modify: `src/agent.ts:5-178`
- Modify: `src/agent.test.ts:1-362`

**Interfaces:**
- Consumes: existing `executeTool(name: string, args: unknown): Promise<ToolResult>` and `Journal.record()`.
- Produces: `ToolOutputTruncation`, `ToolResult.output`, `ToolResult.modelOutput`, `ToolResult.truncation`, and `createToolErrorResult(output, error)`.
- Invariant: `output` is raw Journal data; only `modelOutput` may enter a `function_call_output` item.

- [x] **Step 1: Add failing pure output-boundary tests**

Create `src/tools.test.ts` with direct tests for exact small output, Unicode code-point counting, and head/tail truncation:

```ts
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
    expect(Array.from(result.modelOutput.match(/😀/gu) ?? [])).toHaveLength(20_000);
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
```

- [x] **Step 2: Add a failing agent routing test**

The existing hoisted `responses.create` mock already suffices. Add this case to `src/agent.test.ts`:

```ts
it("journals raw tool output but sends only bounded output to the model", async () => {
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `process.stdout.write("a".repeat(10001) + "z".repeat(10000))`,
  )}`;
  const call = {
    type: "function_call" as const,
    name: "run",
    arguments: JSON.stringify({ command }),
    call_id: "call-large-run",
  };
  const records: Array<{ type: string; data: unknown; context: unknown }> = [];
  let secondRequestInput: unknown[] = [];
  openai.create
    .mockResolvedValueOnce({ output: [call], output_text: "" })
    .mockImplementationOnce(async (request) => {
      secondRequestInput = structuredClone(request.input);
      return {
        output: [assistantMessage("message-done", "done")],
        output_text: "done",
      };
    });

  await createAgent()("run it", journalWith(records), 1, {
    onToolStarted: async () => {},
    onToolFinished: async () => {},
  });

  const finished = records.find(({ type }) => type === "tool_finished");
  const data = finished?.data as {
    output: string;
    modelOutput: string;
    truncation: { truncated: boolean; omittedCharacters: number };
  };
  const sent = secondRequestInput.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "function_call_output",
  ) as { output: string };

  expect(data.output.length).toBeGreaterThan(20_000);
  expect(data.truncation.truncated).toBe(true);
  expect(sent.output).toBe(data.modelOutput);
  expect(sent.output).not.toBe(data.output);
});
```

- [x] **Step 3: Run the focused tests and verify the red state**

Run:

```bash
pnpm test src/tools.test.ts src/agent.test.ts
```

Expected: `src/tools.test.ts` fails because `prepareBoundedOutput` is missing; the new agent assertion fails because `ToolResult` has only raw `output` and the model receives it unchanged.

- [x] **Step 4: Add the explicit result envelope and generic bounder**

In `src/tools.ts`, add these constants and types near the existing `ROOT` constant:

```ts
const MODEL_OUTPUT_CHARACTERS = 20_000;
const MODEL_OUTPUT_EDGE_CHARACTERS = 10_000;

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
```

Implement the pure preparation functions in the same file:

```ts
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
```

Make each private tool return `PreparedToolOutput`. At this stage `read` and `run` use generic bounding; Task 2 replaces only the `read` preparation:

```ts
async function read(args: { path: string }) {
  const fullPath = resolveInsideRoot(args.path);
  return prepareBoundedOutput(await fs.readFile(fullPath, "utf8"));
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

async function run(args: { command: string }) {
  const { stdout, stderr } = await execAsync(args.command, {
    cwd: ROOT,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return prepareBoundedOutput(JSON.stringify({ stdout, stderr }));
}
```

Replace the old `ToolResult` declaration with:

```ts
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
```

In `executeTool`, carry a `PreparedToolOutput` through the existing switch and return the prepared representations together:

```ts
let prepared: PreparedToolOutput;
switch (name) {
  case "read": {
    if (!("path" in args) || typeof args.path !== "string") {
      throw new Error("Tool argument path must be a string");
    }
    prepared = await read({ path: args.path });
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
```

In its catch block, preserve the existing stdout/stderr error envelope and pass that raw string through the same generic bounder:

```ts
const normalized = normalizeError(error);
const fields = error && typeof error === "object" ? error : {};
const output =
  "stdout" in fields || "stderr" in fields
    ? `ERROR: ${JSON.stringify({
        error: normalized.message,
        stdout: "stdout" in fields ? fields.stdout : "",
        stderr: "stderr" in fields ? fields.stderr : "",
      })}`
    : `ERROR: ${normalized.message}`;
return createToolErrorResult(output, error);
```

- [x] **Step 5: Route raw and bounded fields in the agent loop**

Update the import in `src/agent.ts`:

```ts
import {
  createToolErrorResult,
  executeTool,
  type ToolResult,
  tools,
} from "./tools.js";
```

For malformed JSON, replace the hand-built result with:

```ts
result = createToolErrorResult("ERROR: Invalid tool arguments", error);
```

Keep journaling `{ name, arguments, phase, ...result }`, so `output` is complete and `truncation` explains `modelOutput`. Change both `function_call_output` insertions to:

```ts
input.push({
  type: "function_call_output",
  call_id: call.call_id,
  output: result.modelOutput,
});
```

- [x] **Step 6: Run focused tests and verify green state**

Run:

```bash
pnpm test src/tools.test.ts src/agent.test.ts
```

Expected: all focused tests pass; existing checkpoint and tool-callback tests remain green.

- [x] **Step 7: Commit the result-envelope boundary**

```bash
git add src/tools.ts src/tools.test.ts src/agent.ts src/agent.test.ts
git commit -m "feat(tools): bound model-visible output"
```

---

### Task 2: Add Deterministic Ranged Reads

**Files:**
- Modify: `src/tools.test.ts`
- Modify: `src/tools.ts`
- Modify: `src/agent.test.ts`

**Interfaces:**
- Consumes: `PreparedToolOutput`, `ToolOutputTruncation`, existing `resolveInsideRoot()`.
- Produces: `read({ path, startLine?, startColumn? })` with one-based coordinates and an exact continuation header.
- Coordinate contract: newline belongs to the preceding line at `lineLength + 1`; a file ending in newline has no extra empty logical line.

- [x] **Step 1: Add failing read-range tests**

Replace the existing tools import in `src/tools.test.ts` and add a file helper:

```ts
import { executeTool, prepareBoundedOutput, tools } from "./tools.js";

async function projectFile(content: string) {
  const path = `.tools-test-${process.pid}-${artifacts.length}.txt`;
  artifacts.push(path);
  await fs.writeFile(path, content);
  return path;
}
```

Add these cases:

```ts
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
    const firstContent = first.modelOutput.slice(first.modelOutput.indexOf("\n") + 1);
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
    const firstContent = first.modelOutput.slice(first.modelOutput.indexOf("\n") + 1);
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
});
```

- [x] **Step 2: Assert the read schema exposes optional coordinates**

Add this schema check to `src/tools.test.ts` using the combined `tools` import from Step 1:

```ts
it("publishes strict optional read coordinates", () => {
  const readTool = tools.find((tool) => tool.name === "read");

  expect(readTool?.parameters).toMatchObject({
    required: ["path"],
    additionalProperties: false,
    properties: {
      startLine: { type: "integer", minimum: 1 },
      startColumn: { type: "integer", minimum: 1 },
    },
  });
});
```

- [x] **Step 3: Run read tests and verify the red state**

Run:

```bash
pnpm test src/tools.test.ts
```

Expected: range headers and continuation tests fail; current `read` ignores coordinates and uses generic head/tail output.

- [x] **Step 4: Implement line/column paging in `src/tools.ts`**

Add constants and coordinate helpers:

```ts
const READ_LINES = 200;
const READ_CHARACTERS = 20_000;

interface ReadPosition {
  line: number;
  column: number;
}

function readCoordinate(
  args: object,
  name: "startLine" | "startColumn",
) {
  const value = name in args ? args[name] : undefined;
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`Tool argument ${name} must be a positive integer`);
  }
  return value as number;
}

function formatPosition(position: ReadPosition | undefined) {
  return position ? `${position.line}:${position.column}` : "none";
}
```

Implement a single `prepareReadOutput()` function. Keep the full suffix from the requested coordinate in `output`; put only the page plus its header in `modelOutput`:

```ts
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
      characters[nextLineStart - 1] === "\n" ? nextLineStart - 1 : nextLineStart;
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
```

Replace private `read` with:

```ts
async function read(args: {
  path: string;
  startLine: number;
  startColumn: number;
}) {
  const fullPath = resolveInsideRoot(args.path);
  const text = await fs.readFile(fullPath, "utf8");
  return prepareReadOutput(args.path, text, args.startLine, args.startColumn);
}
```

In the `read` dispatch case, validate `path`, derive both coordinates through `readCoordinate`, and pass all three fields to `read`:

```ts
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
```

- [x] **Step 5: Extend the strict tool schema**

Add these optional properties under the existing `read.parameters.properties` object:

```ts
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
```

Also change the tool description to `Read a bounded range of a text file in the current project; follow next coordinates when truncated`. Keep `required: ["path"]`, `strict: true`, and `additionalProperties: false`.

- [x] **Step 6: Update the existing restored-input expectation**

The existing `src/agent.test.ts` test `discards failed working input before the next user request` compares the old raw README content. Give it a controlled file fixture so the expected ranged result is derived by hand rather than by calling the code under test:

```ts
const artifact = `.checkpoint-read-${process.pid}.txt`;
artifacts.push(artifact);
await fs.writeFile(artifact, "known");
const call = {
  type: "function_call" as const,
  name: "read",
  arguments: JSON.stringify({ path: artifact }),
  call_id: "call-1",
};
const expectedReadOutput =
  `[read path=${JSON.stringify(artifact)} from=1:1 through=1:5 ` +
  `total_lines=1 truncated=false next=none out_of_range=false]\nknown`;

expect(seenInputs[1]).toEqual([
  ...restoredInput,
  { role: "user", content: "failed request" },
  call,
  {
    type: "function_call_output",
    call_id: "call-1",
    output: expectedReadOutput,
  },
]);
```

Keep the literal independent from `prepareReadOutput`; dedicated tool tests cover the same header for other fixtures.

- [x] **Step 7: Run focused tests and verify green state**

Run:

```bash
pnpm test src/tools.test.ts src/agent.test.ts
```

Expected: all range, long-line, schema, agent-loop, and existing checkpoint tests pass.

- [x] **Step 8: Commit deterministic reads**

```bash
git add src/tools.ts src/tools.test.ts src/agent.test.ts
git commit -m "feat(tools): add ranged file reads"
```

---

### Task 3: Add Exact Single-match Replacement

**Files:**
- Modify: `src/tools.test.ts`
- Modify: `src/tools.ts`

**Interfaces:**
- Consumes: `resolveInsideRoot()`, `exactOutput()`, existing direct dispatch switch.
- Produces: `replace({ path: string, oldText: string, newText: string })`.
- Mutation contract: validation and match-count failures leave the file unchanged; a successful call writes the complete replacement once and returns `OK`.

- [x] **Step 1: Add failing replacement tests**

Add to `src/tools.test.ts`:

```ts
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
    expect(await fs.readFile(path, "utf8")).toBe(
      "before replacement after",
    );
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
```

- [x] **Step 2: Run replacement tests and verify red state**

Run:

```bash
pnpm test src/tools.test.ts
```

Expected: failures report `Unknown tool: replace` and the schema lookup returns `undefined`.

- [x] **Step 3: Implement exact replacement**

Add beside the existing file tools in `src/tools.ts`:

```ts
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
```

Searching for the second occurrence from `firstMatch + 1` intentionally detects overlapping matches such as `aa` inside `aaa`.

- [x] **Step 4: Add strict schema and dispatch validation**

Add one tool definition next to `write` and `edit`:

```ts
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
```

Add a direct dispatch case that validates all three strings and calls `replace`. Do not introduce a registry or generic schema validator:

```ts
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
```

- [x] **Step 5: Teach the model the safe edit rule**

Extend `SYSTEM_PROMPT` in `src/agent.ts` after the capability list:

```text
Large file reads are ranged. Follow the returned next coordinates when more
content is needed. Prefer exact replace after a ranged read when a whole-file
write could erase content you have not inspected.
```

Add one assertion to the existing request-configuration test in `src/agent.test.ts`:

```ts
expect(seenRequest).toMatchObject({
  instructions: expect.stringContaining("Prefer exact replace"),
});
```

- [x] **Step 6: Run focused tests and verify green state**

Run:

```bash
pnpm test src/tools.test.ts src/agent.test.ts
```

Expected: exact replacement, overlapping-match rejection, schema, instructions, range, and routing tests all pass.

- [x] **Step 7: Commit exact replacement**

```bash
git add src/tools.ts src/tools.test.ts src/agent.ts src/agent.test.ts
git commit -m "feat(tools): add exact text replacement"
```

---

### Task 4: Document and Verify PRI-294 End to End

**Files:**
- Modify: `README.md:31-55`
- Verify: `src/tools.ts`, `src/tools.test.ts`, `src/agent.ts`, `src/agent.test.ts`

**Interfaces:**
- Consumes: completed PRI-294 behavior from Tasks 1-3.
- Produces: user-facing documentation and fresh full-suite verification evidence.

- [x] **Step 1: Update Journal and tool-output documentation**

Replace the README sentence claiming full results merely “stay in the journal” with an explicit two-representation contract. Add this paragraph after the description of `tool_finished`:

```markdown
Each tool execution has two output representations. `tool_finished.data.output`
keeps the complete captured result for diagnosis, while
`tool_finished.data.modelOutput` is the bounded representation appended to model
input and saved in conversation checkpoints. Truncation metadata records the
strategy and exact shown and omitted character counts. With `--no-log`, omitted
raw content is not recoverable.

`read` returns at most 200 lines and 20,000 Unicode characters. Its header reports
one-based line/column coordinates and an exact `next` position. `run` keeps small
results exact; large model-visible results contain the first and last 10,000
characters around an omission marker. `replace` edits a file only when its literal
`oldText` occurs exactly once.
```

Keep the existing security warning that Journals may contain file contents, commands, and outputs.

- [x] **Step 2: Run the complete automated verification**

Run each command separately and require exit code 0:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

Expected baseline: at least the existing 76 tests plus the new PRI-294 tests pass; TypeScript reports no errors; Biome reports no errors; Git reports no whitespace errors.

- [x] **Step 3: Inspect the implementation diff against scope**

Run:

```bash
git diff --stat HEAD~3
git diff HEAD~3 -- src/tools.ts src/agent.ts README.md
git status --short
```

Verify manually from the diff:

- no new production module or dependency;
- no Context Budget or compaction code;
- raw `output` goes only to Journal data;
- `modelOutput` is the only tool result appended to Responses input;
- every `read` continuation coordinate advances;
- replacement validation completes before `fs.writeFile`;
- only the shared PRI-82 branch is active.

- [x] **Step 4: Commit the documentation**

```bash
git add README.md
git commit -m "docs: explain bounded tool output"
```

- [x] **Step 5: Re-run post-commit verification**

Run:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git status --short --branch
```

Expected: all tests pass, typecheck and lint exit 0, and the branch has no uncommitted changes.

- [x] **Step 6: Update Linear only after verification**

Use Linear MCP, not the browser:

1. Change PRI-294 with `linear_save_issue` using `state: "Done"` or the resolved Done state ID.
2. Read PRI-294 with `linear_get_issue` and verify `status` plus `stateHistory` moved to Done.
3. Leave PRI-295 and PRI-296 in Backlog; PRI-295 becomes unblocked by the completed PRI-294 relation.

Do not create a PR or MR unless the user explicitly requests one.
