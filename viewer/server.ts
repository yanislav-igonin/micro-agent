import { constants, type Dirent } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import path from "node:path";
import { getItemTimestamp, parseJournal } from "./src/journal.js";

export type JournalSummary = {
	name: string;
	size: number;
	startTimestamp: string;
	status: "complete" | "incomplete";
};

function invalidName(): never {
	throw new Error("Invalid journal name");
}

export function resolveJournalPath(projectRoot: string, name: string): string {
	if (
		name.length === 0 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		path.isAbsolute(name) ||
		path.win32.isAbsolute(name) ||
		!name.endsWith(".jsonl")
	) {
		return invalidName();
	}

	const logsDirectory = path.resolve(projectRoot, "logs");
	const resolved = path.resolve(logsDirectory, name);
	if (path.dirname(resolved) !== logsDirectory) return invalidName();
	return resolved;
}

function timestampFromFilename(name: string): string | null {
	const match = name.match(
		/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2}(?:\.\d{3})?Z)-\d+\.jsonl$/,
	);
	if (!match) return null;
	const [, date, hour, minute, seconds] = match;
	if (!date || !hour || !minute || !seconds) return null;
	const timestamp = `${date}${hour}:${minute}:${seconds}`;
	return Number.isNaN(Date.parse(timestamp)) ? null : timestamp;
}

function firstEventTimestamp(text: string): string | null {
	for (const item of parseJournal(text).items) {
		const timestamp = getItemTimestamp(item);
		if (timestamp !== null && !Number.isNaN(Date.parse(timestamp))) {
			return timestamp;
		}
	}
	return null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

async function readRegularFile(filePath: string) {
	let handle: FileHandle;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (isNodeError(error) && error.code === "ELOOP") return invalidName();
		throw error;
	}

	try {
		const fileStat = await handle.stat();
		if (!fileStat.isFile()) return invalidName();
		return {
			text: await handle.readFile("utf8"),
			fileStat,
		};
	} finally {
		await handle.close();
	}
}

export async function listJournals(
	projectRoot: string,
): Promise<JournalSummary[]> {
	const logsDirectory = path.resolve(projectRoot, "logs");
	let entries: Dirent[];
	try {
		entries = await readdir(logsDirectory, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const summaries = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry): Promise<JournalSummary> => {
				const filePath = resolveJournalPath(projectRoot, entry.name);
				const { text, fileStat } = await readRegularFile(filePath);
				const parsed = parseJournal(text);
				return {
					name: entry.name,
					size: fileStat.size,
					startTimestamp:
						firstEventTimestamp(text) ??
						timestampFromFilename(entry.name) ??
						fileStat.mtime.toISOString(),
					status: parsed.complete ? "complete" : "incomplete",
				};
			}),
	);

	return summaries.sort(
		(a, b) =>
			Date.parse(b.startTimestamp) - Date.parse(a.startTimestamp) ||
			b.name.localeCompare(a.name),
	);
}

export async function readJournal(
	projectRoot: string,
	name: string,
): Promise<string> {
	const { text } = await readRegularFile(resolveJournalPath(projectRoot, name));
	return text;
}
