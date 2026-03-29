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

async function handleStats(env: Env): Promise<Response> {
	// Active instances: only those that reported within the last 3 days
	const activeInstances = await env.DB.prepare(
		`SELECT instance_id FROM telemetry WHERE reported_at >= date('now', '-3 days') GROUP BY instance_id`
	).all();

	const activeIds = activeInstances.results.map((r) => r.instance_id as string);

	if (activeIds.length === 0) {
		return json({ days: [] }, 200);
	}

	// Time-series for active instances (last 90 days)
	const placeholders = activeIds.map(() => "?").join(",");
	const timeseries = await env.DB.prepare(
		`SELECT reported_at as day,
		        COUNT(DISTINCT instance_id) as instances,
		        SUM(drives) as drives,
		        SUM(total_bytes) as total_bytes,
		        SUM(used_bytes) as used_bytes
		 FROM telemetry
		 WHERE instance_id IN (${placeholders})
		   AND reported_at >= date('now', '-90 days')
		 GROUP BY reported_at
		 ORDER BY reported_at`
	)
		.bind(...activeIds)
		.all();

	return json(
		{ days: timeseries.results },
		200,
	);
}

async function handleCleanup(env: Env): Promise<void> {
	// Purge data for instances that haven't reported in 30 days
	await env.DB.prepare(
		`DELETE FROM telemetry
		 WHERE instance_id NOT IN (
		   SELECT instance_id FROM telemetry WHERE reported_at >= date('now', '-30 days')
		 )`
	).run();
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

	async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
		await handleCleanup(env);
	},
} satisfies ExportedHandler<Env>;
