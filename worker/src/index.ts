export interface Env {
	DB: D1Database;
}

interface ReportPayload {
	instance_id: string;
	drives: number;
	total_bytes: number;
	used_bytes: number;
}

function isValidUUID(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isValidPayload(body: unknown): body is ReportPayload {
	if (typeof body !== "object" || body === null) return false;
	const b = body as Record<string, unknown>;
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
	const body = await request.json().catch(() => null);
	if (!isValidPayload(body)) {
		return json({ error: "invalid payload" }, 400);
	}

	await env.DB.prepare(
		`INSERT OR REPLACE INTO telemetry (instance_id, reported_at, drives, total_bytes, used_bytes)
		 VALUES (?, date('now'), ?, ?, ?)`
	)
		.bind(body.instance_id, body.drives, body.total_bytes, body.used_bytes)
		.run();

	return json({ ok: true });
}

interface Row {
	instance_id: string;
	reported_at: string;
	drives: number;
	total_bytes: number;
	used_bytes: number;
}

async function handleStats(env: Env): Promise<Response> {
	// Get all reports from active instances (reported within last 3 days)
	// Include their full history for the chart (last 90 days)
	const rows = await env.DB.prepare(
		`SELECT instance_id, reported_at, drives, total_bytes, used_bytes
		 FROM telemetry
		 WHERE instance_id IN (
		   SELECT instance_id FROM telemetry WHERE reported_at >= date('now', '-3 days')
		 )
		 AND reported_at >= date('now', '-90 days')
		 ORDER BY reported_at`
	).all<Row>();

	if (rows.results.length === 0) {
		return json({ days: [] }, 200);
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

		for (const [, r] of lastSeen) {
			// Only count if last report is within 3 days of this day
			const dayMs = new Date(day).getTime();
			const reportMs = new Date(r.reported_at).getTime();
			if (dayMs - reportMs <= 3 * 86400000) {
				instances++;
				drives += r.drives;
				total_bytes += r.total_bytes;
				used_bytes += r.used_bytes;
			}
		}

		return { day, instances, drives, total_bytes, used_bytes };
	});

	return json({ days }, 200);
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
