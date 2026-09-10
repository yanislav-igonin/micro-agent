import "dotenv/config";

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runAgent } from "./agent.js";
import { createJournal } from "./journal.js";

const journal = await createJournal(!process.argv.includes("--no-log"));
await journal.record("cli_started", {});
let requestNumber = 0;

const rl = createInterface({
	input,
	output,
});

console.log("Micro Agent");
console.log('Type "exit" to quit.\n');

while (true) {
	const prompt = (await rl.question("agent> ")).trim();

	if (!prompt) {
		continue;
	}

	if (prompt === "exit" || prompt === "quit") {
		break;
	}

	try {
		const answer = await runAgent(prompt, journal, ++requestNumber);

		console.log(`\n${answer}\n`);
	} catch {
		console.error(
			"Request failed; see stop reason above and journal for details.",
		);
	}
}

rl.close();
await journal.record("cli_finished", { requestCount: requestNumber });
