# Local Journal Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a loopback-only React viewer that lists local journals, presents schema-v1 events as a structured timeline, and keeps malformed or unsupported data inspectable.

**Architecture:** Vite serves the React client and a thin development-server middleware. Filesystem access stays in `viewer/server.ts`; platform-neutral parsing, ordering, filtering, and grouping stay in `viewer/src/journal.ts`; `App.tsx` owns the small application's state and three-region interface.

**Tech Stack:** TypeScript 7, React 19, Vite 8, Vitest 4, Node.js filesystem APIs, Biome.

**Spec:** `docs/superpowers/specs/2026-09-10-journal-viewer-design.md`

## Global Constraints

- Bind the viewer only to `127.0.0.1`.
- Keep journal access read-only and restricted to direct `logs/*.jsonl` children.
- Interpret only `schemaVersion: 1`; unknown versions remain raw and carry a warning.
- Keep prompts, model payloads, tool arguments, and tool output out of collapsed rows.
- Add no router, state library, component library, service layer, separate workspace package, external font, image, or remote asset.
- Do not change `src/journal.ts`, `src/agent.ts`, `src/tools.ts`, or the journal schema.

---

### Task 1: Journal interpretation

**Files:**
- Create: `viewer/src/journal.test.ts`
- Create: `viewer/src/journal.ts`

**Interfaces:**
- Produces: `parseJournal(text: string): ParsedJournal`
- Produces: `sortItems(items: JournalItem[], order: SortOrder): JournalItem[]`
- Produces: `filterItems(items: JournalItem[], eventType: string, requestNumber: number | null): JournalItem[]`
- Produces: `groupTimeline(items: JournalItem[], order: SortOrder): TimelineGroup[]`
- Produces: `getItemTimestamp(item: JournalItem): string | null`

- [ ] **Step 1: Write parser compatibility tests**

```ts
import { describe, expect, it } from "vitest";
import { parseJournal } from "./journal.js";

const event = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  sequence: 1,
  timestamp: "2026-09-10T10:00:00.000Z",
  type: "cli_started",
  runId: "run-1",
  data: {},
  ...overrides,
});

it("preserves valid events around malformed lines", () => {
  const parsed = parseJournal([
    "not-json",
    JSON.stringify(event()),
    "{broken",
    JSON.stringify(event({ sequence: 2, type: "cli_finished" })),
    "still-not-json",
  ].join("\n"));

  expect(parsed.items.map((item) => item.kind)).toEqual([
    "malformed", "event", "malformed", "event", "malformed",
  ]);
  expect(parsed.items.filter((item) => item.kind === "malformed").map((item) => item.lineNumber)).toEqual([1, 3, 5]);
  expect(parsed.complete).toBe(false);
});

it("keeps unsupported schema versions raw", () => {
  const parsed = parseJournal(JSON.stringify(event({ schemaVersion: 2 })));
  expect(parsed.items[0]).toMatchObject({ kind: "unsupported", schemaVersion: 2 });
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `pnpm exec vitest run viewer/src/journal.test.ts`

Expected: FAIL because `viewer/src/journal.ts` does not exist.

- [ ] **Step 3: Implement line parsing and completion detection**

Create discriminated `event`, `unsupported`, and `malformed` item types. Ignore empty lines; retain complete parsed values; attach one-based source line numbers. Set `complete` only when the final non-empty item is a valid schema-v1 `cli_finished` event.

- [ ] **Step 4: Add ordering and filtering tests**

```ts
it("orders timestamps with sequence as tie breaker without mutating input", () => {
  const parsed = parseJournal([
    JSON.stringify(event({ sequence: 2, timestamp: "2026-09-10T11:00:00.000Z" })),
    JSON.stringify(event({ sequence: 1, timestamp: "2026-09-10T11:00:00.000Z" })),
  ].join("\n"));
  const original = [...parsed.items];
  expect(sortItems(parsed.items, "timestamp-asc").map((item) => item.sequence)).toEqual([1, 2]);
  expect(parsed.items).toEqual(original);
});

it("filters by event type and request number", () => {
  const items = parseJournal([
    JSON.stringify(event({ type: "model_request", requestNumber: 1, stepNumber: 1 })),
    JSON.stringify(event({ sequence: 2, type: "tool_started", requestNumber: 2, stepNumber: 1, callId: "call-1" })),
  ].join("\n")).items;
  expect(filterItems(items, "tool_started", 2)).toHaveLength(1);
});
```

- [ ] **Step 5: Run ordering/filter tests and verify RED**

Run: `pnpm exec vitest run viewer/src/journal.test.ts`

Expected: FAIL because ordering and filtering functions are missing.

- [ ] **Step 6: Implement stable ordering and filters**

Use copied arrays. `sequence` order is ascending; timestamp orders compare parsed timestamp milliseconds and then sequence. Filters preserve malformed and unsupported diagnostics only when no structured field excludes them.

- [ ] **Step 7: Add grouping tests**

```ts
it("groups requests, steps, and matching tool call events", () => {
  const items = parseJournal([
    JSON.stringify(event({ type: "user_request_started", requestNumber: 1 })),
    JSON.stringify(event({ sequence: 2, type: "model_request", requestNumber: 1, stepNumber: 1 })),
    JSON.stringify(event({ sequence: 3, type: "tool_started", requestNumber: 1, stepNumber: 1, callId: "call-1" })),
    JSON.stringify(event({ sequence: 4, type: "tool_finished", requestNumber: 1, stepNumber: 1, callId: "call-1" })),
  ].join("\n")).items;
  const groups = groupTimeline(items, "sequence");
  expect(groups[0]).toMatchObject({ kind: "request", requestNumber: 1 });
  expect(groups[0].steps[0].calls[0]).toMatchObject({ callId: "call-1" });
  expect(groups[0].steps[0].calls[0].items).toHaveLength(2);
});
```

- [ ] **Step 8: Run grouping test and verify RED**

Run: `pnpm exec vitest run viewer/src/journal.test.ts`

Expected: FAIL because `groupTimeline` is missing.

- [ ] **Step 9: Implement hierarchy grouping**

Keep run-level items separate. Group request events by `requestNumber`, step events by `stepNumber`, and tool events by `callId`; order each container from the earliest applicable key for ascending orders and latest applicable key for descending timestamp order.

- [ ] **Step 10: Run journal tests and verify GREEN**

Run: `pnpm exec vitest run viewer/src/journal.test.ts`

Expected: PASS.

### Task 2: Read-only journal server

**Files:**
- Create: `viewer/server.test.ts`
- Create: `viewer/server.ts`

**Interfaces:**
- Consumes: `parseJournal(text: string): ParsedJournal`
- Produces: `listJournals(projectRoot: string): Promise<JournalSummary[]>`
- Produces: `readJournal(projectRoot: string, name: string): Promise<string>`
- Produces: `resolveJournalPath(projectRoot: string, name: string): string`

- [ ] **Step 1: Write path-boundary tests**

```ts
it.each([
  "../secret.jsonl",
  "/tmp/secret.jsonl",
  "nested/run.jsonl",
  "nested\\run.jsonl",
  "run.json",
  "",
])("rejects unsafe journal name %j", (name) => {
  expect(() => resolveJournalPath(projectRoot, name)).toThrow("Invalid journal name");
});

it("accepts a direct JSONL filename", () => {
  expect(resolveJournalPath(projectRoot, "2026-09-10T10-00-00.000Z-12.jsonl"))
    .toBe(path.join(projectRoot, "logs", "2026-09-10T10-00-00.000Z-12.jsonl"));
});
```

- [ ] **Step 2: Run server tests and verify RED**

Run: `pnpm exec vitest run viewer/server.test.ts`

Expected: FAIL because `viewer/server.ts` does not exist.

- [ ] **Step 3: Implement journal-name validation and resolved-path containment**

Reject absolute names, `.`/`..`, `/` and `\\`, and names not ending in `.jsonl`. Resolve against `<projectRoot>/logs` and verify the result's parent is exactly the resolved logs directory.

- [ ] **Step 4: Write listing and read tests with a temporary project root**

```ts
it("returns an empty list when logs are absent", async () => {
  await expect(listJournals(projectRoot)).resolves.toEqual([]);
});

it("lists journals newest first with metadata", async () => {
  await fs.mkdir(path.join(projectRoot, "logs"));
  await fs.writeFile(path.join(projectRoot, "logs", "2026-09-10T10-00-00.000Z-1.jsonl"), completeJournal);
  await fs.writeFile(path.join(projectRoot, "logs", "2026-09-10T11-00-00.000Z-2.jsonl"), incompleteJournal);
  const journals = await listJournals(projectRoot);
  expect(journals.map((journal) => [journal.name, journal.status])).toEqual([
    ["2026-09-10T11-00-00.000Z-2.jsonl", "incomplete"],
    ["2026-09-10T10-00-00.000Z-1.jsonl", "complete"],
  ]);
});

it("reports a removed journal", async () => {
  await expect(readJournal(projectRoot, "missing.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
});
```

- [ ] **Step 5: Run listing/read tests and verify RED**

Run: `pnpm exec vitest run viewer/server.test.ts`

Expected: FAIL because listing and reading functions are missing.

- [ ] **Step 6: Implement listing, timestamp fallbacks, status, and raw reads**

Read direct directory entries only. Ignore non-files and non-JSONL names. Derive start time from first valid event, then standard filename, then `mtime`; sort descending by start time. Return raw UTF-8 text unchanged from `readJournal`.

- [ ] **Step 7: Run server tests and verify GREEN**

Run: `pnpm exec vitest run viewer/server.test.ts`

Expected: PASS.

### Task 3: Vite application shell and API adapter

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `viewer/index.html`
- Create: `viewer/src/main.tsx`

**Interfaces:**
- Consumes: `listJournals(process.cwd())` and `readJournal(process.cwd(), name)`
- Produces: `GET /api/journals` JSON and `GET /api/journals/:name` plain JSONL

- [ ] **Step 1: Add root dependencies and scripts**

Run: `pnpm add react react-dom && pnpm add -D vite @vitejs/plugin-react vitest @types/react @types/react-dom`

Add scripts: `"viewer": "vite"`, `"test": "vitest run"`, and keep existing scripts unchanged.

- [ ] **Step 2: Configure TypeScript and React entry files**

Set `jsx` to `react-jsx` and include DOM libraries without weakening strict checks. Mount `<App />` into `#root` with `createRoot`.

- [ ] **Step 3: Add loopback-only Vite config and API middleware**

Use `root: "viewer"`, `server.host: "127.0.0.1"`, React plugin, and a custom `configureServer` middleware. Return JSON errors with status `400` for invalid names, `404` for missing journals, and `500` for other failures. Reject unsupported methods with `405` and never add write routes.

- [ ] **Step 4: Run typecheck**

Run: `pnpm exec tsc --noEmit`

Expected: PASS for shell, server, and journal modules.

### Task 4: Three-region React viewer

**Files:**
- Create: `viewer/src/App.tsx`
- Create: `viewer/src/styles.css`

**Interfaces:**
- Consumes: `/api/journals`, `/api/journals/:name`, and journal helpers from `journal.ts`
- Produces: accessible journal list, timeline, event details, sorting/filtering controls, Refresh, Copy JSON, and Copy call ID

- [ ] **Step 1: Implement state and data loading in `App.tsx`**

Keep state local: summaries, selected name, raw journal, selected item, sort order, event/request filters, loading state, API error, and clipboard status. On initial load select newest. Refresh the list and reload the previous selection only when it still exists; otherwise show `Journal no longer exists`.

- [ ] **Step 2: Render journal list and timeline hierarchy**

Use buttons for selectable rows. Collapsed text contains only event type, local time, request/step number, tool name, status, phase, and stop reason. Render run groups, request groups, steps, and paired call groups from `groupTimeline`.

- [ ] **Step 3: Render details and resilient actions**

Pretty-print the complete selected event or raw unsupported value. For malformed lines show line number, parse error, and original text. Show local and UTC timestamps. Clipboard failures update an inline status and do not clear selection.

- [ ] **Step 4: Implement industrial visual system**

Use CSS custom properties, local sans/monospace stacks, a charcoal/ink background, amber recorder accent, restrained green/red/blue statuses, crisp one-pixel borders, dense spacing, visible `:focus-visible`, horizontal overflow below desktop width, and a reduced-motion media query.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`

Expected: PASS.

### Task 5: End-to-end verification

**Files:**
- Modify only if verification finds a defect in files above.

**Interfaces:**
- Verifies all acceptance criteria from the approved spec.

- [ ] **Step 1: Run automated verification**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`

Expected: all commands exit 0 with no errors.

- [ ] **Step 2: Start viewer and verify loopback/API behavior**

Run: `pnpm viewer -- --strictPort`

Confirm the printed address is `http://127.0.0.1:<port>/`, `/api/journals` lists the real journals, selected raw text matches the source file, traversal/non-JSONL URLs return `400`, and a missing safe filename returns `404`.

- [ ] **Step 3: Verify UI against real and disposable fixtures**

Use one real complete journal plus temporary incomplete, malformed, and unsupported-version files under `logs/`. Confirm default selection, manual selection, Refresh, hierarchy, all sort/filter modes, details, timestamps, copy success/failure messaging, focus states, narrow-window horizontal access, and empty/error states. Remove only the disposable fixtures created for this check.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Confirm no core journal/agent files changed, no generated files or credentials are present, and implementation matches the approved design.
