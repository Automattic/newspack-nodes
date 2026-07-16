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

---

## ADR-1: Uniform `fill()` contract

**Status:** Accepted

**Context:** A node graph is only composable if any node can hand a message to any other node
without knowing its type. Per-node methods (`write()` vs `process()`) make callers
special-case, and a node can no longer be swapped without touching them.

**Decision:** Every node has exactly one entry point: `fill( array $message )`. No parallel
`write()` / `read()` / `process()` API, no convenience wrappers.

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
isn't actually true (when in doubt, take the enforcing form). Correctness assumes a **local**
POSIX filesystem.

**Revisit if:** `base_dir` can land on a non-local filesystem (NFS / overlay), where the 4 KB
append-atomicity guarantee does not hold — then detect-and-refuse rather than corrupt quietly.
(`mkdir`-as-lock stays NFS-safe; only the large append does not.)

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

**Observed benefits:**

- **A TO path is a serializable address** — it rides inside the message across process and
  wire boundaries (IPC partitions, SSE, HTTP, the browser) where an object reference cannot.
  cd'ing into a worker and the `_output/<pid>` cross-process replies depend on it. The
  contrast with Tachikoma is instructive: its `pivot_client` physically re-sinks the Shell
  into a remote socket and removes the local interpreter; here nothing rewires — the graph
  stays put and only the address changes.
- **TO=FROM replies need no correlation table.** The breadcrumb is the return address.
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
  express.** `Stdin_Node` and `Shell_Node` (`wp nodes cli`, and the JS `Shell_Node`) are
  deliberately UNNAMED: absent from the registry, unreachable by any TO path. The Shell is
  the privilege point (it marks commands `LOCAL` / signs them); if a crafted TM_BYTESTREAM
  could route TO a Shell, unsigned bytes would become authorized commands. Unnamed +
  sink-wired-only means the only way in is the physical input path (stdin → Shell →
  interpreter). No name, no attack surface — security by construction, not by checks.

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
(supervisor-only restart) — rejected: every ~10-minute recycle would idle the slot until the
supervisor's stale-lock rescue; self-respawn hands off immediately and leaves the supervisor
as the safety net (ADR-9), not the scheduler.

**Consequences:** Correctness depends on flawless offsetlog resume across ~144 respawns/day
per worker and on the release-before-respawn ordering. The lifetime is a platform-shaped
constant, not a tuning knob.

**Revisit if:** the platform lifts the time cap or offers resident workers — the respawn
dance collapses into a normal long-lived loop.

---

## ADR-9: Two-tier safety net

**Status:** Accepted

**Context:** With no daemon, a dead worker must be revived by something already in the
system — and whatever revives it can itself die.

**Decision:** Two tiers. Workers self-respawn; the **supervisor** catches stale-locked
workers (heartbeat > `stale_timeout`) and force-spawns. The supervisor self-respawns;
**WP-Cron** catches a dead supervisor at minute cadence.

**Alternatives considered:** Self-respawn only — rejected: nothing catches a worker that dies
before it can respawn. An OS-level process supervisor (systemd, a platform worker tier) —
unavailable; the substrate's own Supervisor is itself a capped request under the same 15-minute
rule, which is exactly why it needs a tier above it (WP-Cron).

**Consequences:** Three independent spawners (worker `finally`, supervisor tick, cron),
bounded against respawn storms by the 15s `is_recently_spawned` throttle (persisted via
memcache). Worst-case revival latency is cron cadence.

**Revisit if:** an OS-level process supervisor becomes available — the tiered self-revival
collapses into it.

---

## ADR-10: Class naming + `make_node` namespace resolution

**Status:** Accepted

**Context:** Topologies and the REPL refer to node types by short name. Resolution needs a
rule sibling and third-party plugins can extend without a central registry.

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
$ctor_args, '\is_scalar' )`, re-indexed) — then `sink( $this )`. As of the args-array migration,
`arguments()` takes and returns a **flat token array** (`list<string>` argv), NOT a space-joined
string: `Node::arguments( ?array $args = null ): array`. Tokens are carried verbatim; the ONLY
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

**Alternatives considered:** A parsing constructor with typed args — rejected: breaks the
round-trippable single-string config and diverges from the Tachikoma sequence. Object args
through `make_node` — filtered deliberately.

**Consequences:** Defaults and required-arg enforcement live in one place — no per-override
`if ( '' === $args ) return;` guards. A bare `make_node` of a node with a `required` arg
throws at construction — intended, fail loud. Nodes configured via post-`make_node` public
properties declare no required positionals and construct bare.

**Revisit if:** throw-on-required proves too strict for a legitimate deferred-config flow
that must build a bare node before configuring it.

---

## ADR-12: Dead-letter poison / crash lifecycle

**Status:** Accepted. Shared by `Consumer_Node` and `Remote_Source_Node` via the
`Dead_Letter_Queue` / `Offsetlog_Cursor` traits. Roadmap item [42] (the "(dead-letter [42])"
CHANGELOG tags).

**Context:** A durable reader (Consumer tailing a Partition; Remote_Source relaying a remote
SSE stream) can hit a *poison* message that always fails downstream. Two failure shapes: a
**caught throw** (downstream `fill()` raised; the exact message is in hand and can be set
aside replayably) and an **uncatchable death** (OOM / fatal / SIGKILL — no catch point; the
next boot only sees the attempt count climb with no reason stamped). Silently dropping loses
data; never advancing wedges the stream.

**Decision:** Per-cursor attempt accounting in the offsetlog frame (`attempts`, `reason`,
`first_crash_ts`); a respawn resumes at `attempts+1`; a graceful shutdown stamps `attempts=0`,
so only a stuck cursor climbs. Cursor discipline is **advance-on-next**: Consumer measures
its own buffered bytes (the chop); Remote_Source pins each message's crumb START on arrival,
pre-dispatch, and moves off it only when the next message arrives — no computed exclusive
end, no trust in a remote-stamped length. A message dead-lettered while the cursor still
sits on it gets a **`quarantined` marker** on the frame at its position ("fate sealed —
already in the DLQ; on re-encounter, drop"); the marker is written wherever a quarantine
does not advance past in the same act, is preserved by every frame committed at that
position (`sealed_quarantine`), and is NEVER written on a below-threshold strike or a
graceful handoff (misreading a strike as quarantined would silently drop a message that
still had fair shots left).

- **Caught-throw poison: quarantined ON SIGHT, identically in both readers.** The throw is
  caught at the emit seam (`Consumer::forward_line`, `Remote_Source::forward_line`),
  the message is `dead_letter()`ed to the `:deadletter` sibling (replayable via
  `wp nodes ingest`). Consumer's chop advances past it locally; Remote_Source stays pinned
  at its start with the marker, so an idle tail's re-pull on the next recycle drops silently
  instead of duplicating the DLQ entry. No retry, no head-block: a transient downstream
  failure is recovered by operator replay, not by automatic retry. Unparseable lines are
  quarantined the same way (raw bytes preserved; the re-encounter drop matches on stream
  position, since the condemned line has no parseable crumb). A quarantine is not forward
  progress — it never clears a live crash streak.
- **Cooperative stop (timeout / memory): the fair-shot path.** At shutdown,
  `cooperative_stop()` strikes the in-flight message only when the worker stopped ON the
  message it booted on (cursor never advanced, `Worker_Should_Stop` escaped its `fill()`); at
  `COOP_MAX_ATTEMPTS` strikes it is quarantined and the shutdown frame lands at the head's
  START — virgin baseline plus the marker — so the successor boots onto it, drops it, and
  advances off the next arrival. A memory stop whose fresh baseline was already near the
  watermark is a leak (alert), not poison.
- **Uncatchable death: crawl.** Booting into an elevated attempt count with NO reason (and
  `>= CRASH_MAX_ATTEMPTS`) enters crawl: checkpoint after EVERY message so a re-crash pins the
  culprit, attempts pinned at the threshold. Surviving `CHECKPOINT_INTERVAL_S` crash-free
  exits to the healthy baseline. Below the threshold, the first successful forward clears the
  streak. Both readers also sacrifice the boot-pinned suspect on crawl entry — quarantined
  to the DLQ (reason `'crash'`) with the marker sealing its position (a re-boot in the
  crash window drops instead of duplicating the entry): Consumer takes the first buffered
  line at the boot cursor and chops past it; Remote_Source matches the relayed message's
  crumb start against the boot pin and moves on with the next arrival (a suspect the stream
  resumed past — GC'd — disarms without sacrificing). Crawl won't exit while the sacrifice is still armed, or an
  un-sacrificed poison re-arms the crash loop next boot. One accepted false positive: the
  entry-transition head (the crash may have been deeper in the checkpoint window; crawl's
  per-message frames pin the true culprit for the next boot).

The reusable core (`attempts` accounting, `record_poison_strike`,
`resume_attempts_from_frame`, `crawl_interval_elapsed` / `exit_crawl`, `dead_letter`, the
`CRASH_MAX_ATTEMPTS` / `COOP_MAX_ATTEMPTS` / `CHECKPOINT_INTERVAL_S` thresholds) lives in
`Dead_Letter_Queue` (plus the `quarantined` seal and the boot skip's drop/DLQ disposition);
each reader keeps its own read-loop shape — Consumer's byte-measured chop, Remote_Source's
commit-on-arrival at crumb starts. The crumb still STAMPS `segment:offset:length` for wire
compatibility (SSE_In's eager reconnect reads it), but cursor management consumes only the
start; readers accept a two-part `segment:offset` crumb.

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
first (`catch (Worker_Should_Stop $e) { throw $e; }`). Three deliberate carve-outs, documented
at each site:

- **Tee (fan-out).** A target throwing says nothing about its siblings, so Tee attempts *every*
  target — one branch's failure can't silently starve the others (a skipped healthy target is
  a permanent loss once the poison path dead-letters the message and advances the cursor). The
  first throwable is deferred and re-thrown only after the full fan-out; a `Worker_Should_Stop`
  overrides the deferred slot so a co-occurring stop beats a poison-DLQ (the poison would
  advance the cursor, but a stop must re-play, not advance).
- **Tap (observability fan-out).** A regular target throw is non-fatal — swallow + log — so a
  broken tap can't break the pipeline; but `Worker_Should_Stop` re-throws.
- **Post-success `finally` (`Job_Worker::after_job`).** Swallows everything, WSS included: the
  handler already succeeded, so propagating anything from post-success cleanup would false-poison
  a completed job (the drain would quarantine an already-processed message — see ADR-12).

**Alternatives considered:** A marker interface / `Control_Flow` exception base caught separately
— premature: `Worker_Should_Stop` is the only control-flow exception today. A second one can
share the explicit-first-catch pattern, or introduce the base then.

**Consequences:** Cooperative stop is guaranteed on every drain path, not just the direct
firehose write. Broad catches stay legal for real errors but must front the WSS re-throw.

**Revisit if:** a second control-flow exception appears (introduce a shared base and catch it),
or a carve-out's rationale stops holding.
