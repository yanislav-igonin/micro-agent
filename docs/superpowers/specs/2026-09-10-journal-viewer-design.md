# Local Journal Viewer Design

## Problem

Micro Agent records each CLI run as a structured JSONL journal, but the user must currently inspect those files with generic text and JSON tools. That makes it unnecessarily difficult to reconstruct user requests, model steps, tool calls, results, and stop reasons.

The journal viewer will provide a small local interface for retrospective inspection. It is a read-only diagnostic and learning tool, not a general logging platform.

## Goals

- List every journal in the project's `logs/` directory.
- Open the newest journal automatically and allow selecting another run.
- Present journal events as an understandable agent timeline while preserving the complete source data.
- Sort and filter events without changing their stored order.
- Keep incomplete, malformed, and unsupported journals diagnostically useful.
- Preserve the journal's local, sensitive-data boundary.
- Keep the implementation direct and easy to follow in this educational project.

## Non-goals

- Live tailing, polling, WebSockets, or monitoring an active run.
- Editing, deleting, rotating, uploading, or otherwise managing journals.
- Deployment, remote access, authentication, or multi-user operation.
- Streaming parsing, pagination, or list virtualization.
- Full-text search or advanced filtering by step, tool, status, or call ID.
- Changing the journal schema or the core agent loop.
- Supporting unknown schema versions with inferred semantics.
- React component tests, browser automation, or visual regression tests.

## Architecture

The viewer lives in a `viewer/` directory inside the existing repository and uses the root package and TypeScript configuration. It is not a separate workspace package.

The `pnpm viewer` command starts Vite on `127.0.0.1`. A small Vite plugin delegates journal access to a Node-only module and exposes two read-only endpoints:

- `GET /api/journals` returns each journal's filename, byte size, start timestamp, and `complete` or `incomplete` status. Start time comes from the first valid event timestamp, falling back to the timestamp in the standard filename and then the file modification time.
- `GET /api/journals/:name` returns the selected journal as its original JSONL text.

The server reads only `.jsonl` files directly inside `<project>/logs/`. It rejects absolute paths, traversal segments, nested paths, non-JSONL names, and any resolved path outside that directory. It never writes to the filesystem. Vite binds only to the loopback interface.

The React client fetches the journal list, selects the newest journal, loads the selected file in full, and parses JSONL in the browser. Loading a complete file is intentionally accepted for the first version; current journals are small, and no arbitrary size limit is introduced without evidence for an appropriate threshold.

Journal interpretation lives in one small platform-neutral module containing the event types, line parser, sorting, filtering, and timeline grouping. The server can reuse it when deriving list metadata, and the browser uses it for the selected journal. This is a concrete testing boundary. The main application remains in one component instead of introducing a component hierarchy for each event type.

## Journal interpretation

`schemaVersion: 1` receives structured interpretation. Every valid line retains its complete parsed value for the detail panel.

The parser produces a diagnostic item for a malformed line. The item includes the one-based line number, the parse error, and the original line, while later valid lines remain visible.

An unknown `schemaVersion` remains visible as raw JSON with an unsupported-version warning. The viewer does not guess how to interpret its fields.

A journal is complete only when its final non-empty valid record is `cli_finished`. Any other ending, including a malformed final line, is incomplete. Incompleteness is a warning, not a reason to reject the journal.

Stored `sequence` is the canonical causal order. Timestamp sorting uses the original timestamp values and uses `sequence` as a deterministic tie-breaker.

## Interface

The viewer is a desktop-first, three-region interface with a dark industrial flight-recorder aesthetic. It uses local font stacks and has no external visual or network dependencies.

### Journal list

The left region lists journals newest first. Each row shows local start time, filename, byte size, and a textual `complete` or `incomplete` status. Status is never communicated by color alone.

The newest journal is selected when the viewer starts. A manual Refresh action reloads the list and then reloads the selected journal if it still exists. If it no longer exists, the viewer explains that condition and keeps the refreshed list usable.

### Timeline

The center region shows:

1. run-level `cli_*` events;
2. groups for each `requestNumber`;
3. model steps inside each request;
4. tool start and finish events associated by `callId` inside their model step.

Collapsed rows show only diagnostic metadata: event type, local time, request number, step number, tool name, status, phase, and stop reason when those fields apply. Prompts, arguments, model payloads, and tool outputs do not appear in collapsed rows.

The default order is ascending `sequence`. Controls allow timestamp ascending or descending order and filtering by event type and request number. Structural nesting remains intact under every order: request groups, model steps, and events are ordered by their earliest applicable value when ascending and latest applicable value when descending. `sequence` breaks timestamp ties. Sorting and filtering affect only the presentation; they do not mutate parsed data.

### Event details

The right region shows the selected event as pretty-printed JSON. It includes the original UTC ISO timestamp alongside the locally formatted time and provides Copy JSON. Events with a `callId` also provide Copy call ID.

Malformed lines show their raw text and parse error in the same region. Unsupported versions show their raw parsed JSON and warning.

### Visual and accessibility rules

- A restrained status palette distinguishes successful, failed, incomplete, and unsupported states.
- Text labels and icons accompany color-coded states.
- Interactive rows and controls have visible keyboard focus.
- Dense monospace presentation is used for diagnostic values without sacrificing readable labels and spacing.
- Motion is limited to short state transitions and respects reduced-motion preferences.
- Mobile-specific layouts are outside scope, but narrow windows must not hide access to any region.

## Error handling

- Missing or empty `logs/`: show a normal empty state.
- Journal removed after listing: show `Journal no longer exists` and retain navigation.
- Read or API failure: show an explicit error without crashing the entire viewer.
- Malformed JSONL line: show a line-level diagnostic and all other valid events.
- Missing `cli_finished`: mark the journal incomplete and keep it inspectable.
- Unknown schema version: warn and show raw JSON.
- Clipboard failure: keep the event selected and report that copying failed.

## Expected implementation shape

- `vite.config.ts`: Vite configuration and thin API route adapter.
- `viewer/server.ts`: filesystem listing, metadata extraction, name/path validation, and journal reads.
- `viewer/index.html`: Vite HTML entry point.
- `viewer/src/main.tsx`: React mount point.
- `viewer/src/App.tsx`: viewer state, requests, controls, and layout.
- `viewer/src/journal.ts`: schema-v1 interpretation, diagnostics, sorting, filtering, and grouping.
- `viewer/src/styles.css`: visual system and responsive overflow behavior.
- `viewer/server.test.ts`: filesystem boundary and traversal tests.
- `viewer/src/journal.test.ts`: parser, compatibility, sorting, filtering, and grouping tests.

The Node server boundary and browser journal boundary justify two focused modules. Beyond those boundaries, related behavior stays together; no router, state library, UI kit, service layer, or dependency-injection framework is introduced.

The root package adds React, React DOM, Vite, the React Vite plugin, their TypeScript types, and Vitest. The root TypeScript configuration gains the DOM and JSX settings needed by the viewer. Vitest uses explicit imports and the Vite TypeScript pipeline; React Testing Library and a DOM test environment are unnecessary.

## Verification

Automated unit tests cover:

- valid schema-v1 lines;
- malformed lines before, between, and after valid events;
- incomplete journals;
- unsupported schema versions;
- stable sequence and timestamp ordering;
- event-type and request-number filtering;
- request, step, and call-ID grouping;
- accepted journal filenames and rejected traversal, absolute, nested, and non-JSONL paths;
- missing files and an empty logs directory.

Manual verification uses a real complete journal plus disposable incomplete, malformed, and unsupported-version fixtures. It confirms journal selection, refresh behavior, timeline grouping, sorting, filters, JSON details, clipboard actions, readable local and UTC timestamps, keyboard focus, and all empty/error states.

Before completion, the implementation must pass `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm lint`.

## Acceptance criteria

1. `pnpm viewer` starts the local viewer without starting the agent and binds only to `127.0.0.1`.
2. The viewer lists `logs/*.jsonl` newest first with time, filename, size, and completion status.
3. The newest journal opens automatically; another journal can be selected and Refresh behaves as specified.
4. Schema-v1 events appear in the agreed run, request, model-step, and tool-call hierarchy.
5. Sequence order, timestamp sorting, event-type filtering, and request filtering work without mutating source data.
6. Selecting an event reveals its complete JSON, local and UTC timestamps, and applicable copy actions.
7. Incomplete journals, malformed lines, unknown versions, missing files, and read failures remain understandable and do not crash the viewer.
8. API path validation prevents reading anything outside the project journal directory.
9. The viewer introduces no writes, live monitoring, remote access, or changes to the journal producer and agent loop.
10. Automated and manual verification described above succeeds.
