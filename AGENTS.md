# Repository Guidelines

## Issue Tracking

Use the [micro-agent Linear project](https://linear.app/mikes-private/project/micro-agent-2f775f92040b/overview) as the default board for this repository. Requests to find, create, or work on tasks on "the board" refer to this project unless the user specifies another destination.

Use the configured Linear MCP tools for issue access. If they are unavailable, report the blocker; do not claim to have read or updated the board. Before creating issues, inspect existing project issues to avoid duplicates.

Change issue states only with `linear_save_issue` using the `state` field, never `status`. Verify each state change with `linear_get_issue`.

## Project Structure & Module Organization

This repository is a small TypeScript command-line coding agent built on the OpenAI Responses API, plus a local React viewer for its diagnostic journals.

Agent core (`src/`):

- `src/index.ts`: entry point. Loads dotenv, creates the journal and the conversation store, then runs the prompt loop in `src/cli.ts`. `--no-log` disables journaling; Ctrl-C exits with code 130.
- `src/cli.ts`: the interactive loop. Exports `runCli` (the injectable entry point used by tests) and the `Cli` class that holds one run: prompt formatting with live context usage, `/history` and `/new`, `exit`/`quit`, checkpoint save and retry, SIGINT handling, and the `WARNING:` / `UNSAVED:` messages.
- `src/agent.ts`: model and tool loop, limited to 20 model steps per user request. Owns system instructions, exact input-token preflight, the context-budget boundary and compaction, tool-call execution, and the stop reason. Exports the `Agent` class; one instance continues one conversation and keeps the last complete model input.
- `src/tools.ts`: tool schemas and dispatch for `read`, `write`, `edit`, `replace`, and `run`, plus the bounded model-visible output representation.
- `src/conversations.ts`: durable checkpoint store, split into two classes. `Conversation` is one conversation's state plus the mutations the agent loop applies to it; `ConversationStore` owns the filesystem operations that create, list, load, and save `conversations/<12-hex-id>.json` atomically. A mutation adopts its new revision only after the write succeeded.
- `src/journal.ts`: append-only JSONL diagnostic journal at `logs/<UTC-timestamp>-<pid>.jsonl`. Serializes each event eagerly, before the next model or tool step can mutate it.

Journal viewer (`viewer/`, wired by `vite.config.ts`):

- `viewer/server.ts`: resolves, validates, and reads journal files from disk.
- `viewer/src/journal.ts`: pure parsing, filtering, sorting, and timeline grouping of journal text.
- `viewer/src/App.tsx`, `viewer/src/main.tsx`, `viewer/src/styles.css`: the React UI.
- `vite.config.ts`: sets the Vite root to `viewer/` and adds the `journal-api` dev middleware for `/api/journals`.

Tests are colocated with the module they cover, named `*.test.ts`: `src/*.test.ts`, `viewer/server.test.ts`, `viewer/src/journal.test.ts`. There is no separate test directory.

Docs: `CONTEXT.md` holds the project's domain vocabulary, `README.md` is the behavior reference, and `docs/superpowers/{specs,plans}` holds design specs and implementation plans.

Runtime data (`conversations/`, `logs/`) and dependencies are gitignored. Never commit them.

## Build, Test, and Development Commands

Use the pinned package manager, `pnpm@12.3.4`, from the repository root.

- `pnpm install`: installs dependencies using the lockfile.
- `cp .env.example .env`: creates local configuration; set `OPENAI_API_KEY` before starting.
- `pnpm dev`: runs the interactive agent through `tsx src/index.ts`; pass `--no-log` to disable journaling.
- `pnpm test`: runs the Vitest suite (`vitest run --root .`).
- `pnpm exec tsc --noEmit`: checks TypeScript without generating files.
- `pnpm lint`: runs `biome check`. The Husky `pre-commit` hook runs `lint-staged`, which applies `biome check --write` to staged `*.{ts,js,mjs,json}`.
- `pnpm viewer`: starts the Vite dev server for the journal viewer on `127.0.0.1`.

There is no build script: the CLI runs directly through `tsx`, and the viewer runs through Vite.

## Architecture Invariants Worth Preserving

- The journal is diagnostic only. Conversation checkpoints are the sole source of truth for resuming work; never reconstruct conversation state from a journal.
- A checkpoint advances only after a complete final answer. Failed, interrupted, or pending requests leave the previous checkpoint intact and are never replayed automatically; surface them and let the user decide.
- Model-visible tool output is bounded; the journal keeps the complete captured result. Do not widen model input to keep diagnostics intact.
- Journal writes are best-effort: the first failure disables logging for that run with one warning and the agent continues. Conversation persistence is required, and its failure blocks later requests until the same checkpoint saves.
- Use the vocabulary defined in `CONTEXT.md` (run, conversation, active conversation, checkpoint, model step, model input, compaction, journal). Read it before renaming a concept or introducing a new one.

## Coding Style & Naming Conventions

### Educational Readability Comes First

This is a learning project. The user should be able to read the code and understand how an agent works. Optimize for obvious control flow and visible data flow, not architectural sophistication or the fewest lines of code.

- Keep one concern per module: CLI interaction in `src/cli.ts`, the model/tool loop in `src/agent.ts`, tool schemas and execution in `src/tools.ts`, persistence in `src/conversations.ts`, diagnostics in `src/journal.ts`. This split is a readability reference, not a hard limit; add a module only when it makes behavior easier to understand.
- Keep the core sequence easy to follow in one place: build model input, call the model, inspect its response, execute tools, append results, and repeat or stop. Do not hide these steps behind generic orchestration layers.
- Prefer ordinary functions, explicit loops, conditionals, and a direct tool-dispatch switch. Avoid factories, service layers, registries, event buses, dependency-injection containers, and class hierarchies unless a concrete requirement makes them simpler overall.
- The three core entities are deliberately plain classes: `Agent`, `Conversation` with `ConversationStore`, and `Cli`. Each one holds state that was previously threaded through closures and long parameter lists, and each was introduced for that concrete reason. Keep them flat: no inheritance, no interface that exists only for another class to implement, and no factory beyond `ConversationStore.open`. A struct that names the arguments of one call (`AgentRunOptions`, `CliOptions`, `ConversationStoreOptions`) is not such an interface and is welcome.
- Extend existing modules first. Do not create a file per small function, tool, event, or type.
- A little straightforward duplication is preferable to an abstraction that forces the reader to jump between files or learn a framework. Extract helpers for meaningful concepts or real repetition, not merely to shorten a function.
- Use clear names and simple types. Avoid clever generic types, compressed expressions, and speculative extension points. Simplicity does not justify bypassing type checks or omitting necessary validation and error handling.
- Add short explanatory comments where they teach agent mechanics or explain a non-obvious decision. Do not narrate obvious syntax.
- Do not introduce an agent framework or rewrite the existing loop just to implement an ordinary feature. Framework comparisons belong to the explicitly agreed learning experiment.
- Before adding substantial abstraction or splitting the code across more modules, explain the concrete problem and why a direct implementation in the existing structure is insufficient.

Follow existing TypeScript style: two-space indentation, semicolons, double-quoted strings, and trailing commas in multiline structures. Biome enforces this on commit; keep `conversations/` and `logs/` out of formatting scope, as `biome.json` already does. Use camelCase for functions and variables, uppercase names for module-level constants such as `ROOT` and `ID_PATTERN`, and short lowercase verbs for exposed tool names, matching the existing `read`, `write`, `edit`, `replace`, `run`.

Preserve ESM imports with `.js` extensions for local modules. Respect the strict compiler settings, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. Keep tool schemas and dispatch cases synchronized when adding or changing tools.

## Testing Guidelines

Vitest is the test runner; tests are colocated as `*.test.ts` and run with `pnpm test`. There is no coverage threshold or separate test directory.

- Import the module under test with its `.js` ESM extension, as production code does.
- Prefer exercising the real module with narrow fakes over mocking whole layers. `runCli` already accepts injectable dependencies (agent factory, signal source, conversation selector, model, context budget) for exactly this reason; extend that pattern rather than reaching for module mocks.
- Cover error and edge paths, not just happy paths: invalid tool arguments, tool execution failure, checkpoint save failure, context-budget boundaries, malformed conversation and journal files.
- Use disposable files or temporary roots when a test touches `write`, `edit`, `replace`, or `run`. Never let a test write into the real `conversations/` or `logs/` directory.
- Before finishing a change, run `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm lint`. Also see the "Verification" section of `README.md` for the manual CLI checks (tool results, `/history` navigation, interrupted requests, `--no-log`, file permissions).

## Commit & Pull Request Guidelines

History mixes two shapes: merged features use `Feature - <topic> (#N)`, and small changes use short informal subjects such as `write/append file`. Write concise, descriptive subjects and keep commits focused. The `pre-commit` hook rewrites staged files through Biome, so review its edits before committing.

For pull requests, describe the behavior changed, link relevant issues, and list validation performed and any known failures. Create requests only when explicitly requested, from a non-default branch with committed changes.

## Security & Configuration

Never commit `.env` or API keys. `OPENAI_MODEL` optionally overrides the default model (`gpt-5.6-luna`); `MICRO_AGENT_CONTEXT_BUDGET` optionally sets a positive integer limit on model input tokens, and an invalid value stops startup.

`conversations/` and `logs/` hold sensitive, unencrypted local data: prompts, model output, file contents, commands, and their results, with no secret masking, cleanup, or retention policy. They use `0700` directories and `0600` files; keep that discipline when adding new persistence, and never add either path to git.

The `run` tool executes shell commands with the local process permissions of the CLI user. The working directory is not a sandbox, so run experiments in a disposable checkout.
