# The SSE Host Budget

Why `sse_max_streams` defaults to 6, `sse_max_slots` to 3,
`sse_reserved_slots` to 0 and `sse_slot_ttl` to 60 seconds.

An SSE stream is not a request that finishes. It holds one php-fpm child for
its entire life, so every open stream spends one of the site's workers. That
makes the slot pool a capacity reservation, and the numbers below are the
reservation's arithmetic.

Two routes stream — `GET /newspack-nodes/v1/messages/stream` and `GET
/newspack-nodes/v1/log/stream` — and they draw on one pool.
[`Log_Stream_Out_Node`](../includes/rest/class-log-stream-out-node.php) subclasses [`SSE_Out_Node`](../includes/rest/class-sse-out-node.php), inheriting every wire concern
and differing only in what a subscription resolves to. The budget is per host,
not per route.

## What the platform does when you run out

Every Atomic site has a PHP worker allocation, ten by default. Past it, the
host holds each further PHP request in a queue for a worker, and a request no
worker frees for in time is refused with a **429**. A request the queue does
serve arrives slow; one it refuses arrives as an error page. So for as long as
the workers stay busy, readers get pages and refusals by turns, request by
request, and the stream that holds the worker sees neither.

The platform may also put the site into defensive mode on its own: the edge
location that saw the refusals answers every visitor through it with a
browser challenge for a minute at a time, extended while the overload lasts.
Newspack sites carry an opt-out from that mode, made during its tuning in
February 2025, and nothing in this repository can confirm the opt-out still
stands, so treat it as a reprieve that can be withdrawn rather than as an
exemption.

Two consequences drive the defaults:

- **The blast radius is the site's readers, not the offending connection.** A
  stream holds its worker to the end, and the request that pays is the next
  reader's. There is no per-client shedding to hide behind, which is why the
  cap must bind before the platform's does.
- **Burst capacity cannot be spent on something sustained.** Bursting above the
  configured allocation is explicitly not guaranteed, and sites that lean on it
  are expected to be resized rather than to keep leaning. A stream that holds a
  child for minutes is the exact shape of load that must fit inside the
  allocation.

Sources: [Clarification on Auto-Defensive
Mode](https://edgeopsp2.wordpress.com/2025/02/27/clarification-on-auto-defensive-mode/)
(edgeopsp2, 2025-02-27), the defensive-mode trigger in Mark George's comment,
the burst-capacity expectation and the Newspack opt-out in Barry's; [429 & 599
Errors](https://dotcomuniversity.wordpress.com/wow/site-performance/429-599-errors/)
(dotcomuniversity) for the ten-worker default and the 429 a visitor sees past
it.

## The arithmetic

![Three rows of ten php-fpm children. With one node worker running, six streams and the worker leave about three children for pages, cron and the loopback; with four workers running, six streams and four workers leave none, so the next reader queues, and is refused with 429 when no child frees in time; with one slot reserved, browsers claim five and the sixth waits for the hub's pull. A bar chart below gives cache reads per second by open streams, 30 at one, 180 at the default six, 1,920 at the schema maximum of 64, from ten 100 ms ticks a second times the three reads in check(). A side card explains the per-identity share of three, and a note says six is a budget, not a target.](img/sse-host-arithmetic.png)

The post's sizing goal is "always under 10 CPUs", and a stream spends more
than a child. A worker holds a php-fpm child for its whole ~595-second life,
because the process holding the spawn connection **is** the worker
([ADR-8](architecture-decisions.md#adr-8-worker-zombie-pattern)); one is
spawned per active topology partition, and an on-demand topology's worker
exits when idle, giving its child back. A stream holds cache traffic too: [`SSE_Slot_Pool::check()`](../includes/class-sse-slot-pool.php)
runs in `SSE_Out_Node`'s drain predicate on every tick, and a tick with no
timer armed waits [`Event_Framework::IDLE_TIMEOUT_US`](../includes/class-event-framework.php).
Read the live worker count from [`wp nodes status`](cli.md) before raising a
stream bound.

## The bounds and where to set them

| Key | Default | Bounds | What it sets |
|---|---|---|---|
| `sse_max_streams` | 6 | 1–64 | Concurrent streams on the host |
| `sse_max_slots` | 3 | 1–64, and never above `sse_max_streams` | Streams one identity holds at once |
| `sse_reserved_slots` | 0 | 0–63, and always leaving one slot claimable | Trailing slots browsers may not claim |
| `sse_slot_ttl` | 60 | 45–3600, raised to 45 rather than honoured below it | Lease lifetime in seconds |
| `sse_idle_timeout` | 15 | none declared | Seconds without data before a stream closes clean; 0 never closes |
| `sse_retry_ms` | 5000 | none declared | Milliseconds the client waits before reopening |

None of the six appears on Settings → Nodes Runtime, because [`Settings_Schema`](../includes/class-settings-schema.php)
declares each of them `ui: false`. Set one in [`newspack-nodes-config.php`](../newspack-nodes-config.php), in
the file `LOCAL_NEWSPACK_NODES_CONF` names, or as a `newspack_nodes_<key>`
option. The `settings set` verb refuses a value outside the declared bounds; a
value written straight into a config file or an option is taken as written, and
only the pool's own clamps in `max_streams()`, `max_slots()`,
`reserved_slots()` and `ttl()` bind it. That verb reaches only a Field
declaring a minimum, so it refuses `sse_idle_timeout` and `sse_retry_ms` as
unknown settings; a config file or an option is the only way to move either.

The four budget keys read through [`SSE_Slot_Pool::budget()`](../includes/class-sse-slot-pool.php), which falls back
to the default `Settings_Schema` declares
([ADR-20](architecture-decisions.md#adr-20-a-config-default-lives-in-code-every-config-file-is-an-override-surface))
rather than to zero. Read unguarded, an operator's blank entry would collapse
the host cap to 1. `SSE_Out_Node` reads the other two straight through
[`Config::value()`](../includes/class-config.php) with a zero fallback, so a blank `sse_idle_timeout` stops the
idle close outright and a blank `sse_retry_ms` sends a `retry` of 0 that the
client discards in favour of its own backoff.

[`Bootstrap::register_rest_routes()`](../includes/class-bootstrap.php) installs the pool's four seams on
`SSE_Out_Node` in the pass that registers the two routes, so a stream and its
meter arrive together. Nothing else installs them, and with them left null
`acquire` hands back an unmetered sentinel lease no cap binds.

## What the client sees on a refusal or a lost slot

`acquire()` runs before any header is sent, so a refusal still answers a JSON
`WP_Error` — `too_many_connections`, HTTP **429**. Once the event-stream headers
are out, 429 is no longer sayable.

Acquire, check and touch fail **closed**: with neither memcached nor APCu
answering, ownership is unverifiable and every stream is refused. [`wp nodes
doctor`](cli.md#doctor-health-report)'s `cache-backend` check is where that reads as a cause rather than as a
slot shortage. Release fails open, because a lease expires on its own.

A refusal fails the browser's `EventSource` outright, and [`SseInNode`](../src/runtime/sse-in-node.js) reopens
under a backoff that doubles from 2 seconds (`INITIAL_BACKOFF_MS`) to a
30-second ceiling (`MAX_BACKOFF_MS`) and clears on the next `connected`
handshake, so a tab the pool keeps refusing settles at one claim attempt every
30 seconds.

A stream that loses its lease mid-flight — the TTL expired, or a rival claimed
the slot — gets a `disconnect` event and the drain loop returns.
[`SSE_Slot_Pool::inspect()`](../includes/class-sse-slot-pool.php) then re-reads the pool and names which of its six
states caused it, into the diagnostic the endpoint writes: `backend_read_error`,
`pointer_missing`, `slot_released`, `pointer_owner_mismatch`,
`liveness_missing`, or `recovered_during_inspection`, the last meaning the lease
came back between the failed check and the inspection, so the next heartbeat may
simply succeed.

The verdict arrives with the backend that produced it, and on APCu or on any
read error [`Cache_Backend::diagnostic_metadata()`](../includes/class-cache-backend.php) merges in the facts that
explain it — `apcu_expunges` and `apcu_available_memory_bytes`, or
`memcached_result_code` and `memcached_result_message`. `SSE_Out_Node` copies
exactly those four onto the diagnostic, one allow-listed key at a time, so a
`liveness_missing` beside a climbing `apcu_expunges` is an APCu segment evicting
leases rather than a rival taking the slot. That pairing is what separates cache
pressure from contention.

## Machine pulls share the budget with browsers

A hub's [`Remote_Source_Node`](../includes/class-remote-source-node.php) pulls a spoke's firehose over that spoke's
`/messages/stream`, so an aggregation pull draws from the same host budget a
browser tab does. Nothing gives it priority: enough dashboard tabs open on a
spoke will refuse the hub's pull, and the hub's view of that spoke goes stale
until a slot frees.

`sse_reserved_slots` holds slots back from browsers so a pull always finds one.
It ships at 0, and a spoke sets 1. The reservation comes **out of**
`sse_max_streams`, not on top of it: with 6 streams and 1 reserved, browsers
claim 5 and the sixth waits for the pull. Nobody's ceiling moves — the setting
only decides who may reach the last slot. A pull is otherwise bounded exactly
like a browser, same per-identity share and same TTL.

The pull announces itself with an `X-Newspack-Nodes-Pull` request header. That
is a fairness hint, not a security boundary: the endpoint already requires the
READ capability, so any holder of it could send the header, and forging it costs
a reserved slot rather than granting access. Reserving every slot would lock out
the readers the host exists for, so `reserved_slots()` always leaves at least
one.

An aggregator brings up every `Remote_Source` in one tick, and N simultaneous
connects are what a spoke's pool answers with 429, so each connect goes through
[`Remote_Link_Node::queue_connect()`](../includes/class-remote-link-node.php)
onto [`Connect_Queue_Timer_Node`](../includes/class-connect-queue-timer-node.php),
which pops one every `INTERVAL_MS` (500 ms) and retires when the queue runs
dry.

On a hub already up the queue never runs dry. Each link's once-per-second
housekeeping re-queues its connect as soon as the previous closure has run —
`queue_connect()` clears its `connect_queued` flag inside the closure, not on a
successful connect — and the closure costs nothing while the stream is healthy,
because [`SSE_In_Node::maybe_connect()`](../includes/class-sse-in-node.php)
returns at once on an open handle. N live links therefore hold about N entries
and are polled round-robin, so each link's reconnect check comes round every
N × 500 ms: sixty links leave a dropped stream unattended for up to thirty
seconds before the first reopen, on top of `SSE_In_Node`'s own backoff.
`INTERVAL_MS` is a class constant with no config key, so unlike
`sse_max_streams` and `sse_reserved_slots` the ramp cannot be tuned at runtime.

## Why the TTL is 60 and not shorter

![A timeline of one machine pull's lease over sixty seconds, in three rows. Pokes land at 0 and 15 seconds; the poke at 30 seconds is refused with 401, which is when the link drops its session, and pokes resume at 60. The session row shows a spoke restart or key rotation at 16 seconds dropping every link's session on the spoke at once, the link learning of it only from that 401, and the three gates its ask must pass: its own second of the cadence, at most once per interval, and never inside the first 7 seconds of its lease. The lease row shows the 60-second lease from the last poke outliving the gap, a 45-second TTL expiring exactly at the poke that saves it, and a 30-second TTL fencing the stream at 45 seconds, mid re-auth. Two cards below say whose poke refreshes a lease and why the ask is phased by name.](img/sse-ttl-floor.png)

Shortening the TTL to reclaim crashed readers faster grows more tempting as the
pool shrinks, and 45 seconds is the wall. The floor is **three**
[`Remote_Link_Node::HEARTBEAT_INTERVAL`](../includes/class-remote-link-node.php)s,
45 seconds, not two, and [`SSE_Slot_Pool::ttl()`](../includes/class-sse-slot-pool.php) enforces it: a configured
`sse_slot_ttl` below the floor is raised to it rather than honoured.
`maybe_send_heartbeat()` sends nothing while
[`Command_Auth::has_session()`](../includes/class-command-auth.php) is false,
and that reads the hub's own session map, which `HTTP_Out` empties when a poke
comes back 401; `maybe_request_session()` then gates the ask as the diagram
shows. The refresh
is the client's alone: a browser pokes from its
[`_heartbeat` node](../src/runtime/heartbeat-node.js), a machine pull from
`Remote_Link_Node`, and the server checks the lease on every drain iteration
and extends nothing.

## Scope

The pool is keyed `machine:site`. Both halves are load-bearing and they fail in
opposite directions: on Atomic one pool host serves many sites, so a
machine-only key would put all of them on one budget; in dndocker one site spans
many containers over a shared database and memcached, so a site-only key would
collapse those instead. The machine half is [`gethostname()`](https://www.php.net/manual/en/function.gethostname.php), never
`SERVER_NAME`, because a namespace the caller picks is no rate limit. The site
half is twelve hex characters over `DB_NAME`, the network table prefix and the
install's rotatable cache salt.

[`wp nodes memcache flush`](cli.md) rotates that salt, so the site half moves under
running streams. `site()` and `salt()` both memoize per process and a stream
holds its process for its whole life: a stream open at the rotation goes on
checking and releasing the old scope's pointers while every new connection
claims a fresh set, putting up to twice `sse_max_streams` on the host. It settles within one
TTL — the client heartbeat lands in a new process on the new scope, finds no
pointer to refresh, and the orphaned lease expires on its own.

Each slot is two cache keys under that scope: `sse:{slot}`, a permanent integer
pointer holding a positive owner or the release tombstone 0, and
`sse:{slot}:lease:{owner}`, the expiring liveness key whose value is the
holder's identity. The pointer count **is** the host cap. Every substrate key
is addressed `newspack_nodes:{version}:{scope}:{logical}`, which is what lets
the CLI rebuild the machine scope from a logical name behind `--host`. `--key`
prints the resolved address without reading it:

```bash
wp nodes memcache get --host sse:0
wp nodes memcache get --host sse:0:lease:<owner>
wp nodes memcache get --host --key sse:0
```
