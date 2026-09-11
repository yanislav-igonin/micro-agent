# Conversation Persistence and Recovery Design

## Problem

Micro Agent keeps one complete model-visible conversation in memory during a CLI run, but that conversation disappears when the process exits. The diagnostic journal records enough detail to inspect a run, yet it is intentionally best-effort, may be disabled, and is organized around runs rather than durable conversations. Treating journals as the recovery source would make an operational feature depend on a diagnostic format and would make incomplete tool calls unsafe to replay.

The agent needs a small project-local conversation store that can restore the exact model-visible history without restoring stale runtime configuration or repeating uncertain side effects.

This design implements the decisions from [PRI-81](https://linear.app/mikes-private/issue/PRI-81/obsuzhdenie-26-sohranenie-i-vosstanovlenie-sessii).

## Goals

- Start every CLI run with a new empty conversation.
- Persist non-empty conversations inside the current project.
- List previous conversations newest-first and select one interactively.
- Restore the exact Responses API input history, including model output items, function calls, and function call outputs.
- Keep conversation state separate from the diagnostic journal.
- Preserve the last complete checkpoint when a request, tool, process, or state write fails.
- Never repeat an incomplete tool call automatically.
- Make project changes between runs explicit to the restored agent.
- Keep the implementation direct and readable in the existing small codebase.

## Non-goals

- Reconstructing conversation state from logs/*.jsonl.
- Using previous_response_id or remote OpenAI storage as the recovery source.
- Restoring historical model configuration, system instructions, or tool schemas.
- Saving, restoring, reverting, or merging project files.
- Automatically continuing an incomplete model request or tool call.
- Supporting concurrent work on one conversation from multiple CLI runs.
- Adding robust process locks, stale-lock recovery, or cross-process coordination.
- Renaming, deleting, searching, exporting, rotating, or expiring conversations.
- Adding a conversation index, database, streaming parser, or pagination.
- Adding context compaction or summarization.
- Encrypting conversation files or moving them outside the project.
- Building a full-screen terminal application with Ink or another UI framework.
- Repairing malformed files or migrating unsupported schema versions.

## Domain model

The canonical terms live in CONTEXT.md.

- A **Run** is one CLI process lifetime. A run may switch between conversations, but only one conversation is active at a time.
- A **Conversation** is the durable model-visible exchange and may span multiple runs.
- A **User Request** starts with one user message and contains one or more model steps and tool calls.
- A **Model Step** is one Responses API request and response; tools requested by that response belong to the same step.
- A **Conversation Checkpoint** is the last complete input that is safe to restore.
- A **Conversation Store** owns project-local conversation files. It does not call OpenAI or execute tools.
- A **Journal** remains a detailed, best-effort diagnostic record for one run and is never the source of restored conversation state.

## Architecture

The implementation adds one production module, src/conversations.ts. It follows the existing createJournal() factory style rather than adding a class hierarchy, repository interface, service layer, event bus, or dependency-injection container.

Responsibilities remain local:

- src/conversations.ts defines the versioned file schema and creates, lists, loads, validates, and atomically saves conversation state.
- src/agent.ts owns the mutable in-memory ResponseInput, runs the visible model/tool loop, and exposes the current input after a successful request.
- src/cli.ts owns the active conversation, handles /history and /new, connects request lifecycle callbacks to the store, and replaces the agent when the active conversation changes.
- src/index.ts creates the project-local store and passes it to the CLI.
- src/journal.ts accepts conversationId in applicable event context so diagnostic events can be correlated with a durable conversation.

The agent does not depend on filesystem details. The CLI supplies small asynchronous callbacks for tool-started and tool-finished state changes. These callbacks are the concrete boundary needed to persist pending tool status before and after execution; they are not a generic event system.

## Storage location and security

Conversation state lives beside the existing journal directory:

~~~text
<project>/
├── logs/
└── conversations/
    └── a1b2c3d4e5f6.json
~~~

conversations/ is added to .gitignore. The directory is created with Unix mode 0700, and each state file uses mode 0600. Existing permissions are tightened in the same manner as the journal directory.

Conversation files are sensitive and unencrypted. Exact model-visible input may contain file contents, commands, tool arguments, and tool results. Files remain readable to the same OS user, privileged processes, backups, and other software with sufficient access.

No global, home-directory, or cloud storage is used. The current project directory defines the available conversation history.

## File schema

Each conversation uses one JSON file:

~~~json
{
  "schemaVersion": 1,
  "id": "a1b2c3d4e5f6",
  "title": "Inspect the failing request and explain why…",
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:15:00.000Z",
  "revision": 4,
  "lastModel": "gpt-5.6-luna",
  "input": [],
  "pendingRequest": null
}
~~~

- id is 12 lowercase hexadecimal characters generated from six random bytes. File creation rejects collisions and generates another ID.
- title is derived once from the first user request. Whitespace is collapsed, and the result is limited to 50 Unicode code points with an ellipsis when truncated. It remains stable.
- createdAt is the conversation creation time in UTC ISO 8601 format.
- updatedAt changes after every successful state mutation, including pending-request and tool-status updates. It drives /history ordering.
- revision starts at 1 and increases on every successful save.
- lastModel is a string or null. It records the model used for the most recently completed request and remains null while the first request is pending. It is informational and does not override current configuration.
- input is the exact ResponseInput from the last complete checkpoint.
- pendingRequest is absent or null while the checkpoint is ready.

While a request is incomplete, pendingRequest contains only recovery metadata:

~~~json
{
  "prompt": "Fix the error handling",
  "startedAt": "2026-09-12T08:14:00.000Z",
  "tools": [
    {
      "callId": "call_123",
      "name": "write",
      "status": "started"
    }
  ]
}
~~~

Tool status is written as started immediately before execution and finished immediately after execution. Tool arguments and results are already available in the journal and are not duplicated in pendingRequest. The stable input is not replaced until the complete user request succeeds.

## Atomic saves and revisions

The store never overwrites a conversation file in place. It serializes the full next state to a uniquely named temporary file in conversations/, closes that file, and renames it over the target file. A process failure before the rename leaves the previous state intact; a leftover temporary file is ignored by listing and loading.

This protects JSON structure from partial writes. It is not a guarantee against storage-device failure or sudden power loss without filesystem durability primitives.

Before saving an existing conversation, the store reads its current revision and compares it with the caller's expected revision. A mismatch rejects the save and leaves the disk state unchanged. This is a low-cost stale-write guard, not an atomic compare-and-swap and not full concurrent-use support. Two runs must not actively use the same conversation.

## Conversation lifecycle

### New conversation

Every CLI run starts with a new empty active conversation in memory. It receives an ID immediately but creates no file until the first non-command user request begins. Exiting or switching away before that first request leaves no empty history entry.

/new replaces the active conversation with another new empty conversation. A successfully saved previous conversation remains available in /history.

### Beginning a user request

Before calling the model, the CLI asks the store to persist pendingRequest while leaving the stable checkpoint unchanged. If this save fails, the model is not called and no tool can execute.

The agent performs the request using a working copy of the checkpoint input plus the new user message. The journal records the existing run, request, and step events with the active conversationId.

Immediately before each tool execution, the agent awaits the tool-started callback. Immediately after execution, it awaits the tool-finished callback. A state-write failure before execution prevents that tool from running.

### Completing a user request

When the model returns a final answer, the CLI atomically commits the agent's complete working input, updates lastModel, clears pendingRequest, advances revision, and updates updatedAt.

The answer may be shown if this final save fails, but the CLI must also show a prominent UNSAVED warning. The advanced input remains in memory. No later model call, tool execution, /new, or /history switch may proceed until the same checkpoint saves successfully. Exiting remains possible with an explicit warning that the unsaved state will be lost.

Normal exit or quit needs no additional conversation write because every successful request is already checkpointed.

### Failed or interrupted request

A model error, maximum-step error, unexpected error, signal interruption, or process crash does not replace the stable checkpoint. The in-memory agent created for that request is discarded and can be recreated from the checkpoint.

pendingRequest remains available with the original prompt and known tool statuses. No model request or tool call is retried automatically. The CLI shows the incomplete request and distinguishes:

- finished: execution returned before interruption;
- started: execution may or may not have produced side effects.

The next ordinary user message explicitly abandons the incomplete request and begins a new request from the stable checkpoint. Re-entering the old prompt is a deliberate user action. /new and /history may switch away while leaving the incomplete metadata on the old conversation.

## History selector

/history temporarily pauses the normal text prompt and opens an interactive selector implemented with @clack/prompts. This is a focused selection prompt, not an alternate-screen application.

Each valid row shows:

- updatedAt formatted in local time;
- the 12-character conversation ID;
- the stable title derived from the first request.

Rows are sorted by updatedAt descending, so a resumed conversation returns to the top after any activity. Arrow keys change the selection, Enter loads it, and Escape cancels and returns to the existing active conversation. /history <id> is not required in the first version.

Loading replaces the active conversation and recreates the agent with the stored checkpoint input. The selector may be opened at any idle CLI prompt, including after another conversation has already been used during the same run.

If no valid conversations exist, /history shows a normal empty state and returns to the active conversation.

## Invalid and unsupported files

The history listing reads each direct conversations/*.json file because no separate metadata index exists. This intentionally favors simplicity over scalability for the first version.

A malformed file, unreadable file, invalid required field, filename/ID mismatch, or unknown schemaVersion is skipped. The CLI reports how many files could not be read without printing sensitive state. Loading a file that becomes invalid after listing reports a clear error and leaves the active conversation unchanged.

The store does not repair, overwrite, quarantine, rename, or delete invalid files. Temporary files are not treated as conversations.

## Runtime configuration after restoration

Only model-visible input is restored. It includes user messages, every preserved model output item, reasoning items, function calls, and function call outputs exactly as required for manual Responses API state management.

The next request uses the current:

- OPENAI_MODEL value or current default model;
- system instructions compiled with the running code;
- tool definitions and implementations;
- process and project settings.

If the current model differs from lastModel, the CLI prints an informational warning. The old model is not selected automatically.

Project files are never restored. During every run that resumes a conversation, the model receives a current instruction that tool outputs from earlier runs describe historical project state and that relevant files must be read again before changes are based on them. No Git commit, working-tree hash, or file fingerprint is stored.

## Journal relationship

Journal and conversation state have different guarantees:

- Journal is detailed, per-run, best-effort, optional through --no-log, and optimized for diagnosis.
- Conversation state is minimal, cross-run, required for resumability, and must be saved before side effects proceed.

--no-log disables only journal creation. It never disables conversation persistence.

Applicable journal events gain conversationId. Run-level events such as cli_started and cli_finished do not require one because a run may use multiple conversations. Existing runId, requestNumber, stepNumber, and callId semantics remain unchanged.

## Failure behavior

- Conversation directory creation or initial state creation failure: report the error and do not start the user request.
- Pending-request save failure: report the error and do not call the model.
- Tool-started save failure: report the error and do not execute the tool.
- Tool-finished save failure: preserve the last disk state, treat the request as incomplete, and do not continue to another model step.
- Final checkpoint save failure: retain the advanced input in memory, show UNSAVED, and block further work or switching until persistence succeeds.
- Revision mismatch: reject the stale save, leave disk state untouched, and require reloading the conversation.
- Invalid history file: skip it with a summary warning.
- Invalid selected file: keep the current conversation active.
- Incomplete restored request: show its prompt and tool statuses, restore only the last checkpoint, and perform no automatic work.
- Journal failure: preserve existing behavior; warn once, disable journal writing for the run, and continue conversation work.

## Expected implementation shape

- Create src/conversations.ts for schema, validation, IDs, atomic writes, revision checks, listing, loading, pending status, and checkpoint commits.
- Create src/conversations.test.ts for filesystem and state-transition behavior.
- Modify src/agent.ts and src/agent.test.ts to initialize from stored input, expose committed input, discard failed working input, and await tool-status callbacks.
- Modify src/cli.ts and src/cli.test.ts to own the active conversation, coordinate saves, handle commands, and isolate the interactive selector behind an ordinary function argument for deterministic tests.
- Modify src/index.ts to create the store from the current project root.
- Modify src/journal.ts and src/journal.test.ts to accept and preserve conversationId.
- Modify .gitignore, README.md, package.json, and pnpm-lock.yaml for storage documentation and @clack/prompts.

The feature changes five production TypeScript modules, including one new module. A more layered repository/manager architecture is rejected because it would spread one workflow across unnecessary abstractions.

## Verification

Automated tests cover:

- empty conversations producing no files;
- collision-safe 12-character IDs and stable 50-character titles;
- exact round-trip of mixed Responses input items;
- createdAt, updatedAt, revision, and lastModel;
- atomic replacement leaving the previous checkpoint readable after a simulated save failure;
- pending-request creation and tool started/finished transitions;
- rollback to the stable checkpoint after model, tool, and interruption failures;
- blocking model and tool execution when required state writes fail;
- retaining unsaved final input and blocking later work until it saves;
- stale revision rejection;
- newest-first history sorting;
- malformed, unreadable, mismatched-ID, and unsupported-version files;
- /new, /history, selection, cancellation, empty history, and active-conversation switching;
- exact restored input on the next model request;
- current model selection and a warning when lastModel differs;
- model-visible stale-project guidance after restoration;
- journal correlation through conversationId;
- --no-log leaving conversation persistence enabled;
- directory mode 0700, file mode 0600, and Git ignoring conversations/.

Manual verification uses this minimum recovery scenario:

1. Start the CLI and complete a conversation containing multiple user requests and at least one tool call.
2. Exit normally and confirm one valid project-local conversation file.
3. Start the CLI again and confirm the active conversation is initially empty.
4. Run /history, navigate with arrow keys, cancel once with Escape, reopen it, and select the saved conversation with Enter.
5. Send a request that depends on an earlier message and tool result.
6. Confirm the exact old checkpoint appears in the next model request, the answer uses the restored context, updatedAt changes, and the conversation moves to the top of history.
7. Change a previously inspected project file between runs and confirm the restored agent reads its current contents before modifying it.
8. Interrupt a request after a tool has started, restore the conversation, and confirm the CLI warns, uses the last stable checkpoint, and never runs the tool automatically.

Before completion, implementation must pass pnpm test, pnpm exec tsc --noEmit, and pnpm lint.

## Acceptance criteria

1. Every run starts with a new empty active conversation and creates no empty state file.
2. Completed non-empty conversations are stored only in project-local conversations/*.json, ignored by Git, with the specified Unix permissions.
3. /history provides newest-first arrow-key selection, Enter restoration, and Escape cancellation.
4. /new starts a new empty active conversation without deleting prior state.
5. Restoration supplies the next model request with the exact saved Responses input while using current model, instructions, tools, and project state.
6. Journal data is never used to restore conversations, and --no-log does not disable conversation persistence.
7. State writes are atomic, revision-checked, and performed before model or tool work whose recovery status must be known.
8. Failed or interrupted requests preserve the last complete checkpoint, expose pending request and tool status, and never retry work automatically.
9. Corrupt and unsupported files do not break history selection or replace the active conversation.
10. State-write failures and stale revisions never silently lose or overwrite conversation history.
11. Journal events remain per-run and gain conversationId where applicable.
12. Automated and manual verification described above succeeds.
