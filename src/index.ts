import "dotenv/config";

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runAgent } from "./agent.js";

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
		const answer = await runAgent(prompt);

		console.log(`\n${answer}\n`);
	} catch (error) {
		console.error(error);
	}
}

rl.close();
