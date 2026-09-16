import { isCancel, select } from "@clack/prompts";
import type { ResponseInput } from "openai/resources/responses/responses";
import {
	Agent,
	type AgentResult,
	ContextBudgetExceededError,
	DEFAULT_MODEL,
	UnsavedCompactionError,
} from "./agent.js";
import {
	Conversation,
	type ConversationState,
	type ConversationStore,
} from "./conversations.js";
import type { Journal } from "./journal.js";

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
	compacted = false,
) {
	if (inputTokens === undefined)
		return compacted ? "agent [· compacted]> " : "agent> ";
	const count = inputTokens.toLocaleString("en-US");
	if (budget === undefined)
		return `agent [context ${count}${compacted ? " · compacted" : ""}]> `;
	const percentage = Math.round((inputTokens / budget) * 100);
	return `agent [context ${count}/${budget.toLocaleString("en-US")} · ${percentage}%${compacted ? " · compacted" : ""}]> `;
}

interface CliPrompt {
	question(query: string): Promise<string>;
	pause(): void;
	resume(): void;
	close(): void;
	once(event: "SIGINT", listener: () => void): this;
	off(event: "SIGINT", listener: () => void): this;
}

export interface ConversationChoice {
	value: string;
	label: string;
}

export type ConversationSelector = (
	choices: ConversationChoice[],
) => Promise<string | undefined>;

export async function selectSavedConversation(choices: ConversationChoice[]) {
	const selected = await select({
		message: "Select a conversation",
		options: choices,
	});
	if (isCancel(selected)) return undefined;
	return typeof selected === "string" ? selected : undefined;
}

function conversationChoice(
	conversation: ConversationState,
): ConversationChoice {
	return {
		value: conversation.id,
		label: `${new Date(conversation.updatedAt).toLocaleString()}  ${conversation.id}  ${conversation.title}`,
	};
}

interface SignalSource {
	once(event: "SIGINT", listener: () => void): unknown;
	off(event: "SIGINT", listener: () => void): unknown;
}

/** A checkpoint that could not be saved; the next prompt retries exactly that write. */
type UnsavedCheckpoint =
	| { kind: "final"; result: AgentResult }
	| { kind: "compaction"; input: ResponseInput; model: string };

interface CliOptions {
	prompt: CliPrompt;
	journal: Journal;
	conversations: ConversationStore;
	createAgent: (input: ResponseInput) => Agent;
	signals: SignalSource;
	selectConversation: ConversationSelector;
	currentModel: string;
	contextBudget: number | undefined;
}

/**
 * One CLI run: it keeps the active conversation, runs one user request at a
 * time, and reports everything to the journal.
 */
export class Cli {
	#prompt: CliPrompt;
	#journal: Journal;
	#conversations: ConversationStore;
	#createAgent: (input: ResponseInput) => Agent;
	#signals: SignalSource;
	#selectConversation: ConversationSelector;
	#currentModel: string;
	#contextBudget: number | undefined;

	#conversation: Conversation;
	#agent: Agent;
	#requestNumber = 0;
	#stopping = false;
	#activeRequest: AbortController | undefined;
	#unsaved: UnsavedCheckpoint | undefined;
	#showCompacted = false;
	#latestInputTokens: number | undefined;
	// Declared before #interrupted: its initializer fills this in.
	#resolveInterrupt: (() => void) | undefined;
	#interrupted = new Promise<boolean>((resolve) => {
		this.#resolveInterrupt = () => resolve(true);
	});

	constructor(options: CliOptions) {
		this.#prompt = options.prompt;
		this.#journal = options.journal;
		this.#conversations = options.conversations;
		this.#createAgent = options.createAgent;
		this.#signals = options.signals;
		this.#selectConversation = options.selectConversation;
		this.#currentModel = options.currentModel;
		this.#contextBudget = options.contextBudget;
		this.#conversation = options.conversations.create();
		this.#agent = options.createAgent(this.#conversation.input);
	}

	/** Ctrl-C ends the run and aborts the model request that is in flight. */
	#handleSigint = () => {
		this.#stopping = true;
		this.#activeRequest?.abort();
		this.#resolveInterrupt?.();
	};

	async run() {
		this.#prompt.once("SIGINT", this.#handleSigint);
		this.#signals.once("SIGINT", this.#handleSigint);
		let interrupted: boolean;
		try {
			// The question promise does not settle on Ctrl-C, so the run races it.
			interrupted = await Promise.race([this.#promptLoop(), this.#interrupted]);
		} finally {
			this.#prompt.off("SIGINT", this.#handleSigint);
			this.#signals.off("SIGINT", this.#handleSigint);
			this.#prompt.close();
		}
		if (interrupted) {
			console.log();
		}
		await this.#journal.finish({ requestCount: this.#requestNumber });

		return { interrupted };
	}

	async #promptLoop() {
		while (!this.#stopping) {
			const prompt = (
				await this.#prompt.question(
					formatAgentPrompt(
						this.#latestInputTokens,
						this.#contextBudget,
						this.#showCompacted,
					),
				)
			).trim();
			// The marker describes the previous request only.
			this.#showCompacted = false;
			if (!prompt) {
				continue;
			}

			if (prompt === "exit" || prompt === "quit") {
				if (this.#unsaved) {
					console.error(
						"WARNING: UNSAVED conversation checkpoint will be lost on exit.",
					);
				}
				return false;
			}

			if (!(await this.#retryUnsavedCheckpoint())) {
				continue;
			}

			if (prompt === "/new") {
				this.#conversation = this.#conversations.create();
				this.#agent = this.#createAgent(this.#conversation.input);
				this.#latestInputTokens = undefined;
				continue;
			}

			if (prompt === "/history") {
				await this.#switchConversation();
				continue;
			}

			await this.#runRequest(prompt);
		}
		return true;
	}

	/**
	 * Retries the checkpoint save that failed earlier. Returns false when the
	 * typed prompt must be skipped: either the save failed again, or a compacted
	 * checkpoint was saved, which continues the request that was already started.
	 */
	async #retryUnsavedCheckpoint() {
		const unsaved = this.#unsaved;
		if (!unsaved) return true;
		try {
			if (unsaved.kind === "compaction") {
				await this.#conversation.saveCompactionCheckpoint(
					unsaved.input,
					unsaved.model,
				);
				this.#unsaved = undefined;
				this.#agent = this.#createAgent(this.#conversation.input);
				this.#showCompacted = true;
				return false;
			}
			await this.#conversation.commitCheckpoint(
				unsaved.result.input,
				unsaved.result.model,
			);
			this.#unsaved = undefined;
			return true;
		} catch {
			console.error(
				"UNSAVED: checkpoint persistence still fails; request was not started.",
			);
			return false;
		}
	}

	async #switchConversation() {
		const { conversations, invalidFileCount } =
			await this.#conversations.list();
		if (invalidFileCount > 0) {
			console.error(
				`WARNING: skipped ${invalidFileCount} invalid conversation file(s).`,
			);
		}
		if (conversations.length === 0) {
			console.log("No saved conversations.");
			return;
		}

		this.#prompt.pause();
		let selectedId: string | undefined;
		try {
			selectedId = await this.#selectConversation(
				conversations.map(conversationChoice),
			);
		} finally {
			this.#prompt.resume();
		}
		if (!selectedId) return;

		try {
			const listed = conversations.find(
				(candidate) => candidate.id === selectedId,
			);
			const loaded = await this.#conversations.load(selectedId);
			// A writer changed the file between listing and loading it; revision
			// and updatedAt both advance on every save.
			if (
				!listed ||
				loaded.revision !== listed.revision ||
				loaded.updatedAt !== listed.updatedAt
			) {
				throw new Error("Conversation changed after listing");
			}
			this.#conversation = new Conversation(this.#conversations, loaded);
			this.#agent = this.#createAgent(loaded.input);
			this.#latestInputTokens = undefined;
			this.#warnAboutRestoredWork(loaded);
		} catch {
			console.error(
				"WARNING: selected conversation could not be loaded; current conversation is unchanged.",
			);
		}
	}

	#warnAboutRestoredWork(conversation: ConversationState) {
		if (conversation.pendingRequest) {
			console.error(
				`WARNING: incomplete request was not resumed: ${conversation.pendingRequest.prompt}`,
			);
			for (const tool of conversation.pendingRequest.tools) {
				console.error(
					`WARNING: tool ${tool.name} (${tool.callId}): ${tool.status}.`,
				);
			}
		}
		if (
			conversation.lastModel &&
			conversation.lastModel !== this.#currentModel
		) {
			console.error(
				`WARNING: conversation last used ${conversation.lastModel}; current model is ${this.#currentModel}.`,
			);
		}
	}

	async #runRequest(prompt: string) {
		if (this.#conversation.blockingTool()) {
			console.error("WARNING: a started tool blocks the next model call.");
			return;
		}
		const controller = new AbortController();
		this.#activeRequest = controller;
		this.#requestNumber++;
		try {
			await this.#conversation.startRequest(prompt);
			const result = await this.#agent.run(prompt, {
				journal: this.#journal,
				requestNumber: this.#requestNumber,
				conversationId: this.#conversation.id,
				signal: controller.signal,
				...(this.#contextBudget === undefined
					? {}
					: { contextBudget: this.#contextBudget }),
				onContextMeasured: (inputTokens) => {
					this.#latestInputTokens = inputTokens;
				},
				onContextWarning: (inputTokens, budget) => {
					console.error(
						`WARNING: context usage is ${inputTokens}/${budget} tokens (at least 80%).`,
					);
				},
				onToolStarted: async (tool) => {
					await this.#conversation.markToolStarted(tool);
				},
				onToolFinished: async (callId) => {
					await this.#conversation.markToolFinished(callId);
				},
				onModelStepBoundary: async () => {
					if (this.#conversation.blockingTool())
						throw new Error("Started tool blocks the next model step");
				},
				onCompacted: async (input, model) => {
					await this.#conversation.saveCompactionCheckpoint(input, model);
					this.#showCompacted = true;
				},
			});

			console.log(`\n${result.answer}\n`);
			try {
				await this.#conversation.commitCheckpoint(result.input, result.model);
			} catch {
				this.#unsaved = { kind: "final", result };
				console.error(
					"UNSAVED: final checkpoint persistence failed; later work is blocked.",
				);
			}
		} catch (error) {
			if (error instanceof UnsavedCompactionError) {
				this.#unsaved = {
					kind: "compaction",
					input: structuredClone(error.input),
					model: error.model,
				};
				console.error(
					"UNSAVED: compacted checkpoint persistence failed; only retrying the same save or exit is allowed.",
				);
			} else if (!this.#stopping) {
				if (error instanceof ContextBudgetExceededError) {
					console.error(error.message);
				} else if (this.#showCompacted) {
					console.error(
						"Request failed after the compacted checkpoint was saved; model and tool work stopped.",
					);
				} else {
					console.error(
						"Request failed; checkpoint was not advanced. See the journal for details.",
					);
				}
			}
		} finally {
			this.#activeRequest = undefined;
		}
	}
}

export async function runCli(
	rl: CliPrompt,
	journal: Journal,
	conversationStore: ConversationStore,
	createAgentForInput: (input: ResponseInput) => Agent = (input) =>
		new Agent(input),
	signals: SignalSource = process,
	selectConversation: ConversationSelector = selectSavedConversation,
	currentModel = process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
	contextBudget = parseContextBudget(process.env.MICRO_AGENT_CONTEXT_BUDGET),
) {
	return await new Cli({
		prompt: rl,
		journal,
		conversations: conversationStore,
		createAgent: createAgentForInput,
		signals,
		selectConversation,
		currentModel,
		contextBudget,
	}).run();
}
