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
  "spawned": true
}
```

The endpoint acknowledges synchronously, then detaches from FPM via `fastcgi_finish_request()` (or proceeds inline if not in FPM context, e.g. CLI tests). After detach:

1. `ignore_user_abort(true) + set_time_limit(0)` so the process survives the client disconnect.
2. `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` and `$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']` are populated for sub-actions / logging.
3. The `newspack_nodes/spawn_worker` action fires with `( string $type, int $partition )`.

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

The spawn endpoint uses dual-mode auth:

1. **HMAC nonce** (the only path covered above) — for the supervisor's automated POST and the worker's self-respawn POST.
2. **`NEWSPACK_NODES_WORKER_TYPE` env-var bypass** (for processes that already passed the HMAC check and are running zombie inside the spawn handler — they don't re-validate against themselves). Reconciles cleanly with the HMAC path; the env-bypass is for processes that already passed it.

Application plugins that add their own REST endpoints typically use `current_user_can( 'manage_options' )` for human-facing endpoints and a separate HMAC scheme (or capability + nonce combo) for machine-facing endpoints. See `newspack-event-logger-nodes/API.md` for the application-side auth patterns.

## Rate Limiting

The runtime does not rate-limit the spawn endpoint at the REST layer. Spawn rate-limiting happens at the supervisor:

- `MIN_SPAWN_INTERVAL_S = 15` per `{type}|{partition}` key.
- Tracked in `Supervisor::$last_spawn_time`; updated after every spawn attempt (success or failure).

Application plugins that add public-facing endpoints should use `PerformanceControllerBase::check_rate_limit()` or equivalent. See `newspack-event-logger-nodes/API.md`.
