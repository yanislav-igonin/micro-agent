import { describe, expect, it } from "vitest";
import {
	filterItems,
	groupTimeline,
	parseJournal,
	sortItems,
} from "./journal.js";

function event(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		sequence: 1,
		timestamp: "2026-09-10T10:00:00.000Z",
		type: "cli_started",
		runId: "run-1",
		data: {},
		...overrides,
	};
}

describe("parseJournal", () => {
	it("interprets schema-v1 events and preserves their complete value", () => {
		const value = event({
			data: { model: "gpt-test", nested: { kept: true } },
		});
		const parsed = parseJournal(JSON.stringify(value));

		expect(parsed.items).toEqual([
			{
				kind: "event",
				lineNumber: 1,
				value,
			},
		]);
	});

	it("preserves valid events around malformed lines", () => {
		const parsed = parseJournal(
			[
				"not-json",
				JSON.stringify(event()),
				"{broken",
				JSON.stringify(event({ sequence: 2, type: "cli_finished" })),
				"still-not-json",
			].join("\n"),
		);

		expect(parsed.items.map((item) => item.kind)).toEqual([
			"malformed",
			"event",
			"malformed",
			"event",
			"malformed",
		]);
		const diagnostics = parsed.items.filter(
			(item) => item.kind === "malformed",
		);
		expect(diagnostics.map((item) => item.lineNumber)).toEqual([1, 3, 5]);
		expect(diagnostics.map((item) => item.original)).toEqual([
			"not-json",
			"{broken",
			"still-not-json",
		]);
		expect(diagnostics.every((item) => item.error.length > 0)).toBe(true);
		expect(parsed.complete).toBe(false);
	});

	it("is complete only when the final non-empty item is cli_finished", () => {
		const complete = parseJournal(
			`${JSON.stringify(event({ type: "cli_finished" }))}\n\n`,
		);
		const incomplete = parseJournal(
			[
				JSON.stringify(event({ type: "cli_finished" })),
				JSON.stringify(event({ sequence: 2, type: "cli_started" })),
			].join("\n"),
		);

		expect(complete.complete).toBe(true);
		expect(incomplete.complete).toBe(false);
		expect(parseJournal("").complete).toBe(false);
	});

	it("keeps unsupported schema versions raw without interpreting fields", () => {
		const value = event({ schemaVersion: 2, requestNumber: 99 });
		const parsed = parseJournal(JSON.stringify(value));

		expect(parsed.items).toEqual([
			{
				kind: "unsupported",
				lineNumber: 1,
				schemaVersion: 2,
				value,
			},
		]);
		expect(parsed.complete).toBe(false);
	});
});

describe("sortItems", () => {
	it("uses ascending sequence as causal order without mutating input", () => {
		const items = parseJournal(
			[
				JSON.stringify(event({ sequence: 3 })),
				JSON.stringify(event({ sequence: 1 })),
				JSON.stringify(event({ sequence: 2 })),
			].join("\n"),
		).items;
		const original = [...items];

		expect(
			sortItems(items, "sequence").map((item) =>
				item.kind === "event" ? item.value.sequence : null,
			),
		).toEqual([1, 2, 3]);
		expect(items).toEqual(original);
	});

	it("sorts timestamps both ways and breaks ties with sequence", () => {
		const items = parseJournal(
			[
				JSON.stringify(
					event({ sequence: 2, timestamp: "2026-09-10T11:00:00.000Z" }),
				),
				JSON.stringify(
					event({ sequence: 3, timestamp: "2026-09-10T12:00:00.000Z" }),
				),
				JSON.stringify(
					event({ sequence: 1, timestamp: "2026-09-10T11:00:00.000Z" }),
				),
			].join("\n"),
		).items;
		const sequences = (order: "timestamp-asc" | "timestamp-desc") =>
			sortItems(items, order).map((item) =>
				item.kind === "event" ? item.value.sequence : null,
			);

		expect(sequences("timestamp-asc")).toEqual([1, 2, 3]);
		expect(sequences("timestamp-desc")).toEqual([3, 1, 2]);
	});
});

describe("filterItems", () => {
	it("filters schema-v1 events by type and request number", () => {
		const items = parseJournal(
			[
				JSON.stringify(
					event({ type: "model_request", requestNumber: 1, stepNumber: 1 }),
				),
				JSON.stringify(
					event({
						sequence: 2,
						type: "tool_started",
						requestNumber: 2,
						stepNumber: 1,
						callId: "call-1",
					}),
				),
			].join("\n"),
		).items;

		expect(filterItems(items, "tool_started", 2)).toMatchObject([
			{ kind: "event", value: { sequence: 2 } },
		]);
		expect(filterItems(items, "all", 1)).toMatchObject([
			{ kind: "event", value: { sequence: 1 } },
		]);
	});

	it("shows diagnostics only when no structured filter is active", () => {
		const items = parseJournal(
			`broken\n${JSON.stringify(event({ schemaVersion: 2 }))}`,
		).items;

		expect(filterItems(items, "all", null)).toHaveLength(2);
		expect(filterItems(items, "cli_started", null)).toEqual([]);
		expect(filterItems(items, "all", 1)).toEqual([]);
	});
});

describe("groupTimeline", () => {
	it("keeps run events in causal order around grouped requests", () => {
		const items = parseJournal(
			[
				JSON.stringify(event()),
				JSON.stringify(
					event({
						sequence: 2,
						type: "user_request_started",
						requestNumber: 1,
					}),
				),
				JSON.stringify(
					event({
						sequence: 3,
						type: "model_request",
						requestNumber: 1,
						stepNumber: 1,
					}),
				),
				JSON.stringify(
					event({
						sequence: 4,
						type: "tool_started",
						requestNumber: 1,
						stepNumber: 1,
						callId: "call-1",
					}),
				),
				JSON.stringify(
					event({
						sequence: 5,
						type: "tool_finished",
						requestNumber: 1,
						stepNumber: 1,
						callId: "call-1",
					}),
				),
				JSON.stringify(event({ sequence: 6, type: "cli_finished" })),
			].join("\n"),
		).items;

		expect(groupTimeline(items, "sequence")).toMatchObject([
			{ kind: "run", items: [{ kind: "event", value: { sequence: 1 } }] },
			{
				kind: "request",
				requestNumber: 1,
				items: [{ kind: "event", value: { sequence: 2 } }],
				steps: [
					{
						stepNumber: 1,
						items: [{ kind: "event", value: { sequence: 3 } }],
						calls: [
							{
								callId: "call-1",
								items: [
									{ kind: "event", value: { sequence: 4 } },
									{ kind: "event", value: { sequence: 5 } },
								],
							},
						],
					},
				],
			},
			{ kind: "run", items: [{ kind: "event", value: { sequence: 6 } }] },
		]);
	});

	it("orders request groups by their timestamp boundary", () => {
		const items = parseJournal(
			[
				JSON.stringify(
					event({
						sequence: 1,
						timestamp: "2026-09-10T12:00:00.000Z",
						type: "user_request_started",
						requestNumber: 1,
					}),
				),
				JSON.stringify(
					event({
						sequence: 2,
						timestamp: "2026-09-10T11:00:00.000Z",
						type: "user_request_started",
						requestNumber: 2,
					}),
				),
			].join("\n"),
		).items;

		expect(
			groupTimeline(items, "timestamp-asc").map((group) =>
				group.kind === "request" ? group.requestNumber : null,
			),
		).toEqual([2, 1]);
		expect(
			groupTimeline(items, "timestamp-desc").map((group) =>
				group.kind === "request" ? group.requestNumber : null,
			),
		).toEqual([1, 2]);
	});
});
