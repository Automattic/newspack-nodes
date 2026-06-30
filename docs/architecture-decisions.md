# Architecture Decision Records

These are the load-bearing design decisions of the substrate. Each is **Accepted** and
deliberate — a tutorial that "fixes" one of these usually reintroduces a bug we already
paid for. But "Accepted" is not "unquestionable": every record states the constraint that
forced the choice, what was weighed against it, what it costs, and the concrete condition
that would reopen it. If you can satisfy a **Revisit if**, the decision is back on the table.

Numbers are stable. `AGENTS.md` and code comments cross-reference these as "decision N";
ADR-N is that N. Don't renumber — supersede.

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
| [12](#adr-12-dead-letter-poison--crash-lifecycle) | Dead-letter poison / crash lifecycle ([42]) |

---

## ADR-1: Uniform `fill()` contract

**Status:** Accepted

**Context:** A node graph is only composable if any node can hand a message to any other
node without knowing its type. The moment one node exposes `write()` and another exposes
`process()`, callers have to special-case which method to call, and a node can no longer be
swapped for another without touching its callers.

**Decision:** Every node has exactly one entry point: `fill( array &$message )`. There is no
parallel `write()` / `read()` / `process()` API and no convenience wrappers. Callers build
the Message inline and call `fill()` directly.

**Alternatives considered:** Per-node typed methods (`enqueue()`, `publish()`, `handle()`) —
rejected because they break uniform composition and make testing per-node instead of
per-message. The whole value of the model is that testing any node is "construct a message,
call `fill()`, inspect what came out the sink."

**Consequences:** Every behavior a node offers must be expressed as "a message arrived." Nodes
that want richer control surfaces expose them as message *types* / verbs through an
interpreter, not as new methods.

**Revisit if:** a node type genuinely cannot express its operation as a single message-in
(none has yet — the interpreter/verb pattern has absorbed every case so far).

---

## ADR-2: One message format: the 7-field positional array

**Status:** Accepted

**Context:** Messages are the hottest object in the system — minted, stamped, and forwarded
on every `fill()`. Hash lookups (`$message['type']`) are measurably slower than indexed
access in the drain loop, and a message that has different shapes in PHP, in JS, on the wire,
and in memory needs a translation layer at every boundary.

**Decision:** One shape everywhere: the 7-field positional array
`[TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5, VALUE=6]`. Always index via the
`Message::*` constants. `packed()` / `unpacked()` are just JSON of the array — the wire shape
*is* the memory shape. There is **no** `{ type, ts, from, to, id, key, value }` object form;
if you see one it is a bug to delete (it crept into the topology-console GUI once and broke
the canvas). The fields diverge from Tachikoma on purpose: KEY not STREAM, VALUE not PAYLOAD,
TIMESTAMP at index 1. `TM_BYTESTREAM` (string VALUE) and `TM_STRUCT` (array VALUE) are
mutually exclusive; array-VALUE consumers gate on TM_STRUCT.

**Alternatives considered:** An associative array / value object with named keys — far more
readable, and the obvious instinct. Rejected twice over: `$message['type']` silently coerces
the string key to int `0` and corrupts TYPE with no error, and the object form already shipped
once and broke the canvas. The readability win doesn't survive the footgun or the per-boundary
translation cost.

**Consequences:** Indexing without the constants is a silent-corruption footgun (see the
"Messages are arrays, not hashes" pitfall). New code must reach for `Message::TYPE` etc.
reflexively. The positional shape is the divergence budget against Tachikoma — anything
*further* from Tachikoma's message model must be justified separately.

**Revisit if:** profiling shows associative arrays are no longer slower in the drain hot path
**and** a typed value object can eliminate the index-0 coercion footgun without reintroducing
a wire/memory translation layer.

---

## ADR-3: Fire-and-forget messaging

**Status:** Accepted

**Context:** Tachikoma's throughput story rests on TM_PERSIST + `answer()` / `cancel()` +
`max_unanswered` slot-based flow control — machinery that only earns its keep when producer
and consumer are decoupled by a real queue that can fill up and exert backpressure. This
substrate has no such queue: every boundary is synchronous I/O, and the entire graph drains
on one CPU.

**Decision:** No producer/consumer ack handshake. TM_PERSIST / `answer()` / `cancel()` were
removed. The one reply-control flag kept from Tachikoma is `TM_NOREPLY`: a Shell with
`want_reply(false)` (topology load / script mode) ORs it onto commands, and the interpreter
then suppresses the reply (logging only an error to stderr). Without it a worker's
boot-topology command replies route to `_output/<pid>` — which has no node in a worker — and
bounce a dropped `NOT_AVAILABLE` on every startup.

**Alternatives considered:** Keeping Tachikoma's persist/ack contract — rejected because the
**synchronous single-threaded drain already _is_ the backpressure**: a slow node slows the
whole drain, which slows the Consumer's next `poll()`, which is the brake. There is no
unbounded queue to overflow because there is no queue. A global persist contract would add
ceremony with nothing to protect.

**Consequences:** No at-least-once delivery guarantee at the message layer; durability comes
from the log/offsetlog tier, not from acks. A slow handler stalls its whole worker's drain
(intended — it is the flow-control mechanism). Any future slot-based flow control must live
at the specific producer that needs it, not as a graph-wide persist contract.

**Revisit if:** a producer needs genuinely decoupled queueing (a real buffer between produce
and consume), **or** the drain stops being single-threaded — either breaks the "the drain is
the backpressure" guarantee and reopens the case for explicit flow control.

---

## ADR-4: PIPE_BUF atomic writes

**Status:** Accepted

**Context:** Multiple producers append to the same partition log concurrently. POSIX
guarantees that an append-mode `write()` of up to `PIPE_BUF` (4096 bytes) onto a local
filesystem does not interleave with another writer's. That guarantee is what lets the
firehose skip a lock on the common path.

**Decision:** Partition's default write limit is 4096 bytes and relies on the POSIX
small-append atomicity guarantee — no lock on the hot path. Producers needing >4 KB MUST opt
into `Partition::allow_large_writes()`, which auto-locks via `Lock` at
`{partition_dir}/write.lock.d/`. Concurrent large writes *without* the lock silently corrupt.

**Alternatives considered:** Always locking every write — rejected because it taxes the common
small-message path (the firehose) for the benefit of a rare large-payload case. Pushing the
size decision onto the producer keeps the fast path lock-free.

**Consequences:** Callers must know their payload size and opt into large writes explicitly;
forgetting the opt-in on a >4 KB concurrent producer is a silent-corruption path. The whole
correctness story assumes a **local** POSIX filesystem.

**Revisit if:** `base_dir` can land on a non-local filesystem (NFS / overlay), where the
4 KB append-atomicity guarantee does not hold and concurrent appends tear across the wire —
then the partition/lock layer should detect-and-refuse a non-local fs rather than corrupt
quietly. (`mkdir`-as-lock stays NFS-safe; only the large *append* does not.)

---

## ADR-5: Lazy init for Topic / Partition

**Status:** Accepted

**Context:** Topic and Partition constructors run in **request scope**, where there is no
event loop. Anything that assumes the loop or touches the filesystem at construction time
either leaks or fails: `set_timer` registers against a framework that isn't running (silent
leak), `Core::node()` lookups NPE, and `scandir` burns syscalls × N partitions on every
request.

**Decision:** Constructors do no event-loop and no filesystem work. No `set_timer`, no
`Core::node()` lookup, no `scandir`. File handles open lazily on the first `fill()` /
`read_at()`.

**Alternatives considered:** Eager initialization in the constructor (open handles, register
timers up front) — the conventional shape, rejected because the constructor's execution
context (request scope, no loop) cannot support it and the failures are silent.

**Consequences:** Class-API code is constrained to be event-loop-free (see the
"Class-API must be event-loop-free" pitfall). State that depends on the loop must be deferred
to first message.

**Revisit if:** Topic/Partition construction moves into a worker / event-loop scope where the
framework and a long-lived process actually exist at construction time.

---

## ADR-6: CRC32 + 31-bit-mask partition routing

**Status:** Accepted

**Context:** The same logical key must always land on the same partition, no matter which
producer routed it. If two producers hash the same key with different functions, that key
silently splits across partitions and ordering/colocation guarantees break.

**Decision:** `Partition::hash_to_partition()` is canonical: strip the query string with
`explode('?')`, CRC32 hash, then `& 0x7FFFFFFF` for 32-bit-PHP safety. Topic, JobIntake-keyed
mode, and every other partition-routing site MUST call this same function.

**Alternatives considered:** Letting each producer pick its own hash — rejected because
divergent hash families silently misroute the same key across producers, the worst kind of
bug (no error, just wrong colocation).

**Consequences:** All routing converges on one function; a new routing site that needs
different behavior must be an explicit, named alternative, never a divergent re-implementation
of the same intent.

**Revisit if:** the partition count outgrows what CRC32 distributes evenly, or a genuinely
different key family is required — in which case it becomes a *new, explicitly named* routing
function, not a quiet second hashing of the existing key.

---

## ADR-7: `sink` vs `target`, and TO=FROM replies

**Status:** Accepted

**Context:** A node needs two distinct notions of "where this goes": the concrete next node to
hand the message to, and a logical address that the router resolves by name. Conflating them
makes the graph un-rewireable and pins routing to compile-time wiring.

**Decision:** `sink` is the **physical** next node `fill()` forwards to. `target` is the
**logical** destination — a path string stamped into `message[TO]` *only when TO is empty*
(Tachikoma's `owner`; Tee's `target` is an array for fan-out). `_router` resolves a non-empty
TO by peeling the head segment and looking it up in `Core`. Replies (response / ack / error)
set `TO=$message[FROM]` to walk the FROM breadcrumb back. Pivoting to a remote/other worker is
just a `TO` prefix (the Shell's `path`) — not hardwiring. **There is no `edge`** — the second
physical output some node graphs carry is intentionally absent.

**Alternatives considered:** A single combined "next" pointer — rejected because it can't
express "forward physically to A but address logically to B," which is what makes the graph
rewireable at runtime and what makes the cli pivot a TO prefix instead of a rewire. A second
physical `edge` output (as in some Tachikoma graphs) — omitted until a concrete need appears.

**Consequences:** Two concepts to keep straight; the FROM breadcrumb must be stamped
correctly at sources (see the FROM-stamping pitfall) or replies can't route back.

**Revisit if:** a node needs a true second *physical* output — then reintroduce `edge`
deliberately, rather than overloading `target` or `sink`.

---

## ADR-8: Worker zombie pattern

**Status:** Accepted

**Context:** The target platform (Atomic) caps a request at 15 minutes and offers no resident
process / daemon. A long-running worker therefore has to be a detached request that outlives
its HTTP caller and respawns a successor before its own clock runs out.

**Decision:** Workers spawn via HTTP POST to an HMAC-validated `/spawn` endpoint, then detach
with `ignore_user_abort(true)` + `fastcgi_finish_request()` + `set_time_limit(0)`. Lifetime is
~595s (sized for the 15-min cap with margin). Self-respawn fires inside `finally`, and
`release()` runs **before** `self_respawn()` so the new worker can acquire the lock
immediately.

**Alternatives considered:** A resident daemon / system service — unavailable on the platform.
Respawn *after* release reordered the other way — rejected because releasing after the spawn
leaves a 15-second slot gap (see the "Worker lock release before spawn" pitfall).

**Consequences:** Correctness depends on flawless offsetlog resume across thousands of
respawns/day, and on the release-before-respawn ordering. The lifetime is a platform-shaped
constant, not a tuning knob.

**Revisit if:** the platform lifts the per-request time cap, or offers genuinely resident
worker processes — then the detach-and-respawn dance can collapse into a normal long-lived
loop.

---

## ADR-9: Two-tier safety net

**Status:** Accepted

**Context:** With no daemon and no external supervisor, a worker that dies has to be revived by
something already in the system. A single layer isn't enough — whatever revives the worker can
itself die.

**Decision:** Two tiers. Workers self-respawn; the **supervisor** catches stale-locked workers
(heartbeat > `stale_timeout`) and force-spawns. The supervisor self-respawns; **WP-Cron**
catches a dead supervisor at minute cadence.

**Alternatives considered:** A single self-respawn layer — rejected because nothing catches a
worker that dies *before* it can respawn (uncatchable fatal). An external process supervisor —
unavailable on the platform.

**Consequences:** Three independent spawners (worker `finally`, supervisor tick, cron) — bounded
against respawn storms by the per-type 15s `is_recently_spawned` throttle, persisted across
processes via memcache. Revival latency is cron-cadence (minute) in the worst case.

**Revisit if:** a real process supervisor (systemd, a platform worker tier) becomes available —
then the tiered self-revival can be replaced by it.

---

## ADR-10: Class naming + `make_node` namespace resolution

**Status:** Accepted

**Context:** Topologies and the REPL refer to node types by short name (`Tee`, `Router`).
Resolving those to classes needs a rule that sibling and third-party plugins can extend
without editing a central registry.

**Decision:** Every PHP class is `Word_Word` (acronyms `HTTP` / `SSE` / `CLI` / `LRU` / `CI`
stay all-caps). Node subclasses end `_Node` (`Tee_Node`, `HTTP_In_Node`, `SSE_Out_Node`, the
`*_CI_Node`s); non-node helpers are normalized without it (`Event_Framework`, `Worker_Base`,
`Spawn_Controller`, `CLI`). The shell name a topology line / `make_node` uses is the short-name
minus `_Node` (`Tee_Node` → `Tee`). There is **no** `register_class` / `class_map`: plugins
call `Command_Interpreter_Node::register_namespace( 'My_Prefix\\' )` once, and `make_node($type)`
constructs the first `{$prefix}{$type}_Node` that is a concrete Node subclass (abstract ones
like `Service_CI_Node` resolve to `null`, not fatal). The palette catalog (`Classes_CI` `list`)
scans the composer classmap for `*_Node` Node subclasses with a non-Hidden / non-empty
`node_schema()` category — so after adding/renaming a class you MUST `composer dump-autoload -o`.
Test infra stays PascalCase (Newspack convention); the one exception is the `Capture_Sink_Node`
test double, a real `make_node`'d Node.

**Alternatives considered:** A central `register_class` / `class_map` registry — rejected
because namespace-prefix resolution lets a plugin add node types by registering one prefix,
with no central table to edit (and no merge conflicts on it).

**Consequences:** Naming is load-bearing, not cosmetic — `make_node` resolution depends on the
`_Node` suffix and the prefix. Adding or renaming a class requires a `composer dump-autoload -o`
or the palette won't see it.

**Revisit if:** namespace prefixes collide across plugins (two prefixes resolving the same
`$type` ambiguously) — then resolution needs a tiebreak rule or an explicit registry after all.

---

## ADR-11: `make_node` construction sequence

**Status:** Accepted (revised: the empty-string short-circuit was replaced by a centralized default/required ladder in `parse_schema_args()` — see Decision and Revisit-if)

**Context:** Config must round-trip: a live graph has to be able to emit `make_node <type>
<name> <args>` lines (`dump_config()`) that reconstruct the same graph. That requires a fixed
construction order and a config representation that survives the round trip.

**Decision:** `make_node` uses the v0.6.0 Tachikoma sequence: no-arg ctor → `name()` →
`arguments()` → `sink()`. Every substrate Node has a no-arg constructor; `make_node`
instantiates with `new $fqcn()`, then calls `name()`, then
`arguments( implode( ' ', array_filter( $ctor_args, '\is_scalar' ) ) )`, then `sink( $this )`.
The base `arguments()` is the trivial Tachikoma getter/setter — it stores the raw string and
does **not** parse it. A node that wants its declared positional args assigned to `$this->{$name}`
props opts into the `Schema_Reflection` trait and calls `parse_schema_args()` from its own
`arguments()` override (JS mirrors this: base `set arguments` stores only; consumers call the
exported `parseSchemaArgs( node, args )`). Config travels as a single space-joined string that
round-trips through `dump_config()`. Programmatic dependencies (e.g. `Workers_CI_Node::$cli`)
are **public properties** the caller assigns AFTER `make_node` returns; object args passed
positionally are silently filtered (`is_scalar`) because they aren't round-trippable through
`arguments`. `parse_schema_args()` records the raw string into `$this->arguments` (so `dump_config()` still
round-trips) and is the single source of truth for defaults: a missing token takes the arg's
schema `default`, or throws if the arg is `required`. So an under-argged `make_node` (e.g.
`make_node Partition foo` with no dir) now throws `Missing required argument: dir` instead of
deriving filesystem-root junk like `/p0` — fail loud, not silent garbage. Subclasses that derive
state (Partition's `partition_dir`) compute it after `parse_schema_args()` returns, by which point
the required tokens are guaranteed present.

**Alternatives considered:** A parsing constructor that takes typed args — rejected because it
breaks the round-trippable single-string config representation and diverges from the Tachikoma
construction sequence the rest of the model assumes. Object args through `make_node` — filtered
out deliberately, because they can't survive `dump_config()`.

**Consequences:** Centralizing the default/required ladder in `parse_schema_args()` retired the
empty-string short-circuit (the recurring footgun where every config-bearing `arguments()`
override had to mirror `if ( '' === $args ) return;` or derive garbage). The trade: a bare
`make_node <Type> <name>` of a node with a `required` arg now throws at construction instead of
yielding an unconfigured node — intended (fail fast and loud). Nodes whose config arrives as
post-`make_node` public properties (e.g. `Workers_CI_Node::$cli`) declare no required positional
args, so they still construct bare.

**Revisit if:** *(Acted on)* — the short-circuit's recurring cost triggered exactly this
revision: the parsed default/required ladder now lives once in `parse_schema_args()`. Revisit
again only if throw-on-required-at-construction proves too strict for a legitimate deferred-config
flow that must build a bare node before configuring it.

---

## ADR-12: Dead-letter poison / crash lifecycle ([42])

**Status:** Accepted (extended: the fair-shot + crawl machinery, originally Consumer-only, is now
shared by `Consumer_Node` and `Remote_Source_Node` via the `Dead_Letter_Queue` / `Offsetlog_Cursor`
traits)

**Context:** A durable reader (Consumer tailing a Partition; Remote_Source relaying a remote SSE
stream) can hit a message that always fails downstream — a *poison* message. Two failure shapes
exist, and they need opposite responses. A **caught throw** (the downstream `fill()` raised, we
caught it) is deterministic and recoverable: we can retry it a bounded number of times and then set
it aside. An **uncatchable death** (OOM / fatal / SIGKILL mid-forward) leaves no catch point; all we
know on the next boot is that the attempt count at this cursor climbed with no reason stamped. Naively
either (a) dropping a poison on first failure loses data we might have delivered after a transient
blip, or (b) never advancing past it wedges the whole stream forever. Both shapes must converge on
"make progress eventually, but only after honest retries, and never silently."

**Decision:** A durable reader carries per-cursor attempt accounting in its offsetlog frame
(`attempts`, `reason`, `first_crash_ts`); a respawn resumes at `attempts+1`. A graceful shutdown
stamps `attempts=0` (a clean handoff → the respawn is virgin), so only a *stuck* cursor climbs.

- **Caught-throw poison is strictly serialized.** The poison BLOCKS the head: nothing past it
  forwards and the committed cursor freezes at the poison's own start, so each respawn re-pulls
  exactly it and `attempts` climbs. At `COOP_MAX_ATTEMPTS` the message is `dead_letter()`ed (quarantined
  to the `:deadletter` sibling for `wp nodes ingest` replay) and the quarantine is recorded durably
  *at quarantine time* so an idle stream or a recycle can't re-pull-and-re-quarantine it. Remote_Source
  can't compute the poison's byte END locally (SSE_In's cursor sits at a message's OWN start, and the
  remote-log line length is unknown to the client — only the *next* message's ID reveals "past"), so
  instead of deferring the advance to a hypothetical next message it commits a **`dlq` marker frame**
  at the poison's offset: a respawn / reconnect re-pulls the poison once, recognizes the marked offset,
  and DROPS it (no re-forward, no duplicate DLQ); the marker clears and the cursor advances the moment
  a *later* message forwards past it. Forward progress before the threshold clears the streak — a
  transient blip doesn't count against the message. (Consumer, which owns its byte cursor, advances
  past directly; the `dlq`-marker indirection is Remote_Source-specific to the SSE-push model.)
- **Uncatchable-death poison crawls.** Booting into an elevated attempt count with NO reason stamped
  (and `>= CRASH_MAX_ATTEMPTS`) enters *crawl*: checkpoint after EVERY message so a re-crash pins the
  exact culprit, attempts pinned at the threshold. Surviving `CHECKPOINT_INTERVAL_S` of crash-free
  forward progress exits crawl back to the healthy baseline (`attempts=1`) and resumes coarse
  checkpointing. Consumer additionally sacrifices its boot-cursor head on crawl entry (its per-line
  drain model has an in-flight head to blame); Remote_Source's per-relayed-message model has none, so
  it only isolates.

The reusable core (`attempts` accounting, `record_poison_strike`, `resume_attempts_from_frame`,
`crawl_interval_elapsed` / `exit_crawl`, `dead_letter`, the `CRASH_MAX_ATTEMPTS` / `COOP_MAX_ATTEMPTS`
/ `CHECKPOINT_INTERVAL_S` thresholds) lives in `Dead_Letter_Queue`; each reader supplies its own
read-loop shape (Consumer's buffer/line cursor vs Remote_Source's SSE-pushed `{seg,off}` cursor with a
`poison_pos` block + an explicit advance-past on the next relay). Worker shutdown checkpoints BOTH:
`Worker_Base::checkpoint_durable_consumers()` handles `Consumer_Node` (graceful / fair-shot) and now
`Remote_Source_Node` (`checkpoint_shutdown()`), so a healthy remote cursor isn't lost each ~10-min
recycle.

**Alternatives considered:** Drop-on-first-failure — rejected (loses recoverable transient failures,
no audit trail). Unbounded retry without quarantine — rejected (wedges the stream forever on a truly
poison message). A single shared read loop for both readers — rejected: the buffer/line model and the
SSE-push model genuinely differ, so only the *accounting/decision* logic is shared (forcing a common
loop would couple two things split apart on purpose). Treating a Remote_Source caught-throw the way
Consumer treats one (one-shot dead-letter) — rejected: across the SSE-pull model a downstream throw is
often transient (a recycling spoke), so the fair-shot block-and-climb earns the message real retries
before quarantine.

**Consequences:** Poison can't wedge a durable stream and is never silently lost — every give-up
emits a rate-limited `error_log` alert and (when configured) a replayable `:deadletter` entry. The
cost is per-cursor offsetlog bookkeeping and, in crawl, per-message checkpoint I/O — bounded to the
crash region by the interval-survival exit. Remote_Source's poison accounting is throw-driven (its
`poison_pos` block), distinct from Consumer's boot-cursor cooperative-stop strikes; this is a
deliberate, documented asymmetry, not an inconsistency.

**Revisit if:** the shared trait surface starts carrying read-loop specifics (a sign the wrong thing
was extracted — keep loops in the readers), or a third durable reader appears whose model fits neither
shape (re-evaluate whether the trait split is still the right seam).
