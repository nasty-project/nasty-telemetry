import { describe, expect, it } from "vitest";
import { isValidPayload } from "./index";

function payload(overrides: Record<string, unknown> = {}) {
	return {
		instance_id: "01234567-89ab-cdef-0123-456789abcdef",
		drives: 2,
		total_bytes: 100,
		used_bytes: 50,
		version: "0.0.16",
		arch: "x86_64",
		...overrides,
	};
}

describe("protocol count validation", () => {
	it("accepts omitted and bounded protocol counts", () => {
		expect(isValidPayload(payload())).toBe(true);
		expect(
			isValidPayload(
				payload({ smb_shares: 3, nfs_exports: 2, iscsi_luns: 1, nvmeof_namespaces: 0 }),
			),
		).toBe(true);
	});

	it("rejects null, fractional, negative, and excessive protocol counts", () => {
		expect(isValidPayload(payload({ smb_shares: null }))).toBe(false);
		expect(isValidPayload(payload({ nfs_exports: 1.5 }))).toBe(false);
		expect(isValidPayload(payload({ iscsi_luns: -1 }))).toBe(false);
		expect(isValidPayload(payload({ nvmeof_namespaces: 10_001 }))).toBe(false);
	});
});
