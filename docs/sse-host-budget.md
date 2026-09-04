# The SSE Host Budget

Why `sse_max_streams` defaults to 6, `sse_max_slots` to 3,
`sse_reserved_slots` to 0 and `sse_slot_ttl` to 60 seconds.

An SSE stream is not a request that finishes. It occupies one php-fpm child for
its entire life, so every open stream is subtracted from the site's worker
allocation until the client goes away. That makes the slot pool a capacity
reservation, and the numbers below are the reservation's arithmetic.

`GET /newspack-nodes/v1/messages/stream` and `GET
/newspack-nodes/v1/log/stream` both stream, and they draw on one pool.
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
expectation and the 60-second window in Barry's. Auto-defensive mode was
disabled for Newspack while it was being tuned; treat that as a reprieve that
can be withdrawn, not as an exemption. The observed client-side cycle of
alternating refusal and burst windows is not described there.

## The arithmetic

Against a ~10-worker allocation, with "the goal is always under 10 CPUs":

| Reserved for | Children |
|---|---|
| SSE streams (`sse_max_streams`) | 6 |
| Node workers | one each |
| Page requests, cron, loopback | the remainder, ~3 with a single worker |

A worker is a php-fpm request that never returns: the process holding the spawn
connection **is** the worker, for its whole ~595-second life
([ADR-8](architecture-decisions.md#adr-8-worker-zombie-pattern)). One is
spawned per active topology partition, and an on-demand topology's worker exits
when idle, so the row moves with the fleet: four running workers have spent four
children before a single dashboard connects. Read the live count from `wp nodes
status` before raising a stream bound.

Six is the ceiling that still leaves the site able to serve pages while fully
subscribed. It is a **budget, not a target** — a deployment that reaches it
regularly wants a larger allocation or fewer dashboards, because the remaining
headroom is what absorbs a traffic spike.

`sse_max_slots` (3) is one reader's share of that budget. It does not reserve
anything: slots are pooled host-wide, and the per-identity cap only stops a
single reader with many tabs from taking the site down alone. An identity is
`{user id}:{8-hex md5 of REMOTE_ADDR}`, so every tab one person opens spends the
same share. Three, because an idle stream closes after `sse_idle_timeout`
(15 seconds) and reopens `sse_retry_ms` later (5 seconds), and its dead lease
can linger for the whole TTL while the client is already asking for another.

The share is approximate; the host cap is exact. A lease read that fails counts
as not-held, so two connections from one identity can both see a stale count and
overshoot their share. That direction is deliberate: an exact count would need a
second compare-and-swapped counter, and a wrong value there leaks capacity
permanently rather than for one TTL. The host cap needs no counter, because a
claim is a compare-and-swap on a fixed number of pointers.

## The bounds and where to set them

| Key | Default | Bounds | What it caps |
|---|---|---|---|
| `sse_max_streams` | 6 | 1–64 | Concurrent streams on the host |
| `sse_max_slots` | 3 | 1–64, and never above `sse_max_streams` | Streams one identity holds at once |
| `sse_reserved_slots` | 0 | 0–63, and always leaving one slot claimable | Trailing slots browsers may not claim |
| `sse_slot_ttl` | 60 | 45–3600, raised to 45 rather than honoured below it | Lease lifetime in seconds |

None of the four appears on Settings → Nodes Runtime, because `Settings_Schema`
declares each of them `ui: false`. Set one in `newspack-nodes-config.php`, in
the file `LOCAL_NEWSPACK_NODES_CONF` names, or as a `newspack_nodes_<key>`
option. The `settings set` verb refuses a value outside the declared bounds; a
value written straight into a config file or an option is taken as written, and
only the pool's own clamps in `max_streams()`, `max_slots()`,
`reserved_slots()` and `ttl()` bind it.

Each knob reads through `SSE_Slot_Pool::budget()`, which falls back to the
default `Settings_Schema` declares
([ADR-20](architecture-decisions.md#adr-20-a-config-default-lives-in-code-every-config-file-is-an-override-surface))
rather than to zero. Read unguarded, an operator's blank entry would collapse
the host cap to 1.

## What a refused stream sees

`acquire()` runs before any header is sent, so a refusal still answers a JSON
`WP_Error` — `too_many_connections`, HTTP **429**. Once the event-stream headers
are out, 429 is no longer sayable.

Acquire, check and touch fail **closed**: with neither memcached nor APCu
answering, ownership is unverifiable and every stream is refused. Release fails
open, because a lease expires on its own.

A stream that loses its lease mid-flight — the TTL expired, or a rival claimed
the slot — gets a `disconnect` event and the drain loop returns.
`SSE_Slot_Pool::inspect()` then names which of its six states caused it, into
the diagnostic the endpoint writes.

## Machine pulls share the budget with browsers

A hub's `Remote_Source_Node` pulls a spoke's firehose over that spoke's
`/messages/stream`, so an aggregation pull draws from the same host budget a
browser tab does. It has no reservation and no priority: enough dashboard tabs
open on a spoke will refuse the hub's pull, and the hub's view of that spoke
goes stale until a slot frees.

`sse_reserved_slots` (default 0) holds slots back from browsers so a pull always
finds one. A spoke sets 1. The reservation comes **out of** `sse_max_streams`,
not on top of it: with 6 streams and 1 reserved, browsers claim 5 and the sixth
waits for the pull. Nobody's ceiling moves — the setting only decides who may
reach the last slot. A pull is otherwise bounded exactly like a browser, same
per-identity share and same TTL.

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

## Why the TTL is 60 and not shorter

The floor is **three** `Remote_Link_Node::HEARTBEAT_INTERVAL`s, 45 seconds, not
two. Only an owner-matched `workers heartbeat <slot> <owner>` refreshes a lease
— `check()` never does — and a client that loses its session stops heartbeating
for the whole re-auth round trip. A TTL sized for heartbeat loss alone fences a
stream that is merely re-authenticating, which costs the reader its slot at the
moment it is least able to reclaim one.

The refresh is the CLIENT's, and only the client's. A browser pokes the verb
from its `_heartbeat` node every 15 seconds (`POKE_INTERVAL_MS`), one poke per
live lease; a machine pull pokes it from `Remote_Link_Node` on the same cadence.
The server checks the lease on every drain iteration and extends nothing, so a
stream lives exactly as long as its client keeps saying so, however long the
connection stays open. Fifteen seconds divides the TTL, so one lost poke still
leaves a refresh before expiry.

Shortening the TTL to reclaim crashed readers faster gets more tempting as the
pool gets smaller. 45 is the wall, and `ttl()` enforces it: a configured
`sse_slot_ttl` below the floor is raised to it rather than honoured.

## Scope

The pool is keyed `machine:site`. Both halves are load-bearing and they fail in
opposite directions: on Atomic one pool host serves many sites, so a
machine-only key would put all of them on one budget; in dndocker one site spans
many containers over a shared database and memcached, so a site-only key would
collapse those instead.

Each slot is two cache keys under that scope: `sse:{slot}`, a permanent integer
pointer holding a positive owner or the release tombstone 0, and
`sse:{slot}:lease:{owner}`, the expiring liveness key whose value is the
holder's identity. The pointer count **is** the host cap. Read either from the
CLI, which rebuilds the machine scope behind `--host`:

```bash
wp nodes memcache get --host sse:0
wp nodes memcache get --host sse:0:lease:<owner>
```
