# NASty Telemetry

Privacy-preserving usage telemetry for the [NASty](https://github.com/nasty-project/nasty) NAS appliance. Enabled by default, can be disabled from the WebUI. Helps us understand how NASty is used in the real world — how many drives, how much storage, how many instances.

## Dashboard

**[https://nasty-telemetry.pages.dev/](https://nasty-telemetry.pages.dev/)**

## What is collected

Every 24 hours (with random jitter), each NASty instance sends a single JSON payload:

```json
{
  "instance_id": "a1b2c3d4-...",
  "drives": 3,
  "total_bytes": 6000000000000,
  "used_bytes": 1500000000000,
  "version": "0.0.3",
  "commit": "a1b2c3d",
  "vms": 2,
  "apps": 5,
  "smb_shares": 3,
  "nfs_exports": 1,
  "iscsi_luns": 2,
  "nvmeof_namespaces": 1,
  "arch": "x86_64"
}
```

| Field | Description |
|-------|-------------|
| `instance_id` | Random UUID generated on first boot, persisted at `/var/lib/nasty/telemetry-id`. Not tied to any user identity. |
| `drives` | Total number of block devices across all mounted bcachefs filesystems. |
| `total_bytes` | Total storage capacity across all mounted filesystems. |
| `used_bytes` | Total storage used across all mounted filesystems. |
| `version` | NASty engine semver (`CARGO_PKG_VERSION` at build time). |
| `commit` | Short git SHA the engine was built from. Omitted for dev cargo builds. |
| `vms` | Total number of configured VMs (running + stopped). |
| `apps` | Total number of installed apps. |
| `smb_shares` | Number of configured SMB shares. Omitted if collection fails. |
| `nfs_exports` | Number of configured NFS exports. Omitted if collection fails. |
| `iscsi_luns` | Number of configured iSCSI LUNs. Omitted if collection fails. |
| `nvmeof_namespaces` | Number of configured NVMe-oF namespaces. Omitted if collection fails. |
| `arch` | CPU architecture — `x86_64` or `aarch64`. |

**That's it.** The report payload contains no hostnames, IP addresses, file names, user data, or hardware identifiers.

## Source code

The telemetry collection and reporting logic lives in the NASty engine:

[`engine/nasty-engine/src/telemetry.rs`](https://github.com/nasty-project/nasty/blob/main/engine/nasty-engine/src/telemetry.rs)

```rust
#[derive(Serialize)]
struct Report {
    instance_id: String,
    drives: usize,
    total_bytes: u64,
    used_bytes: u64,
    version: &'static str,
    commit: Option<String>,
    vms: usize,
    apps: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    smb_shares: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nfs_exports: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    iscsi_luns: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvmeof_namespaces: Option<usize>,
    arch: &'static str,
}
```

The report is collected from mounted bcachefs filesystems:

```rust
for fs in &mounted {
    drives += fs.devices.len();
    total_bytes += fs.total_bytes;
    used_bytes += fs.used_bytes;
}
```

## Opt-out

Telemetry is **enabled by default** but can be disabled at any time from the NASty WebUI:

**Settings → Telemetry → Disable**

When disabled, no data is sent. The `telemetry_enabled` flag is checked before every report:

```rust
if !state.settings.get().await.telemetry_enabled {
    debug!("Telemetry disabled, skipping report");
    return false;
}
```

## Architecture

- **Worker** (`worker/`) — Cloudflare Worker that receives reports and stores them in D1 (SQLite).
- **Site** (`site/`) — Static dashboard that reads from the worker's API and renders charts with Chart.js.
- **Migrations** (`worker/migrations/`) — The complete D1 schema history for both fresh and existing databases; apply with `wrangler d1 migrations apply nasty-telemetry`.

## Aggregation and retention

- Each instance contributes at most one row per UTC day; sending again replaces that day's row.
- An instance is considered active for three days after its most recent report.
- The public API exposes a rolling 90-day aggregate plus current distributions and adoption totals. It never returns instance IDs or individual reports.
- Daily per-instance rows are currently retained indefinitely. The planned retention model is to materialize permanent daily aggregates and delete per-instance rows after 90 days, preserving long-term trends without keeping long-term pseudonymous history.

## Abuse protection

`POST /api/report` is rate-limited at the Cloudflare edge to **5 requests per minute per source IP**. A real NASty engine reports once every 24 hours (with random jitter), so a single legitimate box never approaches the limit; the cap exists so a script can't flood the worker with thousands of fake `instance_id` UUIDs to inflate the dashboard's *Active Instances* pill. Exceeded requests get an HTTP 429 with `Retry-After: 60`. The limit is configured via the `[[unsafe.bindings]] type = "ratelimit"` block in `worker/wrangler.toml`; self-hosters can adjust it there.

`GET /api/stats` is intentionally not rate-limited — it's a read-only dashboard endpoint and the data it returns is already public.

## Privacy

- The `instance_id` is a random UUID with no relation to hardware, network, or user identity.
- Reports are sent over HTTPS to a Cloudflare Worker.
- The persistent pseudonymous UUID associates daily reports from the same installation; it is not derived from hardware or user data.
- Source IPs are used transiently by Cloudflare's rate limiter and are not stored in the telemetry database.
- Disabling telemetry immediately stops all data collection — no "last report" is sent.
