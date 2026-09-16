import "dotenv/config";

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runCli } from "./cli.js";
import { ConversationStore } from "./conversations.js";
import { createJournal } from "./journal.js";

const journal = await createJournal(!process.argv.includes("--no-log"));
const conversationStore = await ConversationStore.open();
await journal.record("cli_started", {});

const rl = createInterface({
	input,
	output,
});

console.log("Micro Agent");
console.log('Type "/history", "/new", "exit", or press Ctrl-C.\n');

const result = await runCli(rl, journal, conversationStore);
if (result.interrupted) {
	process.exit(130);
}
