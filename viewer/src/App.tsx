import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { JournalSummary } from "../server.js";
import {
	filterItems,
	getItemTimestamp,
	groupTimeline,
	type JournalItem,
	parseJournal,
	type SortOrder,
	type TimelineCall,
	type TimelineStep,
} from "./journal.js";

type ApiError = {
	error?: string;
};

function formatLocalTime(timestamp: string | null): string {
	if (timestamp === null) return "time unavailable";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "invalid timestamp";
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "medium",
	});
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function itemKey(item: JournalItem): string {
	return `${item.kind}:${item.lineNumber}`;
}

function dataRecord(item: JournalItem): Record<string, unknown> | null {
	if (
		item.kind !== "event" ||
		typeof item.value.data !== "object" ||
		item.value.data === null ||
		Array.isArray(item.value.data)
	) {
		return null;
	}
	return item.value.data as Record<string, unknown>;
}

function stringField(
	record: Record<string, unknown> | null,
	name: string,
): string | null {
	const value = record?.[name];
	return typeof value === "string" ? value : null;
}

function itemTone(item: JournalItem): string {
	if (item.kind === "malformed") return "danger";
	if (item.kind === "unsupported") return "warning";
	const data = dataRecord(item);
	if (
		item.value.type === "model_error" ||
		stringField(data, "status") === "error"
	) {
		return "danger";
	}
	if (
		item.value.type === "cli_finished" ||
		item.value.type === "user_request_finished" ||
		stringField(data, "status") === "ok"
	) {
		return "success";
	}
	return "neutral";
}

function itemLabel(item: JournalItem): string {
	if (item.kind === "malformed") {
		return `malformed line · line ${item.lineNumber}`;
	}
	if (item.kind === "unsupported") {
		return `unsupported schema · ${String(item.schemaVersion ?? "missing")}`;
	}

	const data = dataRecord(item);
	const parts = [
		item.value.type,
		formatLocalTime(getItemTimestamp(item)),
		typeof item.value.requestNumber === "number"
			? `request ${item.value.requestNumber}`
			: null,
		typeof item.value.stepNumber === "number"
			? `step ${item.value.stepNumber}`
			: null,
		stringField(data, "name"),
		stringField(data, "status"),
		stringField(data, "phase"),
		stringField(data, "reason"),
	];
	return parts.filter((part): part is string => part !== null).join(" · ");
}

async function apiError(response: Response): Promise<Error> {
	try {
		const value = (await response.json()) as ApiError;
		return new Error(value.error || `Request failed (${response.status})`);
	} catch {
		return new Error(`Request failed (${response.status})`);
	}
}

export function App() {
	const [journals, setJournals] = useState<JournalSummary[]>([]);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [journalText, setJournalText] = useState<string | null>(null);
	const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
	const [sortOrder, setSortOrder] = useState<SortOrder>("sequence");
	const [eventType, setEventType] = useState("all");
	const [requestFilter, setRequestFilter] = useState("all");
	const [listLoading, setListLoading] = useState(true);
	const [journalLoading, setJournalLoading] = useState(false);
	const [viewerError, setViewerError] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);

	const parsed = useMemo(
		() =>
			journalText === null
				? { items: [], complete: false }
				: parseJournal(journalText),
		[journalText],
	);
	const requestNumber = requestFilter === "all" ? null : Number(requestFilter);
	const filteredItems = useMemo(
		() => filterItems(parsed.items, eventType, requestNumber),
		[parsed.items, eventType, requestNumber],
	);
	const timeline = useMemo(
		() => groupTimeline(filteredItems, sortOrder),
		[filteredItems, sortOrder],
	);
	const selectedItem =
		parsed.items.find((item) => itemKey(item) === selectedItemKey) ?? null;
	const eventTypes = useMemo(
		() =>
			[
				...new Set(
					parsed.items.flatMap((item) =>
						item.kind === "event" ? [item.value.type] : [],
					),
				),
			].sort(),
		[parsed.items],
	);
	const requestNumbers = useMemo(
		() =>
			[
				...new Set(
					parsed.items.flatMap((item) =>
						item.kind === "event" &&
						typeof item.value.requestNumber === "number"
							? [item.value.requestNumber]
							: [],
					),
				),
			].sort((a, b) => a - b),
		[parsed.items],
	);

	const loadJournal = useCallback(async (name: string) => {
		setJournalLoading(true);
		setViewerError(null);
		setCopyStatus(null);
		try {
			const response = await fetch(
				`/api/journals/${encodeURIComponent(name)}`,
				{ cache: "no-store" },
			);
			if (!response.ok) throw await apiError(response);
			const text = await response.text();
			const nextParsed = parseJournal(text);
			setJournalText(text);
			setSelectedItemKey(
				nextParsed.items[0] ? itemKey(nextParsed.items[0]) : null,
			);
		} catch (error) {
			setJournalText(null);
			setSelectedItemKey(null);
			setViewerError(
				error instanceof Error ? error.message : "Could not read journal",
			);
		} finally {
			setJournalLoading(false);
		}
	}, []);

	const refreshJournals = useCallback(
		async (currentName: string | null) => {
			setListLoading(true);
			setViewerError(null);
			try {
				const response = await fetch("/api/journals", { cache: "no-store" });
				if (!response.ok) throw await apiError(response);
				const nextJournals = (await response.json()) as JournalSummary[];
				setJournals(nextJournals);

				if (currentName !== null) {
					if (nextJournals.some((journal) => journal.name === currentName)) {
						await loadJournal(currentName);
					} else {
						setSelectedName(null);
						setJournalText(null);
						setSelectedItemKey(null);
						setViewerError("Journal no longer exists");
					}
				} else if (nextJournals[0]) {
					setSelectedName(nextJournals[0].name);
					await loadJournal(nextJournals[0].name);
				} else {
					setJournalText(null);
					setSelectedItemKey(null);
				}
			} catch (error) {
				setViewerError(
					error instanceof Error ? error.message : "Could not list journals",
				);
			} finally {
				setListLoading(false);
			}
		},
		[loadJournal],
	);

	useEffect(() => {
		void refreshJournals(null);
	}, [refreshJournals]);

	async function selectJournal(name: string) {
		setSelectedName(name);
		await loadJournal(name);
	}

	async function copyText(label: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopyStatus(`${label} copied`);
		} catch {
			setCopyStatus(`Could not copy ${label.toLowerCase()}`);
		}
	}

	function renderItem(item: JournalItem): ReactNode {
		const key = itemKey(item);
		return (
			<button
				aria-pressed={selectedItemKey === key}
				className={`event-row tone-${itemTone(item)} ${
					selectedItemKey === key ? "is-selected" : ""
				}`}
				key={key}
				onClick={() => {
					setSelectedItemKey(key);
					setCopyStatus(null);
				}}
				type="button"
			>
				<span className="event-sequence">
					{item.kind === "event"
						? `#${String(item.value.sequence).padStart(3, "0")}`
						: `L${item.lineNumber}`}
				</span>
				<span className="event-dot" aria-hidden="true" />
				<span className="event-label">{itemLabel(item)}</span>
			</button>
		);
	}

	function renderCall(call: TimelineCall): ReactNode {
		const toolName =
			call.items
				.map((item) => stringField(dataRecord(item), "name"))
				.find((name) => name !== null) ?? "unknown tool";
		return (
			<section className="call-group" key={call.callId}>
				<div className="group-label">tool call · {toolName}</div>
				<div className="group-items">{call.items.map(renderItem)}</div>
			</section>
		);
	}

	function renderStep(step: TimelineStep): ReactNode {
		const directItems = (
			<div className="group-items">{step.items.map(renderItem)}</div>
		);
		const calls = step.calls.map(renderCall);
		return (
			<section className="step-group" key={step.stepNumber}>
				<div className="group-label">model step {step.stepNumber}</div>
				{sortOrder === "timestamp-desc" ? (
					<>
						{calls}
						{directItems}
					</>
				) : (
					<>
						{directItems}
						{calls}
					</>
				)}
			</section>
		);
	}

	function renderTimeline(): ReactNode {
		if (journalLoading) {
			return <div className="state-card">Reading journal…</div>;
		}
		if (journalText === null) {
			return (
				<div className="state-card">
					Select a journal to reconstruct the run.
				</div>
			);
		}
		if (parsed.items.length === 0) {
			return <div className="state-card">Journal is empty.</div>;
		}
		if (timeline.length === 0) {
			return <div className="state-card">No events match these filters.</div>;
		}

		return timeline.map((group) => {
			if (group.kind === "run") {
				const runKey = group.items[0]
					? `run-${itemKey(group.items[0])}`
					: "run-empty";
				return (
					<section className="run-group" key={runKey}>
						<div className="group-items">{group.items.map(renderItem)}</div>
					</section>
				);
			}

			const finishedItems = group.items.filter(
				(item) =>
					item.kind === "event" && item.value.type === "user_request_finished",
			);
			const openingItems = group.items.filter(
				(item) => !finishedItems.includes(item),
			);
			const opening = openingItems.map(renderItem);
			const finished = finishedItems.map(renderItem);
			const steps = group.steps.map(renderStep);
			return (
				<section className="request-group" key={group.requestNumber}>
					<div className="request-heading">
						<span>request</span>
						<strong>{String(group.requestNumber).padStart(2, "0")}</strong>
					</div>
					{sortOrder === "timestamp-desc" ? (
						<>
							{finished}
							{steps}
							{opening}
						</>
					) : (
						<>
							{opening}
							{steps}
							{finished}
						</>
					)}
				</section>
			);
		});
	}

	const selectedTimestamp =
		selectedItem === null ? null : getItemTimestamp(selectedItem);
	const selectedValue =
		selectedItem?.kind === "event" || selectedItem?.kind === "unsupported"
			? selectedItem.value
			: null;
	const selectedCallId =
		selectedItem?.kind === "event" &&
		typeof selectedItem.value.callId === "string"
			? selectedItem.value.callId
			: null;

	return (
		<div className="viewer">
			<header className="topbar">
				<div className="brand">
					<span className="recorder-mark" aria-hidden="true">
						<span />
					</span>
					<div>
						<p>Micro Agent / local diagnostic</p>
						<h1>Journal Flight Recorder</h1>
					</div>
				</div>
				<div className="connection">
					<span>LOCAL ONLY</span>
					<code>127.0.0.1</code>
				</div>
			</header>

			<div className="workspace">
				<aside className="panel journal-panel" aria-label="Journals">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Archive</span>
							<h2>Journals</h2>
						</div>
						<button
							className="control-button"
							disabled={listLoading}
							onClick={() => void refreshJournals(selectedName)}
							type="button"
						>
							{listLoading ? "Loading…" : "Refresh"}
						</button>
					</div>
					<div className="journal-list">
						{!listLoading && journals.length === 0 ? (
							<div className="state-card">No journals in logs/.</div>
						) : null}
						{journals.map((journal) => (
							<button
								aria-pressed={selectedName === journal.name}
								className={`journal-row ${
									selectedName === journal.name ? "is-selected" : ""
								}`}
								key={journal.name}
								onClick={() => void selectJournal(journal.name)}
								type="button"
							>
								<span className="journal-time">
									{formatLocalTime(journal.startTimestamp)}
								</span>
								<strong>{journal.name}</strong>
								<span className="journal-meta">
									<span>{formatBytes(journal.size)}</span>
									<span className={`status status-${journal.status}`}>
										{journal.status}
									</span>
								</span>
							</button>
						))}
					</div>
				</aside>

				<main className="panel timeline-panel">
					<div className="panel-heading timeline-heading">
						<div>
							<span className="eyebrow">Causal reconstruction</span>
							<h2>Timeline</h2>
						</div>
						<span
							className={`status status-${
								parsed.complete ? "complete" : "incomplete"
							}`}
						>
							{journalText === null
								? "no journal"
								: parsed.complete
									? "complete"
									: "incomplete"}
						</span>
					</div>

					<fieldset className="filters">
						<legend className="visually-hidden">Timeline controls</legend>
						<label>
							<span className="filter-label">Order</span>
							<select
								onChange={(event) =>
									setSortOrder(event.target.value as SortOrder)
								}
								value={sortOrder}
							>
								<option value="sequence">Sequence ↑</option>
								<option value="timestamp-asc">Timestamp ↑</option>
								<option value="timestamp-desc">Timestamp ↓</option>
							</select>
						</label>
						<label>
							<span className="filter-label">Event</span>
							<select
								onChange={(event) => setEventType(event.target.value)}
								value={eventType}
							>
								<option value="all">All types</option>
								{eventTypes.map((type) => (
									<option key={type} value={type}>
										{type}
									</option>
								))}
							</select>
						</label>
						<label>
							<span className="filter-label">Request</span>
							<select
								onChange={(event) => setRequestFilter(event.target.value)}
								value={requestFilter}
							>
								<option value="all">All requests</option>
								{requestNumbers.map((number) => (
									<option key={number} value={number}>
										Request {number}
									</option>
								))}
							</select>
						</label>
					</fieldset>

					{viewerError ? (
						<div className="error-banner" role="alert">
							<strong>Viewer warning</strong>
							<span>{viewerError}</span>
						</div>
					) : null}

					<div className="timeline-scroll">{renderTimeline()}</div>
				</main>

				<aside className="panel detail-panel" aria-label="Event details">
					<div className="panel-heading">
						<div>
							<span className="eyebrow">Source record</span>
							<h2>Details</h2>
						</div>
						{selectedItem ? (
							<span className="line-badge">line {selectedItem.lineNumber}</span>
						) : null}
					</div>

					{selectedItem === null ? (
						<div className="state-card">Select an event to inspect it.</div>
					) : (
						<div className="detail-content">
							{selectedItem.kind === "unsupported" ? (
								<div className="warning-card" role="status">
									<strong>Unsupported schema version</strong>
									<span>Raw JSON shown. No semantics have been inferred.</span>
								</div>
							) : null}
							{selectedItem.kind === "malformed" ? (
								<div className="warning-card danger-card" role="alert">
									<strong>Malformed JSONL line</strong>
									<span>{selectedItem.error}</span>
								</div>
							) : null}

							{selectedTimestamp ? (
								<dl className="timestamp-grid">
									<div>
										<dt>Local time</dt>
										<dd>{formatLocalTime(selectedTimestamp)}</dd>
									</div>
									<div>
										<dt>Original UTC</dt>
										<dd>{selectedTimestamp}</dd>
									</div>
								</dl>
							) : null}

							<div className="detail-actions">
								{selectedValue !== null ? (
									<button
										className="control-button"
										onClick={() =>
											void copyText(
												"JSON",
												JSON.stringify(selectedValue, null, 2),
											)
										}
										type="button"
									>
										Copy JSON
									</button>
								) : null}
								{selectedCallId ? (
									<button
										className="control-button"
										onClick={() => void copyText("Call ID", selectedCallId)}
										type="button"
									>
										Copy call ID
									</button>
								) : null}
								{copyStatus ? (
									<span
										className={`copy-status ${
											copyStatus.startsWith("Could") ? "is-error" : ""
										}`}
										role="status"
									>
										{copyStatus}
									</span>
								) : null}
							</div>

							<pre className="json-view">
								{selectedItem.kind === "malformed"
									? selectedItem.original
									: JSON.stringify(selectedValue, null, 2)}
							</pre>
						</div>
					)}
				</aside>
			</div>
		</div>
	);
}
