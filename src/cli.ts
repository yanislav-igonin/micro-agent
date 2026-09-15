import { isCancel, select } from "@clack/prompts";
import type { ResponseInput } from "openai/resources/responses/responses";
import {
	type AgentResult,
	ContextBudgetExceededError,
	createAgent,
	UnsavedCompactionError,
} from "./agent.js";
import type { ConversationState, ConversationStore } from "./conversations.js";
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

export async function runCli(
	rl: CliPrompt,
	journal: Journal,
	conversationStore: ConversationStore,
	createAgentForInput = createAgent,
	signals: SignalSource = process,
	selectConversation: ConversationSelector = selectSavedConversation,
	currentModel = process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
	contextBudget = parseContextBudget(process.env.MICRO_AGENT_CONTEXT_BUDGET),
) {
	let requestNumber = 0;
	let stopping = false;
	let activeRequest: AbortController | undefined;
	let conversation = conversationStore.createConversation();
	let agent = createAgentForInput(conversation.input);
	let unsaved:
		| { kind: "final"; result: AgentResult }
		| { kind: "compaction"; input: ResponseInput; model: string }
		| undefined;
	let showCompacted = false;
	let latestInputTokens: number | undefined;
	let interrupt: () => void = () => {};
	const interrupted = new Promise<true>((resolve) => {
		interrupt = () => {
			stopping = true;
			activeRequest?.abort();
			resolve(true);
		};
	});

	rl.once("SIGINT", interrupt);
	signals.once("SIGINT", interrupt);

	const promptLoop = async () => {
		while (!stopping) {
			const promptText = formatAgentPrompt(
				latestInputTokens,
				contextBudget,
				showCompacted,
			);
			showCompacted = false;
			const prompt = (await rl.question(promptText)).trim();

			if (!prompt) {
				continue;
			}

			if (prompt === "exit" || prompt === "quit") {
				if (unsaved) {
					console.error(
						"WARNING: UNSAVED conversation checkpoint will be lost on exit.",
					);
				}
				return false;
			}

			if (unsaved) {
				try {
					conversation =
						unsaved.kind === "compaction"
							? await conversationStore.saveCompactionCheckpoint(
									conversation,
									unsaved.input,
									unsaved.model,
								)
							: await conversationStore.commitCheckpoint(
									conversation,
									unsaved.result.input,
									unsaved.result.model,
								);
					const wasCompaction = unsaved.kind === "compaction";
					unsaved = undefined;
					if (wasCompaction) {
						agent = createAgentForInput(conversation.input);
						showCompacted = true;
						continue;
					}
				} catch {
					console.error(
						"UNSAVED: checkpoint persistence still fails; request was not started.",
					);
					continue;
				}
			}

			if (prompt === "/new") {
				conversation = conversationStore.createConversation();
				agent = createAgentForInput(conversation.input);
				latestInputTokens = undefined;
				continue;
			}

			if (prompt === "/history") {
				const { conversations, invalidFileCount } =
					await conversationStore.listConversations();
				if (invalidFileCount > 0) {
					console.error(
						`WARNING: skipped ${invalidFileCount} invalid conversation file(s).`,
					);
				}
				if (conversations.length === 0) {
					console.log("No saved conversations.");
					continue;
				}

				rl.pause();
				let selectedId: string | undefined;
				try {
					selectedId = await selectConversation(
						conversations.map(conversationChoice),
					);
				} finally {
					rl.resume();
				}
				if (!selectedId) continue;

				try {
					const listedConversation = conversations.find(
						(candidate) => candidate.id === selectedId,
					);
					const loadedConversation =
						await conversationStore.loadConversation(selectedId);
					if (
						!listedConversation ||
						JSON.stringify(loadedConversation) !==
							JSON.stringify(listedConversation)
					) {
						throw new Error("Conversation changed after listing");
					}
					const loadedAgent = createAgentForInput(loadedConversation.input);
					conversation = loadedConversation;
					agent = loadedAgent;
					latestInputTokens = undefined;
					if (loadedConversation.pendingRequest) {
						console.error(
							`WARNING: incomplete request was not resumed: ${loadedConversation.pendingRequest.prompt}`,
						);
						for (const tool of loadedConversation.pendingRequest.tools) {
							console.error(
								`WARNING: tool ${tool.name} (${tool.callId}): ${tool.status}.`,
							);
						}
					}
					if (
						loadedConversation.lastModel &&
						loadedConversation.lastModel !== currentModel
					) {
						console.error(
							`WARNING: conversation last used ${loadedConversation.lastModel}; current model is ${currentModel}.`,
						);
					}
				} catch {
					console.error(
						"WARNING: selected conversation could not be loaded; current conversation is unchanged.",
					);
				}
				continue;
			}

			const controller = new AbortController();
			if (
				conversation.pendingRequest?.tools.some(
					(tool) => tool.status === "started",
				)
			) {
				console.error("WARNING: a started tool blocks the next model call.");
				continue;
			}
			activeRequest = controller;
			requestNumber++;
			try {
				conversation = await conversationStore.startRequest(
					conversation,
					prompt,
				);
				const result = await agent(prompt, journal, requestNumber, {
					conversationId: conversation.id,
					signal: controller.signal,
					...(contextBudget === undefined ? {} : { contextBudget }),
					onContextMeasured: (inputTokens) => {
						latestInputTokens = inputTokens;
					},
					onContextWarning: (inputTokens, budget) => {
						console.error(
							`WARNING: context usage is ${inputTokens}/${budget} tokens (at least 80%).`,
						);
					},
					onToolStarted: async (tool) => {
						conversation = await conversationStore.markToolStarted(
							conversation,
							tool,
						);
					},
					onToolFinished: async (callId) => {
						conversation = await conversationStore.markToolFinished(
							conversation,
							callId,
						);
					},
					onModelStepBoundary: async () => {
						if (
							conversation.pendingRequest?.tools.some(
								(tool) => tool.status === "started",
							)
						)
							throw new Error("Started tool blocks the next model step");
					},
					onCompacted: async (input, model) => {
						conversation = await conversationStore.saveCompactionCheckpoint(
							conversation,
							input,
							model,
						);
						showCompacted = true;
					},
				});

				console.log(`\n${result.answer}\n`);
				try {
					conversation = await conversationStore.commitCheckpoint(
						conversation,
						result.input,
						result.model,
					);
				} catch {
					unsaved = { kind: "final", result };
					console.error(
						"UNSAVED: final checkpoint persistence failed; later work is blocked.",
					);
				}
			} catch (error) {
				if (error instanceof UnsavedCompactionError) {
					unsaved = {
						kind: "compaction",
						input: structuredClone(error.input),
						model: error.model,
					};
					console.error(
						"UNSAVED: compacted checkpoint persistence failed; only retrying the same save or exit is allowed.",
					);
				}
				if (!stopping) {
					if (!(error instanceof UnsavedCompactionError))
						console.error(
							error instanceof ContextBudgetExceededError
								? error.message
								: showCompacted
									? "Request failed after the compacted checkpoint was saved; model and tool work stopped."
									: "Request failed; checkpoint was not advanced. See the journal for details.",
						);
				}
			} finally {
				activeRequest = undefined;
			}
		}
		return true;
	};

	let wasInterrupted: boolean;
	try {
		wasInterrupted = await Promise.race([promptLoop(), interrupted]);
	} finally {
		rl.off("SIGINT", interrupt);
		signals.off("SIGINT", interrupt);
		rl.close();
	}

	if (wasInterrupted) {
		console.log();
	}
	await journal.finish({ requestCount: requestNumber });

	return { interrupted: wasInterrupted };
}
