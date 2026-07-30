const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const ACTIVE_AGE_DAYS = 3;
const MAX_HISTORY_VERSIONS = 8;
const MAX_CURRENT_VERSIONS = 12;
const MIN_DISTRIBUTION_POPULATION = 10;
const MIN_VISIBLE_CELL = 3;

export interface Row {
	instance_id: string;
	reported_at: string;
	drives: number;
	total_bytes: number;
	used_bytes: number;
	version: string | null;
	commit_sha: string | null;
	vms: number | null;
	apps: number | null;
	arch: string | null;
}

interface CountEntry {
	instances: number;
}

interface DistributionEntry extends CountEntry {
	label: string;
}

interface BreakdownEntry extends CountEntry {
	version?: string;
	arch?: string;
}

function dayString(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function versionLabel(version: string | null): string {
	return version ? `${version}+` : "unknown";
}

function increment(counts: Record<string, number>, label: string): void {
	counts[label] = (counts[label] ?? 0) + 1;
}

function sortedBreakdown(counts: Record<string, number>, key: "version" | "arch"): BreakdownEntry[] {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([label, instances]) => ({ [key]: label, instances }));
}

function limitCounts(counts: Record<string, number>, limit: number): Record<string, number> {
	const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	if (sorted.length <= limit) return counts;
	const visible = sorted.slice(0, limit - 1);
	const other = sorted.slice(limit - 1).reduce((sum, [, count]) => sum + count, 0);
	return Object.fromEntries([...visible, ["Other", other]]);
}

function compactVersionHistory(days: Array<{ versions: Record<string, number> }>): void {
	const totals: Record<string, number> = {};
	for (const day of days) {
		for (const [version, count] of Object.entries(day.versions)) {
			totals[version] = (totals[version] ?? 0) + count;
		}
	}
	if (Object.keys(totals).length <= MAX_HISTORY_VERSIONS) return;

	const visible = new Set(
		Object.entries(totals)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, MAX_HISTORY_VERSIONS - 1)
			.map(([version]) => version),
	);
	for (const day of days) {
		let other = 0;
		const compacted: Record<string, number> = {};
		for (const [version, count] of Object.entries(day.versions)) {
			if (visible.has(version)) compacted[version] = count;
			else other += count;
		}
		if (other > 0) compacted.Other = other;
		day.versions = compacted;
	}
}

function distribution(
	rows: Row[],
	value: (row: Row) => number,
	buckets: Array<{ label: string; below: number }>,
): DistributionEntry[] {
	const counts = buckets.map(() => 0);
	for (const row of rows) {
		const bucket = buckets.findIndex(({ below }) => value(row) < below);
		counts[bucket === -1 ? counts.length - 1 : bucket]++;
	}
	return buckets.map(({ label }, index) => ({ label, instances: counts[index] }));
}

function safeDistribution(
	rows: Row[],
	value: (row: Row) => number,
	buckets: Array<{ label: string; below: number }>,
): DistributionEntry[] {
	if (rows.length < MIN_DISTRIBUTION_POPULATION) return [];
	const entries = distribution(rows, value, buckets);
	const visible = entries.filter(({ instances }) => instances >= MIN_VISIBLE_CELL);
	const other = entries
		.filter(({ instances }) => instances > 0 && instances < MIN_VISIBLE_CELL)
		.reduce((sum, { instances }) => sum + instances, 0);
	if (other > 0 && other < MIN_VISIBLE_CELL) return [];
	if (other > 0) visible.push({ label: "Other", instances: other });
	return visible;
}

function adoption(rows: Row[], key: "vms" | "apps"): { reporting: number; using: number | null } {
	const reporting = rows.filter((row) => row[key] !== null).length;
	const using = rows.filter((row) => row[key] !== null && row[key] > 0).length;
	if (
		reporting < MIN_DISTRIBUTION_POPULATION ||
		using < MIN_VISIBLE_CELL ||
		reporting - using < MIN_VISIBLE_CELL
	) {
		return { reporting, using: null };
	}
	return { reporting, using };
}

export function aggregateStats(rows: Row[], now: Date) {
	if (rows.length === 0) {
		return {
			days: [],
			latest: {
				versions: [],
				arches: [],
				distributions: { drives: [], capacity: [], utilization: [] },
				adoption: {
					vms: { reporting: 0, using: 0 },
					apps: { reporting: 0, using: 0 },
				},
			},
		};
	}

	const sortedRows = [...rows].sort((a, b) =>
		a.reported_at.localeCompare(b.reported_at) || a.instance_id.localeCompare(b.instance_id),
	);
	const endMs = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
	const startMs = endMs - (HISTORY_DAYS - 1) * DAY_MS;
	const lastSeen = new Map<string, Row>();
	const days = [];
	let rowIndex = 0;
	let latestRows: Row[] = [];

	for (let dayMs = startMs; dayMs <= endMs; dayMs += DAY_MS) {
		const day = dayString(dayMs);
		while (rowIndex < sortedRows.length && sortedRows[rowIndex].reported_at <= day) {
			const row = sortedRows[rowIndex++];
			lastSeen.set(row.instance_id, row);
		}

		const activeRows = [...lastSeen.values()].filter((row) => {
			const reportMs = Date.parse(`${row.reported_at}T00:00:00Z`);
			return dayMs - reportMs <= ACTIVE_AGE_DAYS * DAY_MS;
		});
		const versions: Record<string, number> = {};
		const arches: Record<string, number> = {};
		let drives = 0;
		let totalBytes = 0;
		let usedBytes = 0;
		let vms = 0;
		let apps = 0;
		let vmsReporting = 0;
		let appsReporting = 0;

		for (const row of activeRows) {
			drives += row.drives;
			totalBytes += row.total_bytes;
			usedBytes += row.used_bytes;
			if (row.vms !== null) {
				vms += row.vms;
				vmsReporting++;
			}
			if (row.apps !== null) {
				apps += row.apps;
				appsReporting++;
			}
			increment(versions, versionLabel(row.version));
			increment(arches, row.arch ?? "unknown");
		}

		days.push({
			day,
			instances: activeRows.length,
			drives,
			total_bytes: totalBytes,
			used_bytes: usedBytes,
			vms,
			apps,
			vms_reporting: vmsReporting,
			apps_reporting: appsReporting,
			versions,
		});
		latestRows = activeRows;
	}

	compactVersionHistory(days);
	const latestVersionCounts = latestRows.reduce<Record<string, number>>((counts, row) => {
		increment(counts, versionLabel(row.version));
		return counts;
	}, {});
	const tebibyte = 2 ** 40;
	return {
		days,
		latest: {
			versions: sortedBreakdown(limitCounts(latestVersionCounts, MAX_CURRENT_VERSIONS), "version"),
			arches: sortedBreakdown(
				latestRows.reduce<Record<string, number>>((counts, row) => {
					increment(counts, row.arch ?? "unknown");
					return counts;
				}, {}),
				"arch",
			),
			distributions: {
				drives: safeDistribution(latestRows, (row) => row.drives, [
					{ label: "1", below: 2 },
					{ label: "2", below: 3 },
					{ label: "3-4", below: 5 },
					{ label: "5-8", below: 9 },
					{ label: "9+", below: Number.POSITIVE_INFINITY },
				]),
				capacity: safeDistribution(latestRows, (row) => row.total_bytes / tebibyte, [
					{ label: "<1 TiB", below: 1 },
					{ label: "1-10 TiB", below: 10 },
					{ label: "10-50 TiB", below: 50 },
					{ label: "50-100 TiB", below: 100 },
					{ label: "100+ TiB", below: Number.POSITIVE_INFINITY },
				]),
				utilization: safeDistribution(
					latestRows,
					(row) => (row.total_bytes > 0 ? (row.used_bytes / row.total_bytes) * 100 : 0),
					[
						{ label: "<50%", below: 50 },
						{ label: "50-80%", below: 80 },
						{ label: "80%+", below: Number.POSITIVE_INFINITY },
					],
				),
			},
			adoption: {
				vms: adoption(latestRows, "vms"),
				apps: adoption(latestRows, "apps"),
			},
		},
	};
}
