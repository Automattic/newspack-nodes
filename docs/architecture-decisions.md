# Architecture Decision Records

The load-bearing design decisions of the substrate. "Fixing" one usually reintroduces a bug
already paid for. Each record states the constraint that forced the choice, what was weighed
against it, what it costs, and a concrete condition that would reopen it. A **Revisit if** is
a sufficient tripwire, not the only door — any argument on the merits also reopens a decision.

Numbers are stable. `AGENTS.md` and code comments cross-reference these as "decision N".
Don't renumber — supersede.

| # | Decision |
|---|----------|
| [1](#adr-1-uniform-fill-contract) | Uniform `fill()` contract |
| [2](#adr-2-one-message-format-the-7-field-positional-array) | One message format: the 7-field positional array |
| [3](#adr-3-fire-and-forget-messaging) | Fire-and-forget messaging |
| [4](#adr-4-pipe_buf-atomic-writes) | PIPE_BUF atomic writes |
| [5](#adr-5-lazy-init-for-topic--partition) | Lazy init for Topic / Partition |
| [6](#adr-6-crc32--31-bit-mask-partition-routing) | CRC32 + 31-bit-mask partition routing |
| [7](#adr-7-sink-vs-target-and-tofrom-replies) | `sink` vs `target`, and TO=FROM replies |
| [8](#adr-8-worker-zombie-pattern) | Worker zombie pattern |
| [9](#adr-9-two-tier-safety-net) | Two-tier safety net |
| [10](#adr-10-class-naming--make_node-namespace-resolution) | Class naming + `make_node` namespace resolution |
| [11](#adr-11-make_node-construction-sequence) | `make_node` construction sequence |
| [12](#adr-12-dead-letter-poison--crash-lifecycle) | Dead-letter poison / crash lifecycle |
| [13](#adr-13-fill-returns-nothing) | `fill()` returns nothing |
| [14](#adr-14-cooperative-stop-propagates-through-broad-catches) | Cooperative-stop propagates through broad catches |
| [15](#adr-15-command-authorization-local-taint--the-minter-signs) | Command authorization: LOCAL taint + the minter signs |

---

## ADR-1: Uniform `fill()` contract

**Status:** Accepted

**Context:** A node graph is only composable if any node can hand a message to any other node
without knowing its type. Per-node methods (`write()` vs `process()`) make callers
special-case, and a node can no longer be swapped without touching them.

**Decision:** Every node has exactly one entry point: `fill( array $message )`. No parallel
`write()` / `read()` / `process()` API, no convenience wrappers.

The test is not what a method is *named*. It is whether anything outside the node can reach
the node's work without going through `fill()`. Splitting that work into halves and letting
the caller sequence them — a `parse()` that returns the parsed result, a `dispatch()` that
sends it — is the same parallel API with the pieces renamed, and it is worse than a single
`process()`: the caller now knows this node has two stages and in which order to run them.
Helper methods are fine as `fill()`'s own internals. Nothing outside the node calls them to
get a message in.

A node whose natural input is not a Message — a typed REPL line, a raw wire frame, a file
chunk — does not widen its signature to accept one. The producer wraps it, and `fill()`
unwraps: a line arrives as a `TM_BYTESTREAM` whose VALUE is the line. `Shell_Node::fill()`
is the worked example — it takes a Message like every other node and reads the statement out
of the VALUE.

By VALUE — **never `fill( array &$message )`**. The copy (PHP copy-on-write) is an ownership
boundary in both directions: a message handed to your `fill()` is yours (mutate freely; the
caller never sees it), and a message you've forwarded belongs to the downstream (hold no
reference, expect nothing preserved). By-ref breaks both at once: a Tee hands the same array
to N targets, so one target's edits would leak into the next's; and a caller reading the
request's FROM/ID *after* forwarding (the standard reply pattern) would find them clobbered.
Nodes compose because no node can reach back through a `fill()` call.

**Alternatives considered:** Per-node typed methods (`enqueue()`, `publish()`, `handle()`) —
rejected: they break uniform composition, and testing any node is "construct a message, call
`fill()`, inspect the sink."

Keep `fill()` but also expose its stages, so a caller that wants the parsed result can take
it — rejected, and worth naming because it arrives disguised as cleanup. It reads as removing
a wrapper; it is adding the parallel API this ADR exists to forbid, and it drags ADR-13 down
with it, since the stage a caller reaches for hands its result back as a return value.

**Consequences:** Every behavior is "a message arrived." Richer control surfaces are message
types / verbs through an interpreter, not new methods.

**Revisit if:** a node type genuinely cannot express its operation as a single message-in
(none has yet — the interpreter/verb pattern has absorbed every case so far).

---

## ADR-2: One message format: the 7-field positional array

**Status:** Accepted

**Context:** Messages are the hottest object in the system. Hash lookups (`$message['type']`)
are measurably slower than indexed access in the drain loop, and a message with different
shapes in PHP / JS / wire / memory needs a translation layer at every boundary.

**Decision:** One shape everywhere: `[TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5,
VALUE=6]`, always indexed via the `Message::*` constants. `packed()` / `unpacked()` are JSON
of the array — the wire shape IS the memory shape. There is **no** object form; if you see
one it is a bug to delete. Deliberate Tachikoma divergences: KEY not STREAM, VALUE not PAYLOAD, TIMESTAMP at index 1.
`TM_BYTESTREAM` (string VALUE) and `TM_STRUCT` (array VALUE) are mutually exclusive;
array-VALUE consumers gate on TM_STRUCT.

One field sits outside the seven: `LOCAL` at index 7, the in-process provenance taint a
Shell stamps on a command it mints. It is appended AFTER the canonical fields and both
ports slice it off in `packed()` / `pack()`, so it cannot cross a process boundary — which
is exactly what makes it usable as an authorization signal (ADR-15). Nothing else may be
appended on that basis.

**Alternatives considered:** Associative array / value object — rejected:
`$message['type']` silently coerces to index 0 and corrupts TYPE with no error, and an
object form reintroduces the per-boundary translation layer.

**Consequences:** Indexing without the constants is a silent-corruption footgun. The
positional shape is the divergence budget against Tachikoma — anything further must be
justified separately.

**Revisit if:** profiling shows associative arrays are no longer slower in the drain hot path
**and** a typed value object can eliminate the index-0 coercion footgun without a wire/memory
translation layer.

---

## ADR-3: Fire-and-forget messaging

**Status:** Accepted

**Context:** Tachikoma's TM_PERSIST + `answer()`/`cancel()` + `max_unanswered` flow control
earns its keep when producer and consumer are decoupled by a queue that can fill. This
substrate has no such queue: every boundary is synchronous, and the whole graph drains on one
CPU.

**Decision:** No producer/consumer ack handshake — no TM_PERSIST, no `answer()` /
`cancel()`. The one reply-control flag is `TM_NOREPLY`: a Shell with `want_reply(false)`
(topology load / script mode) ORs it onto commands and the interpreter suppresses the reply —
otherwise a worker's boot-topology replies route to `_output/<pid>` (absent in a worker) and
bounce a dropped `NOT_AVAILABLE` every startup.

**Alternatives considered:** Keeping the persist/ack contract — rejected: the synchronous
single-threaded drain already IS the backpressure (a slow node slows the drain slows the next
`poll()`), and there is no queue to overflow.

**Consequences:** No at-least-once guarantee at the message layer; durability comes from the
log/offsetlog tier. (TM_PERSIST is not a rival to that tier — in Tachikoma the ack IS the
tier's advance/discard signal, needed because consumption is asynchronous from delivery. Here
the reader owns its cursor entirely — Consumer's chop, Remote_Source's commit-on-arrival at
each message's start — so "safe to resume" is always local knowledge, in the same
synchronous drain that dispatched the message, and an ack has nothing to signal.)
A slow handler stalls its worker's drain — intended; that is the flow control. Future
slot-based flow control lives at the producer that needs it, never graph-wide.

**Revisit if:** a producer needs genuinely decoupled queueing, **or** the drain stops being
single-threaded, **or** offset advance is decoupled from delivery (async handlers, in-flight
windows) — each breaks the "delivered = safe to advance" coincidence the removal rests on.

---

## ADR-4: PIPE_BUF atomic writes

**Status:** Accepted

**Context:** Multiple producers append to the same partition log concurrently. POSIX
guarantees an append-mode `write()` ≤ `PIPE_BUF` (4096 bytes) on a local filesystem does not
interleave — which lets the firehose skip a lock on the common path.

**Decision:** Default write limit 4096 bytes, lock-free. >4 KB requires an explicit opt-in:

- **`allow_large_writes()`** — ENFORCED exclusivity: takes a `Lock` at
  `{partition_dir}/write.lock.d/`. Acquisition retries up to `max_wait_ms` (default 65s,
  deliberately longer than the lock's 60s stale window: a dead predecessor's lock goes stale
  mid-wait and is stolen; only a live second writer throws, at timeout — never immediately).
  An optional `debounce_ms` takes the lock per write burst and frees it after that much
  quiet instead of holding it for the partition's lifetime — still enforced, just yielded
  between bursts so intermittent large writers can take turns.
- **`void_warranty()`** — ASSERTED exclusivity: lifts the cap and skips the write/rotate
  locks on the caller's assertion that it is the sole writer. For partitions already inside a
  single-writer boundary (a worker's own offsetlog under its topology lock, a per-worker
  durable log). Two concurrent writers + `void_warranty()` = silent torn-write corruption.

Concurrent large writes without either opt-in silently corrupt.

**Alternatives considered:** Always locking — rejected: taxes the firehose for a rare case.
Only the enforced opt-in — rejected: a partition already inside a single-writer boundary
would pay a redundant second lock (plus heartbeat upkeep) to re-prove what the topology lock
guarantees.

**Consequences:** Callers must know their payload size. Forgetting the opt-in on a >4 KB
concurrent producer is a silent-corruption path — as is `void_warranty()` where single-writer
isn't actually true (when in doubt, take the enforcing form).

**Habitable zone:** everything under `base_directory` — locks, partitions, offsets, IPC —
is scoped to **one host's local POSIX filesystem, shared by that host's PHP processes**.
That is the design point, not a limitation to engineer around: the base dir is
topology-worker IPC, and workers are per-host by construction. Outside the zone the
guarantees simply don't hold — NFS/overlay mounts void the 4 KB append atomicity, and
containers with separate `/tmp` are separate hosts (each runs its own fleet against its
own base dir; pointing two containers' config at one *path* that is actually two
filesystems split-brains silently). There is no runtime detection of exotic mounts —
earlier drafts prescribed "detect-and-refuse," but no reliable portable signal exists on
the platforms we run on. State the habitat; deploy inside it.

**Revisit if:** a deployment genuinely needs cross-host coordination — that is a different
transport (the hub/spoke remote channels), not a shared filesystem.

---

## ADR-5: Lazy init for Topic / Partition

**Status:** Accepted

**Context:** Topic and Partition constructors run in **request scope** — no event loop.
Constructor-time loop or filesystem work leaks or fails silently: `set_timer` registers
against a framework that isn't running, `Core::node()` NPEs, `scandir` burns syscalls × N
partitions per request.

**Decision:** Constructors do no event-loop and no filesystem work. File handles open lazily
on first `fill()` / `read_at()`.

**Alternatives considered:** Eager init — rejected: the constructor's execution context
cannot support it and the failures are silent.

**Consequences:** Class-API code must be event-loop-free; loop-dependent state defers to
first message.

**Revisit if:** Topic/Partition construction moves into a worker / event-loop scope.

---

## ADR-6: CRC32 + 31-bit-mask partition routing

**Status:** Accepted

**Context:** The same key must always land on the same partition regardless of producer.
Same key → one partition → its single consumer: a key's messages are processed serially, by
one process, in append order. Sometimes the point is the order; often it's pure
non-concurrency — per-key mutexes, CAS loops, and read-modify-write guards never need to
exist. The hash IS the concurrency control. Divergent hash families silently split a key
across partitions and break all of it.

**Decision:** `Partition::hash_to_partition()` is canonical: strip the query string
(`explode('?')`), CRC32, then `& 0x7FFFFFFF` for 32-bit-PHP safety. Every routing site MUST
call it.

**Alternatives considered:** Per-producer hashing — rejected: divergent hashes misroute the
same key silently (no error, just wrong colocation).

**Consequences:** All routing converges on one function; a site needing different behavior
must be an explicit, named alternative, never a divergent re-implementation.

**Revisit if:** the partition count outgrows CRC32's distribution, or a genuinely different
key family is required — then a *new, named* routing function, not a quiet second hash.

---

## ADR-7: `sink` vs `target`, and TO=FROM replies

**Status:** Accepted

**Decision:** `sink` is the **physical** next node `fill()` forwards to. `target` is the
**logical** destination (Tachikoma's `owner`). The base `Node::fill` stamps it into
`message[TO]` only when TO is empty; the routing nodes go further — Tee (array target,
fan-out) sets TO per target, the target itself or `target/TO` prepended so the remainder
routes onward after the Router peels the head, and Echo completes the re-addressing matrix
(prepend when both set, bounce `TO=FROM` when both empty, fall through to the base stamp
otherwise). `_router` resolves a non-empty TO by peeling the head segment. Replies set
`TO=$message[FROM]` to walk the breadcrumb back.

`target` also governs the **inbound** direction at a wire boundary, which is Tachikoma's
`Socket.pm:852-862` clause ported into `HTTP_Out`/`HttpOut`'s reply leg. A `TM_RESPONSE`
self-routes by the TO the remote echoed off our own FROM breadcrumb. Anything else arriving
there is the remote addressing OUR graph, and `target` decides what that means: an
unaddressed non-response belongs to the target (this is how a server-side `log` broadcast —
minted with no TO by the stderr handler, packed verbatim into the reply body — reaches the
browser transcript instead of dying at `_router` as *message not addressed*), while an
addressed non-response arriving **while a target is set** is the remote choosing its own
destination inside us, and is refused. With no target neither arm engages, so a graph that
sets none is unaffected. `SSE_In` is deliberately exempt: a subscribed `_repl` stream is
*supposed* to deliver unaddressed output verbatim.

**Observed benefits:**

- **A TO path is a serializable address** — it rides inside the message across process and
  wire boundaries (IPC partitions, SSE, HTTP, the browser) where an object reference cannot.
  cd'ing into a worker and the `_output/<pid>` cross-process replies depend on it. The
  contrast with Tachikoma is instructive: its `pivot_client` physically re-sinks the Shell
  into a remote socket and removes the local interpreter; here nothing rewires — the graph
  stays put and only the address changes.
- **TO=FROM replies need no correlation table.** The breadcrumb is the return address.
- **A subject rides in the address, so one node answers about many rows.** A minter that
  serves N subjects appends the one it is asking about to its own FROM —
  `vault:test:in/spoke-01`. The server echoes `TO = FROM`, `_router` peels the receiver, and
  the reply arrives at `vault:test:in` carrying `spoke-01` as its remaining TO: the answer
  says which row it is about, with no id in the message and nothing correlating it. A screen
  serving many rows then FILES that answer under the subject it arrived naming; a per-row map
  is view state, not correlation, because the matching already happened in the address. What
  this ADR forbids is a table that decides WHICH ask a reply belongs to. This is what
  "ONE node doing N jobs — make it N nodes" does NOT mean: a table of ten servers is one node
  per verb, not fifty. Split by JOB (a verb, a poll, a stream), never by SUBJECT. A subject
  is one path segment, so it is escaped going out and read back on arrival
  (`useCommandOnce`'s `subjectOf`), and a first token too long to be an address — a document
  rather than an identity — is refused where the caller can fix it.
- **Late binding.** Targets resolve at fill-time: any construction order, cyclic graphs
  wireable. Eager reference-binding breaks reordered and cyclic graphs.
- **In practice, targets route everything — data included.** The discipline in both realms
  (PHP workers and the JS console) is: every node sinks into `_command_interpreter` →
  `_router`, and TARGET links carry the flow (request-builder's whole hot pipeline is target
  links). The router hop is paid on the hot path and is fine; sink-chains as a fast path
  exist but are not what the split is used for.
- **One chokepoint.** Everything passes the Router — one place for NOT_AVAILABLE and the
  routing counter.
- **Unaddressability is a security boundary — the one property only the physical plane can
  express.** The stdin reader and the `Shell_Node` (`wp nodes cli`, and the JS `Shell_Node`)
  are deliberately UNNAMED: absent from the registry, unreachable by any TO path. The Shell
  is the privilege point (it marks commands `LOCAL` and signs them); if a crafted
  TM_BYTESTREAM could route TO a Shell, unsigned bytes would become authorized commands.
  `Shell_Node::name()` throws on any argument so the rule cannot be violated by a later
  caller; the reader is simply never named. Unnamed + sink-wired-only means the only way in
  is the physical input path (stdin → Shell → interpreter). No name, no attack surface —
  security by construction, not by checks.

**The two-properties argument:** each plane expresses a property the other cannot.
All-logical routing loses structural unaddressability (every node must have an address to
receive anything). All-physical routing loses the serializable address (no cd into a remote
worker, no cross-process TO=FROM). Both properties are load-bearing in production, so the
split is not two ways to do one job; it is the minimal design that carries both.

**Alternatives considered:** A single combined "next" pointer — never attempted as a port;
rejected on the two-properties argument. A second physical `edge` output (as in some
Tachikoma graphs) — omitted until a concrete need appears.

**Consequences:** Two concepts to keep straight; FROM must be stamped correctly at sources
(see the FROM-stamping pitfall) or replies can't route back.

**Revisit if:** a node needs a true second *physical* output — then reintroduce `edge`
deliberately, rather than overloading `target` or `sink`.  Or if an alternative architecture
is compelling and proven to be more efficient.

---

## ADR-8: Worker zombie pattern

**Status:** Accepted

**Context:** The target platform (Atomic) caps a request at 15 minutes and offers no resident
process. A long-running worker is therefore an HTTP request that finishes its response
immediately and keeps executing, respawning a successor before its clock runs out.

**Decision:** Workers spawn via HTTP POST to an HMAC-validated `/spawn` endpoint and finish
the HTTP response up front (`fastcgi_finish_request()` + `ignore_user_abort(true)` +
`set_time_limit(0)` — the process keeps running inside FPM; nothing detaches from the process
group). Lifetime ~595s. Self-respawn fires in `finally`, with `release()` **before**
`self_respawn()` so the successor can acquire the lock immediately.

**Alternatives considered:** A resident daemon — unavailable on the platform. No self-respawn
(rescue-only restart) — rejected: every ~10-minute recycle would idle the slot until a peer's
stale-lock rescue; self-respawn hands off immediately and leaves the peer scan as the safety
net (ADR-9), not the scheduler.

**Consequences:** Correctness depends on flawless offsetlog resume across ~144 respawns/day
per worker and on the release-before-respawn ordering. The lifetime is a platform-shaped
constant, not a tuning knob.

**Revisit if:** the platform lifts the time cap or offers resident workers — the respawn
dance collapses into a normal long-lived loop.

---

## ADR-9: Two-tier safety net

**Status:** Accepted (revised — the middle tier is no longer a process)

**Context:** With no daemon, a dead worker must be revived by something already in the
system — and whatever revives it can itself die.

**Decision:** Two tiers. Workers self-respawn AND scan their peers: every worker mounts
`_fleet` (`Fleet_Node`), which every 15 seconds spawns any fleet worker whose lock dir is
missing or whose heartbeat exceeds its `stale_timeout`. **WP-Cron** catches a fleet with
nothing left running, at minute cadence, via `Bootstrap::reconcile_fleet()` — one pass that
spawns (`Spawn_Coordinator::spawn_due_workers()`) and then keeps house.

**Alternatives considered:** Self-respawn only — rejected: nothing catches a worker that dies
before it can respawn. An OS-level process supervisor (systemd, a platform worker tier) —
unavailable. A DEDICATED supervisor process as the middle tier — that is what this ADR
originally specified, and it was deleted: the supervisor was never a supervisor in the OS
sense. It could not signal a worker, reap it, or restart it in place — it polled lock-dir
mtimes and POSTed to an HTTP endpoint. Polling is work the pollees can do for each other, and
the throttle that makes three spawners safe makes N safe. What this ADR actually established
is that revival must not depend on a single process; peer scanning honors that more
completely than a dedicated tier did, and gives back a permanently-resident PHP-FPM child.

**Consequences:** N independent spawners (each worker's `finally`, each worker's `_fleet`
scan, cron), bounded against respawn storms by the 15s `is_recently_spawned` throttle. The
spawn ENDPOINT is where that throttle is enforced and recorded, because it is the one gate
they all cross; the record persists through `Cache_Backend::shared_first()`, falling back to
a transient. Supervision now survives the loss of any single process instead of dying with
one. The cost: with EVERY worker dead there is nothing left to scan, so a total fleet death
waits up to a cron minute — which is why the cold-start pass deserves its direct tests.
Housekeeping (lock-dir reconcile, retention sweeps, orphan-IPC reaping,
`newspack_nodes/periodic`) rides that same cron pass, one step each behind its own
`try`/`catch` so a third-party subscriber cannot cost the others their window. Spawn runs
FIRST: it is the only time-critical step. Housekeeping therefore depends on no live worker
at all — retention and orphan reaping run even when the fleet is down, which is when disk
most needs reclaiming — and its real cadence needs are minutes or slower (`Log_Cleaner`'s
delete grace alone is an hour). The delayed-jobs sweep moves with it, so `not_before`
granularity is a minute; firing late is what `not_before` means, and firing early would be
the bug.

**Revisit if:** an OS-level process supervisor becomes available — the tiered self-revival
collapses into it.

---

## ADR-10: Class naming + `make_node` namespace resolution

**Status:** Accepted

**Context:** Topologies and the REPL refer to node types by short name. Resolution needs a
rule that sibling and third-party plugins can extend without a central registry.

**Decision:** Every PHP class is `Word_Word` (acronyms `HTTP` / `SSE` / `CLI` / `LRU` / `CI`
stay all-caps). Node subclasses end `_Node`; non-node helpers don't (`Event_Framework`,
`Worker_Base`, `CLI`). The shell name is the short name minus `_Node` (`Tee_Node` → `Tee`).
No `register_class` / `class_map`: plugins call
`Command_Interpreter_Node::register_namespace( 'My_Prefix\\' )` once, and `make_node($type)`
constructs the first `{$prefix}{$type}_Node` that is a concrete Node subclass (abstract →
`null`, not fatal). The palette catalog (`Classes_CI` `list`) scans the composer classmap for
`*_Node` subclasses with a non-Hidden, non-empty `node_schema()` category — after adding or
renaming a class, run `composer dump-autoload -o`. Test infra stays PascalCase; the one
exception is the `Capture_Sink_Node` test double, a real `make_node`'d Node.

**Alternatives considered:** A central registry — rejected: prefix registration adds node
types with no central table to edit (and no merge conflicts on it).

**Consequences:** Naming is load-bearing — resolution depends on the `_Node` suffix and the
prefix. Renames require `composer dump-autoload -o` or the palette won't see them.

**Revisit if:** namespace prefixes collide (two prefixes resolving the same `$type`) — then a
tiebreak rule or an explicit registry after all.

---

## ADR-11: `make_node` construction sequence

**Status:** Accepted

**Context:** Config must round-trip: a live graph emits `make_node <type> <name> <args>`
lines (`dump_config()`) that reconstruct the same graph. That requires a fixed construction
order and a config representation that survives the trip.

**Decision:** The v0.6.0 Tachikoma sequence: no-arg ctor → `name()` → `arguments()` →
`sink()`. `make_node` instantiates `new $fqcn()`, then `name()`, then `arguments( $arg_tokens )`
— where `$arg_tokens` is the scalar positional args `array_map`ped to strings (`array_filter(
$ctor_args, '\is_scalar' )`, re-indexed) — then `sink( $this )`. `arguments()` takes and returns
a **flat token array** (`list<string>` argv), NOT a space-joined string:
`Node::arguments( ?array $args = null ): array`. Tokens are carried verbatim; the ONLY
place they re-join into a single line is the serialization anchor `Node::serialize_args( array
$tokens ): string` (used by `dump_config()`), which single-quotes any token bearing whitespace /
quote / backtick / backslash / emptiness and escapes `\` and `'` so the round-trip is lossless
for ANY token. The base `arguments()` stores the token array and does NOT parse. A node wanting
declared positional args assigned to props opts into `Schema_Reflection` and calls
`parse_schema_args( array $args )` from its `arguments()` override (JS mirrors: base stores;
consumers call `parseSchemaArgs( node, args )`). `parse_schema_args()` records the token array
into `$this->arguments` (so `dump_config()` round-trips) and is the single source of defaults: a
missing token takes the schema `default`, or throws if `required` — `make_node Partition foo`
with no dir throws `Missing required argument: partition_dir` instead of deriving
filesystem-root junk. Derived state (Partition's `partition_dir`) computes after
`parse_schema_args()` returns. Programmatic dependencies (e.g. `Workers_CI_Node::$cli`) are
public properties assigned AFTER `make_node`; object args are filtered (`is_scalar`) because
they can't round-trip.

Re-declaring a name is decided by the same tokens: identical class AND tokens return the
existing node (so replaying a dump, or including a topology twice, is idempotent), anything
else throws `make_node conflict`. And a node that throws while being named or configured is
removed rather than left half-built in the registry.

**Alternatives considered:** A parsing constructor with typed args — rejected: breaks the
round-trippable single-string config and diverges from the Tachikoma sequence. Object args
through `make_node` — filtered deliberately.

**Consequences:** Defaults and required-arg enforcement live in one place — no per-override
`if ( '' === $args ) return;` guards. A bare `make_node` of a node with a `required` arg
throws at construction — intended, fail loud. Nodes configured via post-`make_node` public
properties declare no required positionals and construct bare.

**Revisit if:** throw-on-required proves too strict for a legitimate deferred-config flow
that must build a bare node before configuring it.

**Amendment:** that flow arrived — a dashboard whose subscription is CHOSEN from a catalog
must build its `RemoteLink` before anything names one. A required positional is therefore
enforced at construction UNLESS the node refuses the same invariant at the point of USE.
Where both exist the point-of-use refusal is the contract and the positional is optional:
`RemoteLink` declares `subscribe` optional and `_assertConfigured()` throws on any verb that
would open a stream. A required token whose only effect is to make a deferred caller invent a
placeholder moves the failure from loud to silent — the placeholder has to name something,
and a live-looking name streams a log nobody asked for. The corollary is that a verb handed
the missing value CONFIGURES the node with it: `setSubscribe()` and `reconnect( subscribe )`
assign through `arguments`, so the getter reports what is streaming rather than whatever the
constructor was given — and past this class's own setter, so a subclass declaring a
DIFFERENT positional (`RemoteIpc`'s `reader`) does not have it overwritten with a
subscription. The cost is real and accepted: a graph dumped while a node is still
unconfigured emits a `make_node` line that REFUSES on replay. That is the deferred flow
being loud about its own window, and it is strictly better than the placeholder it
replaces, which replayed cleanly into the wrong log.

---

## ADR-12: Dead-letter poison / crash lifecycle

**Status:** Accepted. Shared by `Consumer_Node` and `Remote_Source_Node` via the
`Dead_Letter_Queue` and `Durable_Reader` traits. Roadmap item [42] (the "(dead-letter [42])"
CHANGELOG tags).

**Context:** A durable reader (Consumer tailing a Partition; Remote_Source relaying a remote
SSE stream) can hit a *poison* message that always fails downstream. Two failure shapes: a
**caught throw** (downstream `fill()` raised; the exact message is in hand and can be set
aside replayably) and an **uncatchable death** (OOM / fatal / SIGKILL — no catch point; the
next boot only sees the attempt count climb with no reason stamped). Silently dropping loses
data; never advancing wedges the stream.

**Decision:** Per-cursor attempt accounting in the offsetlog frame (`attempts`, `reason`,
`first_crash_ts`); a respawn resumes at `attempts+1`; a graceful shutdown stamps `attempts=0`,
so only a stuck cursor climbs. Cursor discipline is **the cursor names the next unread
position**, identically in both readers: `Durable_Reader`'s drain loop advances past each
record by the length in that record's own crumb — the line's own bytes for a tailing reader,
the spoke's stamped length for a pull source (`crumb_for_line`). A record DISPOSED of rather
than forwarded (dead-lettered or dropped) is resolved: the cursor advances past it and the
disposal commits there GRACEFULLY, so the next boot resumes past it and reads no lineage to
sacrifice a head for. There is no re-encounter to recognise, and so no quarantine marker.

- **Caught-throw poison: quarantined ON SIGHT, identically in both readers.** The throw is
  caught at the shared emit seam (`Durable_Reader::forward_line`, which Consumer inherits
  and Remote_Source overrides for its crumb-derived cursor), and the message is
  `dead_letter()`ed to the `:deadletter` sibling (replayable via `wp nodes ingest`), the
  cursor advances past it, and the disposal commits there — so it is never re-delivered and
  never re-quarantined. No retry, no head-block: a transient downstream failure is recovered
  by operator replay, not by automatic retry. Unparseable lines are quarantined the same way
  (raw bytes preserved); a torn frame carries no crumb of its own, so a pull source places it
  at the spoke's own next-read position — the one authority it has — and a length-less crumb
  moves the cursor by nothing rather than by a local length in the wrong byte space.
- **Cooperative stop (timeout / memory): the fair-shot path.** At shutdown,
  `cooperative_stop()` strikes the in-flight message only when the worker stopped ON the
  message it booted on (cursor never advanced, `Worker_Should_Stop` escaped its `fill()`); at
  `COOP_MAX_ATTEMPTS` strikes it is quarantined and the shutdown frame lands PAST the head,
  at the virgin baseline, so the successor boots straight onto the next record. A memory stop whose fresh baseline was already near the
  watermark is a leak (alert), not poison.
- **Uncatchable death: crawl.** Booting into an elevated attempt count with NO reason (and
  `>= CRASH_MAX_ATTEMPTS`) enters crawl: checkpoint after EVERY message so a re-crash pins the
  culprit, attempts pinned at the threshold. Surviving `CHECKPOINT_INTERVAL_S` crash-free
  exits to the healthy baseline. Below the threshold, the first successful forward clears the
  streak. Both readers also sacrifice the boot-pinned suspect on crawl entry — quarantined
  to the DLQ (reason `'crash'`), then committed past like any other disposal, which is what
  closes the sacrifice-to-checkpoint crash window: Consumer takes the first buffered line at
  the boot cursor; Remote_Source matches the relayed message's crumb start against the boot
  pin (a suspect the stream resumed past — GC'd — disarms without sacrificing). Crawl won't exit while the sacrifice is still armed, or an
  un-sacrificed poison re-arms the crash loop next boot. One accepted false positive: the
  entry-transition head (the crash may have been deeper in the checkpoint window; crawl's
  per-message frames pin the true culprit for the next boot).

The reusable core (`attempts` accounting, `record_poison_strike`,
`resume_attempts_from_frame`, `crawl_interval_elapsed` / `exit_crawl`, `dead_letter`, the
`CRASH_MAX_ATTEMPTS = 5` / `COOP_MAX_ATTEMPTS = 2` / `CHECKPOINT_INTERVAL_S = 30`
thresholds) lives in `Dead_Letter_Queue`; the cursor and its advance live in
`Durable_Reader`, so no reader can forget either. `Partition_Node` uses the same
trait for a third case with no cursor at all: a short write or a failed segment open
quarantines the messages that never landed. The crumb STAMPS `segment:offset:length`, and a
pull source reads all three: the start places the record, the length advances past it. A
two-part `segment:offset` crumb is still accepted, and moves the cursor by nothing.

**Worker shutdown checkpoints both readers** (`Worker_Base::checkpoint_durable_consumers()`),
and the graceful `attempts=0` stamp is half the crash detector, not just a progress save:
every boot climbs `attempts+1` unconditionally, so without the stamp a clean ~10-min recycle
is indistinguishable from a crash, and an idle cursor would cross `CRASH_MAX_ATTEMPTS` and
quarantine an innocent message. The handoff is deliberately SKIPPED on a fatal
(`is_fatal_shutdown()`) — leaving the count climbing is how a deterministic fatal-poison
reaches the crawl threshold. (It also saves the last <`CHECKPOINT_INTERVAL_S` of throttled
progress from re-delivery each recycle.)

**Alternatives considered:** Drop-on-first-failure — rejected (loses data, no audit trail).
Unbounded retry — rejected (wedges the stream). A single shared read loop — rejected: the
buffer/line and SSE-push models genuinely differ; only the accounting/decision logic is
shared. Automatic retry (fair-shot block-and-climb) for caught-throws — rejected: a caught
throw is deterministic per message and the quarantined original is replayable, so retries
only risk wedging the stream; and the transient failures retries would target are UPSTREAM
(a recycling spoke drops the SSE stream — the reconnect path's problem), which never makes a
downstream `fill()` throw.

**Consequences:** Poison can't wedge a stream and is never silently lost — every give-up
emits a rate-limited alert and (when configured) a replayable `:deadletter` entry. Cost:
per-cursor offsetlog bookkeeping and, in crawl, per-message checkpoint I/O, bounded by the
interval-survival exit. Poison handling is symmetric across both readers — caught-throw
quarantine-on-sight and crawl-entry head sacrifice alike; both self-heal from a
deterministic fatal-poison without operator intervention.

**Revisit if:** the shared trait surface starts carrying read-loop specifics (the wrong thing
was extracted), or a third durable reader appears whose model fits neither shape.

---

## ADR-13: `fill()` returns nothing

**Status:** Accepted

**Context:** ADR-1 makes the *forward* direction an ownership boundary — a message handed to a
sink belongs to the downstream; the caller holds no reference and expects nothing preserved.
The return direction is that same boundary seen from the other side. If a node could read
what its `fill()` call returned, it would couple to the downstream's *disposition* of the
message — delivered, dropped, queued, transformed — and swapping that downstream would change
the caller. That is exactly the callee-coupling the uniform contract exists to remove. A
`Tee` filling N targets has no single disposition to hand back anyway, and flow control is the
single-threaded drain (ADR-3), not a return code the caller inspects.

Perl Tachikoma's `fill` *did* return values (`return $self->SUPER::fill(...)`,
`return $self->cancel(...)`) — an artifact of Perl having no way to declare a `void` return,
so every sub yields its last expression whether or not anyone is meant to read it. Nothing
downstream was; the returns were internal bookkeeping that leaked into the signature.

**Decision:** `fill( array $message ): void`. A node emits into its sink and learns nothing
about what happens next: it does not care what other nodes do with its messages, and is not
permitted to care. No node's `fill()` produces a value; no caller reads, assigns, or branches
on a `fill()` return. PHP enforces this with the `: void` return type; JS keeps it by
convention — `fill()` bodies use a bare `return;` for early-exit only, never `return <expr>`.

This covers *any* value, not only a disposition read back from the sink. A result the node
computed itself before its sink was ever touched — a parse, a validation, a lookup — is still
a `fill()` return, and still couples the caller to this node's internals. It leaves as a
message: a `TO=FROM` reply, a `TM_ERROR`, or a send to a target.

**Alternatives considered:** Return a delivery status/ack from `fill()` — rejected: it
reintroduces callee-coupling, has no meaning at a fan-out node, and duplicates a reply channel
that already exists. A node that must know an outcome *receives it as a message* — a `TO=FROM`
reply (ADR-7) or a `TM_ERROR` (ADR-3) routed back through the graph, observable and loggable
like any other traffic — not a hidden return value.

**Consequences:** Outcomes are always messages, never return values; errors flow as
`TM_ERROR`, not an error code the caller reads. Testing a node stays "construct a message,
call `fill()`, inspect the *sink*" — never "inspect `fill()`'s return."

**Revisit if:** a node genuinely needs a synchronous in-process answer from its sink that
cannot be expressed as a routed reply — none has; the reply channel has absorbed every case.

---

## ADR-14: Cooperative-stop propagates through broad catches

**Status:** Accepted

**Context:** `Event_Framework::pump()` raises `Worker_Should_Stop` from inside a long in-process
job to unwind the worker's `fill()` stack and stop cooperatively (timeout / memory / shutdown).
It extends `\RuntimeException`, so any broad `catch (\Throwable|\Exception)` on the drain path
catches it — and if that catch treats it as an error (logs it, wraps it `TM_ERROR`, defers it),
the stop is swallowed: the worker runs past its deadline until the next drain tick re-checks
the predicate. That was a live bug — a mid-job stop was guaranteed only on the direct
`Log_Manager → Topic → Partition` firehose path; an intervening Tee / Command_Interpreter ate it.

**Decision:** A broad catch on the message/drain path re-throws `Worker_Should_Stop` before
handling anything else — it's cooperative-stop signalling, not an error. Catch it explicitly
first (`catch (Worker_Should_Stop $e) { throw $e; }`). Two deliberate carve-outs, documented
at each site:

- **Fan-out (Tee and Tap, via `Fanout_Targets`).** A target throwing says nothing about its
  siblings, so a fan-out attempts *every* target — one branch's failure can't silently starve
  the others (a skipped healthy target is a permanent loss once the poison path dead-letters
  the message and advances the cursor). Completing the fan-out is what preserves at-least-once;
  duplicates on replay are its accepted cost, and they arise with any fan-out regardless of
  when it throws. Tap additionally always performs its passthrough before re-throwing — the
  passthrough IS the pipeline, and a `Worker_Should_Stop_Clean` commits PAST the message, so
  aborting early would drop it from the main path entirely.

  The deferred slot holds whichever throwable is safest to act on, decided once in
  `Fanout_Targets::outranks()`: a plain `Worker_Should_Stop` (replay) outranks both a poison
  (dead-letter, cursor advances) and a `Worker_Should_Stop_Clean` (commit past), in either
  order. Advancing past a message that needed a replay loses it; replaying a clean one is a
  duplicate the contract already tolerates.

  *Superseded:* Tap previously swallowed ordinary target errors as non-fatal ("a broken tap
  can't break the pipeline") and re-threw `Worker_Should_Stop` immediately. The justification
  was categorical — taps are observability — and nothing enforces that category: a snapshot
  node raising `Worker_Should_Stop_Clean` from a tap participates in cursor semantics. The
  immediate re-throw also skipped the passthrough. Both are gone.

  *Superseded:* the deferred slot previously preferred `Worker_Should_Stop_Clean` in either
  order, added while chasing duplicate deliveries in request-builder. The revert signal is
  recorded in `tests/unit/TeeStopPrecedenceTest.php`.
- **Post-success `finally` (`Job_Worker::after_job`).** Swallows everything, WSS included: the
  handler already succeeded, so propagating anything from post-success cleanup would false-poison
  a completed job (the drain would quarantine an already-processed message — see ADR-12). Its
  `before_job` counterpart is NOT a carve-out — it follows the rule, re-throwing WSS first and
  swallowing only a listener's own error, which skips that one job instead of killing the batch.

**Alternatives considered:** A marker interface / `Control_Flow` exception base caught separately
— premature: the control-flow family today is `Worker_Should_Stop` plus its subclass
`Worker_Should_Stop_Clean`, so one explicit-first catch on the parent already covers both. A
third, unrelated one can share that pattern, or introduce the base then.

**Consequences:** Cooperative stop is guaranteed on every drain path, not just the direct
firehose write. Broad catches stay legal for real errors but must front the WSS re-throw.

**Revisit if:** a second control-flow exception appears (introduce a shared base and catch it),
or a carve-out's rationale stops holding.

---

## ADR-15: Command authorization: LOCAL taint + the minter signs

**Status:** Accepted

**Context:** A command is graph construction with full interpreter authority — `make_node`,
`connect_node`, the config verbs. The *same* `Command_Interpreter_Node` class runs in two
trust roles: in-process, where the browser console and the bare `wp nodes cli` mint their own
commands, and over the wire, where a worker reads them off an IPC partition and the
`/command` request-scope CI reads them out of an HTTP body. WordPress authentication answers
"who is this request?" at the REST boundary. It cannot answer "who minted this message?",
and the two come apart the moment a message crosses an IPC partition into a worker that has
no request context at all. In-process provenance is free — a Shell knows what it minted.
Across a process boundary nothing survives that a sender could not equally forge.

**Decision:** Two tiers, keyed to whether an interpreter can trust its own process. The gate
is a per-instance `authorize` closure (`$this->authorize ?? self::$default_authorize`),
checked for EVERY command in `interpret()`; a refusal returns `unauthorized: <verb>` instead
of dispatching.

- **Client tier** — `Message::LOCAL` (index 7), set by a `Shell_Node` on a command it mints
  in-process. The default policy is `isset( $message[ Message::LOCAL ] )`. Both ports slice
  `packed()` / `pack()` to `LAST_VALUE_INDEX + 1` and PHP's `unpacked()` rejects an 8-field
  line, so LOCAL cannot cross a boundary — which is precisely what makes its presence mean
  something.
- **Server tier** — verifier processes install `Command_Auth::verifier()`, which accepts a
  LOCAL command OR one carrying a valid HMAC envelope at `VALUE['auth']`. The envelope rides
  INSIDE VALUE so it survives IPC, unlike the stripped LOCAL.

**The minter signs; the ingress only verifies.** A client first establishes a session:
`POST /newspack-nodes/v1/auth` (fleet-site gate + `manage_options`) returns
`{ handle, key, expires_in, now }` — a random 16-byte handle and 32-byte key, stored under a
site-namespaced address with `add()`, never `set()`, for a fixed `SESSION_TTL_S = 3600`. The
response is the only place the key is ever disclosed; `now` lets the client align its
TIMESTAMP to the minter's clock. `add()` means a colliding handle fails instead of displacing
a live session, and the TTL is never slid on use, so a leaked handle expires on a bounded
schedule no matter how busy it is.

The canonical signing string is `JSON.stringify([ ts, name, arguments, nonce ])` — semantics
only. Never TO or FROM, which Router peels and nodes stamp in transit; never TYPE, which is
envelope too, and whose exclusion is what lets a mint sign at build time before flags are
OR'd in. PHP encodes it with `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE` to match
`JSON.stringify` byte-for-byte, and `tests/fixtures/signatures.json` pins that parity from
both languages.

Two keys exist, and **which key signs IS the destination binding**. `Command_Auth::sign()`
uses the per-site secret (`hash_hmac( 'sha256', 'nodes-command-v1', wp_salt('nonce') )`) and
stamps no handle — that is the attached cli's Shell, same host, over a filesystem-gated IPC
partition. `sign_for( $destination )` signs under the session established with one remote and
stamps its handle; a signature under one remote's key verifies only there, which pins a
command to its destination without signing TO. No session means no signature: a minter waits
rather than emitting something that will be refused.

Freshness is an age/skew check (`MAX_PAST_S = 20`, `MAX_FUTURE_S = 10`). Replay protection
claims the nonce with an atomic `add()` at `NONCE_TTL_S = 60`. The two claims deliberately
choose different cache tiers: nonces via `Cache_Backend::local_first()`, because a claim only
has to be unique to the process that verifies it and APCu is the faster host-local answer;
sessions via `shared_first()`, because a session minted in a web request MUST resolve in a
worker. Every failure — bad envelope, stale or skewed timestamp, signature mismatch, replayed
nonce, unavailable backend — refuses and logs through the *handling* interpreter's
`drop_message`. `HTTP_In` installs a fresh verifier per request and latches any refusal, so a
batch containing one answers **401** rather than a reassuring 202.

Stated non-goal: **HMAC-SHA256 at every tier; no asymmetric signing anywhere.**

**Alternatives considered:**

- **Sign at the ingress** — the original design, where `HTTP_In` conferred authority on
  arrival after WordPress auth. Rejected: it makes the boundary an ORACLE. Anything reaching
  it acquires authority regardless of what put it there, so a wire-arrived frame routed into
  the egress node would go back out signed. Moving the signature to the mint is what closes
  that; the ingress now signs nothing.
- **LOCAL alone, everywhere** — rejected: LOCAL cannot cross a process boundary, which is
  what makes it trustworthy in-process and useless for a worker that legitimately receives
  commands over IPC.
- **One shared site secret for every client** — rejected for browsers: anything shipped to
  wp-admin is readable by whoever is sitting there, so a shared secret there is not secret. A
  session key is a capability scoped to one session with a bounded lifetime. The per-site
  secret survives only where the signer is already inside the trust boundary (same-host IPC).
- **Signing TO / FROM / TYPE** — rejected: Router peels TO and nodes stamp FROM in transit,
  so a signature covering them would break in flight. This substrate is a variant of
  Tachikoma, whose `Command.pm::sign` covers `id:timestamp:name:arguments:payload` for the
  same reason.
- **Asymmetric signing (Ed25519)** — previously deferred "until cross-server command
  authority exists". That authority now exists (hub → spoke via `sign_for()`) and HMAC covers
  it, because both ends of a session are the same trust domain: the site that minted the key
  is the site that verifies it. Public-key signing buys non-repudiation and third-party
  verification; no consumer needs either, and it costs a key-distribution problem we do not
  otherwise have.
- **`crypto.subtle` in the browser** — rejected: it returns promises, and awaiting one makes
  the Shell's dispatch async, moving every graph mutation a microtask later. Synchronous
  `@noble/hashes` instead.
- **Filesystem permissions alone for IPC** — rejected as *sufficient*: they gate the
  directory, not the message. They remain the first gate; the signature is what makes a
  command believable however it reached the partition.

**Consequences:** `Message::LOCAL` at index 7 is the one field outside ADR-2's seven, and it
exists solely for this decision — nothing else may be appended on that basis, and nothing may
rely on it surviving a boundary. The envelope change was breaking and forced the 2.0.0 major.
A client must establish a session before it can mint at all, and a minter without one skips
instead of emitting. Cross-port canonical parity becomes a standing maintenance obligation:
each language's own suite stays green through a drift only the shared fixture catches. A
re-credentialed or removed Vault entry must forget its session
(`newspack_nodes/vault/changed`), or the next command signs under a key the far side has
already forgotten.

**Revisit if:** a party that cannot hold the signing key must verify a command — that is what
asymmetric signing buys, and it would earn its keep then — **or** a command must be
authorized between two sites that share no secret, **or** session state needs to outlive the
cache tier it lives in.

## ADR-16: JS node-class resolution — names are the TSL surface, classes are the API

**Status:** Accepted

**Context:** The browser runtime resolves `make_node <Type>` through
`CommandInterpreterNode.includeNodes`, a flat name→class table each bundle extends at import
time via `registerNodeClasses()`. That table is a **per-bundle static**: two bundles loaded on
the same page hold two copies. It works for TSL and the console palette, where the graph is
authored as text and the interpreter reading it is the one whose bundle registered the class.

It fails the moment a graph is built through *someone else's* interpreter. The devtools hub
mounts tabs from several bundles against one backbone, so a hook resolving `makeNode(
'ClassCatalogView' )` asks an interpreter whose bundle never registered that name and gets
`unknown class: ClassCatalogView` — at runtime, in the browser, with every test green,
because a test loads exactly one bundle. ADR-10 governs the PHP side and explicitly refuses a
class map; the JS side has always had one, and this is the consequence nobody wrote down.

**Decision:** A NAME is for the text path — TSL, the palette, `make_node` typed in the REPL.
A programmatic builder hands `makeNode` the **class itself**, imported from the `register.js`
that owns it, which therefore exports its classes rather than only registering them:

```js
export const views = { ClassCatalogView: ClassCatalogViewNode };
CommandInterpreterNode.registerNodeClasses( views );
```

`makeNode( type, name, args )` accepts either — `'function' === typeof type` selects the class
directly and skips resolution entirely. Registration is still required, for TSL and the
palette; it is no longer what a hook depends on. Enforced mechanically by
`scripts/lint-contract.mjs` rule `name-lookup-in-hook`, whose builtin allow-list is read from
`includeNodes`' own declaration — the runtime's own classes ship in every bundle, so resolving
one by name is always safe.

**Alternatives considered:**

- **A window-global registry**, as `src/shared/devtools/tabRegistry.js` uses for tabs.
  Rejected for classes: it makes every bundle's node classes globally visible and collides on
  name, which is exactly the ambiguity the per-bundle static avoids. The tab registry earns it
  because a hub tab is *meant* to be reachable across bundles; a view class is not.
- **Requiring every bundle to register every class.** Rejected: it couples each plugin's build
  to the union of all of them, and the failure is still silent until the missing one is asked
  for.
- **Resolving by name lazily against a chain of interpreters.** Rejected: it re-invents dynamic
  scope, and picks arbitrarily between two bundles that both registered the name.

**Consequences:** `register.js` files export a `views` map and hooks import it, so a dead view
class is now a normal unused-export finding instead of a name nobody notices is unreachable.
The name and the class are declared in one place. A hook that still passes a name fails the
contract gate rather than the browser.

**Revisit if:** the runtime gains a single cross-bundle class registry with collision handling
— then names become safe again everywhere and the rule retires with the decision.

---

## ADR-17: Timers fire on a shared wall-clock grid

**Status:** Accepted

**Context:** Every browser poll rides the `_router` TIMER, and `HTTP_Out` batches whatever was
minted during one tick into a single POST. That batching is the whole reason the graph has one
heartbeat — but a hitchhiking timer whose interval exceeds the 1s tick threw the benefit away.
It paced itself from its OWN last fire, so *when* a surface was opened decided which second it
polled in: a 5s catalog opened at :02 and another opened at :04 never shared a tick again, and
each paid its own POST forever. A page with four cadences paid four requests where one would
do, and no test could see it — every poll worked.

**Decision:** `TimerNode.fireCb()` fires on a boundary of a wall-clock GRID, not on elapsed
time since its own last fire:

```js
nextBoundary( after, intervalMs ) // ( floor( ( after - phase ) / interval ) + 1 ) * interval + phase
```

The grid is a pure function of the clock, so two timers on one cadence converge with nothing
shared, nothing persisted and no coordination — the same property that lets `LRU_Cache`'s
bucket rotation survive a process restart with its predecessor's phase intact.

**ONE phase serves every cadence** (`GRID_PHASE_MS`), never one per interval. That is what
keeps the harmonics: a 10s boundary is every second 5s boundary and a 30s boundary every sixth,
so 5s/10s/15s/30s polls all meet every 30 seconds and leave together. A per-interval phase —
the first implementation — slides each cadence a few hundred milliseconds off the others and
destroys exactly the alignment the grid exists for. The offset itself only keeps the grid off
:00, where every other periodic job on the box already is.

**The grid lives in `TimerNode` and nowhere else.** A subclass picks a harmonic interval and
nothing more; it never computes a boundary. `MetadataNode` used to keep a second throttle of
its own and is the cautionary case: its poll drifted off the grid, and the fix had to be
written twice before it became a `PollerNode` like the others.

**Alternatives considered:**

- **Per-interval phase.** Rejected on the harmonics, above.
- **A shared scheduler node every timer registers with.** Rejected: the Router already IS the
  one heartbeat, and a second coordinator is state where arithmetic suffices.
- **Snapping each timer to the first tick after arming.** Rejected — that is the behaviour this
  replaces; it is exactly what made the phase depend on when a surface opened.

**Consequences:** The first period after arming is the short remainder of the period the timer
opened in, so a poll can fire twice in quick succession at mount. That is the cost of
converging immediately, and it is paid once. Tests that assert "no second fire within N
seconds" become clock-dependent unless they pin the clock — pin it FORWARD to just past a
boundary, since moving it back reads to every watchdog as a stream gone silent.

**Revisit if:** the runtime gains sub-second cadences, where a 360ms phase is a large fraction
of a period and the grid would need its own scale.
