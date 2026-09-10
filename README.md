# micro-agent

A small TypeScript CLI coding agent using the OpenAI Responses API.

Use `pnpm@12.3.4`. Install with `pnpm install`, copy `.env.example` to `.env`,
set `OPENAI_API_KEY`, then run `pnpm dev`. `OPENAI_MODEL` overrides the default
model. Type `exit` or `quit` to finish. Each prompt starts a separate agent context.

## Work journal

Each CLI launch creates one `logs/<UTC-timestamp>-<pid>.jsonl` file and prints its
absolute path. Run `pnpm dev --no-log` to disable file logging explicitly.

Each line is an independent JSON event with `schemaVersion: 1`, `sequence`, UTC
`timestamp`, `type`, `runId`, and `data`. `requestNumber`, `stepNumber`, and `callId`
appear where applicable. Sequence numbers cover the whole launch; request numbers
start at 1, and step numbers restart at 1 for each prompt.

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

`user_request_finished.data.reason` is `final_answer`, `max_steps`, `model_error`,
or `unexpected_error`. `cancelled` is reserved; signal handling is not implemented.
An API failure emits `model_error` before finishing the request. Missing finish
events indicate an interrupted action or incomplete journal. No repair is attempted.

The terminal shows progress, tool statuses, stop reasons, and the final answer.
Full diagnostic arguments and results stay in the journal. On the first journal
creation or write failure, one warning appears and logging stays disabled for
that launch; the agent continues.

`logs/` has Unix mode `0700`; files have mode `0600`. The directory is ignored by
Git. Journals are sensitive, unencrypted local files: file contents, commands,
and their outputs are preserved without heuristic secret masking. API client
configuration, environment variables and authorization headers are not serialized.
There is no automatic cleanup or rotation.

Inspect a journal with standard JSON tools, for example:

```sh
jq . logs/<filename>.jsonl
jq 'select(.type == "user_request_finished") | {requestNumber, data}' logs/<filename>.jsonl
```

## Verification

Run `pnpm exec tsc --noEmit` and `pnpm lint`. There is no automated test framework.
Exercise CLI behavior in a disposable project: ask it to read/write a sample file,
then try a missing file or failing shell command, send a second prompt, and quit.
Check JSON parsing, sequence order, matching call IDs, separate request numbers,
`OK` for writes, error outputs, and the final `cli_finished` event. Check file
permissions and `--no-log` as well.

For deterministic malformed arguments, model failures and the 20-step limit,
point the SDK's `OPENAI_BASE_URL` at a local HTTP fixture serving Responses payloads
and use a dummy API key. This exercises the real CLI and SDK without changing
production dependencies. To exercise logging failure, run where `logs` is a file,
or make the active log path unwritable during a request; expect one warning and
continued agent work.
