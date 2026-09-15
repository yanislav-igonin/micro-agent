# micro-agent

A small TypeScript CLI coding agent using the OpenAI Responses API.

Use `pnpm@12.3.4`. Install with `pnpm install`, copy `.env.example` to `.env`,
set `OPENAI_API_KEY`, then run `pnpm dev`. `OPENAI_MODEL` overrides the default
model. Type `exit` or `quit` to finish. Each CLI launch keeps one conversation, so
follow-up prompts can refer to earlier messages and tool results. Type `/history` to
select a saved project-local conversation, or `/new` to start an empty conversation
without deleting the current one.

`MICRO_AGENT_CONTEXT_BUDGET` optionally sets a positive integer limit for model
input tokens. Invalid values stop startup. The normal prompt shows `agent> ` before
the first exact measurement, `agent [context 42,103]> ` without a budget, or
`agent [context 42,103/100,000 · 42%]> ` with one. These counts come only from
Responses API usage or exact input-token preflight; local bounds never appear in
the prompt. With no budget, the agent shows raw usage without a percentage or limit.

With a budget, a conservative local size check triggers exact preflight when input
could reach 80% of the limit. The agent warns once per period at or above 80%, then
resets that warning after exact usage falls below 80%. An exact preflight count above
100% blocks the model call and leaves the last complete conversation checkpoint
unchanged. A required preflight failure also stops the model call. The CLI suggests
`/new`, raising `MICRO_AGENT_CONTEXT_BUDGET`, or future compaction after a hard
block. Automatic truncation and compaction are disabled.

## Work journal

Each CLI launch creates one `logs/<UTC-timestamp>-<pid>.jsonl` file and prints its
absolute path. Run `pnpm dev --no-log` to disable file logging explicitly.

Each line is an independent JSON event with `schemaVersion: 1`, `sequence`, UTC
`timestamp`, `type`, `runId`, and `data`. `conversationId`, `requestNumber`,
`stepNumber`, and `callId` appear where applicable. Run-level events remain
conversation-neutral. Sequence numbers cover the whole launch; request numbers start
at 1, and step numbers restart at 1 for each prompt.

The normal sequence is:

```text
cli_started
  user_request_started
    model_request → model_response
      tool_started → tool_finished (for each requested tool)
    model_request → model_response
  user_request_finished
cli_finished
```

`model_request.data` contains the exact Responses create parameters, including
full input, instructions and tool schemas. `model_response.data` contains the
full serializable SDK response. `tool_started.data.arguments` is the raw JSON
string; `tool_finished.data.arguments` contains parsed arguments when parsing
succeeded. Tool events use the original model `call_id` as `callId`.

Tool results contain `status` (`ok` or `error`) and a string `output`; errors also
include normalized error details and a `phase` (`argument_parsing` or `execution`).
Invalid JSON never executes a tool and returns `ERROR: Invalid tool arguments`
to the model. Successful write/append operations return `OK`. Tool errors are
returned to the model and allow the cycle to continue, including shell failures
with their stdout and stderr preserved.

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

`user_request_finished.data.reason` is `final_answer`, `max_steps`, `model_error`,
`unexpected_error`, or `cancelled`. SIGINT aborts an active model request. An API
failure emits `model_error` before finishing the request. Missing finish events
indicate an interrupted action or incomplete journal. No repair is attempted.

The terminal shows progress, tool statuses, stop reasons, and the final answer.
On the first journal creation or write failure, one warning appears and logging
stays disabled for that launch; the agent continues.

`logs/` has Unix mode `0700`; files have mode `0600`. The directory is ignored by
Git. Journals are sensitive, unencrypted local files: file contents, commands,
and their outputs are preserved without heuristic secret masking. API client
configuration, environment variables and authorization headers are not serialized.
There is no automatic cleanup or rotation.

## Conversation checkpoints

Each CLI launch starts with a new empty conversation. Before its first model call,
the CLI creates `conversations/<id>.json` and records the pending request. It records
tool status before and after execution, then atomically commits the exact Responses
input only after a final answer. Failed or interrupted requests leave the previous
checkpoint intact and are never replayed automatically.

If the final checkpoint cannot be saved, the CLI prints `UNSAVED`, retains the
advanced input in memory, and blocks later requests until the same checkpoint saves.
`--no-log` and journal failures do not disable required conversation persistence.
Conversation files are local, sensitive, unencrypted, ignored by Git, and use the
same `0700` directory and `0600` file permissions as journals.

`/history` lists valid checkpoints newest-first. Each row contains the local update
time, the 12-character conversation ID, and the stable title derived from its first
request. Use the arrow keys and Enter to load a checkpoint, or Escape to keep the
current conversation. `/new` and `/history` can be used repeatedly during one run.
Neither command can switch away from a completed checkpoint that is still `UNSAVED`.

Loading always rereads and validates the selected file. A corrupt, unreadable, or
changed file is skipped without replacing the active conversation; the CLI reports
only the skipped-file count. A restored incomplete request is displayed with its
known tool statuses, but is never replayed. `started` means a tool may have produced
side effects; `finished` means its execution returned before interruption. The next
ordinary prompt deliberately abandons that pending request and continues from the
last complete checkpoint.

Restored conversations use the current `OPENAI_MODEL`, system instructions, tools,
and project files. A model mismatch produces a warning. Earlier tool outputs describe
historical project state, so the agent must reread relevant files before changing
them. Conversation JSON can contain prompts, model output, file contents, commands,
and tool results. Keep the project directory and backups protected; there is no
encryption, automatic cleanup, retention policy, or concurrent-use protection.

Manual recovery check:

1. Complete a request, start another request, and interrupt it after a tool starts.
2. Restart the CLI in the same project and run `/history`.
3. Select the conversation and confirm the incomplete prompt and tool statuses appear.
4. Press Escape once to confirm cancellation preserves the active conversation, then
   reopen `/history` and select the checkpoint.
5. Send a new prompt and confirm no pending work runs automatically, the saved
   conversation moves to the top, and the project files are reread when relevant.

Inspect a journal with standard JSON tools, for example:

```sh
jq . logs/<filename>.jsonl
jq 'select(.type == "user_request_finished") | {requestNumber, data}' logs/<filename>.jsonl
```

## Verification

Run `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm lint`.
Exercise CLI behavior in a disposable project: ask it to read/write a sample file,
then try a missing file or failing shell command, send a second prompt, and quit.
Check JSON parsing, sequence order, matching call IDs, separate request numbers,
`OK` for writes, error outputs, and the final `cli_finished` event. Check file
permissions and `--no-log` as well.

Also verify `/history` with arrow keys, Enter, and Escape; its empty and corrupt-file
states; repeated switching; `/new`; normal exit; newest-first reordering; incomplete
request recovery; a model mismatch; and a project file changed after the checkpoint.

For deterministic malformed arguments, model failures and the 20-step limit,
point the SDK's `OPENAI_BASE_URL` at a local HTTP fixture serving Responses payloads
and use a dummy API key. This exercises the real CLI and SDK without changing
production dependencies. To exercise logging failure, run where `logs` is a file,
or make the active log path unwritable during a request; expect one warning and
continued agent work.
