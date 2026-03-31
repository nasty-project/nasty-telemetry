# NASty Telemetry

Anonymous telemetry for the [NASty](https://github.com/nasty-project/nasty) NAS appliance. Enabled by default, can be disabled from the WebUI. Helps us understand how NASty is used in the real world — how many drives, how much storage, how many instances.

## Dashboard

**[https://nasty-telemetry.pages.dev/](https://nasty-telemetry.pages.dev/)**

## What is collected

Every 24 hours (with random jitter), each NASty instance sends a single JSON payload:

```json
{
  "instance_id": "a1b2c3d4-...",
  "drives": 3,
  "total_bytes": 6000000000000,
  "used_bytes": 1500000000000
}
```

| Field | Description |
|-------|-------------|
| `instance_id` | Random UUID generated on first boot, persisted at `/var/lib/nasty/telemetry-id`. Not tied to any user identity. |
| `drives` | Total number of block devices across all mounted bcachefs filesystems. |
| `total_bytes` | Total storage capacity across all mounted filesystems. |
| `used_bytes` | Total storage used across all mounted filesystems. |

**That's it.** No hostnames, no IP addresses, no file names, no user data, no hardware identifiers.

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

## Privacy

- The `instance_id` is a random UUID with no relation to hardware, network, or user identity.
- Reports are sent over HTTPS to a Cloudflare Worker.
- No cookies, no fingerprinting, no tracking beyond the anonymous instance ID.
- Disabling telemetry immediately stops all data collection — no "last report" is sent.
