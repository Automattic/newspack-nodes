# Newspack Nodes REST API

The runtime ships exactly one REST endpoint — the worker spawn handler. Application plugins register their own endpoints (status, dashboards, SSE streams, etc.) on top.

For the full architecture and rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Worker Spawn

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
```

HMAC-validated zombie-process spawn. Used internally by the supervisor and by the worker's own `self_respawn()` chain. **Not for public callers** — the HMAC token rotates every 10s and is per-site (`NONCE_SALT`-keyed); externally calling this endpoint without a valid token returns `403 Forbidden`.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Worker type (matches a key in the `newspack_nodes/topologies` filter, e.g. `firehose-workers`, `request-workers`, `aggregator`). |
| `partition` | int | yes | Partition index, 0-based. Must be `< num_partitions` for this `type`. |
| `nonce` | string | yes | HMAC-SHA256 token. Computed as `hash_hmac('sha256', "newspack_nodes_spawn:{$window}", NONCE_SALT)` where `$window = floor(time() / 10)`. The endpoint accepts both the current window and the immediately preceding window for race tolerance. |

Body: form-encoded (`application/x-www-form-urlencoded`) or JSON (`application/json`).

### Response

#### 200 OK

```json
{
  "spawned": true,
  "type": "firehose-workers",
  "partition": 3
}
```

For `type=supervisor`, the response additionally includes a sanitized `result` payload (whitelist `entries_processed`, `requests_complete`, `requests_pending`, `flames_written`, `jobs_processed`) drawn from the supervisor's synchronous `run()` return.

The endpoint acknowledges synchronously, then detaches from FPM via `fastcgi_finish_request()` (or proceeds inline if not in FPM context, e.g. CLI tests). After detach:

1. `ignore_user_abort(true) + set_time_limit(0)` so the process survives the client disconnect.
2. `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` and `$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']` are populated for sub-actions / logging.
3. For topology workers, the `newspack_nodes/spawn_worker` action fires with `( string $type, int $partition )`. For `type=supervisor`, the controller instantiates and runs the supervisor synchronously inside the request — no separate fork.

Topology owners hook the `newspack_nodes/spawn_worker` action to instantiate the right worker class for the given `$type` and call `->execute()`. The runtime ships no built-in topologies; application plugins (e.g., `newspack-event-logger-nodes`) register them.

#### 403 Forbidden

```json
{
  "code": "invalid_token",
  "message": "Invalid spawn token",
  "data": { "status": 403 }
}
```

Returned when the `nonce` does not validate against either the current or previous 10s HMAC window. This is the normal response for unauthenticated callers — the supervisor regenerates the token each tick.

## Authentication

The spawn endpoint uses dual-mode auth (`SpawnController::check_permission`):

1. **HMAC nonce** — `Supervisor::validate_spawn_token()` against the current or previous 10s window. Used by the supervisor's automated POSTs and the worker's self-respawn POSTs. No user capability check.
2. **WordPress admin** — `current_user_can( 'manage_options' )` AND `wp_verify_nonce( $nonce, 'newspack_nodes_spawn_worker' )` AND a 2s per-user rate limit (transient-backed). For dashboard-initiated spawns. Order matters: capability is checked before rate-limit so unauthenticated requests can't poison the rate-limit transient table.

Both paths require the `nonce` field; only the validator differs. There is no env-var bypass — `NEWSPACK_NODES_WORKER_TYPE` / `_PARTITION` are written to `$_SERVER` *after* auth passes (see [Worker Identity Tags](#worker-identity-tags)) and are not consulted during permission checks.

Application plugins that add their own REST endpoints typically use `current_user_can( 'manage_options' )` for human-facing endpoints and a separate HMAC scheme (or capability + nonce combo) for machine-facing endpoints. See `newspack-event-logger-nodes/API.md` for the application-side auth patterns.

## Worker Identity Tags

After auth passes and `fastcgi_finish_request()` detaches the handler, the spawn controller sets two `$_SERVER` keys:

```php
$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;        // e.g. "firehose-workers"
$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;  // e.g. "3"
```

These are process-identity tags, not credentials. Downstream code uses them to:

- **Exclude worker self-traffic from stats.** Log readers see request entries from worker processes and skip them so the supervisor / firehose-worker churn doesn't pollute global request counters.
- **Tag log lines for correlation.** Audit / error log writers can include `[firehose-workers/p3]` so tail-grep tooling knows where an entry came from.
- **Provide context to sub-actions.** The `newspack_nodes/spawn_worker` action handler and any nested `do_action`s inside the worker can introspect the env to know which worker they're inside without re-passing arguments.

`Supervisor::run()` writes the same keys (`'supervisor'` / `'0'`) at the top of its tick loop so it's tagged consistently with topology workers.

## Rate Limiting

The spawn endpoint applies a 2-second per-user rate limit (`SpawnController::RATE_LIMIT_S`) on the WordPress-admin auth path — transient-backed, returning `429` on overflow. The HMAC path is not rate-limited at the REST layer; spawn rate-limiting for internal traffic happens at the supervisor:

- `MIN_SPAWN_INTERVAL_S = 15` per `{type}|{partition}` key (`SupervisorBase::MIN_SPAWN_INTERVAL_S`).
- Tracked in `SupervisorBase::$last_spawn_time`; updated after every spawn attempt (success or failure).

Application plugins that add public-facing endpoints should layer their own rate limits on top.
