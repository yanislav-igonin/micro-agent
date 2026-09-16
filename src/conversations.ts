import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResponseInput } from "openai/resources/responses/responses";

export interface PendingTool {
	callId: string;
	name: string;
	status: "started" | "finished";
}

export interface PendingRequest {
	prompt: string;
	startedAt: string;
	tools: PendingTool[];
}

export interface ConversationState {
	schemaVersion: 1;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	lastModel: string | null;
	input: ResponseInput;
	pendingRequest: PendingRequest | null;
}

const ID_PATTERN = /^[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isItemStatus(value: unknown) {
	return (
		value === "in_progress" || value === "completed" || value === "incomplete"
	);
}

function isCaller(value: unknown) {
	return (
		value === null ||
		(isRecord(value) &&
			(value.type === "direct" ||
				(value.type === "program" && typeof value.caller_id === "string")))
	);
}

function isOutputContent(value: unknown) {
	if (!isRecord(value)) return false;
	if (value.type === "refusal") return typeof value.refusal === "string";
	if (value.type !== "output_text") return false;
	return (
		typeof value.text === "string" &&
		Array.isArray(value.annotations) &&
		value.annotations.every(
			(annotation) =>
				isRecord(annotation) && typeof annotation.type === "string",
		) &&
		(value.logprobs === undefined ||
			(Array.isArray(value.logprobs) && value.logprobs.every(isRecord)))
	);
}

function isResponseInputItem(value: unknown) {
	if (!isRecord(value)) return false;
	if (value.type === undefined || value.type === "message") {
		if (value.role === "user") {
			return (
				typeof value.content === "string" ||
				(value.type === "message" &&
					typeof value.id === "string" &&
					isItemStatus(value.status) &&
					Array.isArray(value.content) &&
					value.content.every(
						(item) =>
							isRecord(item) &&
							item.type === "input_text" &&
							typeof item.text === "string",
					))
			);
		}
		return (
			value.type === "message" &&
			value.role === "assistant" &&
			typeof value.id === "string" &&
			isItemStatus(value.status) &&
			Array.isArray(value.content) &&
			value.content.every(isOutputContent) &&
			(value.phase === undefined ||
				value.phase === null ||
				value.phase === "commentary" ||
				value.phase === "final_answer")
		);
	}
	if (value.type === "compaction") {
		return (
			typeof value.id === "string" &&
			value.id.length > 0 &&
			typeof value.encrypted_content === "string" &&
			value.encrypted_content.length > 0
		);
	}
	if (value.type === "reasoning") {
		return (
			typeof value.id === "string" &&
			Array.isArray(value.summary) &&
			value.summary.every(
				(item) =>
					isRecord(item) &&
					item.type === "summary_text" &&
					typeof item.text === "string",
			) &&
			(value.content === undefined ||
				(Array.isArray(value.content) &&
					value.content.every(
						(item) =>
							isRecord(item) &&
							item.type === "reasoning_text" &&
							typeof item.text === "string",
					))) &&
			(value.encrypted_content === undefined ||
				value.encrypted_content === null ||
				typeof value.encrypted_content === "string") &&
			(value.status === undefined || isItemStatus(value.status))
		);
	}
	if (value.type === "function_call") {
		return (
			typeof value.call_id === "string" &&
			typeof value.name === "string" &&
			typeof value.arguments === "string" &&
			(value.id === undefined || typeof value.id === "string") &&
			(value.async === undefined || typeof value.async === "boolean") &&
			(value.caller === undefined || isCaller(value.caller)) &&
			(value.namespace === undefined || typeof value.namespace === "string") &&
			(value.status === undefined || isItemStatus(value.status))
		);
	}
	if (value.type === "function_call_output") {
		return (
			typeof value.call_id === "string" &&
			typeof value.output === "string" &&
			(value.id === undefined ||
				value.id === null ||
				typeof value.id === "string") &&
			(value.caller === undefined || isCaller(value.caller)) &&
			(value.name === undefined ||
				value.name === null ||
				typeof value.name === "string") &&
			(value.namespace === undefined ||
				value.namespace === null ||
				typeof value.namespace === "string") &&
			(value.status === undefined ||
				value.status === null ||
				isItemStatus(value.status))
		);
	}
	return false;
}

function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isPendingRequest(value: unknown): value is PendingRequest {
	if (!isRecord(value) || !Array.isArray(value.tools)) return false;
	return (
		typeof value.prompt === "string" &&
		isTimestamp(value.startedAt) &&
		value.tools.every(
			(tool) =>
				isRecord(tool) &&
				typeof tool.callId === "string" &&
				typeof tool.name === "string" &&
				(tool.status === "started" || tool.status === "finished"),
		)
	);
}

function parseState(text: string, expectedId: string): ConversationState {
	const value: unknown = JSON.parse(text);
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.id !== "string" ||
		!ID_PATTERN.test(value.id) ||
		value.id !== expectedId ||
		typeof value.title !== "string" ||
		value.title.length === 0 ||
		Array.from(value.title).length > 50 ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt) ||
		typeof value.revision !== "number" ||
		!Number.isInteger(value.revision) ||
		value.revision < 1 ||
		!(value.lastModel === null || typeof value.lastModel === "string") ||
		!Array.isArray(value.input) ||
		!value.input.every(isResponseInputItem) ||
		!(
			value.pendingRequest === undefined ||
			value.pendingRequest === null ||
			isPendingRequest(value.pendingRequest)
		)
	) {
		throw new Error("Invalid conversation state");
	}
	return {
		...value,
		pendingRequest: value.pendingRequest ?? null,
	} as unknown as ConversationState;
}

function createTitle(prompt: string) {
	const normalized = prompt.trim().replaceAll(/\s+/g, " ");
	const codePoints = Array.from(normalized);
	return codePoints.length <= 50
		? normalized
		: `${codePoints.slice(0, 49).join("")}…`;
}

interface ConversationStoreOptions {
	createId?: () => string;
	now?: () => Date;
}

/**
 * One conversation: the input the model sees, the request still in flight, and
 * the mutations the agent loop applies to them.
 *
 * The store reference is a #private field, so a conversation serializes as
 * exactly the state that is written to disk.
 */
export class Conversation {
	readonly schemaVersion = 1;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	lastModel: string | null;
	input: ResponseInput;
	pendingRequest: PendingRequest | null;
	#store: ConversationStore;

	constructor(store: ConversationStore, state: ConversationState) {
		this.#store = store;
		this.id = state.id;
		this.title = state.title;
		this.createdAt = state.createdAt;
		this.updatedAt = state.updatedAt;
		this.revision = state.revision;
		this.lastModel = state.lastModel;
		this.input = state.input;
		this.pendingRequest = state.pendingRequest;
	}

	/** The tool that started but never finished; it blocks compaction and steps. */
	blockingTool() {
		return this.pendingRequest?.tools.find((tool) => tool.status === "started");
	}

	/** Records the user request before any model work for it starts. */
	async startRequest(prompt: string) {
		const timestamp = this.#store.timestampAfter(this.updatedAt);
		return this.#save(
			{
				title: this.title || createTitle(prompt),
				pendingRequest: {
					prompt,
					startedAt: timestamp,
					tools: [],
				},
			},
			timestamp,
		);
	}

	async markToolStarted(tool: Omit<PendingTool, "status">) {
		const pending = this.#requirePendingRequest();
		return this.#save({
			pendingRequest: {
				...pending,
				tools: [...pending.tools, { ...tool, status: "started" }],
			},
		});
	}

	async markToolFinished(callId: string) {
		const pending = this.#requirePendingRequest();
		if (!pending.tools.some((candidate) => candidate.callId === callId)) {
			throw new Error(`Pending tool not found: ${callId}`);
		}
		return this.#save({
			pendingRequest: {
				...pending,
				tools: pending.tools.map((candidate) =>
					candidate.callId === callId
						? { ...candidate, status: "finished" }
						: candidate,
				),
			},
		});
	}

	/** Replaces the checkpoint with the complete input of a finished request. */
	async commitCheckpoint(input: ResponseInput, lastModel: string | null) {
		return this.#save({
			input: structuredClone(input),
			lastModel,
			pendingRequest: null,
		});
	}

	/** Replaces older input with a compacted window without ending the request. */
	async saveCompactionCheckpoint(input: ResponseInput, lastModel: string) {
		this.#requirePendingRequest();
		if (this.blockingTool()) throw new Error("Started tool blocks compaction");
		return this.#save({ input: structuredClone(input), lastModel });
	}

	#requirePendingRequest() {
		if (!this.pendingRequest) {
			throw new Error("Conversation has no pending request");
		}
		return this.pendingRequest;
	}

	/**
	 * Writes the next revision and only then adopts it, so a failed save leaves
	 * this conversation exactly as the saved file still describes it.
	 */
	async #save(changes: Partial<ConversationState>, updatedAt?: string) {
		const next: ConversationState = {
			...this.#snapshot(),
			...changes,
			updatedAt: updatedAt ?? this.#store.timestampAfter(this.updatedAt),
			revision: this.revision + 1,
		};
		Object.assign(this, await this.#store.save(next, this.revision));
		return this;
	}

	#snapshot(): ConversationState {
		return {
			schemaVersion: 1,
			id: this.id,
			title: this.title,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			revision: this.revision,
			lastModel: this.lastModel,
			input: this.input,
			pendingRequest: this.pendingRequest,
		};
	}
}

/**
 * Local conversation files: the operations that create, list, load, and persist
 * them. It never runs the agent or executes tools.
 */
export class ConversationStore {
	#directory: string;
	#createId: () => string;
	#now: () => Date;

	private constructor(root: string, options: ConversationStoreOptions) {
		this.#directory = path.join(root, "conversations");
		this.#createId = options.createId ?? (() => randomBytes(6).toString("hex"));
		this.#now = options.now ?? (() => new Date());
	}

	/** Opens storage, creating the directory when it is missing. */
	static async open(
		root = process.cwd(),
		options: ConversationStoreOptions = {},
	) {
		const store = new ConversationStore(root, options);
		await store.#prepareDirectory();
		return store;
	}

	create(): Conversation {
		const timestamp = this.#now().toISOString();
		return new Conversation(this, {
			schemaVersion: 1,
			id: this.#generateId(),
			title: "",
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			lastModel: null,
			input: [],
			pendingRequest: null,
		});
	}

	/** Reads one saved state; the caller decides whether to adopt it. */
	async load(id: string): Promise<ConversationState> {
		if (!ID_PATTERN.test(id)) {
			throw new Error(`Invalid conversation ID: ${id}`);
		}
		const statePath = path.join(this.#directory, `${id}.json`);
		return await this.#readStateFile(statePath, id);
	}

	async list() {
		const conversations: ConversationState[] = [];
		let invalidFileCount = 0;
		for (const entry of await fs.readdir(this.#directory, {
			withFileTypes: true,
		})) {
			const filename = entry.name;
			if (!filename.endsWith(".json")) continue;
			try {
				if (!entry.isFile()) {
					throw new Error("Conversation state path must be a regular file");
				}
				const id = filename.slice(0, -".json".length);
				const statePath = path.join(this.#directory, filename);
				conversations.push(await this.#readStateFile(statePath, id));
			} catch {
				invalidFileCount++;
			}
		}
		conversations.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
		return { conversations, invalidFileCount };
	}

	/** Next ISO timestamp strictly after `previous`. */
	timestampAfter(previous: string) {
		const currentTime = this.#now().valueOf();
		const previousTime = new Date(previous).valueOf();
		return new Date(Math.max(currentTime, previousTime + 1)).toISOString();
	}

	/**
	 * Low-level write of one revision, used only by `Conversation#save`. Calling
	 * it directly would bypass the conversation's own invariants.
	 */
	async save(
		state: ConversationState,
		expectedRevision: number,
	): Promise<ConversationState> {
		if (!ID_PATTERN.test(state.id)) {
			throw new Error(`Invalid conversation ID: ${state.id}`);
		}

		if (expectedRevision > 0) {
			const targetPath = path.join(this.#directory, `${state.id}.json`);
			const current = await this.#readStateFile(targetPath, state.id);
			if (current.revision !== expectedRevision) {
				throw new Error(
					`Conversation revision mismatch: expected ${expectedRevision}, found ${current.revision}`,
				);
			}
			const temporaryPath = await this.#writeTemporaryState(state);
			try {
				await fs.rename(temporaryPath, targetPath);
				return state;
			} finally {
				await this.#removeTemporaryFile(temporaryPath);
			}
		}

		let stateToWrite = state;
		while (true) {
			const firstPath = path.join(this.#directory, `${stateToWrite.id}.json`);
			const temporaryPath = await this.#writeTemporaryState(stateToWrite);
			try {
				try {
					// A hard link publishes the complete first state without an empty target.
					await fs.link(temporaryPath, firstPath);
					return stateToWrite;
				} catch (error) {
					if (!hasErrorCode(error, "EEXIST")) throw error;
					stateToWrite = { ...stateToWrite, id: this.#generateId() };
				}
			} finally {
				await this.#removeTemporaryFile(temporaryPath);
			}
		}
	}

	async #prepareDirectory() {
		await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
		if (!(await fs.lstat(this.#directory)).isDirectory()) {
			throw new Error("Conversation storage path must be a directory");
		}
		// mkdir's mode does not tighten an already existing directory.
		await fs.chmod(this.#directory, 0o700);
	}

	#generateId() {
		const id = this.#createId();
		if (!ID_PATTERN.test(id)) {
			throw new Error("Invalid generated conversation ID");
		}
		return id;
	}

	async #writeTemporaryState(state: ConversationState) {
		const serializedState = `${JSON.stringify(state, null, 2)}\n`;
		parseState(serializedState, state.id);
		const temporaryPath = path.join(
			this.#directory,
			`.${state.id}.${randomBytes(6).toString("hex")}.tmp`,
		);
		await fs.writeFile(temporaryPath, serializedState, {
			flag: "wx",
			mode: 0o600,
		});
		return temporaryPath;
	}

	async #removeTemporaryFile(temporaryPath: string) {
		try {
			await fs.rm(temporaryPath, { force: true });
		} catch {
			// Leftover temporary files are ignored by loading and listing.
		}
	}

	async #readStateFile(statePath: string, expectedId: string) {
		if (!(await fs.lstat(statePath)).isFile()) {
			throw new Error("Conversation state path must be a regular file");
		}
		const flags =
			constants.O_RDONLY |
			(constants.O_NOFOLLOW || 0) |
			(constants.O_NONBLOCK || 0);
		const handle = await fs.open(statePath, flags);
		try {
			if (!(await handle.stat()).isFile()) {
				throw new Error("Conversation state path must be a regular file");
			}
			const state = parseState(await handle.readFile("utf8"), expectedId);
			await handle.chmod(0o600);
			return state;
		} finally {
			await handle.close();
		}
	}
}

function hasErrorCode(error: unknown, code: string) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}
