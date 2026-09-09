# Repository Guidelines

## Issue Tracking

Use the [micro-agent Linear project](https://linear.app/mikes-private/project/micro-agent-2f775f92040b/overview) as the default board for this repository. Requests to find, create, or work on tasks on "the board" refer to this project unless the user specifies another destination.

Use the configured Linear MCP tools for issue access. If they are unavailable, report the blocker; do not claim to have read or updated the board. Before creating issues, inspect existing project issues to avoid duplicates.

Change issue states only with `linear_save_issue` using the `state` field, never `status`. Verify each state change with `linear_get_issue`.

## Project Structure & Module Organization

This repository is a small TypeScript command-line coding agent using OpenAI.

- `src/index.ts`: loads environment variables and runs the interactive prompt; `exit` or `quit` ends the session.
- `src/agent.ts`: manages model requests, conversation state, and the tool-call loop, limited to 20 steps.
- `src/tools.ts`: defines tool schemas and dispatches file reads, writes, appends, directory listings, and shell commands.
- `package.json`, `pnpm-lock.yaml`, and `tsconfig.json`: dependencies, package-manager pinning, and compiler configuration.

There are currently no dedicated test or asset directories. Keep related behavior in the existing modules and avoid speculative abstractions.

## Build, Test, and Development Commands

Use the pinned package manager, `pnpm@12.3.4`, from the repository root.

- `pnpm install`: installs dependencies using the lockfile.
- `cp .env.example .env`: creates local configuration; set `OPENAI_API_KEY` before starting.
- `pnpm dev`: runs the interactive agent through `tsx src/index.ts`.
- `pnpm exec tsc --noEmit`: checks TypeScript without generating files.

No build, test, lint, or formatting scripts are currently configured.

## Coding Style & Naming Conventions

### Educational Readability Comes First

This is a learning project. The user should be able to read the code and understand how an agent works. Optimize for obvious control flow and visible data flow, not architectural sophistication or the fewest lines of code.

- Use the current three-module structure as the baseline: CLI interaction in `src/index.ts`, the model/tool loop in `src/agent.ts`, and tool schemas and execution in `src/tools.ts`.
- Keep the core sequence easy to follow in one place: build model input, call the model, inspect its response, execute tools, append results, and repeat or stop. Do not hide these steps behind generic orchestration layers.
- Prefer ordinary functions, explicit loops, conditionals, and a direct tool-dispatch switch. Avoid factories, service layers, registries, event buses, dependency-injection containers, and class hierarchies unless a concrete requirement makes them simpler overall.
- Extend existing modules first. Do not create a file per small function, tool, event, or type. Three files are a readability reference, not a hard limit; add a module only when it makes the behavior easier to understand.
- A little straightforward duplication is preferable to an abstraction that forces the reader to jump between files or learn a framework. Extract helpers for meaningful concepts or real repetition, not merely to shorten a function.
- Use clear names and simple types. Avoid clever generic types, compressed expressions, and speculative extension points. Simplicity does not justify bypassing type checks or omitting necessary validation and error handling.
- Add short explanatory comments where they teach agent mechanics or explain a non-obvious decision. Do not narrate obvious syntax.
- Do not introduce an agent framework or rewrite the existing loop just to implement an ordinary feature. Framework comparisons belong to the explicitly agreed learning experiment.
- Before adding substantial abstraction or splitting the code across more modules, explain the concrete problem and why a direct implementation in the existing structure is insufficient.

Follow existing TypeScript style: two-space indentation, semicolons, double-quoted strings, and trailing commas in multiline structures. Use camelCase for functions and variables, uppercase names for constants such as `ROOT`, and snake_case for exposed tool names such as `read_file`.

Preserve ESM imports with `.js` extensions for local modules. Respect strict compiler settings. Keep tool schemas and dispatch cases synchronized when adding or changing tools.

## Testing Guidelines

No automated testing framework, test naming convention, or coverage threshold exists yet. Run the type check and manually exercise affected behavior with `pnpm dev`. Use disposable files when checking write/append tools. Verify error paths as well as successful calls. If adding automated tests, document their runner, naming convention, and command.

## Commit & Pull Request Guidelines

History uses short, informal subjects such as `write/append file`; no enforced commit format is evident. Write concise, descriptive subjects and keep commits focused.

For pull requests, describe the behavior changed, link relevant issues, and list validation performed and any known failures. Create requests only when explicitly requested, from a non-default branch with committed changes.

## Security & Configuration

Never commit `.env` or API keys. `OPENAI_MODEL` optionally overrides the default model. Shell commands run with local process permissions; the working directory is not a sandbox. Run experiments in a disposable checkout.
