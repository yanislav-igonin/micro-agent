import "dotenv/config";

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runCli } from "./cli.js";
import { createJournal } from "./journal.js";

const journal = await createJournal(!process.argv.includes("--no-log"));
await journal.record("cli_started", {});

const rl = createInterface({
	input,
	output,
});

console.log("Micro Agent");
console.log('Type "exit" or press Ctrl-C to quit.\n');

const result = await runCli(rl, journal);
if (result.interrupted) {
	process.exit(130);
}
