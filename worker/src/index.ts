export interface Env {
	DB: D1Database;
	/** Cloudflare Rate Limiting binding declared in wrangler.toml as
	 * `[[unsafe.bindings]] type = "ratelimit"`. Applied to POST
	 * /api/report only; reads (`/api/stats`) skip it because they
	 * hit a small static surface and the dashboard polls them
	 * normally. Optional in the Env interface so the type-checker
	 * doesn't complain on a local `wrangler dev` config that omits
	 * the binding — see `applyRateLimit` for the fail-open behavior. */
	REPORT_RATE_LIMIT?: RateLimit;
}

/** Per-IP rate limit guard for POST /api/report. Returns null when the
 * request is allowed (or when the binding isn't wired, which we treat
 * as "allow" to avoid breaking local dev). Returns a 429 Response with
 * a Retry-After header when the limit has been exceeded.
 *
 * Threat model: the receiver previously accepted unlimited reports
 * from anyone with a valid-shaped payload, so a single attacker could
 * spam thousands of fake `instance_id` UUIDs to inflate the public
 * "Active Instances" pill. Per-IP rate limiting is the cheapest
 * effective defense — an attacker behind one IP can still pollute
 * (5 reports/min ≈ 7200/day), but the 3-day staleness window on the
 * stats query bounds the inflation, and stopping multi-thousand-RPS
 * spam runs from a single source is the bulk of the win.
 *
 * Future hardening (deliberately deferred):
 *   - Per-instance_id rate limit (one report/24h) via the D1 layer.
 *     Catches the "rotating IPs, same UUID" pattern.
 *   - Cloudflare zone-level rule limiting by ASN range / known proxy
 *     networks. Requires zone-level config rather than worker code.
 */
async function applyRateLimit(request: Request, env: Env): Promise<Response | null> {
	if (!env.REPORT_RATE_LIMIT) {
		// Local dev / misconfigured deploy — allow the request rather
		// than 500'ing. The wrangler.toml in the repo declares the
		// binding so prod deploys always have it.
		return null;
	}
	const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const { success } = await env.REPORT_RATE_LIMIT.limit({ key });
	if (success) return null;
	return new Response(
		JSON.stringify({
			error: "rate_limited",
			message:
				"Too many reports from this IP in the last minute. Real NASty engines report once per 24h — slow down.",
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				// Period is 60s per wrangler.toml; Retry-After matches.
				"Retry-After": "60",
				...CORS_HEADERS,
			},
		},
	);
}

interface ReportPayload {
	instance_id: string;
	drives: number;
	total_bytes: number;
	used_bytes: number;
	// version + arch are required: the NASty engine populates them
	// from `env!("CARGO_PKG_VERSION")` and `std::env::consts::ARCH`
	// at compile time, so a real engine never omits them. A POST
	// without these fields is a probe / curl test / non-NASty client
	// — accepting it would let an outsider pollute the dashboard
	// with "unknown" instances.
	version: string;
	arch: string;
	commit?: string;
	vms?: number;
	apps?: number;
}

const ALLOWED_ARCHES = new Set(["x86_64", "aarch64"]);

function isValidUUID(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isValidVersion(s: unknown): s is string {
	return typeof s === "string" && s.length > 0 && s.length <= 32 && /^[0-9a-zA-Z.+\-]+$/.test(s);
}

function isValidCommit(s: unknown): s is string {
	return typeof s === "string" && /^[0-9a-f]{4,40}$/i.test(s);
}

function isValidCount(n: unknown, max: number): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
}

function isValidArch(s: unknown): s is string {
	return typeof s === "string" && ALLOWED_ARCHES.has(s);
}

function isValidPayload(body: unknown): body is ReportPayload {
	if (typeof body !== "object" || body === null) return false;
	const b = body as Record<string, unknown>;
	// version + arch are required (see ReportPayload).
	if (!isValidVersion(b.version)) return false;
	if (!isValidArch(b.arch)) return false;
	if (b.commit !== undefined && !isValidCommit(b.commit)) return false;
	if (b.vms !== undefined && !isValidCount(b.vms, 10000)) return false;
	if (b.apps !== undefined && !isValidCount(b.apps, 10000)) return false;
	return (
		typeof b.instance_id === "string" &&
		isValidUUID(b.instance_id) &&
		typeof b.drives === "number" &&
		Number.isInteger(b.drives) &&
		b.drives > 0 &&
		b.drives <= 1000 &&
		typeof b.total_bytes === "number" &&
		b.total_bytes >= 0 &&
		typeof b.used_bytes === "number" &&
		b.used_bytes >= 0
	);
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

async function handleReport(request: Request, env: Env): Promise<Response> {
	// Rate-limit BEFORE parsing the body so a flood of malformed POSTs
	// can't consume D1 quota or worker CPU on JSON parsing. The check
	// is keyed on the source IP via the CF-Connecting-IP header — the
	// only header Cloudflare guarantees is the original client IP
	// (X-Forwarded-For can be appended by anyone upstream).
	const rl = await applyRateLimit(request, env);
	if (rl) return rl;

	const body = await request.json().catch(() => null);
	if (!isValidPayload(body)) {
		return json({ error: "invalid payload" }, 400);
	}

	await env.DB.prepare(
		`INSERT OR REPLACE INTO telemetry (instance_id, reported_at, drives, total_bytes, used_bytes, version, commit_sha, vms, apps, arch)
		 VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			body.instance_id,
			body.drives,
			body.total_bytes,
			body.used_bytes,
			body.version,
			body.commit ?? null,
			body.vms ?? null,
			body.apps ?? null,
			body.arch,
		)
		.run();

	return json({ ok: true });
}

interface Row {
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

async function handleStats(env: Env): Promise<Response> {
	// Get all reports from active instances (reported within last 3 days)
	// Include their full history for the chart (last 90 days)
	const rows = await env.DB.prepare(
		`SELECT instance_id, reported_at, drives, total_bytes, used_bytes, version, commit_sha, vms, apps, arch
		 FROM telemetry
		 WHERE instance_id IN (
		   SELECT instance_id FROM telemetry WHERE reported_at >= date('now', '-3 days')
		 )
		 AND reported_at >= date('now', '-90 days')
		 ORDER BY reported_at`
	).all<Row>();

	if (rows.results.length === 0) {
		return json({ days: [], latest: { versions: [], arches: [] } }, 200);
	}

	// Collect all unique days
	const allDays = [...new Set(rows.results.map((r) => r.reported_at))].sort();

	// For each day, use the instance's report for that day, or carry forward
	// its most recent previous report. This avoids dips when instances
	// haven't reported yet today due to random jitter.
	const lastSeen = new Map<string, Row>();
	const days = allDays.map((day) => {
		// Update lastSeen with any reports from this day
		for (const r of rows.results) {
			if (r.reported_at === day) {
				lastSeen.set(r.instance_id, r);
			}
		}

		// Aggregate from all instances last seen within 3 days of this day
		let instances = 0;
		let drives = 0;
		let total_bytes = 0;
		let used_bytes = 0;
		let vms = 0;
		let apps = 0;

		for (const [, r] of lastSeen) {
			// Only count if last report is within 3 days of this day
			const dayMs = new Date(day).getTime();
			const reportMs = new Date(r.reported_at).getTime();
			if (dayMs - reportMs <= 3 * 86400000) {
				instances++;
				drives += r.drives;
				total_bytes += r.total_bytes;
				used_bytes += r.used_bytes;
				vms += r.vms ?? 0;
				apps += r.apps ?? 0;
			}
		}

		return { day, instances, drives, total_bytes, used_bytes, vms, apps };
	});

	// Build breakdowns from the final-day lastSeen snapshot. Same 3-day
	// staleness gate as the per-day aggregates so we agree with the "Active
	// Instances" stat card.
	const finalDay = allDays[allDays.length - 1];
	const finalDayMs = new Date(finalDay).getTime();
	const versionCounts = new Map<string, number>();
	const archCounts = new Map<string, number>();
	for (const [, r] of lastSeen) {
		const reportMs = new Date(r.reported_at).getTime();
		if (finalDayMs - reportMs > 3 * 86400000) continue;
		// Group commits under their semver. "+" indicates "0.0.3 family,
		// exact commit may vary" — see dashboard for rendering.
		const versionLabel = r.version ? `${r.version}+` : "unknown";
		versionCounts.set(versionLabel, (versionCounts.get(versionLabel) ?? 0) + 1);
		const archLabel = r.arch ?? "unknown";
		archCounts.set(archLabel, (archCounts.get(archLabel) ?? 0) + 1);
	}

	const sortDesc = (a: [string, number], b: [string, number]) =>
		b[1] - a[1] || a[0].localeCompare(b[0]);
	const versions = [...versionCounts.entries()]
		.sort(sortDesc)
		.map(([version, instances]) => ({ version, instances }));
	const arches = [...archCounts.entries()]
		.sort(sortDesc)
		.map(([arch, instances]) => ({ arch, instances }));

	return json({ days, latest: { versions, arches } }, 200);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		if (url.pathname === "/api/report" && request.method === "POST") {
			return handleReport(request, env);
		}

		if (url.pathname === "/api/stats" && request.method === "GET") {
			return handleStats(env);
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
