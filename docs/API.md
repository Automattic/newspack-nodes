# Newspack Nodes REST API

The runtime ships a small REST surface for worker lifecycle, session auth,
command dispatch, two SSE streams, and an internal cache-health probe.
Application plugins register their own endpoints (dashboards, additional
streams) on top, and mount service [`Command_Interpreter_Node`](../includes/class-command-interpreter-node.php)s into the
dispatch endpoint's graph through the
[`newspack_nodes/request_graph_ready`](#newspack_nodesrequest_graph_ready)
hook.

Everything lives under one namespace, `newspack-nodes/v1`, registered by
[`Bootstrap::register_rest_routes()`](../includes/class-bootstrap.php) on [`rest_api_init`](https://developer.wordpress.org/reference/hooks/rest_api_init/). The order is
load-bearing: `/health/cache` registers first so REST init completes even when
the runtime base directory is refused, and the other five register only once
that base is available and `ensure_runtime_wired()` has run.

| Route | Method | Permission |
|---|---|---|
| [`/workers/spawn`](#worker-spawn) | POST | Internal HMAC token, or MANAGE + WP nonce + rate limit |
| [`/auth`](#establishing-a-session) | POST | READ |
| [`/command`](#command-dispatch) | POST | READ + per-user burst limit, then a per-command signature |
| [`/messages/stream`](#sse-stream) | GET | READ |
| [`/log/stream`](#log-stream) | GET | READ |
| [`/health/cache`](#internal-cache-health) | POST | Internal HMAC token |

![A grid of the six routes against the four gates a request crosses in order: WordPress's declared-argument check, the fleet gate that answers 403 newspack_nodes_not_fleet_site on a multisite subsite, each route's own permission callback with its refusal codes, and what the handler then refuses or does; beneath it, why /health/cache registers first and the two admin-post.php entry points outside the namespace.](img/api-route-gates.png)

The substrate is also its own client. [`HTTP_Out_Node`](../includes/class-http-out-node.php) POSTs batched JSONL
command envelopes to a remote spoke's `/command` (`COMMAND_PATH`) and
establishes the session that signs them at that spoke's `/auth` (`AUTH_PATH`);
[`SSE_In_Node`](../includes/class-sse-in-node.php) pulls `/messages/stream` over cURL. Both speak the shapes
documented below, under bounds of their own — see
[The substrate as client](#the-substrate-as-client).

For the full architecture and rationale, see [architecture-guide.md](architecture-guide.md).

## Worker Spawn

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
```

HMAC-validated worker spawn, used by every worker's `_fleet` peer scan, the
WP-Cron cold-start pass, and the worker's own `self_respawn()` chain. **Not for
public callers** — the token rotates every 10s and is per-site, so an external
call presenting no valid one returns `403 Forbidden`.

![A five-lane sequence of one spawn POST across the spawner, WordPress, check_permission, spawn() and the worker: the argument check, the fleet gate, the two validators of the one nonce field, the three ordered refusals, the four accepted steps, the worker running inline for 595 seconds and the 200 written when it ends; below, the internal token formula for both purposes and the Perl mirror that copies it by hand.](img/api-spawn-handshake.png)

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Worker type, which is also the topology name (see `wp nodes types`). The route's `validate_callback` refuses a type no ACTIVE topology declares, so an unknown one never reaches the handler. |
| `partition` | int | yes | Partition index, 0-based. Must be below both the type's active partition count and `Spawn_Coordinator::MAX_PARTITIONS` (16). |
| `nonce` | string | yes | Either the internal HMAC token or a WordPress nonce for the `newspack_nodes_spawn_worker` action — one field, two validators. |

The internal token is
[`Internal_Request_Token::generate( 'spawn', $now, Spawn_Coordinator::spawn_key() )`](../includes/class-internal-request-token.php);
the diagram carries the construction. The Perl side of that contract lives in
`services/gyrobase/sources/newspack-gyrobase/Gyrobase/Log.pm`, and the two
halves of `for_window()` are held together only by `t/spawn-token.t` in that
separate repository.

### Response

#### 200 OK

```json
{
  "spawned": true,
  "type": "job-worker",
  "partition": 0
}
```

Topology owners hook `newspack_nodes/spawn_worker` to build the right worker for `$type` and call
`->execute()`. The substrate registers [`Topology_Registry::spawn_worker`](../includes/class-topology-registry.php) on it
at load, which spawns any worker in the active set, and the runtime ships four
topologies under [`topologies/`](../topologies/) — [`job-worker`](../topologies/job-worker.tsl) (the generic `Job_Worker_Node`
pool, per-partition), [`job-intake`](../topologies/job-intake.tsl) (drains the large-write job ingress on
substrate-only installs), [`settings-sync`](../topologies/settings-sync.tsl) (a single-instance hub control plane,
`num_partitions = 1`) and [`topic-probe`](../topologies/topic-probe.tsl) (the per-worker stats sweep, `include`d
by the others). Application plugins register the rest. **Every active topology,
builtin or application, spawns through this one hook** — there is no separate
control-plane spawn path.

[`Job_Worker_Node`](../includes/class-job-worker-node.php) is generic async-job dispatch: applications register
local and remote handlers through the `newspack_nodes/job_handlers` and
`newspack_nodes/remote_job_handlers` filters, and the entry's `k` field picks
the map. Each handler is called as `( string $id, array $parameters )` — `$id`
is the entry's top-level `id`, `''` when absent. The worker runs the
`newspack_nodes/job_worker/before_job` FILTER
( `$run, $handler, $id, $message` ) and fires the `…/after_job` action
( `$handler, $id, $outcome` ) around each job, so applications can establish and
tear down per-job request context. A before_job listener returning `false`
DECLINES the job — the handler never runs — which is how a plugin refuses work
addressed to another host; only an explicit `false` declines, so an
action-style `null` return carries on. Shorter callables ignore the extra
arguments.

#### 400 Bad Request

```json
{ "code": "invalid_partition", "message": "Partition out of range for worker type", "data": { "status": 400 } }
```

The handler refuses a partition that is negative, at or above
`MAX_PARTITIONS`, or past the type's active partition count. This is the first
of its three refusals.

#### 403 Forbidden

```json
{
  "code": "invalid_token",
  "message": "Invalid spawn token",
  "data": { "status": 403 }
}
```

This is the normal response for unauthenticated callers.

#### 409 Conflict

```json
{ "code": "fleet_held", "message": "fleet held since 2026-09-03T12:00:00+00:00; run `wp nodes start` to resume", "data": { "status": 409 } }
```

A deploy hold stands in [`Spawn_Coordinator::HOLD_OPTION`](../includes/class-spawn-coordinator.php), held at the endpoint
rather than at each spawner because this is the one gate they all cross.

#### 429 Too Many Requests

```json
{ "code": "spawn_throttled", "message": "job-worker.p0 spawned less than 15s ago", "data": { "status": 429 } }
```

The `{type}|{partition}` pair is inside the shared throttle window; see
[Rate Limiting](#rate-limiting).

## Authentication

This section covers the spawn endpoint only; `/command`'s per-command signing
model is [Command Signing](#command-signing) below.

The handshake above draws the spawn endpoint's dual-mode auth
([`Spawn_Controller::check_permission`](../includes/rest/class-spawn-controller.php)) as two validators of one
`nonce` field. There is no
env-var bypass — `NEWSPACK_NODES_WORKER_TYPE` and `_PARTITION` are written to
`$_SERVER` *after* auth passes (see [Worker Identity Tags](#worker-identity-tags))
and are consulted nowhere on the permission path.

Application plugins adding their own endpoints should gate them through
[`Capabilities::can()`](../includes/class-capabilities.php) rather than a bare [`current_user_can( 'manage_options' )`](https://developer.wordpress.org/reference/functions/current_user_can/),
so a site that installs the granular capabilities keeps its read-only callers
read-only. See [`newspack-event-logger-nodes/docs/API.md`](https://github.com/Automattic/newspack-event-logger-nodes/blob/main/docs/API.md) for the
application-side patterns.

## Internal Cache Health

```
POST  /wp-json/newspack-nodes/v1/health/cache
```

Narrow internal loopback endpoint [`wp nodes doctor`](cli.md#doctor-health-report) uses to test the cache
backend the WEB runtime selects — a probe run under WP-CLI reports a posture no
visitor ever gets. It is not a general cache API and not for public callers.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | yes | A lowercase 64-character HMAC-SHA256 token for the `health-cache` purpose. |

The body is form-encoded and carries only `token`, which is
`hash_hmac( 'sha256', "newspack_nodes_health-cache:{$window}", wp_salt( 'nonce' ) )`,
built by [`Internal_Request_Token::generate()`](../includes/class-internal-request-token.php) with `PURPOSE_HEALTH_CACHE`,
where `$window = floor( time() / 10 )`. The endpoint accepts the current and
immediately previous windows. Purpose separation means a spawn token cannot
authorize this route, and a health-cache token cannot authorize worker spawn.

WordPress REST enforces the required `token` argument. Omitting it returns HTTP
`400` with code `rest_missing_callback_param`, before the permission callback
and before `Bootstrap::fleet_gate()`, so no controller validation runs either.

When a token is supplied, the fleet gate applies before controller validation:
on multisite, only the main fleet site may use the route, and a subsite receives
`403 Forbidden`. On the fleet site, a malformed, expired, future-window or
wrong-purpose token receives `403 Forbidden` with code [`invalid_health_token`](../includes/rest/class-health-cache-controller.php).
Both refusals answer under that one code and echo nothing of what was
presented, so a caller learns neither which check failed nor how close its token
came.

The route accepts no caller-selected cache key or value. Extra `key` or `value`
input is never used by the probe and never returned; the server generates and
removes its own random probe entry.

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

The four fields are fixed: `id`, `label`, `status` and `messages`. This local
probe returns `good` or `critical`, and `messages` holds one non-empty
diagnostic string. (`wp nodes doctor` synthesizes `recommended` when the
loopback result cannot be verified.) A proven missing or failed backend is a
canonical `critical` result in the same HTTP `200` response: health severity is
payload state, not a transport failure.

## Worker Identity Tags

The spawn handler sets two `$_SERVER` keys once auth passes, before it fires
`newspack_nodes/spawn_worker`:

```php
$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;        // e.g. "job-worker"
$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;  // e.g. "0"
```

These are process-identity tags, not credentials. Three things read them:

- **[`Core::argv0()`](../includes/class-core.php)** puts the worker type in every log line's midfix, so a firehose line names the process that wrote it instead of the SAPI.
- **[`Consumer_Node::checkpoint_frame_extra()`](../includes/class-consumer-node.php)** stamps `worker_type` into each offsetlog checkpoint, which is how the dashboard labels a reader by the fleet it belongs to.
- **Consumer plugins** keep worker self-traffic out of the global request counters. [`Log_Manager`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-log-manager.php) in event-logger-nodes allow-lists both keys in its environment capture and reads the type to tag its own `process (start)` frame; [`Request_Builder_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-request-builder-node.php) reads the type back off that capture and marks the record `is_worker`, which [`Flame_Builder_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-flame-builder-node.php) files per URL but drops from the global roll-up. Nuclear-gyrobase reads the partition to build the lock lease it hands the Perl engine.

[`Bootstrap::reconcile_fleet()`](../includes/class-bootstrap.php) writes the same keys (`'reconcile'` and `'0'`) so
the WP-Cron reconciliation pass is tagged consistently with topology workers,
and a consumer may tag a request of its own the same way — cache-cozy's
mu-plugin writes `'cache-cozy'` on its warm loopback so that deliberately
expensive render lands outside the global stats. The value is a stats dimension,
not a worker type: nothing compares against the literal. What every writer
shares is that no client can reach the key, since PHP exposes request headers
under an `HTTP_` prefix — which is why event-logger-nodes' [`Auto_Tuner_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-auto-tuner-node.php)
treats the type's mere presence as proof of worker context before it rewrites
the ruleset.

## Rate Limiting

The spawn endpoint's two limits are in the handshake above: the 2-second
per-user limit ([`Spawn_Controller::RATE_LIMIT_S`](../includes/rest/class-spawn-controller.php)) on the WordPress-admin path,
and the 15-second `{type}|{partition}` throttle
([`Spawn_Coordinator::MIN_SPAWN_INTERVAL_S`](../includes/class-spawn-coordinator.php)) every spawner shares, recorded by
`Spawn_Coordinator::record_spawn()` in memory and in the shared cache, with a
transient fallback, at twice the window's TTL.

The `/command` endpoint applies its own per-user burst limit
([`HTTP_In_Node::check_permission`](../includes/rest/class-http-in-node.php)): `RATE_LIMIT_BURST = 30` POSTs per
`RATE_LIMIT_WINDOW_S = 1` second per user, bucketed by clock-second and
transient-backed, answering `429 Too Many Requests` on overflow. Independent
per-second buckets are what keep a steady one-request-per-second client at
count 1 forever. The budget is tunable through the
[`newspack_nodes/command_rate_limit`](#filters) filter, clamped to a minimum of 1.

Application plugins that add public-facing endpoints should layer their own
rate limits on top.

## Command Signing

Passing `/command`'s permission callback authenticates the *request*; it signs
nothing. Every command inside the batch must carry its own HMAC, stamped by the
node that minted it, or the runtime refuses it. Ingress never signs on a caller's
behalf, because that makes the boundary an oracle where arrival implies authority
([ADR-15](architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs)).
Only the minter's own signature counts.

![The auth request's three optional fields and the response drawn as five slots, the signed string drawn as four slots beside the four things that stay outside it, the VALUE.auth envelope, and the five verification checks in order with what each refusal writes to the drop audit and which ceiling it installs.](img/api-session-and-signature.png)

### Establishing a session

```
POST  /wp-json/newspack-nodes/v1/auth
```

Issues a session: a random signing key under a random handle
([`Command_Auth::mint_session()`](../includes/class-command-auth.php)). Gated by the fleet gate then the READ role — a
scope is a ceiling, so a read-only user minting a `manage` session still gets a
read-only one. The handle and the key are both generated server-side; caller
entropy is unverifiable, and a caller-chosen handle could collide with or
fixate a live session.

#### Request (all optional)

| Field | Meaning |
|---|---|
| `scope` | `read`, `tune` or `manage`. Defaults to `manage`, and is CLAMPED to the highest role the minting user holds, so the returned `scope` states authority rather than a request. An unrecognised value answers 400 `invalid_scope`. |
| `label` | How the session shows up in the Sessions tab. An empty label keeps it out of the listing. What is stored runs through [`sanitize_text_field()`](https://developer.wordpress.org/reference/functions/sanitize_text_field/) and is then truncated to [`Sessions::MAX_LABEL`](../includes/class-sessions.php) = 64 characters, so a listing can come back shorter than what was sent, or stripped of markup — the cap is there so a listing cannot be used as storage. `sessions create` echoes the label as SENT, so the two can disagree the moment the next `list` runs. |
| `ttl` | Lifetime in seconds, clamped to `[ Command_Auth::SESSION_TTL_MIN_S, SESSION_TTL_MAX_S ]` = `[60, 86400]`. Defaults to `SESSION_TTL_S` = 3600. |

Beyond the `RuntimeException` the diagram names, `Command_Auth::mint_session()`
throws `InvalidArgumentException` on a scope off the READ/TUNE/MANAGE ladder, which [`issue()`](../includes/rest/class-auth-controller.php) refuses first with the 400
above.

#### Response

```json
{
  "handle": "5f2b...(32 hex chars)",
  "secret": "9ac4...(64 hex chars)",
  "scope": "read",
  "expires_in": 3600,
  "now": 1735689600
}
```

The signing key is disclosed as `secret` because that is the field name
[`Core::is_secret_property()`](../includes/class-core.php) recognises. Every
redactor on both sides of the wire asks that one rule, so a reply rendered into
a drop-audit line or persisted to a browser's transcript is masked by its name
alone.

The key cannot be recovered from the Sessions listing. The session also
records the minting user; without it, a credential presented outside a browser
would authenticate and then act as nobody.

### Signing a command

The minting node signs before the command leaves the process — the browser's
Shell, a dashboard hook, or a PHP caller of [`Command_Auth::sign()`](../includes/class-command-auth.php) /
`sign_for()`. The result rides under `VALUE.auth`:

```json
{ "auth": { "nonce": "b91e...(32 hex chars)", "sig": "7cd0...(64-char hex HMAC)", "handle": "5f2b...(session handle)" } }
```

Repointing an envelope at another handle only makes the signature stop
matching, because the handle stays outside the signed string.

### Verification

The `/command` request process installs [`Command_Auth::verifier()`](../includes/class-command-auth.php) as every
interpreter's authorize policy; the five checks, their order and the ceiling
each outcome installs are in the diagram above. A refused command replies
`TM_COMMAND|TM_ERROR` carrying `unauthorized: <verb>` through the normal
TO=FROM path, and the containing `/command` batch answers **401** instead of
202 or 200 (see [Command Dispatch](#command-dispatch) below). The drop audit is
the rate-limited stderr line [`Node::drop_message()`](../includes/class-node.php) writes as `verification
failed: …`.

## Command Dispatch

```
POST  /wp-json/newspack-nodes/v1/command
```

Unified non-streaming dispatch endpoint. The browser POSTs a TM_COMMAND
envelope; the controller routes it through the request-scope `_router` to the
named CI; the CI's reply walks back via `TO=FROM` through `_output` — an
[`HTTP_In_Node`](../includes/rest/class-http-in-node.php), a double-duty class that is BOTH the `/command` REST controller
and the egress Node registered as `_output` ([`Node_Names::OUTPUT`](../includes/class-node-names.php)) — whose
`fill()` writes the packed Message directly to the HTTP response body. `_output`
is the egress name inside an SSE stream process too, where an [`HTTP_Filter_Node`](../includes/class-http-filter-node.php)
holds it. In the browser graph the two names split: `_http` is the [`HttpOutNode`](../src/runtime/http-out-node.js)
that POSTs the batch, and `_output` is the local sink an unaddressed reply lands
on.

The permission callback (`HTTP_In_Node::check_permission`) authenticates the
request and signs no command inside it — see
[Command Signing](#command-signing). READ is the FLOOR every verb behind the
endpoint needs, not the level any of them demands; who may call what is drawn
under [Service CIs](#service-cis).

### Request

The body is **JSONL** — one packed Message per line, where each line is the JSON
of the substrate's 7-slot positional array
`[TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]` (the wire form [`Message::packed()`](../includes/class-message.php)
emits). Multiple lines in one POST batch through the request-scope graph
serially, so an earlier command's side effect is visible to a later one — a
client sending `connect_worker_input` ahead of the command it enables depends on
that. Blank lines are skipped; every other line must decode to a 7-element
positional array, and `Message::unpacked()` throws on the first that does not. A
body carrying no parseable line throws as well.

That mount is not a pure graph edit.
[`Bootstrap::register_worker_partition()`](../includes/class-bootstrap.php) validates the id against
`/^[a-z0-9_-]+\.p\d+$/`, returns early when the partition is already mounted,
and where the worker holds no lock dir calls
[`Spawn_Coordinator::wake_sleeping_worker()`](../includes/class-spawn-coordinator.php) — so attaching a browser console to
an `idle` on-demand slot STARTS a process. A woken worker skips the
`ipc/{id}/input` existence check, because it creates that directory only once it
runs. Every refusal is silent, since the verb always answers an empty string, and
the command behind it bounces `NOT_AVAILABLE` instead.

Send that body as `text/plain; charset=UTF-8` — the [`COMMAND_CONTENT_TYPE`](../src/runtime/command-transport.js) the
browser transport declares — and never as `application/json`; the diagram under
[Response](#response-3) shows why.

Per-slot semantics (named here for documentation only — the wire is positional):

| Slot | Type | Description |
|------|------|-------------|
| `TYPE` (index 0) | int | Bitmask. `TM_COMMAND` (`8`) for a dispatch. |
| `TIMESTAMP` (index 1) | float | Unix timestamp. The signature covers it truncated to whole seconds, and the freshness window is checked against it. |
| `FROM` (index 2) | string | Reply path. `HTTP_In_Node` stamps `_output` onto it on the way in, so a bare reply path (`_output`, `_sse:{pid}/…`, or empty) walks back to this endpoint. The `_sse` form is minted by the browser's [`RemoteIpcNode`](../src/runtime/remote-ipc-node.js), which rewrites a non-empty reply-node FROM to `_sse:{pid}/{node}` before sending, taking the pid from its own SSE `connected` handshake — that is how the server's `HTTP_Filter_Node` demuxes an async reply back to this session's stream rather than another tab's. |
| `TO` (index 3) | string | CI node name (e.g. `topologies`, `workers`). Router peels the head off; subpaths flow through. Empty TO is dispatched by the base CI in-place. |
| `ID` (index 4) | string | Caller-chosen correlation id. The CI's reply carries the same `ID`. |
| `KEY` (index 5) | string | Routing and correlation metadata (e.g. `'completion'` triggers REPL completion-list mode on `help` and `ls`). |
| `VALUE` (index 6) | array | The inner Command_Interpreter envelope `{name, arguments}` as a live JSON array. `name` is the verb; `arguments` is a **flat token array** (`list<string>` argv) — the Shell and the browser transport tokenize ONCE at the producer boundary, and the tokens ride verbatim through envelope, interpreter and `make_node`. Every verb, scalar and structured alike, reads its data from that array (`$args[0]`, `$args[1]`, …). VALUE also carries `auth`, the HMAC envelope every minter stamps; see [Command Signing](#command-signing). |

The browser's command transport and the attached `wp nodes cli` both produce
this exact wire shape via `Message::packed()`.

### Response

![Seven stages of one /command POST in order, each with the outcome it can produce: the door's WordPress error objects, the uncaught-exception page for an unparseable body, the packed 500 for a missing graph, the FROM that overflows 1024 bytes, then inside interpret() the struct drop, the signature refusal that raises the 401 latch and the capability refusal that leaves the status at 200 or 202, the reply shapes, and the rule that the first write spends the status; beneath, the refusals the browser transport mints itself with undelivered: true.](img/api-command-status.png)

#### Synchronous (in-process reply)

The CI's `interpret()` produced a reply, and `HTTP_In_Node::fill()` (the egress
side) sent `200` and wrote the packed Message to the body.

#### 202 Accepted (async / IPC)

The status line alone, with an empty body: the batch routed without the
`_output` egress seeing a reply. Because `Command_Auth` decides signability
from the TYPE bit rather than by sniffing for `name`, a malformed inner
envelope signs cleanly and then vanishes into the struct drop, which runs
before verification.

#### 401 Unauthorized

The batch answers 401 when any command in it failed `Command_Auth`
verification; the 401 is the fast signal a client checks before parsing the
body. A capability refusal is
not this 401: [`Capabilities::require()`](../includes/class-capabilities.php) throws
`RuntimeException( "permission denied: <role> capability required" )` from
[`Command_Interpreter_Node::dispatch()`](../includes/class-command-interpreter-node.php), after `authorize` has already passed.

#### 500 Internal Server Error

Sent as a packed positional Message, the same wire shape as the request. Example
body:

```json
[288, 1735689600.5, "_command", "<request from>", "<request id>", "", "request-scope graph not initialized (missing _router or _output)"]
```

`TYPE = 288 = TM_RESPONSE | TM_ERROR` (`256 | 32`).
[`HTTP_In_Node::emit_error()`](../includes/rest/class-http-in-node.php) sends it; operational application errors never
reach this path.

#### Refusals the client mints

A batch turned away at the door never reaches a verb, so the browser transport
answers its own caller rather than let a node wait out its deadline:
[`postBatch()`](../src/runtime/command-transport.js) mints the `undelivered: true` refusals the diagram shows.

### Service CIs

The substrate mounts ten service CIs through `newspack_nodes/request_graph_ready`
([`newspack_nodes_mount_substrate_cis()`](../newspack-nodes.php) in `newspack-nodes.php`). Each is a
[`Service_CI_Node`](../includes/class-service-ci-node.php) declaring its verbs once in `node_schema()`, and the base
derives both the dispatch table and the capability gate from that declaration. A
verb that declares no `capability` demands MANAGE, so silence is the strictest
role rather than the loosest.

| Node name | Class | Verbs (role) |
|-----------|-------|--------------|
| `classes` | [`Classes_CI_Node`](../includes/rest/class-classes-ci-node.php) | `dump` (read) |
| `layouts` | [`Layouts_CI_Node`](../includes/rest/class-layouts-ci-node.php) | `get` (read), `save` (tune) |
| `topologies` | [`Topologies_CI_Node`](../includes/rest/class-topologies-ci-node.php) | `dump` (read), `get` (read), `expand` (read), `save`, `delete`, `activate`, `deactivate`, `connect_worker_input` (manage) |
| `raw-logs` | [`Raw_Logs_CI_Node`](../includes/rest/class-raw-logs-ci-node.php) | `list_logs`, `dump_log`, `read_message` (read) |
| `vault` | [`Vault_CI_Node`](../includes/rest/class-vault-ci-node.php) | `list`, `get`, `add`, `update`, `delete`, `test` (manage) |
| `aggregator` | [`Aggregator_CI_Node`](../includes/rest/class-aggregator-ci-node.php) | `summary` (read), `list_servers` (read), `probe` (manage — on-demand per-spoke deep roll-up) |
| `settings` | [`Settings_CI_Node`](../includes/rest/class-settings-ci-node.php) | `get` (read), `set` (tune) |
| `status` | [`Status_CI_Node`](../includes/rest/class-status-ci-node.php) | `get` (read) |
| `sessions` | [`Sessions_CI_Node`](../includes/rest/class-sessions-ci-node.php) | `list`, `create`, `revoke` (manage — issuing one hands out access) |
| `workers` | [`Workers_CI_Node`](../includes/rest/class-workers-ci-node.php) | `list`, `dump_graph`, `dump_cleanup`, `heartbeat` (read), `restart` (manage) |

![Every service CI's verbs as chips colored by the role each declares, read, tune or manage, with the help verb each CI seeds at manage; the root interpreter's fifteen read-only builtins beside its manage verbs and their aliases; and three notes on install-time gating, the Shell builtins that mint nothing, and the three-level secure ladder.](img/api-verb-roles.png)

The first column is the NODE name — `make_node`'s second argument, and what a
caller puts in TO. A CI's SHELL name is a different string: the class short name
minus `_Node`, so `Layouts_CI_Node` is addressed as `layouts` and described as
`Layouts_CI`. [`Command_Interpreter_Node::shell_name_for()`](../includes/class-command-interpreter-node.php) derives that name;
the `classes` CI's `dump` verb reports it under `shell_name`, `dump_metadata`
returns it as `class`, and the topology console's Inspector looks a node's verbs
up by it. It is also what `help Layouts_CI` renders a schema for, because
`Bootstrap` registers the `Newspack_Nodes\Rest\` prefix alongside
`Newspack_Nodes\`.

**`workers.dump_graph` vs `dump_metadata` — different verbs, different shapes.**
The `workers` CI's `dump_graph` returns the dashboard payload:

```
{ workers[], consumers[], logs[], log_partitions, deadletter_segments,
  deadletter_by_reader, num_partitions, max_segments, segment_size,
  timestamp, heartbeat_interval_s, graph }
```

![Where each dump_graph key comes from, one row per source: the lock dirs to workers[] with its ten fields, the last 128 KiB of the topicprobe log to consumers[] with its nine fields and the stale re-measure, the log catalog to logs[] and its join key, the logs root to log_partitions, the dead-letter dirs to the two dead-letter keys, config to the five scalars, and the active topologies to graph; beneath, the two readers of the one snapshot, the dashboard's dump_graph and Alerts::evaluate().](img/api-dump-graph-sources.png)

`consumers[]` is a report, not an inventory: [`CLI::consumer_rows()`](../includes/class-cli.php)
builds it from one [`Probe_Record`](../includes/class-probe-record.php) per
reader in the shared topicprobe log, so a reader that has not reported recently
drops out instead of reading stale, and a record aged past
[`Topic_Probe_Node::stale_after_s()`](../includes/class-topic-probe-node.php) is
re-measured off disk. [`Alerts::evaluate()`](../includes/class-alerts.php) reads
the same snapshot, so an alert can never name a fleet the dashboard does not
show.

**`workers dump_cleanup` names candidates, not casualties.** It answers
`{ logs_dir, on_disk_basenames, expected_basenames, orphans }` — every
first-level dir under `logs/`, the set [`Log_Cleaner::declared_log_dirs()`](../includes/class-log-cleaner.php)
retains, and the difference between them. Both halves are the calls the sweep
itself makes, but the diagnostic applies NO grace window, where the sweep and
`wp nodes gc` spare any dir whose newest inner mtime is under
`Log_Cleaner::DELETE_GRACE_S` (3600s). A dir an in-flight deploy created moments
ago therefore lists as an orphan here while [`gc`](cli.md) would still leave it alone, so
reading this verb as "what the next sweep deletes" overcounts.

**`sessions list` — the directory, never the keys.** It returns
`{ sessions[], ttl_max, scopes[] }`, each row `{ handle, label, scope, created,
expires, live, state }`. `ttl_max` is `Command_Auth::SESSION_TTL_MAX_S` and
`scopes` the three `Capabilities` ladder constants, sent so a client draws its
TTL bound and scope picker from the substrate rather than a second copy that
drifts into offering a scope the mint refuses. `state` is only ever `live` or
`revoked`: [`Sessions::all()`](../includes/class-sessions.php) drops every row past its stated expiry before it
lists, so a listed dead row always lost its lease EARLY — a `sessions revoke`, or
the salt rotation `wp nodes memcache flush` performs — and `expired` is not a
value a client can see. Reading the listing writes nothing; the option keeps
lapsed rows until the next `Sessions::record()` rewrites it.

**`topologies expand` and `topologies get` compose different views.** `expand`
returns [`Topology_Analyzer::expand()`](../includes/class-topology-analyzer.php)'s shape for an include SET —
`{ nodes, edges, tree, hulls }`. A node carries `name`, `class`, `fans_out`,
`args`, `verbs`, `origin` and `via`; an edge carries `from`, `to`, `origin`,
`roles` (`connect`, `config`, or both) and, where a config role exists,
`config_slots` naming the setter verbs that made it. `origin` is a LIST because
a diamond include is provided by several directly-declared includes, while `via`
is only the first path a node entered through. `hulls` maps every topology in
the tree, at any depth, to the node names it declares, depth-first so an outer
topology precedes what it brings and the canvas paints the nested hull on top.
The whole payload is informational — the runtime is the Shell's `include` — and
it is the topology console's edit-mode baseline.

`topologies get <name>` returns `{ name, source, tsl, includes, expanded,
resolved_config_edges }`, and its `expanded` is that same shape built from the
file's DIRECT includes alone: it holds the borrowed members and none of the
file's own lines, which is what lets the editor render a borrowed node as
borrowed. `resolved_config_edges` covers the whole topology instead, because a
config verb pointed at a `<namespace:key>` token names an edge only the server
can resolve. A client parsing a document that carries such a token must treat a
response without that list as fatal rather than wire an edge to the literal
token text; the console's document loader throws there, and
[`augmentWithVirtualEdges()`](../src/topology-console/utils/virtualEdges.js) draws no edge at all for a token the server resolved
to nothing.

**`aggregator` — one `id` field, two meanings.** `list_servers` returns one
row per wired [`Remote_Source`](../includes/class-remote-source-node.php), keyed by the NODE name in `id` and carrying the
Vault credential id separately as `vault_id`. `probe <id>` wants the VAULT id,
answers `server not found: <id>` for anything else, and echoes it back as its
own `id`. A client that carries `id` straight from one verb into the other is
refused. The probe's reply is the whitelisted roll-up
`{ id, workers: { total, live, stale, dead }, worst_distance,
deadletter_segments }`, where `dead` counts every worker that is neither live
nor stale — one that never started — and `worst_distance` is the largest
`distance` across the spoke's `consumers[]`. `summary` reduces the same snapshot
to `{ connected, idle, total, server_now }`, and its per-server reading is best
partition wins: `connected` while any partition is connected, `idle` while none
is connected but one carries a `scheduled_reconnect_at`, and `down` otherwise —
so a partition mid-handshake or in error backoff counts toward `down`.

**`settings` — `get` and `set` do not cover the same keys.** `get` answers the
seven storage settings alone — `num_partitions`, `segment_size`, `min_segments`,
`num_segments`, `min_lifetime`, `lifetime`, `max_segments` — as EFFECTIVE values
through [`Config::value()`](../includes/class-config.php), so a key never saved reports its schema default
rather than an empty option. `set` reaches every `int` Field declaring a
minimum: those seven plus the six `remote_*` spoke-geometry keys, the three
`alert_*` thresholds and the four bounded `sse_*` limits, whether or not the
settings page renders them. An int Field with no minimum (`sse_idle_timeout`,
`sse_retry_ms`, `on_demand_idle`) and every Field of another type
(`base_directory`, `memcache_servers`, `log_sources`, `vault`) is refused as
`unknown setting: <name>`. The option name is accepted either way it is spelled,
short key or full `newspack_nodes_` option name, which is how
[`Settings_Sync_Node`](../includes/class-settings-sync-node.php) pushing the full name and an operator typing the short key
drive one verb unmodified.

Two `set` behaviours differ from the settings page. A value outside the Field's
bounds is REFUSED rather than clamped, throwing `invalid value for setting:
<key>` as a `TM_COMMAND|TM_ERROR` reply. And a value already in place writes
nothing, resets no config and requests no restart, which is what keeps the sync
sweep's unchanged re-pushes from recycling the fleet every tick; a real change
resets `Config` and asks [`Restart_Planner`](../includes/config-system/class-restart-planner.php) to recycle the topologies the Field's
restart class names. The reply to `set` is the same seven-key snapshot `get`
returns, so a caller that writes `sse_max_streams` or `remote_segment_size`
never sees its own value come back — that reply is not evidence the write was
ignored.

**`status get` is a cheap probe.** The snapshot is `{ status, runtime_version,
num_partitions, topologies, cache_available, timestamp }`. Its `num_partitions`
comes from [`Bootstrap::global_num_partitions()`](../includes/class-bootstrap.php), the count clamped into
`[1, Spawn_Coordinator::MAX_PARTITIONS]` that the fleet actually spawns, while
`dump_graph`'s same-named field is the raw config value cast to int — a
misconfigured value makes the two disagree, and only this one names what runs.
`cache_available` asks whether a backend is SELECTABLE: a non-empty memcached
server list reached `Core::$memd`, or APCu is loaded and enabled. Adding a
server connects to nothing, so a configured but unreachable memcached still
reports true; the add/read/delete round trip that catches it is
[`/health/cache`](#internal-cache-health) and the `cache-backend` row of
`wp nodes doctor`.

**`layouts` backs one canvas.** The Topology Console is its only caller, one
layout per topology name. It seeds [`useCanvasLayout`](../src/topology-console/hooks/useCanvasLayout.js)'s position map from
`layouts get` on load, for an edit-mode canvas or a worker scope whose label
matches the topology, and writes back only when a person clicks Save Layout —
dragging autosaves nothing. Every other canvas in the substrate, the debug
overlay's Inspector and each station tab graph included, persists positions to
`localStorage` through the same hook and never reaches the server, so a
dashboard wanting layout to survive a change of browser wires these two verbs up
itself.

Every `Command_Interpreter_Node` separately exposes `dump_metadata` for the
per-node canvas snapshot the topology console renders, keyed by node name:

```
{ class, counter, sink, target, targets, debug_state, arguments, lgst_msg,
  bytes_read, bytes_written, accepts_fill, has_target, has_config }
```

`target` is the ROUTING value, `Node::target()` verbatim, a scalar unless the
node fans out; `targets` is the DISPLAY union [`Node::display_targets()`](../includes/class-node.php) returns,
always a list, the routing target plus any destination the node declares through
`extra_targets()`
([ADR-19](architecture-decisions.md#adr-19-a-node-may-declare-a-destination-it-writes-without-routing)).
`accepts_fill` and `has_target` come from the node's `node_schema()` and tell the
canvas which ports to draw. A node with registered listeners adds
`registrations`, and a node's own `dump_metadata()` may add further keys — never
clobbering a fixed one. Patron-linked nodes and schemas flagged `hidden` are
omitted, since they are plumbing the canvas must not render. A full snapshot
(no node named) also carries a `_header` entry holding `profiling` and, when the
command supplied one, `pwd`.

`registrations` comes from `Node::registered_listeners()`, which walks the
registration table and keeps only the entries whose callback is null — the
Node-NAME listeners. A closure listener has no name to draw an edge to, so it is
skipped, and an event left with no name listeners drops out of the map rather
than reporting empty. [`Timer_Node`](../includes/class-timer-node.php), which registers itself by name on the
router's `TIMER` channel, therefore shows a registration edge, while
[`Remote_Link_Node`](../includes/class-remote-link-node.php), which registers a closure on the fleet's `RELOAD`, shows
none: a missing edge is not evidence that nothing is listening.

A composite node reports its PATRONS' I/O, not its own. Once
`Remote_Link_Node`'s patrons exist, `counter` is `SSE_In`'s frame count,
`bytes_read` and `lgst_msg` are `SSE_In`'s, `bytes_written` is `HTTP_Out`'s, and
the link's own relay increments are masked — so a rate or throughput figure read
off a Remote_Link or Remote_Source row measures the wire, not the node. Before
the patrons are built, on a fresh drop or a spoke with no Vault entry, both byte
counts read 0 and `counter` falls back to the node's own tally.

Address `dump_graph` to `workers` for the dashboard shape; address
`dump_metadata` with empty TO for the canvas shape.

The root (empty-TO) base `Command_Interpreter_Node`'s own vocabulary, the
Shell builtins that precede it and the `secure` ladder are in the verb chart
above. `help <NodeType>` renders a class's `node_schema()` / `nodeSchema()`
identically in PHP and browser-local JS. Addressing a command with empty TO
dispatches against the root table; a non-empty TO routes to the named CI.

**`node_schema()` shape.** A CI's `node_schema()` returns a `Service`-category
schema: `{ category, description, arguments, commands }`, where each `commands`
entry is `{ name, description, capability, args, handler }` plus the optional
console flags `multiple`, `hidden` and `action`, and each arg is
`{ name, type, required }` plus an optional `default` (for example,
`workers restart`'s `partition`, defaulting to `-1`). A node schema may also
carry `requests`, `registrations`, `accepts_fill`, `has_target` and `hidden`;
`requests[]` entries are answered by the addressed node's own `fill()` and
contribute no dispatch entry.

An arg's `required` flag is palette and Inspector metadata, and nothing enforces
it. `Service_CI_Node` builds the dispatch table and the capability gate from
`name`, `handler` and `capability` alone, so a verb called without a declared
argument runs on whatever its handler makes of the empty token. `raw-logs
read_message` declares `log` required and still never refuses one:
`resolve_log_key()` substitutes the catalog's default key for an empty or
unknown value. This is the opposite of a Node constructor's `arguments()`, where
`parse_schema_args()` really does throw `Missing required argument: <name>`
([ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)).

What `help` renders of that is thinner. The COMMANDS and REQUESTS tables
[`Node_Schema_Help::render()`](../includes/class-node-schema-help.php) builds carry `name` and `description` alone: a
verb's capability, its declared `args` and the `multiple` / `hidden` / `action`
flags never appear, and a `hidden` command prints like any other. So `help
Workers_CI` will not tell an operator what `restart` takes or which of the three
roles it needs. The live-mode Inspector's verb modals and the Service-CI tables
above are where arguments and capabilities surface; help is a summary, not the
verb reference.

`Classes_CI`'s `dump` verb inlines the serializable half of every concrete Node
class's schema for the topology-editor palette and the live-mode Inspector. It
returns `{ classes[], formatters[] }`, each class carrying `shell_name`, `fqcn`,
`category`, `description`, `arguments`, `commands`, `requests`,
`registrations`, `accepts_fill`, `has_target`, `is_interpreter` and `fans_out`.
The non-serializable `handler` and the server-enforced `capability` are stripped
on the way out. `formatters[]` is [`Formatters::list_names()`](../includes/class-formatters.php) sorted, and it is
the option list the console renders for any `node_schema()` argument declared
`type: formatter_name` — today only `with_index`'s. The substrate registers no
formatters of its own, so on an install carrying no consumer plugin that calls
`Formatters::register()` the array is empty, the console falls back to a
free-text input, and a `with_index` verb raises `unknown formatter: <name>` for
whatever is typed into it. Discovery reads the composer classmap
([ADR-10](architecture-decisions.md#adr-10-class-naming--make_node-namespace-resolution)),
so a class added or renamed without `composer dump-autoload -o` is absent from
the palette.

**Every verb reads from the `arguments` token array.** Verbs taking a single
scalar — `topologies get` / `delete` / `activate` / `deactivate` /
`connect_worker_input`, `layouts get`, `raw-logs dump_log` — read `$args[0]`
straight from the inner envelope's `arguments` list, so they are typeable in the
REPL (`command_node topologies get Home`), and `dump_log` answers
`{ log_id, segments: [ { id, size } ], segment_count, total_size }` for the one
partition dir it inspects. `raw-logs read_message` reads two positional tokens
the same way, the log key then the position — that position being the
single-step grammar `<segment>:<offset>[:<length>]` or one of `start`, `recent`
and `end`, never the `positions` JSON the two SSE routes take; the two
vocabularies share those three words and nothing else. See
[Log Stream](#log-stream) for the read model and the struct it answers. The
ownership-fenced `workers heartbeat` requires exactly `[ slot, owner ]`, both
canonical decimal tokens from the current SSE `connected` handshake, and the
server — never the client — owns the lease TTL. Structured verbs read the same
list: `topologies save` and `layouts save` take `[ name, body ]` through
`Service_CI_Node::split_first_token()`, where `$args[1]` carries the whole TSL
body or positions JSON, newlines included, as one discrete token, with no
rest-of-line splitting to guess at. Option-flag verbs like `workers restart`
classify `<type>… [--partition=<n>]` through
[`Command_Args::parse( list<string> $args )`](../includes/class-command-args.php), which sorts `--key=value` and bare
`--key` flags out of the positionals.

Verb handlers receive three positional arguments —
`( Command_Interpreter_Node $interpreter, array $args, array $envelope = [] )` —
where `$args` is the pre-split token array (`list<string>` argv; each handler
normalizes through `arg_strings()`). The `$envelope` is the full 7-field
positional Message; both `save` verbs use it to enforce a 1 MiB body cap via
`Message::packed_size( $envelope )`.

**`KEY='completion'` mode.** A `help` or `ls` command carrying `KEY='completion'`
returns a bare newline-separated candidate list — sorted verb names, or bare
node names across the whole registry — instead of the tabulated output. The KEY
stands in for Tachikoma's `TM_COMPLETION` type flag, which this runtime does not
carry, and REPL tab-completion is built on it. See
[architecture-guide.md → REPL](architecture-guide.md#repl-wp-nodes-cli).

Per-verb args, return shapes and error semantics are declared on each CI's
`node_schema()` under
[`includes/rest/class-{classes,layouts,topologies,raw-logs,workers,vault,aggregator,settings,status,sessions}-ci-node.php`](../includes/rest/);
the palette and the Inspector consume the same schema. Auth gating is uniform:
the endpoint requires the READ floor AND a valid command signature, and each
verb's declared role decides the rest. An authorization refusal THROWS —
`Command_Interpreter_Node::interpret()` wraps it as `TM_COMMAND|TM_ERROR`. The
single-step readers are one exception a caller must handle: `raw-logs
read_message` returns `array|string`, answering the teaching error as its
successful TM_RESPONSE value rather than a thrown error (see
[Log Stream](#log-stream)).

### Test mode

[`HTTP_In_Node::set_test_mode( true )`](../includes/rest/class-http-in-node.php) makes `dispatch()` return instead of
`exit()`, so PHPUnit can capture stdout through `ob_start()`.

## SSE Stream

```
GET   /wp-json/newspack-nodes/v1/messages/stream
```

[Server-sent-events](https://html.spec.whatwg.org/multipage/server-sent-events.html) drain endpoint backed by [`SSE_Out_Node`](../includes/rest/class-sse-out-node.php), which is both the
`_sse` egress Node and the REST controller, mirroring `HTTP_In_Node`'s
double-duty pattern. One endpoint covers every subscription a dashboard needs:
log partitions and worker IPC partitions both surface as `Consumer_Node`
instances drained in the same loop. Each Message reaching the `_sse` egress goes
out as an SSE `msg` event carrying the packed Message.

![A stream's life in order: the slot acquire before any header, the headers, the retry event, the graph build, the connected handshake with its 4096-byte padding flush, then the five checks of every drain tick, the finally that releases the slot, the four Closure seams and when each is called, the pool's four numbers, and the client heartbeat that alone keeps a lease alive.](img/api-sse-lifecycle.png)

**Permission**: the fleet gate, then the READ role. No nonce — that would break
the cross-server SSE pull, which is the aggregator's whole job, and it is why
`workers heartbeat` (the slot keepalive) is `read` too: MANAGE there would
expire every read-only stream after one slot TTL.

### Query parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subscribe` | string | yes | CSV of subscription names, described below. Blank entries between commas are dropped. |
| `positions` | string | no | Optional resume positions: a JSON object keyed by the STAMP each subscription resolves to. A value is either an exact `{segment, offset}` object or a **seek sentinel** — `0` start, `-1` end (live tail), `-2` recent — Tachikoma's vocabulary (`Consumer.pm`: *"valid offsets: start (0), recent (-2), end (-1)"*), mirrored as [`Consumer_Node::SEEK_START`](../includes/class-consumer-node.php) / `SEEK_END` / `SEEK_RECENT`. The words `start`, `recent` and `end` are accepted aliases. Stating the seek as a number is what makes `{segment: 0, offset: 0}` mean the START of the log rather than an absent value: `SSE_In_Node` always sends a position, using `-1` when it has none, so a source resuming a `0:0` checkpoint replays its backlog instead of being tail-seeked past it. `-1` / `end` seeks the newest segment's current size; `-2` / `recent` seeks byte 0 of the SECOND-newest segment, or of the only segment when there is just one, so it can replay up to a whole segment. Malformed JSON, or a value decoding to anything but an array, is treated as omitted. A per-key value is handled the opposite way: `SSE_Out_Node::position_arg()` keeps a word as a string, and `Consumer_Node::seek_sentinel()` resolves any word it does not recognise to `SEEK_START`, so ONE typo'd position word replays that subscription's whole log rather than tail-seeking it. Omitting the parameter tail-seeks every subscription, which is what a browser dashboard does on a first connect. |
| `multi_writer` | boolean | no | Read the subscribed logs with the multi-writer seal-grace (`Consumer_Node::SEAL_GRACE_SECONDS`). Set it for a log every request process on this server appends to — the firehose — where a peer can keep writing to segment N for up to [`Partition_Node::DRIFT_RESCAN_INTERVAL_SECONDS`](../includes/class-partition-node.php) after N+1 appears; without it the reader advances off N on sight and orphans that straggler, typically a request's terminal `process (complete)`. The CLIENT asserts it, because nothing on disk records which logs are shared. It applies to log Consumers only — a worker IPC attach has one writer and never takes the grace. Default off: a single-writer log seals N the instant it creates N+1, so the grace would be pure added latency. [`Remote_Source_Node`](../includes/class-remote-source-node.php) sends it through its `set_multi_writer` config verb; browser dashboards leave it unset. |

#### Subscription grammar

![How one subscribe name resolves: the group split against Log_Discovery::GROUPS, the character-class check that leaves * as the only wildcard, the worker-IPC path and the partition-dir glob with the multi-writer seal grace; the connected envelope drawn as six KEY VALUE slots with what SSE_In_Node rejects; and how a client advances each cursor from the ID breadcrumb of every msg and sends it back as positions, with the three seek sentinels.](img/api-sse-subscribe-and-resume.png)

### Response

A standard SSE stream, `Content-Type: text/event-stream`, with every buffering
layer between PHP and the browser disabled and each tick's output chased with
the `FLUSH_SIZE` (4096) padding comment the lifecycle diagram shows.

Five events go out, in this order of first appearance. Every one but `msg` is a
TM_INFO frame stamped `FROM=_stream`, so the table names only what tells them
apart:

| Event | Message | Meaning |
|---|---|---|
| `retry` | `KEY=retry`, VALUE the `sse_retry_ms` config value (default 5000) | The reopen schedule, sent first because every close relies on it. An EVENT rather than the protocol `retry:` field, since the client owns reconnect and needs the interval as data it can read. Set `sse_retry_ms` to 0 to advertise nothing — the client ignores any value at or below zero. |
| `connected` | `KEY=connected`, VALUE the flat envelope below | The session handshake; see below. |
| `msg` | the packed Message the egress received | One delivered record. Only these count as data, which is what defers the idle close. |
| `heartbeat` | `KEY=heartbeat`, VALUE the tick timestamp | Liveness every `HEARTBEAT_MS = 2000`ms. Deliberately not data: a heartbeat never defers the idle close. |
| `disconnect` | `KEY=slot_lease_lost`, VALUE `SSE slot lease lost` | The terminal frame for a stream whose lease was taken from under it. |

The stream **closes itself after `sse_idle_timeout` seconds** (default 15)
with no `msg` event. That idle close is a bare EOF with no terminal event; a
`disconnect` frame always means failure, and `SSE_In_Node` is the reference
implementation for consuming one.

#### The `connected` envelope

```
PID <pid> SLOT <slot> OWNER <owner> SUBSCRIPTIONS <csv> INTERVAL <ms> CURSORS <csv>
```

A flat space-separated `KEY VALUE` string rather than JSON, because a TM_INFO
VALUE is never an array; the slots, their validation by `SSE_In_Node` through
[`Core::canonical_decimal()`](../includes/class-core.php), and the resume loop they seed are in the
subscription diagram above.

#### Slot gating

The application controls concurrency through four optional Closure seams on
`SSE_Out_Node`, installed by [`SSE_Slot_Pool::wire()`](../includes/class-sse-slot-pool.php) from
`Bootstrap::register_rest_routes()`:

| Seam | Signature | Called |
|---|---|---|
| `$acquire_slot` | `function ( int $partition ): array{slot:int,owner:positive-int}\|false` | Once per stream, before any header, so `false` can still answer `429 too_many_connections`. |
| `$check_slot` | `function ( array $lease, int $partition ): bool` | Every drain tick; false takes the `disconnect` close. It only READS — refreshing the TTL belongs to the client heartbeat, and refreshing it here would let a stream nobody is reading hold its slot forever. |
| `$release_slot` | `function ( array $lease, int $partition ): void` | From the drain's `finally`, so neither a clean close nor a throw leaves the slot held until its TTL expires. |
| `$inspect_slot` | `function ( array $lease, int $partition ): array<string,int\|string>` | Only once a check has already failed, to name the backend and lease state in the diagnostic line. The healthy path never pays it. |

Both stream routes draw on one host-wide pool, sized by `sse_max_streams`
(6), `sse_max_slots` (3), `sse_reserved_slots` (0) and `sse_slot_ttl` (60
seconds). [sse-host-budget.md](sse-host-budget.md) carries the arithmetic behind
each number.

## Log Stream

```
GET   /wp-json/newspack-nodes/v1/log/stream
```

Server-sent-events log-tail endpoint backed by [`Log_Stream_Out_Node`](../includes/rest/class-log-stream-out-node.php), an
`SSE_Out_Node` subclass. On the wire it mirrors `/messages/stream` exactly —
same packed `msg` events, `retry` and `connected` envelopes, heartbeat cadence,
flush framing, idle close and slot pool — so any `/messages/stream` client works
unchanged. It overrides exactly two members, `ROUTE` and `open_subscription()`;
both route constants are read late-static, so declaring `ROUTE` is all a
subclass needs to publish a second path. The one difference is what a
subscription resolves to: a fixed
**[`Log_Sources`](../includes/class-log-sources.php) registry NAME** opened as a [`Tail_Node`](../includes/class-tail-node.php) reader instead of a
Consumer. A caller can never supply a path, so there is no traversal surface.

![The Log_Sources registry: the three families merged in priority order with the tail mode each carries, the six fields of a taillog sources row, the two classes Log_Sources::open_tail() maps the mode token to, the one read model behind taillog read and raw-logs read_message with the struct it answers, and the string errors the two verbs return instead of throwing: two shared, and unknown log source from taillog read alone.](img/api-log-stream-sources.png)

The same registry backs the REPL's `taillog` verb (`Log_Sources::taillog()`),
and its `taillog sources` name returns the merged catalog for GUI pickers.

**Permission**: inherited from `SSE_Out_Node` — the fleet gate, then the READ
role, with no nonce.

### Query parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subscribe` | string | yes | CSV of registry NAMES. An unknown name throws the teaching `unknown log source` error listing the names that exist. No globs — registry sources are fixed for the life of a stream, and Tail's missing-file grace covers a source that appears, rotates or truncates mid-stream. |
| `positions` | string | no | Optional resume positions, same vocabulary as `/messages/stream`: a JSON object keyed by registry name, each value a `{segment, offset}` object or a seek sentinel (`0` start, `-1` end, `-2` recent), with `start`, `recent` and `end` accepted as aliases. [`File_Tail_Node`](../includes/class-file-tail-node.php) folds `recent` to the start, because one file has no previous segment to fall back to. The shape round-trips unchanged from the client's perspective: for a segmented source `segment` is the segment id; for a file-mode source the file's inode occupies the same slot, and the cursor self-validates against the live file and degrades to 0 on mismatch. That validation happens on the FIRST POLL, not at subscribe time — `open_subscription()` seeks before the file is open, so the pair is held as a candidate, and `cursor_position()` echoes the client's own unvalidated value straight back into the `connected` envelope's CURSORS. An unchanged echo is therefore not an acknowledgement that the server accepted it. A candidate counts toward `compute_lag()` only while it still names the live generation and sits within the file: honouring a stale pre-rotation position would declare the new generation caught up and let the stream idle-close on its first tick without ever delivering it. Omit to start at `end` (live tail). |
| `multi_writer` | boolean | no | Accepted but inert. The route registration is inherited unchanged, while a subscription here resolves to a `Tail_Node`, and the seal-grace belongs to a Consumer. |

### Response

Identical to `/messages/stream`: each line the Tail emits arrives as an SSE
`msg` event carrying the packed 7-field Message (`TM_BYTESTREAM`, FROM stamped
with the registry name), with the same envelopes, heartbeat, 429 slot-gating and
flush behavior.

## The substrate as client

Two nodes call these endpoints on a remote server instead of serving them: a hub
POSTs commands to its spokes through `HTTP_Out_Node` and pulls their streams back
through `SSE_In_Node`. Both bound themselves, and an operator diagnosing a
flapping spoke reads it against the numbers below.

### `HTTP_Out_Node` — `/command` and `/auth`

![The push side in four steps: fill() buffering under a one-shot timer with the three in-tree minters, fire() dropping an unaddressable batch or holding one while /auth runs, the JSONL POST with its 15-second timeout and 8 MiB reply cap, and on_curl_message() branching on transport error, 401, 202, other non-200 and 200; beneath, the blocking probe_command() bounds and what an operator reads off a flapping spoke.](img/api-http-out-push.png)

A batch lost past [`fire()`](../includes/class-http-out-node.php) has no retry and no dead letter
([ADR-3](architecture-decisions.md#adr-3-fire-and-forget-messaging)); a minter
finding [`Command_Auth::has_session()`](../includes/class-command-auth.php) false calls `ensure_session()` rather
than skip the push, because a skipped push deadlocks both sides: `HTTP_Out`
handshakes only inside `fire()`, and only `fill()` arms that tick.

| Constant | Value | Bounds |
|---|---|---|
| `REQUEST_TIMEOUT` | 15 seconds | One non-blocking POST, as `CURLOPT_TIMEOUT`. |
| `MAX_REPLY_BYTES` | 8388608 (8 MiB) | One spoke's reply body, capped because the write callback buffers it into the PHP heap. |

The blocking path, `probe_command()` behind `vault test` and `aggregator
probe`, is in the diagram: it returns the reply envelope's `payload` array and
nothing else, so a caller never has to read a verdict out of a returned value.

### `SSE_In_Node` — `/messages/stream`

![The pull side as a state machine: CONNECTING, CONNECTED, DISCONNECTING, ERROR, DISCONNECTED and RECONNECTING with the event behind each edge and the backoff rail back to CONNECTING, the four bounds, what the node sends on every connect, which of three cursor inputs wins, the eight keys of connection(), and the browser mirror's own watchdog, silence and backoff numbers with its five states.](img/api-sse-in-pull.png)

A patron ([`Remote_Source_Node`](../includes/class-remote-source-node.php)) drives [`maybe_connect()`](../includes/class-sse-in-node.php) and `check_stale()`;
`Remote_Source_Node::fire()` carries the `has_pending_seek()` gate, and
`Remote_Source_Node::next_offset()` shows both cursor branches, a bare sentinel
forwarded and an explicit pair written through `restore_position()`, each after
a `disconnect()`, because the sentinel is read at connect time only.

| Constant | Value | Bounds |
|---|---|---|
| `CONNECT_TIMEOUT` | 5 seconds | The connect, as `CURLOPT_CONNECTTIMEOUT`. The transfer itself is untimed (`CURLOPT_TIMEOUT` 0), which is what `check_stale()` covers instead. |
| `HEARTBEAT_TIMEOUT` | 45 seconds | The silence `check_stale()` reads as a dead stream. `SSE_Out_Node` heartbeats every 2 seconds, so only a broken link reaches it. |
| `INITIAL_BACKOFF` / `MAX_BACKOFF` | 1 / 30 seconds | The reconnect delay, doubling on each failure and reset to the floor by any received event. A clean 200 close on a stream that advertised a reopen delay — the `retry` event, or a plain server's `retry:` field — takes that delay instead, clamped to the same range and leaving the failure state untouched. |
| `MAX_BUFFER_SIZE` | 33554432 (32 MiB) | Received bytes holding no newline. |
| `MAX_EVENT_SIZE` | 33554432 (32 MiB) | One event's accumulated `data:`. |

The browser mirror, [`src/runtime/sse-in-node.js`](../src/runtime/sse-in-node.js), opens the same endpoint
through `EventSource`; its numbers, states and `seekMap()` precedence are in
the diagram. That precedence is what keeps a chart asking to replay from the
start of the log from being collapsed to a single live point by a stream the
slot pool refused before its first frame, and a glob's dirs tail-seek on the
first connect and resume from the positions they themselves reported
thereafter.

## Extensibility hooks

Every hook the substrate fires, and the ones a consumer plugin is expected to
answer. Every `newspack_nodes/*` name and signature is frozen surface — see
[stability.md](stability.md).

![Four rails, read left to right: a command request from rest_api_init through declare_config_keys, the capability_map and command_rate_limit filters, request_graph_ready and the per-verb capability check to the stderr action; the reconcile pass from the cron event through before_reconcile, the topologies filter, retention's registered_log_producers and periodic to after_reconcile in a finally; a spawn to spawn_worker; and a job from the two handler filters through before_job, the handler, after_job and batch_complete; with the settings, admin and topology-fired hooks beneath.](img/api-hooks-along-request.png)

### Actions

| Hook | Arguments | Fired from |
|---|---|---|
| `newspack_nodes/request_graph_ready` | `Command_Interpreter_Node $base_interpreter` | [`Bootstrap::mount_request_graph()`](../includes/class-bootstrap.php), on every command door. Mount your service CIs here — see below. |
| `newspack_nodes/spawn_worker` | `string $type, int $partition` | [`Spawn_Controller::spawn()`](../includes/rest/class-spawn-controller.php). Build the worker for `$type` and `->execute()` it. `Topology_Registry::spawn_worker` handles every active topology already. |
| `newspack_nodes/reconcile` | — | The WP-Cron event itself, on the registered 60-second `newspack_nodes_minute` schedule. `Bootstrap::reconcile_fleet()` is its handler. |
| `newspack_nodes/before_reconcile` | — | `Bootstrap::reconcile_fleet()`, before the pass. |
| `newspack_nodes/periodic` | — | `Bootstrap::reconcile_fleet()`. The minute-cadence tick for work that needs no worker; [`Alerts::emit()`](../includes/class-alerts.php) and [`Job_Delay::sweep_action()`](../includes/class-job-delay.php) ride it. The whole action is ONE `reconcile_step()` wrapper, so the isolation is from the other reconciliation steps, not between subscribers: a subscriber that throws takes every later subscriber's window with it. Contain your own failures — `Alerts::emit()` catches its journal-write failure and reports it through `Core::stderr()` rather than cost `Job_Delay::sweep_action()` its sweep. |
| `newspack_nodes/after_reconcile` | — | `Bootstrap::reconcile_fleet()`, after the pass. |
| `newspack_nodes/restart_fleet` | `string $name` | [`Topologies_CI_Node`](../includes/rest/class-topologies-ci-node.php), once per AFFECTED fleet on a topology save or delete — a saved child restarts every parent that composes it, transitively. [`Worker_CLI_Command::restart_fleet_by_name()`](../includes/cli/class-worker-cli-command.php) is registered on it at load and restarts every partition of the named fleet, so a substrate-side restart already happens; a name no active worker carries restarts nothing. |
| `newspack_nodes/declare_config_keys` | — | [`Config`](../includes/class-config.php), on the first key check of the process and again on any miss. Call `Config::register_keys()` here and nothing else — see below. |
| `newspack_nodes/config_reset` | — | `Config::reset()`. Drop anything memoized from config: the substrate drops log-dir scans, parsed TSL and vault credentials here. |
| `newspack_nodes/job_worker/after_job` | `string $handler, string $id, ?array $outcome` | [`Job_Worker_Node`](../includes/class-job-worker-node.php), always — after a success, a throw, or a decline. Tear down per-job request context here. |
| `newspack_nodes/job_worker/batch_complete` | `string $batch` | `Job_Worker_Node`, when a batch's last job settles. |
| `newspack_nodes/vault/changed` | `string $id, string $action, string $previous` | [`Vault_CI_Node`](../includes/rest/class-vault-ci-node.php), on any credential write. `$action` is `added`, `updated`, `renamed` or `removed`; `$previous` carries the id a rename moved away from, else `''`. |
| `newspack_nodes/stderr` | `string $text` | [`Core::_stderr()`](../includes/class-core.php), beside the stderr handler and under the same re-entry guard. A listener that throws cannot break the last-resort diagnostic path, and one that calls `stderr()` itself short-circuits to `error_log` rather than recursing. |
| `newspack_nodes/settings_after_form` | — | [`Admin`](../includes/admin/class-admin.php), below the settings form. |

[`Hook_Node`](../includes/class-hook-node.php) fires whatever name its required `hook_name` argument carries —
[`do_action( $hook_name, $value )`](https://developer.wordpress.org/reference/functions/do_action/) by default, [`apply_filters`](https://developer.wordpress.org/reference/functions/apply_filters/) in filter mode —
so a topology can add arbitrary names to this list at runtime. A listener is
handed the VALUE alone as a single argument, never the 7-field envelope, so it
can read and (in filter mode) rewrite the payload but cannot re-address the
message: TO, FROM, ID, STREAM and TIMESTAMP never reach it, and Hook mints
nothing, so FROM crosses untouched and still names the source that stamped it.
Registering with `accepted_args` above 1 gains nothing. Action mode leaves VALUE
and TYPE as they stand; filter mode adopts the return AND restamps TYPE from its
shape — a list array becomes TM_STRUCT and everything else, an associative array
included, becomes TM_BYTESTREAM, which a consumer gating on TM_STRUCT then
refuses.

[`Newspack_Log_Node`](../includes/class-newspack-log-node.php) fires `newspack_log` with `( string $code, string $text,
array $params )` — Newspack Manager's hook, not the substrate's own. Every entry
rides at `'type' => 'debug'` and `'log_level' => 2`, with `'data'` carrying the
message VALUE when it is an array and `[]` otherwise. The level is the contract,
not a detail: Manager ships an entry to WPCOM and logstash fire-and-forget at
log_level 2 or above, and `debug` is what keeps it out of the paging path.

### Filters

| Hook | Filtered value | Applied from |
|---|---|---|
| `newspack_nodes/topologies` | `array $topologies` — name => entry | [`Bootstrap::get_topology_catalog()`](../includes/class-bootstrap.php) and `Topologies_CI_Node`. [`Topology_Registry::publish_catalog`](../includes/class-topology-registry.php) populates it from every registered `.tsl` dir. It runs at the default priority 10 and skips any name already in the array, so a consumer pinning a topology's `num_partitions`, `stale_timeout` or `on_demand_idle` must hook BELOW 10 for its entry to stand; above 10 it receives the synthesized entry and replaces it. Never return `[]` transiently — see below. |
| `newspack_nodes/job_handlers` | `array $handlers` — name => callable | [`Job_Worker_Node::load_handlers_from_filters()`](../includes/class-job-worker-node.php). A name failing `HANDLER_NAME_PATTERN` or a non-callable value is skipped, never refused, so one bad registration cannot cost a worker every other handler. |
| `newspack_nodes/remote_job_handlers` | `array $handlers` | The same, for entries whose `k` selects the remote map. |
| `newspack_nodes/job_worker/before_job` | `bool $run, string $handler, string $id, array $message` | `Job_Worker_Node`. Return `false` to DECLINE the job. |
| `newspack_nodes/capability_map` | `array $map` — role => WP capability | [`Capabilities::cap_for()`](../includes/class-capabilities.php). The baseline is [`Roles::defaults()`](../includes/class-roles.php): all three roles map to `manage_options` until a site installs the granular capabilities, and then to `newspack_nodes_{read,tune,manage}`. Return all three roles — the union form `fn ( $map ) => [ 'read' => 'edit_posts' ] + $map`, never a bare `[ 'read' => … ]`; see below. |
| `newspack_nodes/command_rate_limit` | `int $burst` | [`HTTP_In_Node::check_rate_limit()`](../includes/rest/class-http-in-node.php). Clamped to a minimum of 1. |
| `newspack_nodes/registered_log_producers` | `array<int,string> $producers` — path templates | [`Log_Cleaner`](../includes/class-log-cleaner.php). Declare a log dir the retention sweep must know about. Non-string and empty entries are dropped and duplicates collapse, but a well-formed template resolving to no directory under `<config:logs_dir>` anywhere in the partition range is NOT dropped: `producer_log_dirs()` returns its fail-closed null and the whole sweep, `offsets/` included, is skipped. [`Core::resolve_partition_template`](../includes/class-core.php) expands each template over `Bootstrap::global_num_partitions()` — the global `num_partitions` clamped to `Spawn_Coordinator::MAX_PARTITIONS`, never the declaring topology's own count — so a producer writing past that range leaves undeclared dirs the sweep will take. A template carrying no `{partition}` or `<partition>` token collapses to one directory pinned across the fleet, which is how `alerts.p0` is declared. One log dir escapes this rule: `Log_Cleaner` reads `Settings_Event_Writer::SETTINGS_LOG_DIR` directly and seeds `settings.p0` at partition 0 into an already non-empty declared set, because the settings writer has no `.tsl` write-set entry and registers no template. Do not copy the settings writer as the model for a new PHP producer — one that declares nothing here is reaped. |
| `newspack_nodes/segment_size_overrides` | `array<string,int> $overrides` — basename => bytes | [`Workers_CI_Node`](../includes/rest/class-workers-ci-node.php). Declare the geometry of a Partition built in PHP rather than by a `make_node` line, which has no literal size to read. The union keeps the left side, so the filter fills gaps and never restates. |
| `newspack_nodes/settings_sync/value` | `mixed $value, string $option` | [`Settings_Sync_Node`](../includes/class-settings-sync-node.php). Resolve the value a hub pushes to its spokes — a requirement for any option that can be absent, not an optional refinement. `push()` reads `\get_option( $local )` with NO default and never goes through `Config::value()`, `register_setting()` defaults apply only inside `is_admin()` requests and a worker is never one, and [`Reset_Gate`](../includes/config-system/class-reset-gate.php) DELETES the row on reset-to-default. An unsaved or freshly-reset option therefore resolves to `false`, `Core::as_string()` makes that `''`, and the spoke's typed receiver refuses it with `invalid value for setting: …`. A hub syncing the substrate's own `remote_*` geometry needs a resolver mapping absent to the owning config's default; the filter runs on every push, the periodic sweep included. The substrate registers no handler of its own. |
| `newspack_nodes/settings_audit_values_allowlist` | `array $options` | [`Settings_Event_Writer`](../includes/class-settings-event-writer.php), over the [`Settings_Schema`](../includes/class-settings-schema.php) option names. Options whose old and new values may ride in a settings-audit record; everything else is logged by NAME only. The encrypted vault option is refused BEFORE the filter runs, so no filter can opt the credential store back in. |
| `newspack_nodes/station_tab_bundles` | `array $bundles` | [`Admin`](../includes/admin/class-admin.php). Register a station tab bundle: `handle`, `dir` and `url` are required, `localize` and `lazy` optional. A malformed entry is dropped whole, so one bad contribution cannot break the others. Leave `lazy` off: it skips the enqueue and puts the load recipe on the station handle, but the fetch is driven by placeholders `lazyTabs.js` registers for the four substrate handles it names, so a bundle contributed under any other handle would simply never load. |
| `newspack_nodes/overlay_pages` | `array $pages` | `Admin::overlay_pages()`. Admin page slugs the debug overlay should mount on; non-strings are filtered out. |

**A `capability_map` callback REPLACES the map.** `cap_for()` reads
`$map[ $role ]` and throws `InvalidArgumentException( "unknown capability role:
<role>" )` when the value is missing or empty — and when the filter returned
anything but an array. So a callback written the usual WordPress way, returning
only the key it means to change, breaks every `tune` and `manage` check. The
consequence differs by call path, and neither is a permission denial. Nothing
catches the throw on a REST permission callback (`HTTP_In_Node::check_permission`, `Auth_Controller`,
`Spawn_Controller`) or at admin-menu registration, where `Admin` passes
`Capabilities::cap_for( Capabilities::MANAGE )` straight into `add_menu_page()`,
so a partial map is a 500 and a dead wp-admin; inside a CI verb
`Command_Interpreter_Node::interpret()` catches it and returns it as
`TM_COMMAND|TM_ERROR`. `wp nodes caps status` resolves all three roles and throws
too.

**An empty `topologies` result retires the WHOLE fleet.** When
`Bootstrap::expand_workers()` comes back empty on a pass following one that saw
workers, [`Fleet_Node::refresh_active_set()`](../includes/class-fleet-node.php) calls `drain_all_workers()`, which
writes [`Lock_Node::RESTART_FLAG`](../includes/class-lock-node.php) into every `*.lock.d` under `locks/` — every
worker in the tree, not only the types that vanished — and each holder exits with
its self-respawn refused, because its type is no longer in the active set. Only a
worker's first scan is exempt, by the observed-not-assumed guard on the
previously-read set. Deactivating the last topology is the intended trigger; a
provider returning `[]` on an internal error, or a deploy that removes the `.tsl`
files under a live fleet (`Topology_Registry::resolve()` hits the disk on every
call), takes the same path.

### `newspack_nodes/request_graph_ready`

Fires from [`Bootstrap::mount_request_graph()`](../includes/class-bootstrap.php) once the request-scope graph has
been built or confirmed already-built. That builder is shared by every command
door, not just `/command`, so no door ends up with a different verb surface
behind it. At this point `Core`'s node map holds `_router` and
`_command_interpreter` (the base CI); `HTTP_In_Node` names itself `_output`
immediately after.

**Signature:**

```php
do_action( 'newspack_nodes/request_graph_ready', \Newspack_Nodes\Command_Interpreter_Node $base_interpreter );
```

**Canonical usage** — applications mount their service CIs through the base CI's
[`make_node()`](../includes/class-command-interpreter-node.php):

```php
function my_app_mount_service_cis( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
    $base_interpreter->make_node( 'My_Service_CI', 'my-service' );
    // ... more service CIs ...
}
\add_action( 'newspack_nodes/request_graph_ready', 'my_app_mount_service_cis' );
```

`make_node( string $type, string $name, ...$args ): ?Node` does four things and
returns the node:

1. Resolves and instantiates, via a no-arg `new $fqcn()`, the first `{$prefix}{$type}_Node` that exists and is a concrete `Node` subclass, looping the prefixes registered through `Command_Interpreter_Node::register_namespace()` at plugin load. So `make_node( 'My_Service_CI', … )` resolves `My_App\My_Service_CI_Node` once `My_App\` is registered. There is no per-class registry — a plugin registers its *namespace prefix* once ([ADR-10](architecture-decisions.md#adr-10-class-naming--make_node-namespace-resolution)). It returns null when no prefix yields a concrete class.
2. Calls `$node->name( $name )` so Router can find it.
3. Calls `$node->arguments( $arg_tokens )` — the scalar positional args, cast to strings and re-indexed, as a flat token array (`arguments()` takes and returns `list<string>`, never a space-joined string). They map onto the node's declared `node_schema()['arguments']` properties, so config round-trips through `dump_config()`, which re-joins the tokens via [`Node::serialize_args()`](../includes/class-node.php). A non-scalar argument is dropped with a rate-limited warning; assign object dependencies as public properties after `make_node` returns, as the substrate does for `Workers_CI`'s `CLI`.
4. Calls `$node->sink( $this )` so the node's reply routes back through the base CI to `_router` and out through `_output`.

Redeclaring a name with the SAME class and the same tokens returns the node
already registered, so re-mounting on every request is idempotent; a genuine
collision — same name, different class or different tokens — throws. A
constructor or `name()` that rejects is cleaned up, never left orphaned.

Skipping `make_node()` — constructing and `name()`-ing a node by hand — leaves
it unwired. Its verb responses walk back via TO=FROM
([ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)),
find no path to `_output`, and drop on the floor. Always go through
`make_node()`.

Because the hook fires on every command request, keep CIs stateless: pure verb
dispatchers with their dependencies injected. For the application-side build-out,
read the per-CI `node_schema()` declarations under
[`newspack-event-logger-nodes/includes/app/`](https://github.com/Automattic/newspack-event-logger-nodes/tree/v0.96.0/includes/app).

### `newspack_nodes/declare_config_keys`

[`Config::value()`](../includes/class-config.php) refuses a key nothing declared: it throws `unknown config key
'<key>' — not declared by any registered schema` rather than answer null. The
substrate derives the declared set on the first key check of the process —
registering its own [`Settings_Schema`](../includes/class-settings-schema.php) overlay keys, then firing this action so
every consumer plugin declares its own — and `Config::is_declared()` fires it
again on a miss, which is how a plugin that loads after that first read still
gets its keys accepted for the rest of the request.

**Signature:**

```php
do_action( 'newspack_nodes/declare_config_keys' );
```

No arguments. A callback calls `Config::register_keys( array $keys )` with
UNPREFIXED key names, and nothing else:

```php
function my_app_declare_config_keys(): void {
    \Newspack_Nodes\Config::register_keys( \My_App\Settings_Schema::get()->overlay_keys() );
}
\add_action( 'newspack_nodes/declare_config_keys', 'my_app_declare_config_keys' );
```

Registration is VALIDATION, not resolution. `Config::load_config()` builds its
map from `Settings_Schema` — the substrate's own schema — plus the two config
files plus the `newspack_nodes_`-prefixed option overlay, so a consumer's
registered key is never in that map and `\Newspack_Nodes\Config::value(
'my_key' )` answers null, silently and forever — the `?? default` failure this
whole action exists to prevent. A consumer owns its own `Config` whose `value()`
calls `Newspack_Nodes\Config::is_declared()` to validate the key and then reads its OWN
merged config — its schema defaults, its own option overlay, and the substrate
config layered underneath — as [`Newspack_Event_Logger_Nodes\Config::value()`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-config.php) and
its `load_config()` do. The one exception is a consumer key an operator writes
into `LOCAL_NEWSPACK_NODES_CONF`, which is deliberately free-form and does land
in the substrate's map.

Declare from CODE — a schema, or a literal defaults array — and never from a
config file's keys, which is the rule `Config::declare_keys()` follows for the
substrate's own. Deriving from the file makes an operator's typo self-declaring:
the misspelling becomes valid, the real key falls back to its default, and
nothing says so. It also leaves an install whose file predates a key unable to
read that key at all. A plugin whose schema names only its overlay keys
registers the union, as nuclear-gyrobase does with its code defaults and its WP
option schema.

Register the hook at PLUGIN FILE SCOPE, not from a deferred `plugins_loaded`
loader. The substrate PULLS the declaration from inside a read, and that read can
precede the loader: event-logger-nodes' profiler logs its first line at
[`plugins_loaded`](https://developer.wordpress.org/reference/hooks/plugins_loaded/)`:-10001`, well ahead of a loader at priority 11, and `value()`
would throw on a real key. A plugin whose slug sorts before `newspack-nodes`
loads while no substrate class exists, so it hooks the literal action name rather
than the `Config::DECLARE_ACTION` constant.

Do nothing else in the callback. It runs from inside a config read, on any
request and in any process, so a config read, an option write or I/O from here
fires at an unpredictable point in the request. A read of a still-undeclared key
from a callback is re-entrant — the declaring guard bounds it, but it cannot see
keys a later callback declares.

Declarations accumulate and are never pruned. `Config::reset()` drops the cached
config and re-arms the derive, and the declared set survives it, so a dropped
callback cannot un-declare keys that already resolve. The registry is flat and
shared: every plugin's keys land in the one set, and `Config::is_declared()` is
the primitive a consumer plugin's own `value()` accessor calls to validate a key
before reading its own merged config.
