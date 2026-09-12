import { type AgentResult, createAgent } from "./agent.js";
import type { ConversationStore } from "./conversations.js";
import type { Journal } from "./journal.js";

interface CliPrompt {
	question(query: string): Promise<string>;
	close(): void;
	once(event: "SIGINT", listener: () => void): this;
	off(event: "SIGINT", listener: () => void): this;
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
) {
	let requestNumber = 0;
	let stopping = false;
	let activeRequest: AbortController | undefined;
	let conversation = conversationStore.createConversation();
	const agent = createAgentForInput(conversation.input);
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
