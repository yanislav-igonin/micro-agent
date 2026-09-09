# Repository Guidelines

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

Follow existing TypeScript style: two-space indentation, semicolons, double-quoted strings, and trailing commas in multiline structures. Use camelCase for functions and variables, uppercase names for constants such as `ROOT`, and snake_case for exposed tool names such as `read_file`.

Preserve ESM imports with `.js` extensions for local modules. Respect strict compiler settings. Keep tool schemas and dispatch cases synchronized when adding or changing tools.

## Testing Guidelines

No automated testing framework, test naming convention, or coverage threshold exists yet. Run the type check and manually exercise affected behavior with `pnpm dev`. Use disposable files when checking write/append tools. Verify error paths as well as successful calls. If adding automated tests, document their runner, naming convention, and command.

## Commit & Pull Request Guidelines

History uses short, informal subjects such as `write/append file`; no enforced commit format is evident. Write concise, descriptive subjects and keep commits focused.

For pull requests, describe the behavior changed, link relevant issues, and list validation performed and any known failures. Create requests only when explicitly requested, from a non-default branch with committed changes.

## Security & Configuration

Never commit `.env` or API keys. `OPENAI_MODEL` optionally overrides the default model. Shell commands run with local process permissions; the working directory is not a sandbox. Run experiments in a disposable checkout.
