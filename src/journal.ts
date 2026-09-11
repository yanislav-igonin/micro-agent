import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type StopReason =
	| "final_answer"
	| "max_steps"
	| "model_error"
	| "unexpected_error"
	| "cancelled";

export type JournalEvent =
	| "cli_started"
	| "user_request_started"
	| "model_request"
	| "model_response"
	| "model_error"
	| "tool_started"
	| "tool_finished"
	| "user_request_finished"
	| "cli_finished";

export interface EventContext {
	requestNumber?: number;
	stepNumber?: number;
	callId?: string;
}

// Pick diagnostic fields explicitly: SDK errors also carry headers and configuration.
export function normalizeError(error: unknown) {
	const fields = error && typeof error === "object" ? error : {};
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
		...("status" in fields && typeof fields.status === "number"
			? { status: fields.status }
			: {}),
		...("code" in fields &&
		(typeof fields.code === "string" || typeof fields.code === "number")
			? { code: fields.code }
			: {}),
		...("requestID" in fields && typeof fields.requestID === "string"
			? { requestId: fields.requestID }
			: {}),
	};
}

export async function createJournal(enabled: boolean, root = process.cwd()) {
	const runId = randomUUID();
	const directory = path.join(root, "logs");
	const filePath = path.join(
		directory,
		`${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.jsonl`,
	);
	let active = enabled;
	let sequence = 0;
	let finishing = false;
	let writeQueue = Promise.resolve();

	function disable() {
		active = false;
		console.error(
			"WARNING: Journal unavailable or incomplete; logging disabled for this CLI run.",
		);
	}

	if (enabled) {
		try {
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			// mkdir's mode does not tighten an already existing directory.
			await fs.chmod(directory, 0o700);
			await fs.writeFile(filePath, "", { flag: "wx", mode: 0o600 });
			console.log(`Journal: ${filePath}`);
		} catch {
			disable();
		}
	} else {
		console.log("Journal: disabled (--no-log)");
	}

	function enqueue(
		type: JournalEvent,
		data: unknown,
		context: EventContext = {},
	) {
		if (!active) return writeQueue;

		let line: string;
		try {
			line = `${JSON.stringify({
				schemaVersion: 1,
				sequence: ++sequence,
				timestamp: new Date().toISOString(),
				type,
				runId,
				...context,
				data,
			})}\n`;
		} catch {
			disable();
			return writeQueue;
		}

		writeQueue = writeQueue.then(async () => {
			if (!active) return;
			try {
				await fs.appendFile(filePath, line, { mode: 0o600 });
			} catch {
				disable();
			}
		});
		return writeQueue;
	}

	return {
		record(type: JournalEvent, data: unknown, context: EventContext = {}) {
			if (finishing) return writeQueue;
			// Serialize now, before the next model/tool step can mutate its input.
			return enqueue(type, data, context);
		},
		finish(data: unknown) {
			if (!finishing) {
				finishing = true;
				enqueue("cli_finished", data);
			}
			return writeQueue;
		},
	};
}

export type Journal = Awaited<ReturnType<typeof createJournal>>;
