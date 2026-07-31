import { describe, expect, it } from "vitest";
import { aggregateStats, type Row } from "./stats";

function report(overrides: Partial<Row> & Pick<Row, "instance_id" | "reported_at">): Row {
	return {
		drives: 2,
		total_bytes: 4 * 2 ** 40,
		used_bytes: 2 * 2 ** 40,
		version: "0.0.14",
		commit_sha: null,
		vms: 0,
		apps: 0,
		smb_shares: null,
		nfs_exports: null,
		iscsi_luns: null,
		nvmeof_namespaces: null,
		arch: "x86_64",
		...overrides,
	};
}

describe("aggregateStats", () => {
	it("returns an empty response when no reports exist", () => {
		const result = aggregateStats([], new Date("2026-07-30T12:00:00Z"));
		expect(result.days).toEqual([]);
		expect(result.latest.versions).toEqual([]);
	});

	it("uses the population active on each historical day", () => {
		const result = aggregateStats(
			[
				report({ instance_id: "departed", reported_at: "2026-07-01" }),
				report({ instance_id: "current", reported_at: "2026-07-08" }),
			],
			new Date("2026-07-10T12:00:00Z"),
		);

		expect(result.days).toHaveLength(90);
		expect(result.days.find((day) => day.day === "2026-07-02")?.instances).toBe(1);
		expect(result.days.find((day) => day.day === "2026-07-05")?.instances).toBe(0);
		expect(result.days.at(-1)?.instances).toBe(1);
	});

	it("uses seed reports from before the 90-day display window", () => {
		const result = aggregateStats(
			[report({ instance_id: "seeded", reported_at: "2026-04-29" })],
			new Date("2026-07-30T12:00:00Z"),
		);

		expect(result.days[0]).toMatchObject({ day: "2026-05-02", instances: 1 });
		expect(result.days[1]).toMatchObject({ day: "2026-05-03", instances: 0 });
	});

	it("carries reports forward for three days and replaces them with newer values", () => {
		const result = aggregateStats(
			[
				report({ instance_id: "one", reported_at: "2026-07-06", drives: 2 }),
				report({ instance_id: "one", reported_at: "2026-07-09", drives: 6, version: "0.0.15" }),
			],
			new Date("2026-07-10T12:00:00Z"),
		);

		expect(result.days.find((day) => day.day === "2026-07-08")?.drives).toBe(2);
		expect(result.days.find((day) => day.day === "2026-07-09")?.drives).toBe(6);
		expect(result.days.at(-1)?.versions).toEqual({ "0.0.15+": 1 });
	});

	it("hides distributions and adoption for small populations", () => {
		const result = aggregateStats(
			[
				report({
					instance_id: "small",
					reported_at: "2026-07-30",
					drives: 1,
					total_bytes: 512 * 2 ** 30,
					used_bytes: 64 * 2 ** 30,
					vms: 2,
					apps: 3,
				}),
				report({
					instance_id: "large",
					reported_at: "2026-07-30",
					drives: 12,
					total_bytes: 120 * 2 ** 40,
					used_bytes: 114 * 2 ** 40,
					vms: null,
					apps: 0,
					arch: "aarch64",
				}),
			],
			new Date("2026-07-30T12:00:00Z"),
		);

		expect(result.latest.distributions).toEqual({ drives: [], capacity: [], utilization: [] });
		expect(result.latest.adoption).toEqual({
			vms: { reporting: 1, using: null },
			apps: { reporting: 2, using: null },
		});
	});

	it("merges rare distribution cells and suppresses rare adoption counts", () => {
		const rows = Array.from({ length: 12 }, (_, index) =>
			report({
				instance_id: `instance-${index}`,
				reported_at: "2026-07-30",
				drives: index < 3 ? 1 : index < 6 ? 2 : index < 8 ? 4 : index < 10 ? 6 : 12,
				vms: index < 4 ? 1 : 0,
				apps: index < 2 ? 1 : 0,
			}),
		);
		const result = aggregateStats(rows, new Date("2026-07-30T12:00:00Z"));

		expect(result.latest.distributions.drives).toEqual([
			{ label: "1", instances: 3 },
			{ label: "2", instances: 3 },
			{ label: "Other", instances: 6 },
		]);
		expect(result.latest.distributions.capacity).toEqual([{ label: "1-10 TiB", instances: 12 }]);
		expect(result.latest.distributions.utilization).toEqual([{ label: "50%+", instances: 12 }]);
		expect(result.latest.adoption).toEqual({
			vms: { reporting: 12, using: 4 },
			apps: { reporting: 12, using: null },
		});
	});

	it("hides a distribution when its combined rare cell is still identifying", () => {
		const rows = Array.from({ length: 10 }, (_, index) =>
			report({
				instance_id: `instance-${index}`,
				reported_at: "2026-07-30",
				drives: index === 9 ? 12 : 1,
			}),
		);
		const result = aggregateStats(rows, new Date("2026-07-30T12:00:00Z"));

		expect(result.latest.distributions.drives).toEqual([]);
	});

	it("caps version history and current breakdown cardinality", () => {
		const rows = Array.from({ length: 13 }, (_, index) =>
			report({
				instance_id: `instance-${index}`,
				reported_at: "2026-07-30",
				version: `0.0.${index}`,
			}),
		);
		const result = aggregateStats(rows, new Date("2026-07-30T12:00:00Z"));
		const history = result.days.at(-1)?.versions ?? {};

		expect(Object.keys(history)).toHaveLength(8);
		expect(history.Other).toBe(6);
		expect(result.latest.versions).toHaveLength(12);
		expect(result.latest.versions.find((entry) => entry.version === "Other")?.instances).toBe(2);
	});

	it("keeps a newly active version in history even with little cumulative data", () => {
		const historical = Array.from({ length: 7 }, (_, index) =>
			report({
				instance_id: `historical-${index}`,
				reported_at: "2026-07-20",
				version: `0.0.${index + 7}`,
			}),
		);
		const result = aggregateStats(
			[
				...historical,
				report({ instance_id: "current", reported_at: "2026-07-30", version: "0.0.15" }),
			],
			new Date("2026-07-30T12:00:00Z"),
		);

		expect(result.days.at(-1)?.versions["0.0.15+"]).toBe(1);
	});

	it("publishes protocol counts only with a privacy-safe observed cohort", () => {
		const rows = Array.from({ length: 12 }, (_, index) =>
			report({
				instance_id: `instance-${index}`,
				reported_at: "2026-07-30",
				smb_shares: index < 5 ? 2 : 0,
				nfs_exports: index < 3 ? 1 : 0,
				iscsi_luns: index < 2 ? 1 : 0,
				nvmeof_namespaces: null,
			}),
		);
		const result = aggregateStats(rows, new Date("2026-07-30T12:00:00Z"));

		expect(result.latest.protocols).toEqual({
			smb: { reporting: 12, using: 5, configured: 10 },
			nfs: { reporting: 12, using: 3, configured: 3 },
			iscsi: { reporting: 12, using: null, configured: null },
			nvmeof: { reporting: 0, using: null, configured: null },
		});
	});
});
