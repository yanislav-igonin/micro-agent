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
			return typeof value.content === "string";
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

export async function createConversationStore(
	root = process.cwd(),
	options: ConversationStoreOptions = {},
) {
	const directory = path.join(root, "conversations");
	const createId = options.createId ?? (() => randomBytes(6).toString("hex"));
	const now = options.now ?? (() => new Date());
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await fs.lstat(directory)).isDirectory()) {
		throw new Error("Conversation storage path must be a directory");
	}
	// mkdir's mode does not tighten an already existing directory.
	await fs.chmod(directory, 0o700);

	function generateId() {
		const id = createId();
		if (!ID_PATTERN.test(id)) {
			throw new Error("Invalid generated conversation ID");
		}
		return id;
	}

	function nextTimestamp(previous: string) {
		const currentTime = now().valueOf();
		const previousTime = new Date(previous).valueOf();
		return new Date(Math.max(currentTime, previousTime + 1)).toISOString();
	}

	function hasErrorCode(error: unknown, code: string) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === code
		);
	}

	async function writeTemporaryState(state: ConversationState) {
		const serializedState = `${JSON.stringify(state, null, 2)}\n`;
		parseState(serializedState, state.id);
		const temporaryPath = path.join(
			directory,
			`.${state.id}.${randomBytes(6).toString("hex")}.tmp`,
		);
		await fs.writeFile(temporaryPath, serializedState, {
			flag: "wx",
			mode: 0o600,
		});
		return temporaryPath;
	}

	async function removeTemporaryFile(temporaryPath: string) {
		try {
			await fs.rm(temporaryPath, { force: true });
		} catch {
			// Leftover temporary files are ignored by loading and listing.
		}
	}

	async function readStateFile(statePath: string, expectedId: string) {
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

	async function writeState(
		state: ConversationState,
		expectedRevision: number,
	) {
		if (!ID_PATTERN.test(state.id)) {
			throw new Error(`Invalid conversation ID: ${state.id}`);
		}
		if (expectedRevision > 0) {
			const targetPath = path.join(directory, `${state.id}.json`);
			const current = await readStateFile(targetPath, state.id);
			if (current.revision !== expectedRevision) {
				throw new Error(
					`Conversation revision mismatch: expected ${expectedRevision}, found ${current.revision}`,
				);
			}
			const temporaryPath = await writeTemporaryState(state);
			try {
				await fs.rename(temporaryPath, targetPath);
				return state;
			} finally {
				await removeTemporaryFile(temporaryPath);
			}
		}

		let stateToWrite = state;
		while (true) {
			const targetPath = path.join(directory, `${stateToWrite.id}.json`);
			const temporaryPath = await writeTemporaryState(stateToWrite);
			try {
				try {
					// A hard link publishes the complete first state without an empty target.
					await fs.link(temporaryPath, targetPath);
					return stateToWrite;
				} catch (error) {
					if (!hasErrorCode(error, "EEXIST")) throw error;
					stateToWrite = { ...stateToWrite, id: generateId() };
				}
			} finally {
				await removeTemporaryFile(temporaryPath);
			}
		}
	}

	async function saveMutation(
		conversation: ConversationState,
		changes: Partial<ConversationState>,
		timestamp = nextTimestamp(conversation.updatedAt),
	) {
		const next = {
			...conversation,
			...changes,
			updatedAt: timestamp,
			revision: conversation.revision + 1,
		} satisfies ConversationState;
		return writeState(next, conversation.revision);
	}

	return {
		createConversation(): ConversationState {
			const timestamp = now().toISOString();
			return {
				schemaVersion: 1,
				id: generateId(),
				title: "",
				createdAt: timestamp,
				updatedAt: timestamp,
				revision: 0,
				lastModel: null,
				input: [],
				pendingRequest: null,
			};
		},
		async startRequest(conversation: ConversationState, prompt: string) {
			const timestamp = nextTimestamp(conversation.updatedAt);
			return saveMutation(
				conversation,
				{
					title: conversation.title || createTitle(prompt),
					pendingRequest: {
						prompt,
						startedAt: timestamp,
						tools: [],
					},
				},
				timestamp,
			);
		},
		async markToolStarted(
			conversation: ConversationState,
			tool: Omit<PendingTool, "status">,
		) {
			if (!conversation.pendingRequest) {
				throw new Error("Conversation has no pending request");
			}
			return saveMutation(conversation, {
				pendingRequest: {
					...conversation.pendingRequest,
					tools: [
						...conversation.pendingRequest.tools,
						{ ...tool, status: "started" },
					],
				},
			});
		},
		async markToolFinished(conversation: ConversationState, callId: string) {
			if (!conversation.pendingRequest) {
				throw new Error("Conversation has no pending request");
			}
			const tool = conversation.pendingRequest.tools.find(
				(candidate) => candidate.callId === callId,
			);
			if (!tool) {
				throw new Error(`Pending tool not found: ${callId}`);
			}
			return saveMutation(conversation, {
				pendingRequest: {
					...conversation.pendingRequest,
					tools: conversation.pendingRequest.tools.map((candidate) =>
						candidate.callId === callId
							? { ...candidate, status: "finished" }
							: candidate,
					),
				},
			});
		},
		async commitCheckpoint(
			conversation: ConversationState,
			input: ResponseInput,
			lastModel: string | null,
		) {
			return saveMutation(conversation, {
				input: structuredClone(input),
				lastModel,
				pendingRequest: null,
			});
		},
		async loadConversation(id: string) {
			if (!ID_PATTERN.test(id)) {
				throw new Error(`Invalid conversation ID: ${id}`);
			}
			const statePath = path.join(directory, `${id}.json`);
			return readStateFile(statePath, id);
		},
		async listConversations() {
			const conversations: ConversationState[] = [];
			let invalidFileCount = 0;
			for (const entry of await fs.readdir(directory, {
				withFileTypes: true,
			})) {
				const filename = entry.name;
				if (!filename.endsWith(".json")) continue;
				try {
					if (!entry.isFile()) {
						throw new Error("Conversation state path must be a regular file");
					}
					const id = filename.slice(0, -".json".length);
					const statePath = path.join(directory, filename);
					conversations.push(await readStateFile(statePath, id));
				} catch {
					invalidFileCount++;
				}
			}
			conversations.sort((left, right) =>
				right.updatedAt.localeCompare(left.updatedAt),
			);
			return { conversations, invalidFileCount };
		},
	};
}

export type ConversationStore = Awaited<
	ReturnType<typeof createConversationStore>
>;
