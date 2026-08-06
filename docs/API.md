# Newspack Nodes REST API

The runtime ships a small REST surface for worker lifecycle, session auth,
command dispatch, streams, and an internal web-runtime cache-health probe.
Application plugins register their own endpoints (dashboards, additional
streams, etc.) on top, plus mount service `Command_Interpreter_Node`s into
the dispatch endpoint's graph via the `newspack_nodes/request_graph_ready`
hook.

For the full architecture and rationale, see [architecture-guide.md](architecture-guide.md).

## Worker Spawn

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
```

HMAC-validated zombie-process spawn. Used internally by every worker's `_fleet` peer scan, the WP-Cron cold-start pass, and the worker's own `self_respawn()` chain. **Not for public callers** — the HMAC token rotates every 10s and is per-site (`NONCE_SALT`-keyed); externally calling this endpoint without a valid token returns `403 Forbidden`.

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

The endpoint acknowledges synchronously, then detaches from FPM via `fastcgi_finish_request()` (or proceeds inline if not in FPM context, e.g. CLI tests). After detach:

1. `ignore_user_abort(true) + set_time_limit(0)` so the process survives the client disconnect.
2. `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` and `$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']` are populated for sub-actions / logging.
3. The `newspack_nodes/spawn_worker` action fires with `( string $type, int $partition )`. Every accepted `type` is a topology; there is no other process shape.

Topology owners hook the `newspack_nodes/spawn_worker` action to instantiate the right worker class for the given `$type` and call `->execute()`. The runtime ships two builtin topologies — `job-worker` (the generic `Job_Worker_Node`, spawned per-partition) and `settings-sync` (a single-instance settings-sync control plane, `num_partitions = 1`) — both registered from `topologies/` via `Topology_Registry::register_builtin_dir` and spawned through the same `Topology_Registry::spawn_worker` handler on `newspack_nodes/spawn_worker`. Application plugins (e.g., `newspack-event-logger-nodes`) register the rest. **Every active topology, builtin or app, spawns through this one hook** — there is no separate "control-plane" spawn path.

`Job_Worker_Node` is generic async-job dispatch: applications register local/remote handlers via the `newspack_nodes/{job,remote_job}_handlers` filters. Each handler is called as `( array $parameters, string $id )` (`$id` is the entry's top-level `id`, `''` when absent), and the worker fires `newspack_nodes/job_worker/before_job` ( `$handler, $id` ) and `…/after_job` ( `$handler, $outcome, $id` ) around each job so apps can establish/tear down per-job request context. Shorter callables/listeners ignore the extra args (BC-safe).

#### 403 Forbidden

```json
{
  "code": "invalid_token",
  "message": "Invalid spawn token",
  "data": { "status": 403 }
}
```

Returned when the `nonce` does not validate against either the current or previous 10s HMAC window. This is the normal response for unauthenticated callers — the token is re-minted every window.

## Authentication

This section covers the spawn endpoint only; `/command`'s per-command signing
model is [Command Signing](#command-signing) below.

The spawn endpoint uses dual-mode auth (`Spawn_Controller::check_permission`):

1. **HMAC nonce** — `Spawn_Coordinator::validate_spawn_token()` against the current or previous 10s window. Used by the peer scan, the cron cold-start pass, and the worker's self-respawn POSTs. No user capability check.
2. **WordPress admin** — `current_user_can( 'manage_options' )` AND `wp_verify_nonce( $nonce, 'newspack_nodes_spawn_worker' )` AND a 2s per-user rate limit (transient-backed). For dashboard-initiated spawns. Order matters: capability is checked before rate-limit so unauthenticated requests can't poison the rate-limit transient table.

Both paths require the `nonce` field; only the validator differs. There is no env-var bypass — `NEWSPACK_NODES_WORKER_TYPE` / `_PARTITION` are written to `$_SERVER` *after* auth passes (see [Worker Identity Tags](#worker-identity-tags)) and are not consulted during permission checks.

Application plugins that add their own REST endpoints typically use `current_user_can( 'manage_options' )` for human-facing endpoints and a separate HMAC scheme (or capability + nonce combo) for machine-facing endpoints. See `newspack-event-logger-nodes/docs/API.md` for the application-side auth patterns.

## Internal Cache Health

```
POST  /newspack-nodes/v1/health/cache
```

Narrow internal loopback endpoint used by `wp nodes doctor` to test the cache
backend selected by the web runtime. It is not a general cache API and is not
for public callers. Under WordPress's default REST prefix, its full URL path is
`/wp-json/newspack-nodes/v1/health/cache`.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | yes | A lowercase 64-character HMAC-SHA256 token for the `health-cache` purpose. |

The body is form-encoded and contains only `token`. The token is
`hash_hmac( 'sha256', "newspack_nodes_health-cache:{$window}", wp_salt( 'nonce' ) )`,
where `$window = floor( time() / 10 )`. The endpoint accepts the current and
immediately previous 10-second windows for race tolerance. Purpose separation
means a spawn token cannot authorize this route, and a health-cache token
cannot authorize worker spawn.

WordPress REST enforces the required `token` argument. Omitting it returns HTTP
`400` with code `rest_missing_callback_param`; this happens before the
permission callback or `Bootstrap::fleet_gate()`, so controller token validation
does not run either.

When a token is supplied, `Bootstrap::fleet_gate()` applies before controller
token validation: on multisite, only the main fleet site may use the route. A
subsite receives `403 Forbidden`. On the fleet site, a supplied malformed,
expired, future-window, or wrong-purpose token receives `403 Forbidden` with
code `invalid_health_token`.

The route accepts no caller-selected cache key or value. Extra `key` or `value`
input is never used by the probe and is never returned; the server generates
and removes its own random probe entry.

### Response

After permission succeeds, the route always returns HTTP `200` with exactly one
canonical cache result:

```json
{
  "id": "cache-backend",
  "label": "Cache backend",
  "status": "good",
  "messages": [
    "Cache backend APCu add/read/delete round trip succeeded."
  ]
}
```

The four fields are fixed: `id`, `label`, `status`, and `messages`. This local
probe returns `good` or `critical`, and `messages` contains one non-empty
diagnostic string. (`wp nodes doctor` may synthesize `recommended` when the
loopback result cannot be verified.) A proven missing or failed backend is a
canonical `critical` result in the same HTTP `200` response; health severity is
payload state, not an HTTP transport failure.

## Worker Identity Tags

After auth passes and `fastcgi_finish_request()` detaches the handler, the spawn controller sets two `$_SERVER` keys:

```php
$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;        // e.g. "firehose-workers"
$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;  // e.g. "3"
```

These are process-identity tags, not credentials. Downstream code uses them to:

- **Exclude worker self-traffic from stats.** Log readers see request entries from worker processes and skip them so fleet churn doesn't pollute global request counters.
- **Tag log lines for correlation.** Audit / error log writers can include `[firehose-workers/p3]` so tail-grep tooling knows where an entry came from.
- **Provide context to sub-actions.** The `newspack_nodes/spawn_worker` action handler and any nested `do_action`s inside the worker can introspect the env to know which worker they're inside without re-passing arguments.

`Bootstrap::reconcile_fleet()` writes the same keys (`'supervisor'` / `'0'`) so the WP-Cron reconciliation pass is tagged consistently with topology workers. The value stays `supervisor` although no supervisor process remains: it is the label newspack-event-logger-nodes files this pass's per-URL stats row under, and renaming it only splits that row's history.

## Rate Limiting

The spawn endpoint applies a 2-second per-user rate limit (`Spawn_Controller::RATE_LIMIT_S`) on the WordPress-admin auth path — transient-backed, returning `429` on overflow. The HMAC path is not rate-limited at the REST layer; spawn rate-limiting for internal traffic happens at the endpoint, the one gate every spawner crosses:

- `MIN_SPAWN_INTERVAL_S = 15` per `{type}|{partition}` key (`Spawn_Coordinator::MIN_SPAWN_INTERVAL_S`).
- Tracked in `Spawn_Coordinator::$last_spawn_time`; updated after every spawn attempt (success or failure).

The `/command` endpoint applies its own per-user burst limit (`HTTP_In_Node::check_permission`): `RATE_LIMIT_BURST = 30` POSTs per `RATE_LIMIT_WINDOW_S = 1` second per user, bucketed by clock-second (transient-backed), returning `429 Too Many Requests` on overflow. The burst budget is tunable via the `newspack_nodes/command_rate_limit` filter (clamped to a minimum of 1).

Application plugins that add public-facing endpoints should layer their own rate limits on top.

## Command Signing

Passing `/command`'s permission callback authenticates the *request*; it signs nothing. Every command inside the batch must carry its own HMAC, stamped by the node that minted it, or the runtime refuses it. Ingress does not sign on a caller's behalf — that oracle (arrival implies authority) was removed; only the minter's own signature counts.

### Establishing a session

```
POST  /wp-json/newspack-nodes/v1/auth
```

Issues a session: a random key under a random handle (`Command_Auth::mint_session()`). Gated by `Bootstrap::fleet_gate()` then `current_user_can('manage_options')` — no separate rate limit. The caller supplies nothing; both handle and key are generated server-side, since caller entropy is unverifiable and a caller-chosen handle could collide with or fixate a live session.

#### Response

```json
{
  "handle": "5f2b...(32 hex chars)",
  "key": "9ac4...(64 hex chars)",
  "expires_in": 3600,
  "now": 1735689600
}
```

The key is disclosed only in this response. `expires_in` is the session's fixed lifetime (`Command_Auth::SESSION_TTL_S`, 3600s) — never slid on use, so a leaked handle expires on schedule no matter how busy it is. `now` is the server clock; the client aligns its signed TIMESTAMP to it rather than trusting its own.

### Signing a command

The minting node signs before the command leaves the process — the browser's Shell, a dashboard hook, or a PHP caller of `Command_Auth::sign()` / `sign_for()`. The signature covers the command's semantics, never its routing: `JSON.stringify([ TIMESTAMP, name, arguments, nonce ])`, HMAC-SHA256 under the session key. TO and FROM are excluded because Router peels and nodes stamp them in transit. The result rides under `VALUE.auth`:

```json
{ "auth": { "nonce": "b91e...(32 hex chars)", "sig": "7cd0...(64-char hex HMAC)", "handle": "5f2b...(session handle)" } }
```

Omitting `handle` signs under the per-site secret instead of a session — a same-process path, not one a browser client uses. A command whose VALUE can't be JSON-encoded is left unsigned on purpose, so the verifier refuses it rather than fall back to signing an empty string.

### Verification

The `/command` request process installs `Command_Auth::verifier()` as every interpreter's authorize policy. A command passes only when:

1. its TIMESTAMP sits within `MAX_PAST_S` (20s) behind or `MAX_FUTURE_S` (10s) ahead of the verifier's clock;
2. `auth.sig` matches the HMAC recomputed over the same canonical string, under the resolved key (a session key by `handle`, or the per-site secret with no `handle`); and
3. `auth.nonce` claims successfully as single-use (`NONCE_TTL_S` = 60s) — a replayed nonce fails even under a valid signature.

A command already marked `LOCAL` — minted in this process and never crossed the wire — skips verification: `LOCAL` cannot survive `Message::packed()` / `unpacked()`, so only the process's own commands ever carry it.

A refused command never disappears silently: it replies `TM_COMMAND|TM_ERROR` with a `verification failed: …` reason through the normal TO=FROM path, and the containing `/command` batch answers **401** instead of 202 or 200 (see [Command Dispatch](#command-dispatch) below).

## Command Dispatch

```
POST  /wp-json/newspack-nodes/v1/command
```

Unified non-streaming dispatch endpoint. The browser POSTs a TM_COMMAND envelope; the controller routes it through the request-scope `_router` to the named CI; the CI's reply walks back via `TO=FROM` through `_output` (an `HTTP_In_Node` — a double-duty class that is BOTH the `/command` REST controller and the egress Node registered as `_output`, i.e. `Node_Names::OUTPUT`) which writes the packed Message directly to the HTTP response body. (The JS runtime uses `_http` as its egress/Shell.path name, and the SSE process's `HTTP_Filter` egress is also named `_output` — but the PHP `/command` egress is `_output`.)

Permission callback (`HTTP_In_Node::check_permission`): the fleet gate, then `current_user_can('manage_options')`, then the per-user rate limit below. This authenticates the request; it does not sign any command inside it — see [Command Signing](#command-signing) above. Application CIs may layer additional per-verb capability checks on top — that's an application concern, not the substrate's.

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
| `VALUE` (index 6) | array | The inner Command_Interpreter envelope `{name, arguments}` as a live JSON array. `name` is the verb; `arguments` is a **flat token array** (`list<string>` argv) — the Shell/`CommandClient` tokenizes ONCE at the producer boundary and the tokens ride verbatim through the envelope, interpreter, and `make_node`. Every verb (scalar and structured alike) reads its data from that token array (`$args[0]`, `$args[1]`, …). (The request-side `payload` slot was removed in 0.6.0.) VALUE also carries `auth` — the HMAC envelope every minter must stamp; see [Command Signing](#command-signing). |

The browser's `CommandClient` and the attached `wp nodes cli` both produce this exact wire shape via `Message::packed()`.

### Response

#### Synchronous (in-process reply)

The CI's `interpret()` produced a reply; `HTTP_In_Node::fill()` (the egress side) wrote the packed Message to the body and set `sent_headers=true`. The controller `exit()`s to bypass WP's REST wrapping.

#### 202 Accepted (async / IPC)

```json
{ "queued": true, "id": "<request id>" }
```

Returned when `Router_Node::fill()` returned without the `HTTP_In_Node` egress seeing a reply — typically because the message was routed to a per-worker `Partition` Node and is being delivered via disk IPC. Real replies arrive through the SSE stream the browser already has open.

#### 401 Unauthorized

Sent when any command in the batch failed `Command_Auth` verification — a batch shares one signing handle and one clock, so a single refusal condemns the whole POST. Each refused command still replies `TM_COMMAND|TM_ERROR` with a `verification failed: …` reason through the normal per-command TO=FROM path; the 401 status is the fast signal a client checks before it parses the body. See [Command Signing](#command-signing).

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
| `raw-logs` | `Raw_Logs_CI_Node` | `list_logs`, `log_status`, `read_message` |
| `workers` | `Workers_CI_Node` | `list`, `dump_graph`, `cleanup_status`, `restart`, `heartbeat` |
| `vault` | `Vault_CI_Node` | `list`, `get`, `add`, `update`, `delete`, `test` |
| `aggregator` | `Aggregator_CI_Node` | `summary`, `servers_status`, `probe` (on-demand per-spoke deep roll-up) |
| `settings` | `Settings_CI_Node` | `get`, `set` |
| `status` | `Status_CI_Node` | `get` |

Every CI also answers a default `help` (sorted list of its own verbs) — injected by `Command_Interpreter_Node::commands()` when a subclass installs a custom verb table without its own `help`.

**`workers.dump_graph` vs `Command_Interpreter_Node.dump_metadata` — different verbs, different shapes.** The `workers` CI's `dump_graph` returns the dashboard payload (`{ workers[], consumers[], supervisor, logs, log_partitions, deadletter_segments, num_partitions, num_segments, segment_size, timestamp, heartbeat_interval_s, graph }` — `workers[]` is one liveness row per `(worker_type, partition)`; per-consumer offsetlog rows live in the separate `consumers[]`; `graph` is a map of active-topology-name → `{ nodes, edges }` parsed from each topology's `.tsl`). Every `Command_Interpreter_Node` separately exposes a `dump_metadata` verb for the per-node canvas snapshot the topology console renders (`{ class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written, accepts_fill, has_target, has_config }`, keyed by node name, patron-linked `:config` CIs filtered out; `accepts_fill`/`has_target` come from the node's `node_schema()` and tell the canvas which ports to draw). They are distinct verbs: address `dump_graph` to `workers` for the dashboard shape; address `dump_metadata` with empty TO (root CI) for the per-node canvas shape.

Beyond the service CIs, the root (empty-TO) base `Command_Interpreter_Node` answers its own built-in verbs — `make_node` (alias `make`), `connect_node` (alias `connect`), `ls`, `dump_metadata`, `stats`, `trace`, `pwd`, `help`, `log`, `dmesg`, and the rest of the graph-introspection set. `help <NodeType>` resolves the same registered class table as `make_node` and renders its `node_schema()`/`nodeSchema()` in the same format in PHP and browser-local JS. Addressing a command with empty TO dispatches against this root verb table; a non-empty TO routes to the named CI.

Application plugins layer additional CIs onto the same endpoint (the first being `newspack-event-logger-nodes` with its application-side CIs). The `to` field on the dispatch envelope distinguishes targets — there is no substrate-vs-application namespacing at the endpoint layer.

**`node_schema()` shape.** Each CI's `node_schema()` returns a `Service`-category schema: `{ category, description, arguments, commands }`, where `commands` is a list of `{ name, description, args }` and each arg is `{ name, type, required }` plus an optional `default` (for example, `workers restart`'s optional `partition`). This is what `Classes_CI`'s `list` verb inlines for the topology-editor palette, and what the live-mode Inspector reads to build verb-invocation forms.

**Every verb reads from the `arguments` token array.** Verbs that take a single scalar — `topologies get`/`delete`/`connect_worker_input` (a name or reader id), `layouts get` (a name), and `raw-logs log_status` (a log key) — read `$args[0]` straight from the inner envelope's `arguments` list, so they're typeable in the REPL (e.g. `command_node topologies get Home`). `raw-logs read_message` reads two positional tokens the same way (`$args[0]` the log key, `$args[1]` the position). The ownership-fenced `workers heartbeat` verb instead requires exactly `[ slot, owner ]`: both are canonical decimal tokens from the current SSE `connected` handshake, and the server—not the client—owns the lease TTL. Structured verbs read from the same list: `topologies save` / `layouts save` take `[ name, body ]` via `Service_CI_Node::split_first_token` (`$args[0]` is the name, `$args[1]` carries the whole TSL body or positions JSON — newlines included — as one discrete token, no rest-of-line splitting to guess at); option-flag verbs like `workers restart` classify `<type>… [--partition=<n>]` via `Command_Args::parse( list<string> $args )`, which sorts `--key=value` / bare `--key` flags out of the positional tokens. There is no `payload` input slot.

Verb handlers receive three positional arguments — `( Command_Interpreter_Node $interpreter, array $args, array $envelope = [] )`, where `$args` is the pre-split token array (`list<string>` argv; each handler normalizes via `arg_strings()`). The `$envelope` is the full 7-field positional Message; the `save` verbs use it to enforce the 1 MiB body cap via `Message::packed_size( $envelope )`.

**`KEY='completion'` mode.** A `help` or `ls` command carrying `KEY='completion'` returns a bare newline-separated candidate list (sorted verb names / bare node names) instead of the tabulated output — the substrate's `TM_COMPLETION` analogue, used by REPL tab-completion. See [architecture-guide.md → Completion-query mode](architecture-guide.md#repl-wp-nodes-cli).

Per-verb args, return shapes, and error semantics are declared on each CI's `node_schema()` (`commands[]`) in `includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status}-ci-node.php`; the topology-editor palette and live-mode Inspector consume the same schema. Auth gating is uniform: the `/command` endpoint requires `manage_options` (see "Permission callback" above) AND a valid command signature (see [Command Signing](#command-signing)), and per-verb application-side caps are an application concern.

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

Standard SSE stream (`Content-Type: text/event-stream`). The application
controls slot gating via four optional Closure seams on `SSE_Out_Node`:
`$acquire_slot( $partition )` returns a complete
`{slot: int, owner: positive-int}` lease or `false`;
`$check_slot( $lease, $partition )` verifies that exact lease;
`$release_slot( $lease, $partition )` releases only that owner; and
`$inspect_slot( $lease, $partition )` returns failure-only diagnostic fields.
Unwired, the endpoint uses an explicit unmetered sentinel lease and the other
seams are no-ops. When `$acquire_slot` returns `false`, the controller responds
`429 Too Many Requests` before sending any SSE headers.

The first application frame is `event: connected`. Its packed TM_INFO Message
has `KEY=connected` and a flat VALUE of
`PID <pid> SLOT <slot> OWNER <owner> SUBSCRIPTIONS <csv> INTERVAL <ms>`.
OWNER is an opaque positive decimal token: clients retain it exactly as text
instead of converting it through a precision-limited numeric type. The matching
`workers heartbeat` command sends exactly `[ slot, owner ]`; the server owns the
lease TTL.

When a drain check proves that exact lease is gone, the endpoint first emits
`event: disconnect` and flushes it, then closes the stream. The packed TM_INFO
Message has a non-empty machine KEY (`slot_lease_lost`) and a safe display VALUE
(`SSE slot lease lost`). Clients consume this control frame and retain its
reason so the later transport close cannot replace it with a generic message.

## Log Stream

```
GET   /wp-json/newspack-nodes/v1/log/stream
```

Server-sent-events log-tail endpoint backed by `Log_Stream_Out_Node`, an `SSE_Out_Node` subclass. On the wire it mirrors `/messages/stream` exactly — same packed `msg` events, `connected` envelope, heartbeat cadence, flush framing, and slot pool — so any `/messages/stream` client works unchanged. The one difference is what a subscription resolves to: a fixed **`Log_Sources` registry NAME** opened as a `Tail_Node` reader instead of a Consumer. A caller can never supply a path — the subscribe param carries registry names only, so there is no traversal surface.

The registry merges three families, in priority order (first name wins, then realpath-dedupe keeps the first):

1. **Built-ins** — php `error_log` (only when it's a real file) and `WP_CONTENT_DIR/debug.log`, tailed in Tail file mode (`tail -F` logrotate semantics).
2. **Config** — `log_sources` entries (`name=/absolute/path`, one per line in the substrate settings page), Tail file mode.
3. **Active topologies** — every `Log` node in an active topology's graph, its path template resolved per partition via `Core::resolve_partition_template`, tailed in Tail segmented mode (`{file}.{seg}`). Named by lowercased writes-basename, plus a `.p{N}` suffix when the template is per-partition. A broken topology degrades to being skipped, never a 500.

The same registry backs the REPL's `taillog` verb; its reserved `taillog sources` name returns the merged catalog as `{ name, path, mode, available, bytes, segments }` rows for GUI pickers (`bytes` is the size a tail would read, null when unreadable; `segments` is the sorted `{ id, size }` segment list, `[]` in file mode).

**Permission**: `current_user_can( 'manage_options' )`. No nonce check — same posture as `/messages/stream`.

### Query parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subscribe` | string | yes | CSV of registry NAMES (from the `Log_Sources` registry above). An unknown name throws the teaching `unknown log source` error listing the known names. No globs — registry sources are fixed for the life of a stream; Tail's missing-file grace covers a source that appears, rotates, or truncates mid-stream. |
| `positions` | string | no | Optional resume positions. JSON object keyed by registry name; each value is a `{segment, offset}` object or one of the `start`/`recent`/`end` string forms. Round-trips unchanged from the client's perspective: for a segmented source `segment` is the segment id; for a file-mode source the file's inode occupies the same slot (the cursor self-validates against the live file and degrades to 0 on mismatch). Omit to start at `end` (live tail). |

### Response

Identical to `/messages/stream`: each line the Tail emits arrives as an SSE `msg` event carrying the packed 7-field Message (`TM_BYTESTREAM`, FROM stamped with the registry name), with the same `connected` envelope, heartbeat, 429 slot-gating, and flush behavior.

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
