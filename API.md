# Newspack Nodes REST API

The runtime ships two REST endpoints — the worker spawn handler and a unified command-dispatch endpoint. Application plugins register their own endpoints (dashboards, SSE streams, etc.) on top, plus mount service `Command_Interpreter_Node`s into the dispatch endpoint's graph via the `newspack_nodes/request_graph_ready` hook.

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

The spawn endpoint uses dual-mode auth (`Spawn_Controller::check_permission`):

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

The spawn endpoint applies a 2-second per-user rate limit (`Spawn_Controller::RATE_LIMIT_S`) on the WordPress-admin auth path — transient-backed, returning `429` on overflow. The HMAC path is not rate-limited at the REST layer; spawn rate-limiting for internal traffic happens at the supervisor:

- `MIN_SPAWN_INTERVAL_S = 15` per `{type}|{partition}` key (`Supervisor_Base::MIN_SPAWN_INTERVAL_S`).
- Tracked in `Supervisor_Base::$last_spawn_time`; updated after every spawn attempt (success or failure).

Application plugins that add public-facing endpoints should layer their own rate limits on top.

## Command Dispatch

```
POST  /wp-json/newspack-nodes/v1/command
```

Unified non-streaming dispatch endpoint. The browser POSTs a TM_COMMAND envelope; the controller routes it through the request-scope `_router` to the named CI; the CI's reply walks back via `TO=FROM` through `_http` (an `HTTP_In_Node` — a double-duty class that is BOTH the `/command` REST controller and the egress Node registered as `_http`) which writes the packed Message directly to the HTTP response body.

Permission callback: `current_user_can('manage_options')`. Application CIs may layer additional per-verb capability checks on top — that's an application concern, not the substrate's.

### Request

JSON body (the substrate's 7-slot `Message` array, named):

| Field | Type | Description |
|-------|------|-------------|
| `type` | int | Bitmask. `8` = `TM_COMMAND`. |
| `to` | string | CI shell-name (e.g. `performance`, `workers`). Router peels the head off; subpaths flow through. |
| `from` | string | Reply path. Defaults to `_http` when empty. Pivoted IPC commands set `_http/<ssePid>` so the reply walks back to an SSE process instead of HTTP. |
| `id` | string | Caller-chosen correlation id. The CI's reply carries the same `id`. |
| `value` | string | Inner Command_Interpreter_Node envelope: JSON-encoded `{name, arguments, payload}`. `name` is the verb. |

Alternatively, the browser may POST the raw 7-slot array directly. The controller detects array-shaped bodies via `array_is_list($body) && count($body) >= 7` and uses it as the Message.

### Response

#### Synchronous (in-process reply)

The CI's `interpret()` produced a reply; `HTTP_In_Node::fill()` (the egress side) wrote the packed Message to the body and set `sent_headers=true`. The controller `exit()`s to bypass WP's REST wrapping.

#### 202 Accepted (async / IPC)

```json
{ "queued": true, "id": "<request id>" }
```

Returned when `Router_Node::fill()` returned without the `HTTP_In_Node` egress seeing a reply — typically because the message was routed to a per-worker `Partition` Node and is being delivered via disk IPC. Real replies arrive through the SSE stream the browser already has open.

#### 500 Internal Server Error

```json
{
  "type": 48,  // TM_RESPONSE | TM_ERROR
  "from": "_command",
  "to": "<request from>",
  "id": "<request id>",
  "value": "request-scope graph not initialized (missing _router or _http)"
}
```

Sent (as a packed Message) when `ensure_request_graph()` couldn't build the graph — typically a bootstrap-misconfiguration condition. Operational application errors don't reach this path; they come back as `TM_COMMAND|TM_ERROR` replies through the normal sync path with the verb's exception message in `VALUE`.

### Service CIs

The substrate plugin mounts 5 service CIs via `newspack_nodes/request_graph_ready`. Each is a `Service_CI_Node` (except `Classes_CI_Node`, which extends `Command_Interpreter_Node` directly) declaring its own `node_schema()`:

| CI shell-name | Class | Verbs |
|---------------|-------|-------|
| `classes` | `Classes_CI_Node` | `list` |
| `layouts` | `Layouts_CI_Node` | `get`, `save` |
| `topologies` | `Topologies_CI_Node` | `list`, `get`, `save`, `delete` |
| `raw-logs` | `Raw_Logs_CI_Node` | `firehose_logs`, `firehose_status` |
| `workers` | `Workers_CI_Node` | `list`, `dump_metadata`, `audit`, `cleanup`, `restart`, `heartbeat` |

Every CI also answers a default `help` (sorted list of its own verbs) — injected by `Command_Interpreter_Node::commands()` when a subclass installs a custom verb table without its own `help`.

Application plugins layer additional CIs onto the same endpoint (the first being `newspack-event-logger-nodes` with its application-side CIs). The `to` field on the dispatch envelope distinguishes targets — there is no substrate-vs-application namespacing at the endpoint layer.

**`node_schema()` shape.** Each CI's `node_schema()` returns a `Service`-category schema: `{ category, description, arguments, commands }`, where `commands` is a list of `{ name, description, args }` and each arg is `{ name, type, required }`. This is what `Classes_CI`'s `list` verb inlines for the topology-editor palette, and what the live-mode Inspector reads to build verb-invocation forms.

**Scalar verbs read positional `arguments`, not `payload`.** Verbs that take a single scalar — `topologies get`/`delete` (a topology name), `layouts get` (a name), `raw-logs firehose_status` (a log key), `workers heartbeat` (an SSE slot) — read it from the inner envelope's positional `arguments` string so they're typeable straight in the REPL (e.g. `command_node topologies get Home`). Structured verbs (`topologies save` with TSL, `layouts save` with positions, `workers restart` with a `types[]` array) still take their data from `payload`.

**`KEY='completion'` mode.** A `help` or `ls` command carrying `KEY='completion'` returns a bare newline-separated candidate list (sorted verb names / bare node names) instead of the tabulated output — the substrate's `TM_COMPLETION` analogue, used by REPL tab-completion. See [ARCHITECTURE.md → Completion-query mode](ARCHITECTURE.md#repl-wp-nodes-cli).

Per-verb args, return shapes, and error semantics are declared on each CI's `node_schema()` (`commands[]`) in `includes/rest/class-{classes,layouts,topologies,raw-logs,workers}-ci.php`; the topology-editor palette and live-mode Inspector consume the same schema. Auth gating is uniform: the `/command` endpoint requires `manage_options` (see "Permission callback" above), and per-verb application-side caps are an application concern.

### Test mode

`HTTP_In_Node::set_test_mode(true)` makes `dispatch()` return instead of `exit()`, so PHPUnit can capture stdout via `ob_start()`.

## Extensibility hooks

### `newspack_nodes/request_graph_ready`

Fires from `HTTP_In_Node::dispatch()` after the request-scope graph has been built (or confirmed already-built). The substrate has `_router`, `_command_interpreter` (the base CI), and `_http` (the `HTTP_In_Node` egress) registered in `Core`'s node map at this point.

**Signature:**

```php
do_action( 'newspack_nodes/request_graph_ready', \Newspack_Nodes\Command_Interpreter_Node $base_ci );
```

**Canonical usage** — applications mount their service CIs through the base CI's `make_node()`:

```php
function my_app_mount_service_cis( \Newspack_Nodes\Command_Interpreter_Node $base_ci ): void {
    $base_ci->make_node( 'My_Service_CI', 'my-service', $dep1, $dep2 );
    // ... more service CIs ...
}
\add_action( 'newspack_nodes/request_graph_ready', 'my_app_mount_service_cis' );
```

`make_node( $type, $name, ...$ctor_args )` does three things atomically:

1. Resolves and instantiates the first `{$prefix}{$type}_Node` that exists and is a concrete `Node` subclass, looping the prefixes registered via `Command_Interpreter_Node::register_namespace()` at plugin load time. (So `make_node( 'My_Service_CI', ... )` resolves `My_App\My_Service_CI_Node` once `My_App\` is registered. There is no per-class `register_class` registry — applications register their *namespace prefix* once.)
2. Calls `$node->name( $name )` so Router can find it.
3. Calls `$node->sink( $this )` so the node's reply routes back through the base CI → `_router` → `_http`.

Skipping `make_node()` — by constructing and `name()`-ing the node by hand — leaves it unwired. Verb responses (which walk back via `TO=FROM`) have no path to the `HTTP_In_Node` egress and silently drop on the floor. Always go through `make_node()`.

The hook fires on every `/command` request after lazy-build; it's idempotent on the CI side because `make_node()` overwrites prior registrations under the same name. Applications can re-mount the same CI on every request without leaking state across requests as long as their CIs aren't holding stateful per-request data (the typical pattern: CIs are pure verb dispatchers, dependencies injected via constructor).

For the application-side build-out, see the per-CI `node_schema()` declarations under `newspack-event-logger-nodes/includes/rest/` (the `*_CI_Node` classes mounted via `newspack_nodes/request_graph_ready`).
