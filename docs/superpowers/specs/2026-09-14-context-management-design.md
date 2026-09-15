# Context Management Design

## Problem

Micro Agent currently replays the complete model-visible conversation on every model step. Each request also includes the current system instructions and tool definitions. This is correct, but conversation items and tool results grow without a bound. A large file read or command result can consume a substantial part of the next request, and the CLI neither shows context usage nor prevents a request that exceeds an application-defined safety limit.

Conversation checkpoints and journals already have different guarantees. The checkpoint is the exact model-visible input required for recovery. The journal is a detailed, optional, best-effort diagnostic record. Context management must preserve this separation: bounding what the model sees must not silently discard diagnostic data, and journal availability must not become a requirement for conversation recovery.

This design implements the decisions from [PRI-82](https://linear.app/mikes-private/issue/PRI-82/obsuzhdenie-36-upravlenie-kontekstom).

## Goals

- Bound every tool result before it enters model input or a conversation checkpoint.
- Let the model read large files in explicit, non-overlapping ranges.
- Preserve complete raw tool results in the journal when journaling is enabled and healthy.
- Make safe exact text replacement possible after ranged reads.
- Measure context with Responses API usage and exact token-count preflight near the configured boundary.
- Show the latest exact context measurement in the normal CLI prompt.
- Refuse model calls that exceed an explicit application Context Budget.
- Keep system instructions and tool definitions present exactly once in every model request.
- Define a safe future boundary and persistence contract for native Responses API compaction.
- Keep the implementation direct and readable in the existing modules.

## Non-goals

- Automatically compacting conversation history in the first implementation.
- Silently dropping old conversation items to fit a model context window.
- Using deprecated `truncation: "auto"`.
- Discovering a model context window through the Models API.
- Inventing a default Context Budget when none is configured.
- Adding a repository map, embeddings, vector search, RAG, or automatic file selection.
- Reconstructing full tool results from a conversation checkpoint.
- Making the journal required for agent execution or conversation restoration.
- Storing repeated copies of system instructions or tool definitions in Conversation State.
- Adding placeholder compaction branches, comments, interfaces, or modules before compaction is implemented.

## Domain model

Canonical terms live in `CONTEXT.md`.

- **Model Input** is the complete logical input for one Model Step: current instructions, current tool definitions, and selected conversation items.
- **Model-visible Tool Output** is the bounded representation appended as a `function_call_output` item.
- **Context Budget** is an optional application limit configured by the user. It is not an inferred model capability.
- **Conversation Checkpoint** stores only the exact model-visible input that is safe to restore.
- **Journal** may store full raw tool results and API responses for diagnosis, but never participates in recovery.
- **Compaction** replaces older Model Input with a smaller continuation-preserving representation without rewriting the Journal.

## Model input assembly

Every call to `responses.create()` contains exactly one current copy of:

1. the selected model;
2. `SYSTEM_PROMPT` as `instructions`;
3. the current tool definitions;
4. the working conversation input for the current Model Step.

Instructions and tools are request configuration, not conversation history. They are rebuilt for each request and are not appended to `ResponseInput` or persisted in Conversation State. Therefore they impose a stable base token cost but do not accumulate duplicate copies as the conversation grows.

Stable instructions, tool definitions, and ordering should remain at the beginning of the request so provider prompt caching can reuse the common prefix. Caching may reduce latency and cost, but cached tokens still belong to Model Input and still count toward the Context Budget.

Micro Agent continues manual stateless replay. Switching to `previous_response_id`, Conversations API storage, or a provider-owned session is outside this design because the local Conversation Checkpoint remains the recovery source.

## Bounded tool output

One tool execution produces two representations:

- **raw result**: complete stdout, stderr, file content, or error detail recorded in the Journal;
- **model-visible output**: bounded text appended to Model Input and later stored in the Conversation Checkpoint.

The bounding rule applies independently to every tool call, for successful and failed executions. One large result cannot consume another call's allowance. If journaling is disabled with `--no-log`, disabled after a write failure, or unavailable, any omitted raw tail is intentionally not recoverable.

Journal events retain the current `tool_started` and `tool_finished` lifecycle. `tool_finished` records the raw result plus enough truncation metadata to reproduce which bounded representation the model received. The `function_call_output` item contains only the bounded representation.

### `read`

The `read` tool accepts:

- `path`: required path relative to project root;
- `startLine`: optional one-based line number, default `1`.
- `startColumn`: optional one-based Unicode code-point column within `startLine`, default `1`.

One call returns at most 200 lines and at most 20,000 Unicode code points, stopping at the first limit reached. Ranges are contiguous: continuation coordinates identify the first omitted code point, so following them introduces neither gaps nor repeated content. `startColumn` greater than `1` is needed only when one line crosses the character boundary. Empty files, positions exactly at end of file, and positions beyond the end return explicit metadata rather than ambiguous blank output.

The model-visible result begins with a machine-readable single-line header:

~~~text
[read path="src/example.ts" from=1:1 through=200:42 total_lines=417 truncated=true next=201:1]
~~~

The selected content follows the header unchanged. When the character limit cuts a line, `next` points to the next one-based column on that same line. A later call supplies both coordinates, so even a single line longer than 20,000 characters makes forward progress without exceeding the allowance.

`truncated=false` means the call reached the end of the file. Metadata is part of the model-visible output but does not reduce the 20,000-character content allowance.

### `run`

The `run` tool continues executing with the existing timeout and process buffer. Its raw result preserves complete captured stdout and stderr in the Journal.

The model-visible payload has a 20,000-character content allowance:

- results at or below the allowance are returned unchanged;
- larger results include the first 10,000 and last 10,000 characters;
- an explicit marker between them reports the number of omitted characters;
- a header reports original size and `truncated=true`.

Metadata and omission markers do not reduce the payload allowance. Stdout, stderr, and command error information remain distinguishable in the serialized result. Failed commands use the same head/tail rule as successful commands.

### Other tools

`write`, append-style `edit`, and `replace` normally return short status text. The same 20,000-character safety ceiling still applies to any unexpected success or error output before it enters Model Input.

## Safe file editing

Ranged reads make a whole-file rewrite unsafe when the model has not inspected the omitted tail. The first implementation therefore adds a minimal `replace` tool:

~~~text
replace({ path, oldText, newText })
~~~

The operation resolves the path inside the project root and changes the file only when `oldText` occurs exactly once. Zero matches or multiple matches return an error and leave the file unchanged. Empty `oldText` is rejected. The tool performs no fuzzy matching, regular expressions, patch parsing, multi-file edits, or automatic retries.

The existing `write` and append-style `edit` tools remain available. System instructions teach the model to prefer ranged reads plus exact replacement when unread file content must be preserved.

## File selection

The model remains responsible for selecting files. It can use `run` with `rg`, directory commands, and ranged `read` calls. Restored tool outputs describe historical project state, so existing guidance to reread relevant files remains in force.

No repository indexing or retrieval subsystem is introduced. Evidence for adding one does not yet exist, and it would obscure the educationally useful direct loop.

## Context Budget configuration

`MICRO_AGENT_CONTEXT_BUDGET` optionally configures the maximum Model Input token count as a positive integer.

- When configured, Micro Agent can calculate percentage usage, warn near the boundary, run exact preflight, and block oversized requests.
- When absent, Micro Agent reports raw token counts received from API usage but shows no percentage and imposes no invented hard limit.
- An invalid value is a startup configuration error. The agent does not silently ignore it or substitute a default.

The budget is intentionally independent from the model's advertised context window. Model metadata available to the application does not provide a reliable context-window value, and deployments may want a smaller operational safety boundary.

## Measurement and preflight

The primary measurement is `response.usage.input_tokens` from each successful `responses.create()` call. This is the latest exact size of input that the model processed.

Micro Agent does not call the token-count endpoint before every request. Before each `responses.create()` it decides whether exact preflight is required:

1. Build the complete request using current instructions, current tools, and working conversation input.
2. If no Context Budget exists, send the request normally.
3. If no prior exact measurement exists, use a conservative local size check. If the request could be at or above 80% of the budget, call `responses.inputTokens.count()`.
4. If a prior exact measurement exists, combine it with a conservative upper bound for newly appended input. If that could reach 80%, call `responses.inputTokens.count()` with the complete request.
5. When uncertainty cannot be bounded safely, perform exact preflight.

The local estimate is only a gate for deciding whether to preflight. It is never displayed as an exact token count and never authorizes a request known to exceed the budget.

An exact count at or above 80% emits one warning for the current high-usage period. Usage below 80% is quiet. Dropping below 80% resets the warning so a later crossing can warn again.

An exact count above 100% blocks `responses.create()`. The stable Conversation Checkpoint remains unchanged, the current User Request remains incomplete under existing recovery semantics, and no automatic history truncation occurs. The CLI tells the user to start `/new`, raise `MICRO_AGENT_CONTEXT_BUDGET`, or wait for the future compaction capability.

If required preflight fails, Micro Agent does not guess and does not call the model. It records the error, preserves the stable checkpoint and pending-request state, and reports the failed request through the existing error path.

Bounded tool outputs make growth between exact measurements predictable enough for this two-stage strategy.

## CLI display

Context appears in the same line as the normal input prompt:

~~~text
agent>
agent [context 42,103]>
agent [context 42,103/100,000 · 42%]>
~~~

- Before any exact measurement, preserve `agent> `.
- Without a configured budget, show the latest exact raw token count.
- With a budget, show count, budget, and whole-number percentage.
- A newer exact preflight measurement replaces an older response usage measurement.
- The value describes the latest exactly measured Model Input, not an estimate of an unsent next request.

After future successful compaction, the next prompt adds a one-shot marker:

~~~text
agent [context 12,430/100,000 · 12% · compacted]>
~~~

The marker disappears after that prompt. No separate status line is printed during normal low-usage operation.

## Future native compaction

Automatic compaction is deliberately deferred until bounded outputs and budget measurement are working and observable. Its implementation task will use the native `openai.responses.compact()` API. It will not add a custom summarizer and will not enable automatic provider `context_management`.

Compaction is eligible only when a configured Context Budget exists and exact preflight reaches the 80% soft boundary. It runs explicitly before `responses.create()`. With no budget, Micro Agent does not invent a trigger.

### Safe boundary

Compaction may run only at a Model Step boundary:

- between User Requests; or
- inside an incomplete User Request after every emitted tool call has a corresponding tool output.

It must never run while a tool is recorded as `started`. The next model call is blocked until the tool lifecycle is resolved. Compaction input contains the same current instructions, tool definitions, and working conversation items that the next model call would otherwise receive.

### Persistence

After successful API compaction, the Conversation Checkpoint contains only the compacted model input. It does not retain a second full-history field or an archive copy. The old complete input remains available only in the Journal when journaling was enabled and healthy.

The checkpoint is advanced only after the compact API result is structurally valid and the atomic conversation save succeeds.

Failure behavior is strict:

- compact API failure leaves the original checkpoint untouched, performs no next model call, and does not retry automatically;
- compact API success followed by checkpoint save failure retains the exact compacted result in memory as `UNSAVED`, blocks all further work and conversation switching, and retries only saving that same result;
- a save retry never calls the compact API again;
- restoring a conversation with an incomplete request shows the existing warning and never continues compaction or model work automatically.

### Semantic preservation contract

The compacted input must preserve enough information to continue work correctly:

- current user goal;
- explicit decisions and constraints;
- active plan and unfinished work;
- important paths, symbols, identifiers, and issue references;
- changes already made and their reasons;
- verification results and unresolved failures;
- uncertainty, incomplete operations, and possible tool side effects.

It need not preserve verbatim conversation wording, rejected alternatives after a decision is final, raw large tool output, or the detailed event timeline already held by the Journal.

Semantic quality is verified through behavior scenarios, not by comparing summary prose byte for byte.

### Journal events

Future compaction adds:

- `compaction_started` with trigger and pre-compaction size;
- `compaction_finished` with before/after sizes and the full compact API response;
- `compaction_failed` with trigger, failure phase, and normalized error.

These events remain best-effort. Their failure does not replace the Conversation Checkpoint contract.

## Architecture and implementation shape

The first implementation should remain in existing modules:

- `src/tools.ts`: ranged `read`, exact `replace`, raw result preservation, and model-visible output bounding;
- `src/tools.test.ts`: direct tool boundary and file-safety tests;
- `src/agent.ts`: request assembly, usage reporting, exact preflight, budget enforcement, and separation of raw versus model-visible tool results;
- `src/agent.test.ts`: request, usage, preflight, blocking, and checkpoint-isolation tests;
- `src/cli.ts`: parse configured budget once, retain latest exact measurement, and render the contextual prompt;
- `src/cli.test.ts`: prompt and warning behavior;
- `src/journal.ts` and its tests only if event data types require explicit additions.

No production module is created solely for token counting or truncation unless implementation reveals concrete duplication that cannot remain readable in these files.

Future compaction should extend the same request boundary in `src/agent.ts` and existing persistence coordination in `src/cli.ts` and `src/conversations.ts`. It earns a separate implementation task because atomic persistence and failure recovery make it independently reviewable. No placeholder code is added during the first implementation.

## Verification

Automated tests cover the first implementation:

- small tool outputs remain exact;
- `read` pages have no missing or repeated content, including a single line longer than the character limit;
- line and character limits produce exact metadata and continuation coordinates;
- empty files and out-of-range starts are explicit;
- `run` preserves exact small results and uses head/omission/tail for large success and error results;
- Journal receives raw output while Model Input and Conversation Checkpoint receive bounded output;
- `replace` changes one exact match and rejects zero, multiple, and empty matches without modifying the file;
- prompt rendering before measurement, without budget, and with budget;
- response usage becomes the latest exact measurement;
- soft-boundary risk causes exact `inputTokens.count()` preflight;
- below-boundary requests avoid unnecessary preflight;
- exact usage at 80% warns once;
- exact usage above 100% blocks the model call;
- required preflight failure does not corrupt the stable checkpoint;
- system instructions and tools appear once per request and never accumulate in persisted input.

Future compaction tests cover:

- compaction only at safe Model Step boundaries;
- no compaction while a tool remains `started`;
- compact API failure preserving the original checkpoint;
- successful compaction atomically replacing checkpoint input;
- checkpoint save failure retaining one `UNSAVED` compacted result without another API call;
- restoration from compacted input;
- one-shot prompt marker and Journal lifecycle events;
- manual semantic scenarios covering goals, decisions, paths, completed changes, test failures, uncertainty, and possible side effects.

Every implementation task must pass `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm lint`. Manual verification runs the CLI with a disposable project, forces large `read` and `run` outputs, crosses the configured soft and hard boundaries, and inspects both the saved checkpoint and Journal.

## Delivery split

Implementation is divided into three independently reviewable Linear issues, all intended for branch `codex/pri-82-context-management`:

1. Bound tool outputs, add ranged `read`, and add exact `replace`.
2. Add Context Budget measurement, exact preflight, enforcement, warnings, and prompt display. This issue depends on bounded tool output.
3. Add native Responses compaction with atomic checkpoint replacement and Journal events. This issue is deferred and depends on the first two.

The discussion issue is the design source. Another discussion issue and a large placeholder comment in code would duplicate that source and are intentionally rejected.

## Acceptance criteria

1. Every model request contains one current copy of instructions and tools; neither is persisted as repeated conversation history.
2. Every tool result entering Model Input is bounded, explicitly marked when truncated, and safe to continue reading where applicable.
3. Full raw tool results appear only in the optional Journal; checkpoints contain only model-visible outputs.
4. Large files can be read through deterministic one-based pages without silent data loss.
5. Exact replacement cannot modify a file when the target is absent or ambiguous.
6. No repository retrieval subsystem is introduced.
7. With no Context Budget, the CLI shows only exact observed tokens and imposes no fake percentage or hard limit.
8. With a Context Budget, the CLI preflights near 80%, warns at the soft boundary, and refuses input above 100% without advancing the stable checkpoint.
9. Required preflight failures never fall through to a model call.
10. First implementation performs no history compaction and uses no automatic truncation.
11. Future compaction uses the native compact API only at safe boundaries and never duplicates full history in Conversation State.
12. Compaction and checkpoint-save failures preserve a recoverable, non-repeated state.
13. Automated and manual verification described above succeeds.
