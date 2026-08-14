# The SSE Host Budget

Why `sse_max_streams` defaults to 6, `sse_max_slots` to 3, and `sse_slot_ttl` to 60.

An SSE stream is not a request that finishes. It occupies one php-fpm child for
its entire life, so every open stream is subtracted from the site's worker
allocation until the client goes away. That makes the slot pool a capacity
reservation, and the numbers below are the reservation's arithmetic.

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
| Node worker | 1 |
| Page requests, cron, loopback | ~3 |

Six is the ceiling that still leaves the site able to serve pages while fully
subscribed. It is a **budget, not a target** — a deployment that reaches it
regularly wants a larger allocation or fewer dashboards, because the remaining
headroom is what absorbs a traffic spike.

`sse_max_slots` (3) is one reader's share of that budget. It does not reserve
anything: slots are pooled host-wide, and the per-identity cap only stops a
single reader with many tabs from taking the site down alone. Three, because
idle streams close and reopen on an `sse_idle_timeout` + `sse_retry_ms` cycle
and a dead lease can linger for its TTL while the client is already asking for
another.

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

## Why the TTL is 60 and not shorter

The floor is **three** `Remote_Link_Node::HEARTBEAT_INTERVAL`s (45s), not two.
Only an owner-matched `workers heartbeat` refreshes a lease — `check()` never
does — and a client that loses its session stops heartbeating for the whole
re-auth round trip. A TTL sized for heartbeat loss alone fences a stream that is
merely re-authenticating, which costs the reader its slot at the moment it is
least able to reclaim one.

Shortening the TTL to reclaim crashed readers faster gets more tempting as the
pool gets smaller. 45 is the wall, and `ttl()` enforces it: a configured
`sse_slot_ttl` below the floor is raised to it rather than honoured.

## Scope

The pool is keyed `machine:site`. Both halves are load-bearing and they fail in
opposite directions: on Atomic one pool host serves many sites, so a
machine-only key would put all of them on one budget; in dndocker one site spans
many containers over a shared database and memcached, so a site-only key would
collapse those instead.
