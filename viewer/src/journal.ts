export type SortOrder = "sequence" | "timestamp-asc" | "timestamp-desc";

export type JournalEventValue = Record<string, unknown> & {
	schemaVersion: 1;
	sequence: number;
	timestamp: string;
	type: string;
	runId: string;
	data: unknown;
	requestNumber?: number;
	stepNumber?: number;
	callId?: string;
};

export type EventItem = {
	kind: "event";
	lineNumber: number;
	value: JournalEventValue;
};

export type UnsupportedItem = {
	kind: "unsupported";
	lineNumber: number;
	schemaVersion: unknown;
	value: unknown;
};

export type MalformedItem = {
	kind: "malformed";
	lineNumber: number;
	error: string;
	original: string;
};

export type JournalItem = EventItem | UnsupportedItem | MalformedItem;

export type ParsedJournal = {
	items: JournalItem[];
	complete: boolean;
};

export type TimelineCall = {
	callId: string;
	items: JournalItem[];
};

export type TimelineStep = {
	stepNumber: number;
	items: JournalItem[];
	calls: TimelineCall[];
};

export type TimelineGroup =
	| {
			kind: "run";
			items: JournalItem[];
	  }
	| {
			kind: "request";
			requestNumber: number;
			items: JournalItem[];
			steps: TimelineStep[];
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaV1Event(value: unknown): value is JournalEventValue {
	return isRecord(value) && value.schemaVersion === 1;
}

export function parseJournal(text: string): ParsedJournal {
	const items: JournalItem[] = [];

	for (const [index, original] of text.split("\n").entries()) {
		if (original.trim() === "") continue;
		const lineNumber = index + 1;

		try {
			const value: unknown = JSON.parse(original);
			if (isSchemaV1Event(value)) {
				items.push({ kind: "event", lineNumber, value });
			} else {
				items.push({
					kind: "unsupported",
					lineNumber,
					schemaVersion: isRecord(value) ? value.schemaVersion : undefined,
					value,
				});
			}
		} catch (error) {
			items.push({
				kind: "malformed",
				lineNumber,
				error: error instanceof Error ? error.message : "Unknown parse error",
				original,
			});
		}
	}

	const finalItem = items.at(-1);
	return {
		items,
		complete:
			finalItem?.kind === "event" && finalItem.value.type === "cli_finished",
	};
}

function itemSequence(item: JournalItem): number {
	return item.kind === "event" && Number.isFinite(item.value.sequence)
		? item.value.sequence
		: item.lineNumber;
}

export function getItemTimestamp(item: JournalItem): string | null {
	if (item.kind !== "event" || typeof item.value.timestamp !== "string") {
		return null;
	}
	return item.value.timestamp;
}

function timestampMillis(item: JournalItem): number | null {
	const timestamp = getItemTimestamp(item);
	if (timestamp === null) return null;
	const value = Date.parse(timestamp);
	return Number.isNaN(value) ? null : value;
}

function compareItems(
	a: JournalItem,
	b: JournalItem,
	order: SortOrder,
): number {
	if (order === "sequence") return itemSequence(a) - itemSequence(b);

	const aTimestamp = timestampMillis(a);
	const bTimestamp = timestampMillis(b);
	if (aTimestamp !== null && bTimestamp !== null && aTimestamp !== bTimestamp) {
		return order === "timestamp-asc"
			? aTimestamp - bTimestamp
			: bTimestamp - aTimestamp;
	}
	if (aTimestamp === null && bTimestamp !== null) return 1;
	if (aTimestamp !== null && bTimestamp === null) return -1;
	return itemSequence(a) - itemSequence(b);
}

export function sortItems(
	items: JournalItem[],
	order: SortOrder,
): JournalItem[] {
	return [...items].sort((a, b) => compareItems(a, b, order));
}

export function filterItems(
	items: JournalItem[],
	eventType: string,
	requestNumber: number | null,
): JournalItem[] {
	return items.filter((item) => {
		if (item.kind !== "event") {
			return eventType === "all" && requestNumber === null;
		}
		return (
			(eventType === "all" || item.value.type === eventType) &&
			(requestNumber === null || item.value.requestNumber === requestNumber)
		);
	});
}

function containerItems(
	container: JournalItem[] | TimelineCall | TimelineStep | TimelineGroup,
): JournalItem[] {
	if (Array.isArray(container)) return container;
	if ("calls" in container) {
		return [
			...container.items,
			...container.calls.flatMap((call) => call.items),
		];
	}
	if ("steps" in container) {
		return [
			...container.items,
			...container.steps.flatMap((step) => containerItems(step)),
		];
	}
	return container.items;
}

function compareContainers(
	a: JournalItem[] | TimelineCall | TimelineStep | TimelineGroup,
	b: JournalItem[] | TimelineCall | TimelineStep | TimelineGroup,
	order: SortOrder,
): number {
	const aItems = sortItems(containerItems(a), order);
	const bItems = sortItems(containerItems(b), order);
	const aBoundary = aItems[0];
	const bBoundary = bItems[0];
	if (!aBoundary && !bBoundary) return 0;
	if (!aBoundary) return 1;
	if (!bBoundary) return -1;
	return compareItems(aBoundary, bBoundary, order);
}

export function groupTimeline(
	items: JournalItem[],
	order: SortOrder,
): TimelineGroup[] {
	const runGroups: TimelineGroup[] = [];
	const requests = new Map<
		number,
		{
			kind: "request";
			requestNumber: number;
			items: JournalItem[];
			stepsByNumber: Map<number, TimelineStep>;
		}
	>();

	for (const item of items) {
		if (item.kind !== "event" || typeof item.value.requestNumber !== "number") {
			runGroups.push({ kind: "run", items: [item] });
			continue;
		}

		const requestNumber = item.value.requestNumber;
		let request = requests.get(requestNumber);
		if (!request) {
			request = {
				kind: "request",
				requestNumber,
				items: [],
				stepsByNumber: new Map(),
			};
			requests.set(requestNumber, request);
		}

		if (typeof item.value.stepNumber !== "number") {
			request.items.push(item);
			continue;
		}

		const stepNumber = item.value.stepNumber;
		let step = request.stepsByNumber.get(stepNumber);
		if (!step) {
			step = { stepNumber, items: [], calls: [] };
			request.stepsByNumber.set(stepNumber, step);
		}

		if (typeof item.value.callId !== "string") {
			step.items.push(item);
			continue;
		}

		let call = step.calls.find(
			(candidate) => candidate.callId === item.value.callId,
		);
		if (!call) {
			call = { callId: item.value.callId, items: [] };
			step.calls.push(call);
		}
		call.items.push(item);
	}

	const groups: TimelineGroup[] = [...runGroups];

	for (const request of requests.values()) {
		const steps = [...request.stepsByNumber.values()];
		for (const step of steps) {
			step.items = sortItems(step.items, order);
			for (const call of step.calls) {
				call.items = sortItems(call.items, order);
			}
			step.calls.sort((a, b) => compareContainers(a, b, order));
		}
		steps.sort((a, b) => compareContainers(a, b, order));
		groups.push({
			kind: "request",
			requestNumber: request.requestNumber,
			items: sortItems(request.items, order),
			steps,
		});
	}

	return groups.sort((a, b) => compareContainers(a, b, order));
}
