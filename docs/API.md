# Newspack Nodes REST API

The runtime ships three REST endpoints — the worker spawn handler, the unified command-dispatch endpoint, and a server-sent-events stream. Application plugins register their own endpoints (dashboards, additional streams, etc.) on top, plus mount service `Command_Interpreter_Node`s into the dispatch endpoint's graph via the `newspack_nodes/request_graph_ready` hook.

For the full architecture and rationale, see [architecture-guide.md](architecture-guide.md).

## Worker Spawn

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
```

HMAC-validated zombie-process spawn. Used internally by the supervisor and by the worker's own `self_respawn()` chain. **Not for public callers** — the HMAC token rotates every 10s and is per-site (`NONCE_SALT`-keyed); externally calling this endpoint without a valid token returns `403 Forbidden`.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Worker type — matches a registered topology name (see `wp nodes types`), e.g. `combined`, `aggregator`, `job-worker`. Topology names are deployment-specific. |
| `partition` | int | yes | Partition index, 0-based. Must be `< num_partitions` for this `type`. |
| `nonce` | string | yes | HMAC-SHA256 token. Computed as `hash_hmac('sha256', "newspack_nodes_spawn:{$window}", NONCE_SALT)` where `$window = floor(time() / 10)`. The endpoint accepts both the current window and the immediately preceding window for race tolerance. |

Body: form-encoded (`application/x-www-form-urlencoded`) or JSON (`application/json`).

### Response

#### 200 OK

```json
{
  "spawned": true,
  "type": "combined",
  "partition": 3
}
```

For `type=supervisor`, the response additionally includes a sanitized `result` payload drawn from the supervisor's synchronous `run()` return. Sanitization is generic, not a fixed whitelist: `Spawn_Controller::sanitize_worker_result()` keeps a string `status` field and surfaces every other key matching `[a-zA-Z0-9_]{1,40}` whose value is numeric (cast to int), capped at 32 fields. Strings, arrays, paths, and traces are dropped so no internal paths leak.

The endpoint acknowledges synchronously, then detaches from FPM via `fastcgi_finish_request()` (or proceeds inline if not in FPM context, e.g. CLI tests). After detach:

1. `ignore_user_abort(true) + set_time_limit(0)` so the process survives the client disconnect.
2. `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` and `$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']` are populated for sub-actions / logging.
3. For topology workers, the `newspack_nodes/spawn_worker` action fires with `( string $type, int $partition )`. For `type=supervisor`, the controller instantiates and runs the supervisor synchronously inside the request — no separate fork.

Topology owners hook the `newspack_nodes/spawn_worker` action to instantiate the right worker class for the given `$type` and call `->execute()`. The runtime ships two builtin topologies — `job-worker` (the generic `Job_Worker_Node`, spawned per-partition) and `hub-control` (a single-instance settings-sync / discovery control plane, `num_partitions = 1`) — both registered from `topologies/` via `Topology_Registry::register_builtin_dir` and spawned through the same `Topology_Registry::spawn_worker` handler on `newspack_nodes/spawn_worker`. Application plugins (e.g., `newspack-event-logger-nodes`) register the rest. **Every active topology, builtin or app, spawns through this one hook** — there is no separate "control-plane" spawn path.

`Job_Worker_Node` is generic async-job dispatch: applications register local/remote handlers via the `newspack_nodes/{job,remote_job}_handlers` filters, and the worker fires `newspack_nodes/job_worker/{before,after}_job` actions around each job so apps can establish/tear down per-job request context.

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

Application plugins that add their own REST endpoints typically use `current_user_can( 'manage_options' )` for human-facing endpoints and a separate HMAC scheme (or capability + nonce combo) for machine-facing endpoints. See `newspack-event-logger-nodes/docs/API.md` for the application-side auth patterns.

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

The `/command` endpoint applies its own per-user burst limit (`HTTP_In_Node::permission_callback`): `RATE_LIMIT_BURST = 30` POSTs per `RATE_LIMIT_WINDOW_S = 1` second per user, bucketed by clock-second (transient-backed), returning `429 Too Many Requests` on overflow. The burst budget is tunable via the `newspack_nodes/command_rate_limit` filter (clamped to a minimum of 1).

Application plugins that add public-facing endpoints should layer their own rate limits on top.

## Command Dispatch

```
POST  /wp-json/newspack-nodes/v1/command
```

Unified non-streaming dispatch endpoint. The browser POSTs a TM_COMMAND envelope; the controller routes it through the request-scope `_router` to the named CI; the CI's reply walks back via `TO=FROM` through `_output` (an `HTTP_In_Node` — a double-duty class that is BOTH the `/command` REST controller and the egress Node registered as `_output`, i.e. `Node_Names::OUTPUT`) which writes the packed Message directly to the HTTP response body. (The JS runtime uses `_http` as its egress/Shell.path name, and the SSE process's `HTTP_Filter` egress is also named `_output` — but the PHP `/command` egress is `_output`.)

Permission callback: `current_user_can('manage_options')`. Application CIs may layer additional per-verb capability checks on top — that's an application concern, not the substrate's.

### Request

The body is **JSONL** — one packed Message per line, where each line is the JSON of the substrate's 7-slot positional array `[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]` (the wire form emitted by `Message::packed()`). Multiple lines in one POST batch through the request-scope graph serially, so an earlier command's side effect is visible to a later one. Blank lines are skipped. The controller throws if no line parses to a Message.

Per-slot semantics (named here for documentation only — the wire is positional):

| Slot | Type | Description |
|------|------|-------------|
| `TYPE` (index 0) | int | Bitmask. `TM_COMMAND` (`8`) for a dispatch. |
| `TIMESTAMP` (index 1) | float | Microsecond unix timestamp; the controller does not require it. |
| `FROM` (index 2) | string | Reply path. The `HTTP_In_Node` stamps `_output` onto it on the way in, so a bare reply path (`_output`, `_sse:{pid}/…`, or empty) walks back to this endpoint. |
| `TO` (index 3) | string | CI shell-name (e.g. `topologies`, `workers`). Router peels the head off; subpaths flow through. Empty TO is dispatched by the base CI in-place. |
| `ID` (index 4) | string | Caller-chosen correlation id. The CI's reply carries the same `id`. |
| `KEY` (index 5) | string | Routing/correlation metadata (e.g. `'completion'` triggers REPL completion-list mode on `help`/`ls`). |
| `VALUE` (index 6) | array | The inner Command_Interpreter envelope `{name, arguments}` as a live JSON array. `name` is the verb; `arguments` is a **flat token array** (`list<string>` argv) — the Shell/`CommandClient` tokenizes ONCE at the producer boundary and the tokens ride verbatim through the envelope, interpreter, and `make_node`. Every verb (scalar and structured alike) reads its data from that token array (`$args[0]`, `$args[1]`, …). (The request-side `payload` slot was removed in 0.6.0.) |

The browser's `CommandClient` and the attached `wp nodes cli` both produce this exact wire shape via `Message::packed()`.

### Response

#### Synchronous (in-process reply)

The CI's `interpret()` produced a reply; `HTTP_In_Node::fill()` (the egress side) wrote the packed Message to the body and set `sent_headers=true`. The controller `exit()`s to bypass WP's REST wrapping.

#### 202 Accepted (async / IPC)

```json
{ "queued": true, "id": "<request id>" }
```

Returned when `Router_Node::fill()` returned without the `HTTP_In_Node` egress seeing a reply — typically because the message was routed to a per-worker `Partition` Node and is being delivered via disk IPC. Real replies arrive through the SSE stream the browser already has open.

#### 500 Internal Server Error

Sent as a packed positional Message (the same wire shape as the request). Example body:

```json
[288, 0, "_command", "<request from>", "<request id>", "", "request-scope graph not initialized (missing _router or _output)"]
```

`TYPE = 288 = TM_RESPONSE | TM_ERROR` (`256 | 32`). `Content-Type: application/json`. Emitted by `HTTP_In_Node::emit_error()` when `dispatch()`'s post-build instanceof guard fails — `Core::node(_router)` is not a `Router_Node` or `Core::node(_output)` is not the `HTTP_In_Node` self after `ensure_request_graph()` — typically a bootstrap-misconfiguration condition. Operational application errors don't reach this path; they come back as `TM_COMMAND|TM_ERROR` replies (`TYPE = 40`) through the normal sync path with the verb's exception message in `VALUE`.

### Service CIs

The substrate plugin mounts 9 service CIs via `newspack_nodes/request_graph_ready`. Each is a `Service_CI_Node` declaring its own `node_schema()`:

| CI shell-name | Class | Verbs |
|---------------|-------|-------|
| `classes` | `Classes_CI_Node` | `list` |
| `layouts` | `Layouts_CI_Node` | `get`, `save` |
| `topologies` | `Topologies_CI_Node` | `list`, `get`, `save`, `delete`, `activate`, `deactivate`, `expand`, `connect_worker_input` |
| `raw-logs` | `Raw_Logs_CI_Node` | `list_logs`, `log_status` |
| `workers` | `Workers_CI_Node` | `list`, `dump_graph`, `cleanup_status`, `restart`, `heartbeat` |
| `vault` | `Vault_CI_Node` | `list`, `get`, `add`, `update`, `delete`, `test` |
| `aggregator` | `Aggregator_CI_Node` | `status`, `summary`, `servers_status`, `health`, `servers` |
| `settings` | `Settings_CI_Node` | `get`, `set` |
| `status` | `Status_CI_Node` | `get` |

Every CI also answers a default `help` (sorted list of its own verbs) — injected by `Command_Interpreter_Node::commands()` when a subclass installs a custom verb table without its own `help`.

**`workers.dump_graph` vs `Command_Interpreter_Node.dump_metadata` — different verbs, different shapes.** The `workers` CI's `dump_graph` returns the dashboard payload (`{ workers[], consumers[], supervisor, logs, log_partitions, num_partitions, num_segments, segment_size, timestamp, heartbeat_interval_s, graph }` — `workers[]` is one liveness row per `(worker_type, partition)`; per-consumer offsetlog rows live in the separate `consumers[]`; `graph` is a map of active-topology-name → `{ nodes, edges }` parsed from each topology's `.tsl`). Every `Command_Interpreter_Node` separately exposes a `dump_metadata` verb for the per-node canvas snapshot the topology console renders (`{ class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written, accepts_fill, has_target, has_config }`, keyed by node name, patron-linked `:config` CIs filtered out; `accepts_fill`/`has_target` come from the node's `node_schema()` and tell the canvas which ports to draw). They are distinct verbs: address `dump_graph` to `workers` for the dashboard shape; address `dump_metadata` with empty TO (root CI) for the per-node canvas shape.

Beyond the service CIs, the root (empty-TO) base `Command_Interpreter_Node` answers its own built-in verbs — `make_node` (alias `make`), `connect_node` (alias `connect`), `ls`, `dump_metadata`, `stats`, `trace`, `pwd`, `help`, `log`, `dmesg`, and the rest of the graph-introspection set. `help <NodeType>` resolves the same registered class table as `make_node` and renders its `node_schema()`/`nodeSchema()` in the same format in PHP and browser-local JS. Addressing a command with empty TO dispatches against this root verb table; a non-empty TO routes to the named CI.

Application plugins layer additional CIs onto the same endpoint (the first being `newspack-event-logger-nodes` with its application-side CIs). The `to` field on the dispatch envelope distinguishes targets — there is no substrate-vs-application namespacing at the endpoint layer.

**`node_schema()` shape.** Each CI's `node_schema()` returns a `Service`-category schema: `{ category, description, arguments, commands }`, where `commands` is a list of `{ name, description, args }` and each arg is `{ name, type, required }` plus an optional `default` (e.g. `workers restart`'s `partition` and `workers heartbeat`'s `ttl` args carry one). This is what `Classes_CI`'s `list` verb inlines for the topology-editor palette, and what the live-mode Inspector reads to build verb-invocation forms.

**Every verb reads from the `arguments` token array.** Verbs that take a single scalar — `topologies get`/`delete`/`connect_worker_input` (a name or reader id), `layouts get` (a name), `raw-logs log_status` (a log key), `workers heartbeat` (an SSE slot) — read `$args[0]` straight from the inner envelope's `arguments` list, so they're typeable in the REPL (e.g. `command_node topologies get Home`). Structured verbs read from the same list: `topologies save` / `layouts save` take `[ name, body ]` via `Service_CI_Node::split_first_token` (`$args[0]` is the name, `$args[1]` carries the whole TSL body or positions JSON — newlines included — as one discrete token, no rest-of-line splitting to guess at); option-flag verbs like `workers restart` classify `<type>… [--partition=<n>]` via `Command_Args::parse( list<string> $args )`, which sorts `--key=value` / bare `--key` flags out of the positional tokens. There is no `payload` input slot.

Verb handlers receive three positional arguments — `( Command_Interpreter_Node $interpreter, array $args, array $envelope = [] )`, where `$args` is the pre-split token array (`list<string>` argv; each handler normalizes via `arg_strings()`). The `$envelope` is the full 7-field positional Message; the `save` verbs use it to enforce the 1 MiB body cap via `Message::packed_size( $envelope )`.

**`KEY='completion'` mode.** A `help` or `ls` command carrying `KEY='completion'` returns a bare newline-separated candidate list (sorted verb names / bare node names) instead of the tabulated output — the substrate's `TM_COMPLETION` analogue, used by REPL tab-completion. See [architecture-guide.md → Completion-query mode](architecture-guide.md#repl-wp-nodes-cli).

Per-verb args, return shapes, and error semantics are declared on each CI's `node_schema()` (`commands[]`) in `includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status}-ci-node.php`; the topology-editor palette and live-mode Inspector consume the same schema. Auth gating is uniform: the `/command` endpoint requires `manage_options` (see "Permission callback" above), and per-verb application-side caps are an application concern.

### Test mode

`HTTP_In_Node::set_test_mode(true)` makes `dispatch()` return instead of `exit()`, so PHPUnit can capture stdout via `ob_start()`.

## SSE Stream

```
GET   /wp-json/newspack-nodes/v1/messages/stream
```

Server-sent-events drain endpoint backed by `SSE_Out_Node` (which is both the `_sse` egress Node and the REST controller, mirroring `HTTP_In_Node`'s double-duty pattern). One endpoint covers every subscription dashboards need — log partitions and worker IPC partitions both surface as `Consumer_Node` instances drained in the same loop. Each Message that lands at the `_sse` egress is emitted as an SSE `msg` event carrying the packed Message; idle keepalives fire every `HEARTBEAT_MS = 2000`ms.

**Permission**: `current_user_can( 'manage_options' )`. No nonce check — that would break cross-server SSE pulls.

### Query parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subscribe` | string | yes | CSV of subscription names. Two shapes per name: `{type}.p{N}` (worker IPC reader, resolved via `CLI::attach_to_worker`) or a bare `[a-z0-9_-]+` log-feed identifier (one Consumer per partition under `{base}/logs/{name}.log`). The `{type}.p{N}` form has two cascading fallbacks if there's no live lock dir: (a) tail the IPC `output/` dir if it still exists on disk (down-but-restarting worker — recovers when it respawns); (b) fall through to `logs/{type}.log/p{N}` (the aggregator-hub case: a name like `firehose.p0` with no worker but a log dir). Anything else throws `InvalidArgumentException` (path-traversal guard). Blank entries between commas are dropped. |
| `positions` | string | no | Optional resume positions. JSON object keyed by subscription name (one entry per name in `subscribe`); each value is itself a per-partition map (partition index → cursor), where a cursor is a `{segment, offset}` object or one of the `start`/`recent`/`end` string forms `Consumer::next_offset` accepts. (A single-partition subscription still nests under its partition index.) Decoded by `SSE_Out_Node::parse_positions()`; malformed JSON / non-object → treated as omitted (tail-seek all). Omit to start at `end` (live tail). |

### Response

Standard SSE stream (`Content-Type: text/event-stream`). The application controls slot gating via three optional Closure seams on `SSE_Out_Node` (`$acquire_slot`, `$release_slot`, `$check_slot`); unwired the endpoint allows a single shared slot. When the application's `$acquire_slot` returns `false`, the controller responds `429 Too Many Requests` before sending any SSE headers.

## Extensibility hooks

### `newspack_nodes/request_graph_ready`

Fires from `HTTP_In_Node::dispatch()` after the request-scope graph has been built (or confirmed already-built). The substrate has `_router`, `_command_interpreter` (the base CI), and `_output` (the `HTTP_In_Node` egress) registered in `Core`'s node map at this point.

**Signature:**

```php
do_action( 'newspack_nodes/request_graph_ready', \Newspack_Nodes\Command_Interpreter_Node $base_interpreter );
```

**Canonical usage** — applications mount their service CIs through the base CI's `make_node()`:

```php
function my_app_mount_service_cis( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
    $base_interpreter->make_node( 'My_Service_CI', 'my-service', $dep1, $dep2 );
    // ... more service CIs ...
}
\add_action( 'newspack_nodes/request_graph_ready', 'my_app_mount_service_cis' );
```

`make_node( $type, $name, ...$ctor_args )` does four things atomically:

1. Resolves and instantiates (via no-arg `new $fqcn()`) the first `{$prefix}{$type}_Node` that exists and is a concrete `Node` subclass, looping the prefixes registered via `Command_Interpreter_Node::register_namespace()` at plugin load time. (So `make_node( 'My_Service_CI', ... )` resolves `My_App\My_Service_CI_Node` once `My_App\` is registered. There is no per-class `register_class` registry — applications register their *namespace prefix* once.)
2. Calls `$node->name( $name )` so Router can find it.
3. Calls `$node->arguments( $arg_tokens )` — the scalar positional args, `array_map`ped to strings and re-indexed, as a flat token array (`arguments()` takes and returns `list<string>`, not a space-joined string). They're mapped onto the node's declared `node_schema()['arguments']` properties (so config round-trips through `dump_config()`, which re-joins the tokens via `Node::serialize_args()`). Non-scalar ctor args are filtered out (assign object dependencies as public properties after `make_node` returns instead).
4. Calls `$node->sink( $this )` so the node's reply routes back through the base CI → `_router` → `_output`.

Skipping `make_node()` — by constructing and `name()`-ing the node by hand — leaves it unwired. Verb responses (which walk back via `TO=FROM`) have no path to the `HTTP_In_Node` egress (`_output`) and silently drop on the floor. Always go through `make_node()`.

The hook fires on every `/command` request after lazy-build; it's idempotent on the CI side because `make_node()` overwrites prior registrations under the same name. Applications can re-mount the same CI on every request without leaking state across requests as long as their CIs aren't holding stateful per-request data (the typical pattern: CIs are pure verb dispatchers, dependencies injected via constructor).

For the application-side build-out, see the per-CI `node_schema()` declarations under `newspack-event-logger-nodes/includes/app/` (the `*_CI_Node` classes mounted via `newspack_nodes/request_graph_ready`).
