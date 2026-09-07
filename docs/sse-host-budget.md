# The SSE Host Budget

Why `sse_max_streams` defaults to 6, `sse_max_slots` to 3,
`sse_reserved_slots` to 0 and `sse_slot_ttl` to 60 seconds.

An SSE stream is not a request that finishes. It holds one php-fpm child for
its entire life, so every open stream spends one of the site's workers. That
makes the slot pool a capacity reservation, and the numbers below are the
reservation's arithmetic.

Two routes stream — `GET /newspack-nodes/v1/messages/stream` and `GET
/newspack-nodes/v1/log/stream` — and they draw on one pool.
`Log_Stream_Out_Node` subclasses `SSE_Out_Node`, inheriting every wire concern
and differing only in what a subscription resolves to. The budget is per host,
not per route.

## What the platform does when you run out

Atomic replies **599** with an `a8c-internal-php-defensive-mode` header once a
site has too many PHP requests backlogged. The edge host that received that
response then turns on — or extends — **auto-defensive mode for 60 seconds**,
locally, for that site. Every visitor routed through that edge host gets the
challenge page, not just the traffic that caused the backlog.

Two consequences drive the defaults:

- **The blast radius is the whole site, not the offending connection.** There is
  no per-client shedding to hide behind. Saturating the workers degrades
  everyone, which is why the cap must bind before the platform's does.
- **Burst capacity cannot be spent on something sustained.** Bursting above the
  configured allocation is explicitly not guaranteed, and sites that lean on it
  are expected to be resized rather than to keep leaning. A stream that holds a
  child for minutes is the exact shape of load that must fit inside the
  allocation.

Source: [Clarification on Auto-Defensive
Mode](https://edgeopsp2.wordpress.com/2025/02/27/clarification-on-auto-defensive-mode/)
(edgeopsp2, 2025-02-27) — mechanism in Mark George's comment, the burst-capacity
expectation and the 60-second window in Barry's. That post records the mode
disabled for Newspack during tuning, and nothing in this repository can confirm
it still is, so treat it as a reprieve that can be withdrawn rather than as an
exemption.

## The arithmetic

The post's sizing goal is "always under 10 CPUs". Against a ~10-worker
allocation:

| Spent on | Children |
|---|---|
| SSE streams (`sse_max_streams`) | 6 |
| Node workers | 1 per running worker |
| Page requests, cron, loopback | the rest, about 3 with one worker running |

A worker holds a php-fpm child for its whole ~595-second life: the process
holding the spawn connection **is** the worker
([ADR-8](architecture-decisions.md#adr-8-worker-zombie-pattern)). One is
spawned per active topology partition, and an on-demand topology's worker exits
when idle, so the row moves with the fleet: four running workers have spent four
children before a single dashboard connects. Read the live count from `wp nodes
status` before raising a stream bound.

Six is the ceiling that still leaves the site serving pages while fully
subscribed. It is a **budget, not a target** — a deployment that reaches it
regularly wants a larger allocation or fewer dashboards, because the remaining
headroom is what absorbs a traffic spike.

A stream spends cache traffic as well as a child. `SSE_Slot_Pool::check()`
reads the pointer, then the liveness key, then the pointer again — the second
re-read is there because a rival can reclaim the slot between the first two —
and `SSE_Out_Node`'s drain predicate calls it on every tick. A tick with no
timer armed waits `Event_Framework::IDLE_TIMEOUT_US`, 100 ms, so every open
stream spends at least thirty cache reads a second policing its own lease
before any data moves: around 180 a second on a fully subscribed host at 6, and
around 1,900 at the schema's maximum of 64. Raising `sse_max_streams` buys
php-fpm children and cache round trips in proportion.

`sse_max_slots` (3) is one reader's share of that budget. It does not reserve
anything: slots are pooled host-wide, and the per-identity cap only stops a
single reader with many tabs from taking the site down alone. An identity is
`{user id}:{8-hex md5 of REMOTE_ADDR}`, so every tab one person opens draws on
the same share. Three, because an idle stream closes after `sse_idle_timeout`
(15 seconds) and reopens `sse_retry_ms` later (5 seconds), and a stream whose
process dies before the release leaves its lease standing for the whole TTL
while the client is already asking for another.

The share is approximate; the host cap is exact. Two connections from one
identity can both read the count before either claims, and a lease read that
fails counts as not-held, so either path lets one reader exceed its share. That
direction is deliberate: an exact count would need a second compare-and-swapped
counter, and a wrong value there leaks capacity permanently rather than for one
TTL. The host cap needs no counter, because a claim is a compare-and-swap on a
fixed number of pointers.

## The bounds and where to set them

| Key | Default | Bounds | What it sets |
|---|---|---|---|
| `sse_max_streams` | 6 | 1–64 | Concurrent streams on the host |
| `sse_max_slots` | 3 | 1–64, and never above `sse_max_streams` | Streams one identity holds at once |
| `sse_reserved_slots` | 0 | 0–63, and always leaving one slot claimable | Trailing slots browsers may not claim |
| `sse_slot_ttl` | 60 | 45–3600, raised to 45 rather than honoured below it | Lease lifetime in seconds |
| `sse_idle_timeout` | 15 | none declared | Seconds without data before a stream closes clean; 0 never closes |
| `sse_retry_ms` | 5000 | none declared | Milliseconds the client waits before reopening |

None of the six appears on Settings → Nodes Runtime, because `Settings_Schema`
declares each of them `ui: false`. Set one in `newspack-nodes-config.php`, in
the file `LOCAL_NEWSPACK_NODES_CONF` names, or as a `newspack_nodes_<key>`
option. The `settings set` verb refuses a value outside the declared bounds; a
value written straight into a config file or an option is taken as written, and
only the pool's own clamps in `max_streams()`, `max_slots()`,
`reserved_slots()` and `ttl()` bind it. That verb reaches only a Field
declaring a minimum, so it refuses `sse_idle_timeout` and `sse_retry_ms` as
unknown settings; a config file or an option is the only way to move either.

The four budget keys read through `SSE_Slot_Pool::budget()`, which falls back
to the default `Settings_Schema` declares
([ADR-20](architecture-decisions.md#adr-20-a-config-default-lives-in-code-every-config-file-is-an-override-surface))
rather than to zero. Read unguarded, an operator's blank entry would collapse
the host cap to 1. `SSE_Out_Node` reads the other two straight through
`Config::value()` with a zero fallback, so a blank `sse_idle_timeout` stops the
idle close outright and a blank `sse_retry_ms` sends a `retry` of 0 that the
client discards in favour of its own backoff.

`Bootstrap::register_rest_routes()` installs the pool's four seams on
`SSE_Out_Node` in the pass that registers the two routes, so a stream and its
meter arrive together. Nothing else installs them, and with them left null
`acquire` hands back an unmetered sentinel lease no cap binds.

## What the client sees on a refusal or a lost slot

`acquire()` runs before any header is sent, so a refusal still answers a JSON
`WP_Error` — `too_many_connections`, HTTP **429**. Once the event-stream headers
are out, 429 is no longer sayable.

Acquire, check and touch fail **closed**: with neither memcached nor APCu
answering, ownership is unverifiable and every stream is refused. `wp nodes
doctor`'s `cache-backend` check is where that reads as a cause rather than as a
slot shortage. Release fails open, because a lease expires on its own.

A refusal fails the browser's `EventSource` outright, and `SseInNode` reopens
under a backoff that doubles from 2 seconds (`INITIAL_BACKOFF_MS`) to a
30-second ceiling (`MAX_BACKOFF_MS`) and clears on the next `connected`
handshake, so a tab the pool keeps refusing settles at one claim attempt every
30 seconds.

A stream that loses its lease mid-flight — the TTL expired, or a rival claimed
the slot — gets a `disconnect` event and the drain loop returns.
`SSE_Slot_Pool::inspect()` then re-reads the pool and names which of its six
states caused it, into the diagnostic the endpoint writes: `backend_read_error`,
`pointer_missing`, `slot_released`, `pointer_owner_mismatch`,
`liveness_missing`, or `recovered_during_inspection`, the last meaning the lease
came back between the failed check and the inspection, so the next heartbeat may
simply succeed.

The verdict arrives with the backend that produced it, and on APCu or on any
read error `Cache_Backend::diagnostic_metadata()` merges in the facts that
explain it — `apcu_expunges` and `apcu_available_memory_bytes`, or
`memcached_result_code` and `memcached_result_message`. `SSE_Out_Node` copies
exactly those four onto the diagnostic, one allow-listed key at a time, so a
`liveness_missing` beside a climbing `apcu_expunges` is an APCu segment evicting
leases rather than a rival taking the slot. That pairing is what separates cache
pressure from contention.

## Machine pulls share the budget with browsers

A hub's `Remote_Source_Node` pulls a spoke's firehose over that spoke's
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
connects are what a spoke's pool answers with 429. Each connect therefore goes
through `Remote_Link_Node::queue_connect()` onto `Connect_Queue_Timer_Node`,
which pops one every `INTERVAL_MS` (500 ms) and retires when the queue runs
dry.

On a hub already up, the queue never runs dry and the timer never retires.
Every link's once-per-second housekeeping `fire()` re-queues its connect as soon
as the previous closure has run — `queue_connect()` clears its `connect_queued`
flag inside the closure, not on a successful connect — and the closure costs
nothing when the stream is healthy, because `SSE_In_Node::maybe_connect()`
returns at once on an open handle. A hub with N live links therefore holds
roughly N entries permanently and polls them round-robin: each link's reconnect
check comes round every N × 500 ms rather than every second. Sixty links leave a
dropped stream unattended for up to thirty seconds before the first reopen
attempt, on top of `SSE_In_Node`'s own backoff. `INTERVAL_MS` is a class
constant with no config key, so unlike `sse_max_streams` and
`sse_reserved_slots` the ramp cannot be tuned at runtime.

## Why the TTL is 60 and not shorter

The floor is **three** `Remote_Link_Node::HEARTBEAT_INTERVAL`s, 45 seconds, not
two. Only an owner-matched `workers heartbeat <slot> <owner>` refreshes a lease
— `check()` never does — and a client that loses its session stops heartbeating
for the whole re-auth round trip. A TTL sized for heartbeat loss alone fences a
stream that is merely re-authenticating, which costs the reader its slot at the
moment it is least able to reclaim one.

A machine pull's round trip has a floor of its own. `maybe_send_heartbeat()`
sends nothing while `Command_Auth::has_session()` is false, and
`maybe_request_session()` decides how long the link stays that way: it may ask
for a session only on its own second of the cadence,
`crc32( name ) % HEARTBEAT_INTERVAL`, at most once per interval, and not until
half an interval past the moment its lease first existed. That phase runs on the
absolute clock and comes from the link's name deliberately. The connect queue
spreads first boot alone, whereas a spoke restart or a key rotation drops every
link's session at once, leaving every link past its retry gate and asking
together, and losing a session resets nothing about a name-derived phase. A mass
re-auth can therefore leave one link silent for as long as fifteen seconds plus
its retry gate — part of why the floor is three heartbeat intervals rather than
two.

The refresh is the CLIENT's, and only the client's. The lease it pokes with
arrives in the `connected` envelope, which carries `SLOT` and `OWNER` beside the
stream's PID and cursors. A browser pokes the verb from its `_heartbeat` node
every 15 seconds (`POKE_INTERVAL_MS`), one poke per live lease; a machine pull
pokes it from `Remote_Link_Node` on the same cadence. That node is one per page,
not one per stream: each link registers its own lease against the shared
`_heartbeat` under its own identity and drops it on close, so a page holding
several streams spends several of its identity's slots and refreshes them all in
one tick. The server checks the
lease on every drain iteration and extends nothing, so a stream lives exactly
as long as its client keeps saying so, however long the connection stays open.
Fifteen seconds divides the TTL, so one lost poke still leaves a refresh before
expiry.

Shortening the TTL to reclaim crashed readers faster grows more tempting as the
pool shrinks. 45 is the wall, and `ttl()` enforces it: a configured
`sse_slot_ttl` below the floor is raised to it rather than honoured.

## Scope

The pool is keyed `machine:site`. Both halves are load-bearing and they fail in
opposite directions: on Atomic one pool host serves many sites, so a
machine-only key would put all of them on one budget; in dndocker one site spans
many containers over a shared database and memcached, so a site-only key would
collapse those instead. The machine half is `gethostname()`, never
`SERVER_NAME`, because a namespace the caller picks is no rate limit. The site
half is twelve hex characters over `DB_NAME`, the network table prefix and the
install's rotatable cache salt.

`wp nodes memcache flush` rotates that salt, so the site half moves under
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
