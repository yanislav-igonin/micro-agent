import { isCancel, select } from "@clack/prompts";
import { type AgentResult, createAgent } from "./agent.js";
import type { ConversationState, ConversationStore } from "./conversations.js";
import type { Journal } from "./journal.js";

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
) {
	let requestNumber = 0;
	let stopping = false;
	let activeRequest: AbortController | undefined;
	let conversation = conversationStore.createConversation();
	let agent = createAgentForInput(conversation.input);
	let unsaved: AgentResult | undefined;
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
			const prompt = (await rl.question("agent> ")).trim();

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
					conversation = await conversationStore.commitCheckpoint(
						conversation,
						unsaved.input,
						unsaved.model,
					);
					unsaved = undefined;
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
				});

				console.log(`\n${result.answer}\n`);
				try {
					conversation = await conversationStore.commitCheckpoint(
						conversation,
						result.input,
						result.model,
					);
				} catch {
					unsaved = result;
					console.error(
						"UNSAVED: final checkpoint persistence failed; later work is blocked.",
					);
				}
			} catch {
				if (!stopping) {
					console.error(
						"Request failed; checkpoint was not advanced. See the journal for details.",
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
