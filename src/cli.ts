import { createAgent } from "./agent.js";
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
	agent = createAgent(),
	signals: SignalSource = process,
) {
	let requestNumber = 0;
	let interrupt: () => void = () => {};
	const interrupted = new Promise<true>((resolve) => {
		interrupt = () => resolve(true);
	});

	rl.once("SIGINT", interrupt);
	signals.once("SIGINT", interrupt);

	const promptLoop = async () => {
		while (true) {
			const prompt = (await rl.question("agent> ")).trim();

			if (!prompt) {
				continue;
			}

			if (prompt === "exit" || prompt === "quit") {
				return false;
			}

			try {
				const answer = await agent(prompt, journal, ++requestNumber);

				console.log(`\n${answer}\n`);
			} catch {
				console.error(
					"Request failed; see stop reason above and journal for details.",
				);
			}
		}
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
