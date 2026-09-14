# Context Budget and Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the latest exact Model Input token count, preflight requests near an optional application budget, and block requests whose exact count exceeds that budget.

**Architecture:** Keep request measurement in the existing `createAgent()` closure and prompt rendering in `src/cli.ts`. A UTF-8 byte upper bound only gates the exact `responses.inputTokens.count()` call; exact response/preflight counts alone are displayed and enforced. No new production module, dependency, compaction, or provider automatic truncation is added.

**Tech Stack:** TypeScript 7, OpenAI Node SDK 7.10.0 Responses API, Vitest 5, Biome, pnpm 12.3.4.

**Spec:** `docs/superpowers/specs/2026-09-14-context-management-design.md`

## Global Constraints

- Work on shared branch `codex/pri-82-context-management`.
- `MICRO_AGENT_CONTEXT_BUDGET` is optional; when set it must be a positive safe integer.
- The budget is an application limit, not an inferred model context window.
- Only exact API counts are displayed, warned on, or used for a hard block.
- Soft boundary is `80%`; warn once per continuous high-usage period.
- Hard block occurs only when exact input is greater than `100%` of the budget.
- Required preflight failure must not fall through to `responses.create()`.
- Instructions and tool schemas remain request fields and never enter persisted conversation input.
- Do not set deprecated `truncation: "auto"` and do not add compaction.
- Keep the implementation in `src/agent.ts`, `src/cli.ts`, their tests, and README.

---

### Task 1: Parse the Budget and Render the Prompt

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Produces: `parseContextBudget(value: string | undefined): number | undefined`.
- Produces: `formatAgentPrompt(inputTokens: number | undefined, budget: number | undefined): string`.
- `runCli()` receives one parsed optional budget as its final injectable argument.

- [x] **Step 1: Add failing parser and formatter tests**

Import both helpers in `src/cli.test.ts` and add:

```ts
describe("context budget", () => {
  it("leaves an absent budget unset", () => {
    expect(parseContextBudget(undefined)).toBeUndefined();
  });

  it("parses a positive safe integer", () => {
    expect(parseContextBudget("100000")).toBe(100_000);
  });

  it.each(["", "0", "-1", "1.5", "abc", "9007199254740992"])(
    "rejects an invalid budget: %s",
    (value) => {
      expect(() => parseContextBudget(value)).toThrow(
        "MICRO_AGENT_CONTEXT_BUDGET must be a positive safe integer",
      );
    },
  );

  it.each([
    { tokens: undefined, budget: undefined, expected: "agent> " },
    { tokens: undefined, budget: 100_000, expected: "agent> " },
    { tokens: 42_103, budget: undefined, expected: "agent [context 42,103]> " },
    {
      tokens: 42_103,
      budget: 100_000,
      expected: "agent [context 42,103/100,000 · 42%]> ",
    },
  ])("formats exact context state: $expected", ({ tokens, budget, expected }) => {
    expect(formatAgentPrompt(tokens, budget)).toBe(expected);
  });
});
```

- [x] **Step 2: Run the focused tests and verify RED**

Run `pnpm test src/cli.test.ts`. Expected: missing helper exports fail.

- [x] **Step 3: Implement parser and prompt formatter**

Add to `src/cli.ts`:

```ts
const CONTEXT_BUDGET_ERROR =
  "MICRO_AGENT_CONTEXT_BUDGET must be a positive safe integer";

export function parseContextBudget(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(CONTEXT_BUDGET_ERROR);
  const budget = Number(value);
  if (!Number.isSafeInteger(budget)) throw new Error(CONTEXT_BUDGET_ERROR);
  return budget;
}

export function formatAgentPrompt(
  inputTokens: number | undefined,
  budget: number | undefined,
) {
  if (inputTokens === undefined) return "agent> ";
  const count = inputTokens.toLocaleString("en-US");
  if (budget === undefined) return `agent [context ${count}]> `;
  const percentage = Math.round((inputTokens / budget) * 100);
  return `agent [context ${count}/${budget.toLocaleString("en-US")} · ${percentage}%]> `;
}
```

Add the final `runCli` parameter:

```ts
contextBudget = parseContextBudget(process.env.MICRO_AGENT_CONTEXT_BUDGET),
```

Initialize `let latestInputTokens: number | undefined;`, pass both values to `formatAgentPrompt()` at `rl.question()`, and reset the count after successful `/new` or `/history` switching.

- [x] **Step 4: Run focused tests and verify GREEN**

Run `pnpm test src/cli.test.ts && pnpm exec tsc --noEmit`.

- [x] **Step 5: Commit prompt configuration**

```bash
git add src/cli.ts src/cli.test.ts docs/superpowers/plans/2026-09-15-context-budget-preflight.md
git commit -m "feat(cli): add context budget prompt"
```

---

### Task 2: Publish Exact Response Usage

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/agent.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Extends `AgentRunOptions` with `onContextMeasured?: (inputTokens: number) => void`.
- `response.usage.input_tokens` is the only source for post-response measurements.

- [ ] **Step 1: Add failing agent usage tests**

Add an `onContextMeasured` spy to a one-response agent test. Return a response fixture containing `usage: { input_tokens: 321 }` and assert:

```ts
expect(onContextMeasured).toHaveBeenCalledOnce();
expect(onContextMeasured).toHaveBeenCalledWith(321);
```

Add a second fixture without `usage` and assert the callback is not called, preserving compatibility with existing minimal mocks.

- [ ] **Step 2: Add a failing CLI prompt progression test**

Use a custom agent that calls `options.onContextMeasured?.(42_103)` during the first request. Assert the prompt mock received `"agent> "` first and `"agent [context 42,103]> "` next. Repeat with a `100_000` final budget argument and expect `42%`.

- [ ] **Step 3: Run focused tests and verify RED**

Run `pnpm test src/agent.test.ts src/cli.test.ts`. Expected: the callback is absent and prompts stay `agent> `.

- [ ] **Step 4: Publish response usage and wire the CLI**

In `src/agent.ts`, add the callback to `AgentRunOptions`. Immediately after a successful response and before processing its output:

```ts
if (response.usage) {
  options.onContextMeasured?.(response.usage.input_tokens);
}
```

In `src/cli.ts`, pass:

```ts
onContextMeasured: (inputTokens) => {
  latestInputTokens = inputTokens;
},
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run `pnpm test src/agent.test.ts src/cli.test.ts && pnpm exec tsc --noEmit`.

- [ ] **Step 6: Commit exact response usage**

```bash
git add src/agent.ts src/agent.test.ts src/cli.ts src/cli.test.ts docs/superpowers/plans/2026-09-15-context-budget-preflight.md
git commit -m "feat(agent): report exact input usage"
```

---

### Task 3: Preflight and Enforce the Budget

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/agent.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Extends `AgentRunOptions` with `contextBudget?: number` and `onContextWarning?: (inputTokens: number, budget: number) => void`.
- Produces exported `ContextBudgetExceededError` for the CLI's actionable error message.
- Calls `openai.responses.inputTokens.count(request, { signal })` only when the conservative gate reaches 80% or prior measurement cannot safely apply.

- [ ] **Step 1: Extend the OpenAI mock and add failing preflight tests**

Add hoisted `count: vi.fn()`, expose it as `responses.inputTokens.count`, and reset it before each test. Cover these independent cases:

```ts
// Tiny request, huge budget: count is not called; create is called.
// No prior exact count and byte upper bound reaches 80%: count receives the
// same model, instructions, tools, and input as create.
// Prior response usage plus newly appended UTF-8 bytes stays below 80%:
// the next step does not count.
// A changed model or a request smaller than the last exactly measured request
// forces count because uncertainty is unsafe.
```

Inspect arguments rather than reusing production estimators. Assert no request contains `truncation: "auto"`.

- [ ] **Step 2: Add failing hard-block and failure tests**

With budget `100`, make count return `101`; assert `responses.create` is not called, the run rejects with `ContextBudgetExceededError`, the exact `101` is published, and the agent's stable checkpoint is used by the next request. Make count reject in another test; assert create is not called and Journal `model_error` data has `phase: "input_token_count"`.

- [ ] **Step 3: Add failing warning-period tests**

Return exact counts `80`, `90`, `79`, `80` under budget `100`. Assert warning callback counts are `[80, 80]`: one warning in the first continuous high period, reset below 80, then one new warning.

- [ ] **Step 4: Run agent tests and verify RED**

Run `pnpm test src/agent.test.ts`. Expected: no input-token call, enforcement, warning state, or specialized error exists.

- [ ] **Step 5: Implement the conservative gate and exact state**

Inside `createAgent`, retain:

```ts
let exactMeasurement:
  | { inputTokens: number; requestBytes: number; model: string }
  | undefined;
let highUsageWarningShown = false;
```

Use `Buffer.byteLength(JSON.stringify(request), "utf8")` as a conservative upper bound. Tokens cannot exceed bytes; it is only a preflight gate. Preflight when there is no prior exact measurement and full request bytes reach `budget * 0.8`; with a prior same-model measurement and nonshrinking request, preflight when `inputTokens + byteGrowth` reaches that boundary; otherwise preflight because uncertainty cannot be bounded safely.

Centralize exact-state publication in one local function that replaces the old measurement, calls `onContextMeasured`, warns once at or above 80%, and resets warning state below 80%.

- [ ] **Step 6: Call exact preflight before create and block over budget**

Journal the assembled `model_request` first. Initialize the SDK client, run required count with the complete request and abort signal, publish the exact count, then:

```ts
if (count.input_tokens > contextBudget) {
  throw new ContextBudgetExceededError(count.input_tokens, contextBudget);
}
```

Only then call `responses.create()`. Tag count failures in existing `model_error` data with `phase: "input_token_count"`; never fall through. After a successful response, replace exact state from `response.usage.input_tokens` and the byte size of that request.

- [ ] **Step 7: Wire warnings and actionable hard-limit output in CLI**

Pass `contextBudget`, the measurement callback, and:

```ts
onContextWarning: (inputTokens, budget) => {
  console.error(`WARNING: context usage is ${inputTokens}/${budget} tokens (at least 80%).`);
},
```

In the request catch, print `ContextBudgetExceededError.message`, which instructs `/new`, increasing `MICRO_AGENT_CONTEXT_BUDGET`, or waiting for compaction; retain the existing generic failure message for all other errors.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run `pnpm test src/agent.test.ts src/cli.test.ts && pnpm exec tsc --noEmit`.

- [ ] **Step 9: Commit exact preflight enforcement**

```bash
git add src/agent.ts src/agent.test.ts src/cli.ts src/cli.test.ts docs/superpowers/plans/2026-09-15-context-budget-preflight.md
git commit -m "feat(agent): enforce context budget"
```

---

### Task 4: Document and Verify PRI-295

**Files:**
- Modify: `README.md`
- Verify: `src/agent.ts`, `src/agent.test.ts`, `src/cli.ts`, `src/cli.test.ts`

- [ ] **Step 1: Document configuration and exact semantics**

Document `MICRO_AGENT_CONTEXT_BUDGET`, all three prompt forms, 80% exact preflight/warning behavior, the strict `>100%` block, and that no-budget mode displays response usage without imposing a limit. State that estimates are never displayed and automatic truncation/compaction remain disabled.

- [ ] **Step 2: Run complete verification**

Run separately and require exit code 0:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

- [ ] **Step 3: Audit the scoped diff**

Verify no new dependency/module, no `truncation: "auto"`, no compaction, complete preflight request equality, stable checkpoint after failures, and exact-only display/enforcement.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/superpowers/plans/2026-09-15-context-budget-preflight.md
git commit -m "docs: explain context budget"
```

- [ ] **Step 5: Run post-commit verification**

Run `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm lint`, and `git status --short --branch`.

- [ ] **Step 6: Update Linear only after verification**

Set PRI-295 to Done with `linear_save_issue(state: "Done")`, verify with `linear_get_issue`, and leave PRI-296 in Backlog. Do not create a PR or MR unless explicitly requested.
