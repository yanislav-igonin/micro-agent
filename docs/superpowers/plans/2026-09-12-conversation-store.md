# Conversation Store Implementation Plan

> **For implementation:** Follow each red/green step inline in this session. The user requested one final focused commit, so do not commit between tasks.

**Goal:** Add the project-local, revision-guarded Conversation Store defined by PRI-289 without integrating it into the agent or CLI.

**Architecture:** Add one `src/conversations.ts` module with schema types and a `createConversationStore()` factory. The factory owns direct filesystem operations for one `conversations/` directory; no repository class, service layer, or generic dependency container is introduced.

**Tech Stack:** TypeScript, Node.js `crypto`/`fs`/`path`, OpenAI `ResponseInput`, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-12-conversation-persistence-design.md`

## Global Constraints

- Implement only PRI-289: store, schema, atomic save, revision guard, validation, sorting, permissions, Git ignore, tests.
- Do not modify agent execution, CLI commands, or journal correlation from PRI-290/PRI-291.
- Use one production module and one focused test module.
- Persist only direct `conversations/*.json` files with schema version `1`.
- Use directory mode `0700`, file mode `0600`, and a same-directory temporary file plus `rename`.

### Task 1: Define lifecycle and round-trip behavior

**Files:**

- Create: `src/conversations.test.ts`
- Create: `src/conversations.ts`

**Interfaces:**

- Produces: `createConversationStore(root, options?)`
- Produces methods: `createConversation`, `startRequest`, `markToolStarted`, `markToolFinished`, `commitCheckpoint`, `loadConversation`, `listConversations`

- [x] **Step 1: Write failing tests**

```ts
const conversation = store.createConversation();
expect(await fs.readdir(path.join(root, "conversations"))).toEqual([]);

const pending = await store.startRequest(conversation, "  Fix\n  this  ");
expect(pending).toMatchObject({ title: "Fix this", revision: 1 });

const committed = await store.commitCheckpoint(pending, mixedInput, "gpt-test");
expect(await store.loadConversation(committed.id)).toEqual(committed);
```

- [x] **Step 2: Run `pnpm test src/conversations.test.ts` and confirm missing-module failure**

- [x] **Step 3: Implement minimal schema, title derivation, state transitions, and JSON round-trip**

```ts
export async function createConversationStore(root = process.cwd(), options = {}) {
  // Return a small object of direct store operations.
}
```

- [x] **Step 4: Re-run focused tests and keep them green**

### Task 2: Add persistence safety and listing validation

**Files:**

- Modify: `src/conversations.test.ts`
- Modify: `src/conversations.ts`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: Task 1 store methods and state types.
- Produces: stale revision rejection, atomic replacement, validation, newest-first list with `invalidFileCount`.

- [x] **Step 1: Add failing tests for ID collision, stale revisions, rename failure, invalid files, sorting, and permissions**

```ts
await expect(store.commitCheckpoint(stale, [], null)).rejects.toThrow(
  "Conversation revision mismatch",
);
expect((await store.listConversations()).invalidFileCount).toBe(4);
```

- [x] **Step 2: Run focused tests and confirm each new behavior fails for the intended reason**

- [x] **Step 3: Implement exclusive first-file reservation, revision validation, temporary-file rename, strict schema checks, sorting, permission tightening, and `conversations/` ignore**

```ts
await fs.writeFile(temporaryPath, serializedState, { flag: "wx", mode: 0o600 });
await fs.rename(temporaryPath, targetPath);
```

- [x] **Step 4: Re-run focused tests and refactor only while green**

### Task 3: Verify, review, fix, and commit

**Files:**

- Review every changed file from Tasks 1-2.

- [x] **Step 1: Run `pnpm test`**
- [x] **Step 2: Run `pnpm exec tsc --noEmit`**
- [x] **Step 3: Run `pnpm lint`**
- [x] **Step 4: Inspect `git diff` and request a read-only code review against PRI-289**
- [x] **Step 5: Fix Critical and Important findings with a failing regression test first**
- [x] **Step 6: Re-run all three verification commands**
- [x] **Step 7: Create one focused commit and verify the resulting clean diff/status**
