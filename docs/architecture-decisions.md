# Architecture Decision Records

The load-bearing design decisions of the substrate. "Fixing" one usually reintroduces a bug
already paid for. Each record states the constraint that forced the choice, what was weighed
against it, what it costs, and a concrete condition that would reopen it. A **Revisit if** is
a sufficient tripwire, not the only door — any argument on the merits also reopens a decision.

Numbers are stable. [`AGENTS.md`](../AGENTS.md#architecture-decisions)'s table numbers these as "Decision N"; code comments and
docblocks cite them as `ADR-N`, in this plugin and in every consumer. Don't renumber —
supersede.

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
| [16](#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api) | JS node-class resolution — names are the TSL surface, classes are the API |
| [17](#adr-17-timers-fire-on-a-shared-wall-clock-grid) | Timers fire on a shared wall-clock grid |
| [18](#adr-18-a-table-can-front-a-durable-record-the-walk-that-finds-it-stays-in-the-app) | A Table can front a durable record; the walk that finds it stays in the app |
| [19](#adr-19-a-node-may-declare-a-destination-it-writes-without-routing) | A node may DECLARE a destination it writes without routing |
| [20](#adr-20-a-config-default-lives-in-code-every-config-file-is-an-override-surface) | A config default lives in CODE; every config file is an override surface |
| [21](#adr-21-a-node-may-derive-its-children-from-the-vault-and-static-analysis-reads-it) | A node may derive its children from the Vault, and static analysis reads it |
| [22](#adr-22-a-worker-id-has-one-writer-one-reader-and-two-layout-owners) | A worker id has one writer, one reader, and two layout owners |
| [23](#adr-23-a-request-carries-no-authority-of-its-own) | A request carries no authority of its own |
| [24](#adr-24-a-tables-backend-is-chosen-per-table) | A Table's backend is chosen per Table |

---

## ADR-1: Uniform `fill()` contract

**Status:** Accepted

**Context:** A node graph is only composable if any node can hand a message to any other node
without knowing its type. Per-node methods (`write()` vs `process()`) make callers
special-case, and a node can no longer be swapped without touching them.

**Decision:** Every node has exactly one entry point: `fill( array $message )`, by value. No
parallel `write()` / `read()` / `process()` API, no convenience wrappers.

![Two panels. Forward: Tee::fill hands a copy to each of N targets, so one target's edits stay in its copy; by reference the same array would reach all N, leaking edits and clobbering the caller's FROM and ID before the reply reads them. Return: an outcome comes back as a message, a TO=FROM reply, a TM_ERROR or a send to a target, never as a fill() return the caller would branch on. Below, two rejected shapes, per-node typed methods and exposing fill()'s stages as cleanup, beside the wrap rule for a node whose natural input is not a Message.](img/adr-fill-ownership.png)

The test is not what a method is *named*. It is whether anything outside the node can reach
the node's work without going through `fill()`. Helper methods are fine as `fill()`'s own
internals; nothing outside the node calls them to get a message in. A node whose natural input
is not a Message — a typed REPL line, a raw wire frame, a file chunk — does not widen its
signature: the producer wraps it and `fill()` unwraps it.
[`Shell_Node::fill()`](../includes/class-shell-node.php) is the worked example: it takes a
Message like every other node and reads the statement out of the VALUE.

**Alternatives considered:** Per-node typed methods (`enqueue()`, `publish()`, `handle()`) —
rejected: they break uniform composition, and testing any node is "construct a message, call
`fill()`, inspect the sink." Passing by reference, `fill( array &$message )` — rejected: a Tee
hands one array to N targets, so one target's edits leak into the next, and a caller reading
the request's FROM and ID after forwarding, as every reply does, finds them clobbered. Keeping
`fill()` but exposing its stages, so a caller can take the parsed result — rejected, and named
because it arrives disguised as cleanup: it adds the parallel API this ADR forbids, and drags
[ADR-13](#adr-13-fill-returns-nothing) down with it, since the stage a caller reaches for
hands its result back as a return value.

**Consequences:** Every behavior is "a message arrived." Richer control surfaces are message
types / verbs through an interpreter, not new methods.

**Revisit if:** a node type genuinely cannot express its operation as a single message-in.
None in the tree does: the interpreter/verb pattern absorbs every case.

---

## ADR-2: One message format: the 7-field positional array

**Status:** Accepted

**Context:** Messages are the hottest object in the system. Hash lookups (`$message['type']`)
are measurably slower than indexed access in the drain loop, and a message with different
shapes in PHP / JS / wire / memory needs a translation layer at every boundary.

**Decision:** One shape everywhere: `[TYPE=0, TIMESTAMP=1, FROM=2, TO=3, ID=4, KEY=5,
VALUE=6]`, always indexed via the [`Message::*`](../includes/class-message.php) constants. `packed()` / `unpacked()` are JSON
of the array — the wire shape IS the memory shape. There is **no** object form; if you see
one it is a bug to delete. Deliberate Tachikoma divergences: KEY not STREAM, VALUE not
PAYLOAD, TIMESTAMP at index 1. `TM_BYTESTREAM` (string VALUE) and `TM_STRUCT` (array VALUE)
are mutually exclusive; array-VALUE consumers gate on `TM_STRUCT`.

![Three rows of slots. In memory, new_message() mints the seven indices with TYPE at TM_UNTYPED. A Shell's command carries Message::LOCAL at index 7, which packed() slices off before the wire. The footgun row shows $message['type'] appending an eighth element under a string key that packed() slices away, so the write vanishes while TYPE keeps whatever it held. Below: the rejected associative array or value object, the divergence budget against Tachikoma, and the two conditions that would reopen the decision.](img/adr-eighth-element.png)

`new_message()` mints TYPE as `TM_UNTYPED`, a free high bit matching no type gate, so a
message its minter forgot to type is inert rather than every type at once, and the drop audit
names it. `LOCAL` at index 7 is the in-process provenance taint a Shell stamps on a command it
mints, appended AFTER the canonical fields and sliced off by both ports' `packed()` / `pack()`,
which is exactly what makes it usable as an authorization signal ([ADR-15](#adr-15-command-authorization-local-taint--the-minter-signs)). Nothing else may
be appended on that basis.

**Alternatives considered:** An associative array — rejected: hash lookups are measurably
slower than indexed access in the drain loop, and PHP casts only a NUMERIC string key to an
int, so `$message['type']` appends an eighth element under the string key instead of setting
TYPE, and `packed()` slices it away without a word. A value object — rejected: it reintroduces
a translation layer at every PHP / JS / wire / memory boundary.

**Consequences:** Indexing without the constants is a silent-corruption footgun. The
positional shape is the [divergence budget against Tachikoma](tachikoma-lineage.md#deliberate-divergences) — anything further must be
justified separately.

**Revisit if:** profiling shows associative arrays are no longer slower in the drain hot path
**and** a typed value object can eliminate the string-key footgun without a wire/memory
translation layer.

---

## ADR-3: Fire-and-forget messaging

**Status:** Accepted

**Context:** Tachikoma's [TM_PERSIST](tachikoma-lineage.md#no-tm_persist-no-answer--cancel-no-max_unanswered) + `answer()`/`cancel()` + `max_unanswered` flow control
earns its keep when producer and consumer are decoupled by a queue that can fill. This
substrate has no such queue: every boundary is synchronous, and the whole graph drains on one
CPU.

**Decision:** No producer/consumer ack handshake — no TM_PERSIST, no `answer()` /
`cancel()`. The one reply-control flag is `TM_NOREPLY`: a Shell with `want_reply(false)`
(topology load, script mode) ORs it onto its commands and the interpreter suppresses the
reply, since a worker's boot-topology replies would otherwise route to an absent
`_output/<pid>` and bounce a dropped `NOT_AVAILABLE` every startup. With no reply to carry
it, a TM_NOREPLY command's failure propagates to whatever filled the command, so a broken
topology line fails the load: [`Command_Interpreter_Node::interpret()`](../includes/class-command-interpreter-node.php)
re-throws a refusal or a verb's throwable, and [`Router_Node::send_error()`](../includes/class-router-node.php)
throws `NOT_AVAILABLE` for a command addressed to no node instead of bouncing it. Both browser
twins do the same. Tachikoma prints the one and bounces the other while the script runs on;
the lineage records [why this differs](tachikoma-lineage.md#a-tm_noreply-failure-raises-instead-of-printing).

![Two panels. Rejected, Tachikoma's handshake: a producer sends TM_PERSIST into a Buffer whose max_unanswered caps what is in flight, and the consumer later answers or cancels with a TM_PERSIST | TM_RESPONSE sent TO=FROM, because consumption is asynchronous from delivery and the ack is the tier's advance-or-discard signal. Chosen: Consumer::poll() reads a record, fill() runs down one call stack to the last sink, and only then does the cursor advance, Consumer chopping past the record and Remote_Source committing on arrival at each message's start; the next poll() waits for all of it, which is the backpressure. Three cards below: TM_NOREPLY, which a Shell with want_reply(false) ORs onto its commands so a booting worker's replies do not bounce NOT_AVAILABLE from the absent _output/<pid>; flow control belonging at the producer that needs it; and the three revisit conditions.](img/adr-no-ack.png)

**Alternatives considered:** Keeping the persist/ack contract — rejected: the synchronous
single-threaded drain already IS the backpressure (a slow node slows the drain, which slows
the next `poll()`), and there is no queue to overflow.

**Consequences:** No at-least-once guarantee at the message layer; durability comes from the
log/offsetlog tier, whose reader owns its cursor, so "safe to resume" is always local
knowledge. A slow handler stalls its worker's drain, which is the flow control rather than a
defect. Slot-based flow control belongs at the producer that needs it, never graph-wide.

**Revisit if:** a producer needs genuinely decoupled queueing, **or** the drain stops being
single-threaded, **or** offset advance is decoupled from delivery (async handlers, in-flight
windows) — each breaks the "delivered = safe to advance" coincidence the removal rests on.

---

## ADR-4: PIPE_BUF atomic writes

**Status:** Accepted

**Context:** Multiple producers append to the same partition log concurrently. POSIX
guarantees an append-mode `write()` ≤ `PIPE_BUF` (4096 bytes) on a local filesystem does not
interleave — which lets the firehose skip a lock on the common path.

**Decision:** Default write limit 4096 bytes ([`MAX_LINE_SIZE`](../includes/class-partition-node.php)), lock-free. A record over that
is dropped whole, trimmed at the producer by [`Line_Fitter::fit()`](../includes/class-line-fitter.php), or written under one of two
explicit opt-ins that raise the ceiling to `MAX_LARGE_LINE_SIZE`, 32 MiB.

![A record reaches Partition::fill() and is measured as packed bytes plus newline against MAX_LINE_SIZE 4096: under it, one lock-free atomic write; over it with no opt-in, dropped with a rate-limited WARNING. Three routes below. Line_Fitter::fit keeps the cap by halving the listed VALUE fields in sacrifice order and returns null when none is left. allow_large_writes takes a Lock at write.lock.d, retrying every 100 ms up to DEFAULT_LOCK_WAIT_MS 15 s, stealing a lock orphaned or stale past 60 s, throwing at timeout, with a debounce mode. void_warranty lifts the cap on the caller's assertion of sole writer. A mode strip shows NONE, LOCK and VOID: the lock supersedes a void, and a refused acquisition drops the cap all the way back. A note states the habitable zone: one host's local POSIX filesystem.](img/adr-large-write-modes.png)

The two opt-ins are for a record that must survive whole; the fit is for one carrying an
expendable field, where a fitted line keeps its head and an unfitted one is gone.
[`Job_Probe_Node`](../includes/class-job-probe-node.php) fits every jobstats record, and event-logger-nodes fits its error entries,
its completed-request summaries and its in-flight gyroscope rows.

**Alternatives considered:** Always locking — rejected: taxes the firehose for a rare case.
Only the enforced opt-in — rejected: a partition already inside a single-writer boundary
would pay a redundant second lock (plus heartbeat upkeep) to re-prove what the topology lock
guarantees.

**Consequences:** Callers must know their payload size. A producer that outgrows 4 KB loses
every oversize record to the drop until it fits or opts in; `void_warranty()` where
single-writer isn't true tears them instead (when in doubt, take the enforcing form).

**Habitable zone:** everything under `base_directory` — locks, partitions, offsets, IPC —
is scoped to **one host's local POSIX filesystem, shared by that host's PHP processes**.
That is the design point, not a limitation to engineer around: the base dir is
topology-worker IPC, and workers are per-host by construction. State the habitat; deploy
inside it.

**Revisit if:** a deployment genuinely needs cross-host coordination — that is a different
transport (the hub/spoke remote channels), not a shared filesystem.

---

## ADR-5: Lazy init for Topic / Partition

**Status:** Accepted

**Context:** Topic and Partition constructors run in **request scope** — no event loop.
Constructor-time loop or filesystem work leaks or fails silently: `set_timer` registers
against a framework that isn't running, `Core::node()` answers null for a graph nothing has
built yet, and `scandir` burns syscalls × N partitions per request.

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
One partition has one consumer, so a key's messages are processed serially, by one process,
in append order. Sometimes the point is the order; often it is pure non-concurrency — per-key
mutexes, CAS loops, and read-modify-write guards never need to exist. The hash IS the
concurrency control. Divergent hash families silently split a key across partitions and break
all of it.

**Decision:** [`Partition_Node::hash_to_partition()`](../includes/class-partition-node.php) is canonical, and every routing site
calls it.

![How Topic_Node::fill picks a partition: a TO beginning p<N> with N inside num_partitions wins as addressed, an out-of-range pin falls through; a non-empty KEY goes through hash_to_partition, which strips the query string at the first question mark, then takes crc32 masked with 0x7FFFFFFF modulo num_partitions; a message with neither lands round-robin. Cards below give the rejected per-producer hashing, why the 31-bit mask exists, and the reopen condition.](img/adr-partition-routing.png)

**Alternatives considered:** Per-producer hashing — rejected: divergent hashes misroute the
same key silently (no error, only wrong colocation).

**Consequences:** All routing converges on one function; a site needing different behavior
must be an explicit, named alternative, never a divergent re-implementation.

**Revisit if:** the partition count outgrows CRC32's distribution, or a genuinely different
key family is required — then a *new, named* routing function, not a quiet second hash.

---

## ADR-7: `sink` vs `target`, and TO=FROM replies

**Status:** Accepted

**Decision:** `sink` is the **physical** next node `fill()` forwards to. `target` is the
**logical** destination (Tachikoma's `owner`). The base `Node::fill` stamps it into
`message[TO]` only when TO is empty; [`_router`](../includes/class-router-node.php) resolves a non-empty TO by peeling the head
segment; replies set `TO=$message[FROM]` to walk the breadcrumb back.

![Two planes side by side. Physical: a node reference, unaddressable, which is how the stdin reader and the Shell stay off the registry and out of reach of any TO path. Logical: a string path stamped into an empty TO, walked by _router one segment at a time, serializable across IPC, SSE, HTTP and the browser. Three verdicts: all-logical loses unaddressability, all-physical loses the serializable address, so both planes are load-bearing. A decision at the bottom shows what PHP's HTTP_Out does with a message the remote sent back: addressed messages pass only when their whole TO is on the allow_replies_to list and are dropped otherwise; unaddressed ones take the target when one is set and go on to the sink as they stand when none is. A note under it gives the browser's HttpOut, which keeps Tachikoma's type-bit test and refuses an addressed non-reply while a target is set.](img/adr-sink-vs-target.png)

The routing nodes go further. [Tee](../includes/class-tee-node.php) (array target, fan-out) sets TO per target — the target
alone, or `target/TO` prepended so the remainder routes onward after the Router peels the
head. [Echo](../includes/class-echo-node.php) completes the re-addressing matrix: prepend when both are set, bounce `TO=FROM`
when both are empty, fall through to the base stamp otherwise. It drops a `TM_ERROR` whose
TO is empty rather than bouncing one back to a producer expecting no error trail.

The two realms, PHP workers and the JS console, each gate what a remote sends back at the
wire boundary, and the gates differ because the remotes do. Both first stamp their own name
onto the arriving FROM, as Tachikoma's [`Socket.pm`](https://github.com/datapoke/tachikoma/blob/master/lib/Tachikoma/Nodes/Socket.pm) does, so what comes in carries a
path back out.

PHP's [`HTTP_Out`](../includes/class-http-out-node.php) reply leg homes unaddressed traffic to its target as `Socket.pm`
does, but replaces Socket.pm's `TM_RESPONSE` test with a declared allowlist, because the
remote sets the type bits. A reply self-routes by the TO the remote echoed off our FROM
breadcrumb, so anything addressed is the remote naming a node inside our graph:
`allow_replies_to` is the whole gate, matched as the whole path, and nothing declared means
nothing addressed passes. Unaddressed output belongs to the target, and with no target goes on
to the sink as it stands; that is how a server-side `log` broadcast, minted with no TO,
reaches the browser transcript instead of dying at `_router` as *message not addressed*. A
`Null_Node` makes the right target: it swallows the remote's unaddressed output and counts it,
where the relay that owns the egress would send the spoke's own output straight back out.
`Remote_Link_Node` builds one as `<name>:null`, re-points `HTTP_Out` at it on every rename,
and lists its own name so its heartbeat replies reach it. The per-spoke `HTTP_Out` an operator
wires for [`topologies/settings-sync.tsl`](../topologies/settings-sync.tsl) takes both lines by hand: `connect_node <egress> null`
and `cmd <egress>:config allow_replies_to settings-sync`.

The browser's [`HttpOut`](../src/runtime/http-out-node.js) keeps Tachikoma's type-bit test, counting a directed `TM_ERROR`
as a reply too: a `TM_RESPONSE` or `TM_ERROR` carrying a TO self-routes, an addressed
non-reply is refused while a target is set, an unaddressed one takes the target, and no
allowlist applies. Its remote is the server the session is logged into, and every address
coming back is a breadcrumb the browser minted — `_output/<id>`, `_completion`, `_metadata`,
`_dmesg` — so a fail-closed list over those names would gate the console against its own
replies.

`SSE_In` carries no such gate, because a subscription's records are not replies: `RemoteLink`
sets `homeToTarget` and re-homes every non-command record to the target, `RemoteIpc` sets it
false, and a command reply keeps the TO the server addressed to its minter either way, because
overwriting it would deliver the reply to the subscription's view instead of its receiver.

**Observed benefits:**

- **A TO path is a serializable address**, so cd'ing into a worker and the `_output/<pid>`
  cross-process replies work where an object reference cannot. Tachikoma's `pivot_client`
  physically re-sinks the Shell into a remote socket and removes the local interpreter; here
  nothing rewires.
- **TO=FROM replies need no correlation table.** [`scripts/lint-contract.mjs`](../scripts/lint-contract.mjs) holds the
  JavaScript under `src/` and `examples/` to it: the `reply-keyed-map`, `resolver-pair`,
  `promise-registry`, `op-id` and `key-demux` rules refuse a table filed under an argument, a
  parked resolver pair, a registry of pending resolvers, an id minted into `message[ID]`, and
  KEY read as a demultiplexer.
- **A subject rides in the address, so one node answers about many rows.** A minter serving
  N subjects appends the one it is asking about to its own FROM — `vault:test:in/spoke-01` —
  and the reply arrives at `vault:test:in` carrying `spoke-01` as its remaining TO. A screen
  serving many rows then FILES that answer under the subject; a per-row map is view state, not
  correlation. What this ADR forbids is a table that decides WHICH ask a reply belongs to.
  Split by JOB (a verb, a poll, a stream), never by SUBJECT: a table of ten servers is one
  node per verb, not fifty. A subject is one path segment, so it goes out
  `encodeURIComponent`'d and is read back on arrival ([`useCommandOnce`](../src/shared/hooks/useCommandOnce.js)'s `subjectOf`). An
  escaped subject past `SUBJECT_MAX` (128 characters) is a document rather than an identity:
  the command goes out carrying no subject and the log names the one that needs a `subjectOf`
  of its own — better than raising out of a click handler, and better than addressing a reply
  past the substrate's `MAX_FROM_SIZE`.
- **Late binding.** Targets resolve at fill-time: any construction order, cyclic graphs
  wireable. Eager reference-binding breaks reordered and cyclic graphs.
- **In practice, targets route everything — data included.** In both realms, PHP workers and
  the JS console, every node sinks into `_command_interpreter` and then `_router`, and TARGET
  links carry the flow (request-builder's whole hot pipeline is target links). The router hop
  is paid on the hot path and is fine;
  sink-chains as a fast path exist but are not what the split is used for.
- **One chokepoint.** Everything passes the Router — one place for NOT_AVAILABLE and the
  routing counter.
- **Unaddressability is a security boundary.** The Shell is the privilege point (it marks
  commands `LOCAL` and signs them), so a TO path reaching it would turn a crafted
  `TM_BYTESTREAM` into an authorized command. `Shell_Node::name()` throws on any argument so
  the rule cannot be violated by a later caller, and the stdin reader is never named. No name, no
  attack surface — security by construction, not by checks.

**The two-properties argument:** all-logical routing loses unaddressability, since every node
must hold an address to receive anything; all-physical routing loses the serializable address,
so no cd into a remote worker and no cross-process TO=FROM. Both are load-bearing, so the split
is the minimal design that carries both.

**Alternatives considered:** A single combined "next" pointer — rejected on the
two-properties argument; no port has one. A second physical `edge` output (as in some
Tachikoma graphs) — omitted until a concrete need appears.

**Consequences:** Two concepts to keep straight; FROM must be stamped correctly at sources
(see the FROM-stamping pitfall) or replies can't route back.

**Revisit if:** a node needs a true second *physical* output — then reintroduce [`edge`](tachikoma-lineage.md#there-is-no-edge)
deliberately, rather than overloading `target` or `sink`. Or if an alternative architecture is
compelling and proven more efficient.

**Amendment:** a browser's reply to an attached-worker command is addressed to the command
SESSION, not to a process. [`RemoteIpcNode`](../src/runtime/remote-ipc-node.js) heads the FROM it sends with
`_sse:<handle>`, the handle of the page's command session, and a stream presents
`session=<handle>`, so [`HTTP_Filter_Node`](../includes/class-http-filter-node.php) passes the replies
headed with it on whichever connection that session holds when they land. The head used to be
the pid of the process serving the stream, which named one connection: every reconnect was a
new process, and a reply to a command sent before the drop was addressed to a stream that no
longer existed. The addressing is still the correlation — nothing new is minted, stored or
matched — only the thing the head names moved from the connection to the session. A stream
that presented no session, the server-to-server pull, passes no reply at all. A session
re-minted on expiry changes the handle, so a reply in flight across a re-mint is lost, about
once an hour per tab at most. `wp nodes cli` keeps `_output/<pid>`: it attaches to the IPC
files directly and never reconnects, so its process is its session.

---

## ADR-8: Worker zombie pattern

**Status:** Accepted

**Context:** The target platform (Atomic) caps a request at 15 minutes and offers no resident
process. A long-running worker is therefore an HTTP request whose caller walks away, which
keeps executing after the disconnect and respawns a successor before its clock runs out.

**Decision:** Workers spawn through an HMAC-validated [`POST /newspack-nodes/v1/workers/spawn`](API.md#worker-spawn),
the caller abandons the connection, and the endpoint runs the worker inline for its whole
lifetime.

![A timeline with three lanes. The caller writes the spawn POST and walks away at 250 ms, Core::fire_and_forget_post's SPAWN_POST_TIMEOUT_MS, reading no status. The endpoint checks the HMAC, then runs the worker inline under ignore_user_abort(true) and set_time_limit(0) for about 595 seconds, ending in a finally that releases the lock and then self-respawns, so the successor acquires the lock immediately. Three cards: fastcgi_finish_request rejected because it hands WordPress a response it can no longer send, a resident daemon or rescue-only restart rejected, and the cost of about 144 respawns a day per worker.](img/adr-zombie-request.png)

Nothing detaches from FPM or the process group: the process holding the connection IS the
worker, for [`Cooperative_Stop::DEFAULT_MAX_RUNTIME`](../includes/trait-cooperative-stop.php), ~595 s.

**Alternatives considered:** A resident daemon — unavailable on the platform. No self-respawn
(rescue-only restart) — rejected: every ~10-minute recycle would idle the slot until a peer's
stale-lock rescue; self-respawn hands off immediately and leaves the peer scan as the safety
net ([ADR-9](#adr-9-two-tier-safety-net)), not the scheduler. [`fastcgi_finish_request()`](https://www.php.net/manual/en/function.fastcgi-finish-request.php) — rejected: called ahead of the
`WP_REST_Response`, which COMPLETES the response, it produces an empty body and "headers
already sent" in the log, unnoticed because every caller discards the body anyway.

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

**Decision:** Two tiers. Workers self-respawn AND scan their peers through `_fleet`
([`Fleet_Node`](../includes/class-fleet-node.php)); WP-Cron catches a fleet with nothing left running, at minute cadence, via
[`Bootstrap::reconcile_fleet()`](../includes/class-bootstrap.php).

![Three spawners feed one gate. Tier 1: the shutdown in Worker_Base::execute, which releases the lock then self-respawns; and _fleet, which every 15 seconds (SCAN_INTERVAL_MS) spawns any worker whose lock dir is missing or heartbeat stale, at most MAX_SPAWNS_PER_TICK 4 per pass because each POST is a blocking cURL. Tier 2: Bootstrap::reconcile_fleet on WP-Cron once a minute, no per-pass cap. All three POST the HMAC-validated spawn endpoint, where is_recently_spawned enforces 15 seconds per slot and records last_spawn:{type}|{partition} through shared_first with a transient fallback at twice MIN_SPAWN_INTERVAL_S. The minute pass, Bootstrap::run_reconcile_steps(), runs nine steps in order, each attempted whatever an earlier one threw, then after_reconcile, then every failure raised together: before_reconcile, spawn_due_workers, wake_readers_with_backlog, lock-dir reconcile, retention, orphan-IPC reaping, alerts, the delayed-jobs sweep, newspack_nodes/periodic. Cards give the rejected dedicated supervisor and what N spawners buy.](img/adr-safety-net.png)

**Alternatives considered:** Self-respawn only — rejected: nothing catches a worker that dies
before it can respawn. An OS-level process supervisor (systemd, a platform worker tier) —
unavailable. A DEDICATED supervisor process as the middle tier — rejected: it is no supervisor
in the OS sense, since it can neither signal a worker, reap it, nor restart it in place. All it
does is poll lock-dir mtimes and POST to an HTTP endpoint, and polling is work the pollees do
for each other; the throttle that makes three spawners safe makes N safe. Revival must not
depend on a single process, and peer scanning honors that more completely than a dedicated
tier while giving back a permanently-resident PHP-FPM child.

**Consequences:** N independent spawners, bounded against respawn storms by the 15s
[`is_recently_spawned`](../includes/class-spawn-coordinator.php) throttle at the one gate they all cross. Supervision survives the loss
of any single process rather than dying with one. The cost: with EVERY worker dead there is
nothing left to scan, so a total fleet death waits up to a cron minute — which is why the
cold-start pass deserves its direct tests. Housekeeping depends on no live worker at all —
retention and orphan reaping run even when the fleet is down, which is when disk most needs
reclaiming — and its real cadence needs are minutes or slower ([`Log_Cleaner`](../includes/class-log-cleaner.php)'s delete grace
alone is an hour). The delayed-jobs sweep moves with it, so `not_before` granularity is a
minute; firing late is what `not_before` means, and firing early would be the bug. The gate
judges write conflicts over the topologies that read, as
[`Bootstrap::active_topologies()`](../includes/class-bootstrap.php) answers them; one that will
not — a broken include, or a configured name no `.tsl` resolves — boots nothing, and every pass
that reaches the gate raises it after posting the rest, so a stale name fails loud each minute
rather than dropping out of the fleet in silence.

**Revisit if:** an OS-level process supervisor becomes available — the tiered self-revival
collapses into it.

---

## ADR-10: Class naming + `make_node` namespace resolution

**Status:** Accepted

**Context:** Topologies and the REPL refer to node types by short name. Resolution needs a
rule that sibling and third-party plugins can extend without a central registry.

**Decision:** Every PHP class is `Word_Word`, node subclasses end `_Node`, and `make_node`
resolves a short name by walking the namespaces plugins registered through
[`Command_Interpreter_Node::register_namespace()`](../includes/class-command-interpreter-node.php).

![resolve_class walks a memo and then the registered namespaces in registration order: the memo returns a cached success at once; Newspack_Nodes has no Summarizer_Node; Plugin_A's Summarizer_Node is the first concrete match, cached and returned; Plugin_B's identical short name is never consulted again in this process; no match returns null and make_node answers unknown class, an abstract match counting as a miss. Cards state that a short-name collision is silent and sticky, and the naming rules the resolution depends on.](img/adr-name-resolution.png)

**Alternatives considered:** A central registry — rejected: prefix registration adds node
types with no central table to edit (and no merge conflicts on it).

**Consequences:** Naming is load-bearing — resolution depends on the `_Node` suffix and the
prefix. Renames require `composer dump-autoload -o` or the palette won't see them. A
short-name collision hands BOTH topologies whichever plugin registered first, `make_node`
raises nothing, and a later `register_namespace()` cannot displace the cached answer; the
defence is a distinctive short name, which is why every class in
[`examples/example-ai-newsletter/includes/`](../examples/example-ai-newsletter/includes/) carries a `_Demo` suffix.

**Revisit if:** namespace prefixes collide (two prefixes resolving the same `$type`) — then a
tiebreak rule or an explicit registry after all.

---

## ADR-11: `make_node` construction sequence

**Status:** Accepted

**Context:** Config must round-trip: a live graph emits `make_node <type> <name> <args>`
lines (`dump_config()`) that reconstruct the same graph. That requires a fixed construction
order and a config representation that survives the trip.

**Decision:** The Tachikoma sequence: construct with no arguments, then call `name()`, then
`arguments()`, then `sink()`, with `arguments()` taking and returning a **flat token array**
(`list<string>` argv), NOT a space-joined string: [`Node::arguments( ?array $args = null ): array`](../includes/class-node.php).

![Seven numbered steps. make_node resolves the type and filters positional args to scalars cast to strings; a name already taken returns the existing node when class and tokens are identical and throws make_node conflict otherwise; then new $fqcn(), name(), arguments( $tokens ) where the base stores and parse_schema_args assigns declared positionals with defaults and a Missing required argument throw, sink( $this ), and an unwind that runs remove_node on a throw from steps 4 to 6. Side cards: the round trip through serialize_args and its quoting rule, the empty-token placeholder that works for int and float alone and the console's applyDefaults and trimTrailingEmpties copies of it, the three trait users that hand-roll the check, and the amendment letting a point-of-use refusal stand in for a required positional.](img/adr-make-node-sequence.png)

**Alternatives considered:** A parsing constructor with typed args — rejected: breaks the
round-trippable single-string config and diverges from the Tachikoma sequence. Object args
through `make_node` — filtered deliberately.

**Consequences:** For every node that calls [`parse_schema_args()`](../includes/trait-schema-reflection.php), defaults and required-arg
enforcement live in one place — no per-override `if ( '' === $args ) return;` guards; the
three that hand-roll it (`Newspack_Log_Node`, `Graphite_Node`, `Table_Node`) carry their own.
A bare `make_node` of a node with a `required` arg throws at construction — intended, fail
loud. Nodes configured via post-`make_node` public
properties ([`Workers_CI_Node::$cli`](../includes/rest/class-workers-ci-node.php), for one) declare no required positionals and construct
bare.

**Revisit if:** throw-on-required proves too strict for a legitimate deferred-config flow
that must build a bare node before configuring it.

**Amendment:** that flow exists — a dashboard whose subscription is CHOSEN from a catalog
must build its `RemoteLink` before anything names one. A required positional is therefore
enforced at construction UNLESS the node refuses the same invariant at the point of USE; where
both exist the point-of-use refusal is the contract and the positional is optional. A required
token whose only effect is to make a deferred caller invent a placeholder moves the failure
from loud to silent — the placeholder has to name something, and a live-looking name streams a
log nobody asked for. The accepted cost, a dumped-while-unconfigured `make_node` line that
refuses on replay, beats a placeholder that replays cleanly into the wrong log.

---

## ADR-12: Dead-letter poison / crash lifecycle

**Status:** Accepted. Shared by `Consumer_Node` and `Remote_Source_Node` via the
[`Dead_Letter_Queue`](../includes/trait-dead-letter-queue.php) and [`Durable_Reader`](../includes/trait-durable-reader.php) traits. Roadmap item [42] (the "(dead-letter [42])"
[CHANGELOG](../CHANGELOG.md) tags).

**Context:** A durable reader (Consumer tailing a Partition; Remote_Source relaying a remote
SSE stream) can hit a *poison* message that always fails downstream. Two failure shapes: a
**caught throw** (downstream `fill()` raised; the exact message is in hand and can be set
aside replayably) and an **uncatchable death** (OOM / fatal / SIGKILL — no catch point; the
next boot only sees the attempt count climb with no reason stamped). Silently dropping loses
data; never advancing wedges the stream.

**Decision:** Per-cursor attempt accounting in the offsetlog frame; a respawn resumes at
`attempts+1`; a graceful shutdown stamps `attempts=0`, so only a stuck cursor climbs. The
cursor names the next unread position, identically in both readers, and a record disposed of
rather than forwarded is committed past gracefully, so there is no re-encounter to recognise
and no quarantine marker.

![The checkpoint frame as six slots: segment, offset, attempts, reason, first_crash_ts and Consumer's co-committed cache, committed every CHECKPOINT_INTERVAL_S 30 seconds, at a clean stop and after every message in crawl. Three paths: a caught throw is dead-lettered on sight at Durable_Reader::forward_line and committed past, with Tail as the exception that wraps nothing; a cooperative stop strikes the in-flight message only when the worker stopped on the message it booted on and quarantines it at COOP_MAX_ATTEMPTS 2; an uncatchable death climbs attempts until CRASH_MAX_ATTEMPTS 5 enters crawl, sacrificing the boot-pinned head with reason crash and checkpointing every message until 30 crash-free seconds. Cards: state older than STATE_WIPE_AFTER_S 900 seconds is discarded, the dl_ verbs on the reader's :config interpreter, and Partition's cursor-less third use.](img/adr-poison-accounting.png)

`Durable_Reader`'s drain loop advances past each record by the length in that record's own
crumb — the line's own bytes for a tailing reader, the spoke's stamped length for a pull
source (`crumb_for_line`). A torn frame carries no crumb of its own, so a pull source places
it at the spoke's own next-read position — the one authority it has — and a length-less crumb
moves the cursor by nothing rather than by a local length in the wrong byte space.
[`Tail_Node`](../includes/class-tail-node.php) and `File_Tail_Node` override the emit seam, `Durable_Reader::forward_line`,
and wrap nothing, so a throw from a Tail's sink escapes the drain loop and never reaches
`dead_letter()`; a Tail reaches its `:deadletter` sibling only through the crawl-entry
sacrifice. The same catch that quarantines a caught throw is what sets `stopped_in_fill`, so
`cooperative_stop()` cannot strike a Tail's in-flight message either and `COOP_MAX_ATTEMPTS`
never applies to one. A memory stop whose fresh baseline was already near the watermark is a
leak (alert), not poison. Crawl entry sacrifices the boot-pinned suspect to the DLQ with reason
`crash`, and crawl won't exit while that sacrifice is still armed, or an un-sacrificed poison
re-arms the crash loop next boot.

A reader with no quarantine configured has nowhere to put poison, so `dead_letter()` raises
the error that condemned the message and the successor replays it; a message condemned with no
error — a crash suspect, a fair-shot strike — is reported and dropped.

A sink that can tell a transient failure from poison catches it rather than let the reader
dead-letter the message on sight: [`Job_Delay::sweep()`](../includes/class-job-delay.php) holds
every failed delivery, raises them after the drain and skips the checkpoint, so an intake write
that failed once replays next pass instead of landing in the sweep's quarantine.

A quarantine that cannot be written is no quarantine. `dead_letter()` then raises the write
failure combined with the error that condemned the message, through
`Worker_Should_Stop::raise()` ([ADR-14](#adr-14-cooperative-stop-propagates-through-broad-catches)),
so both escape the drain and the cursor stays on the message for the successor to replay. A
full disk under the quarantine therefore fails loudly on every respawn rather than committing
past a record nothing holds.

The reusable core (`attempts` accounting, `record_poison_strike`,
`resume_attempts_from_frame`, `crawl_interval_elapsed` / `exit_crawl`, `dead_letter`, the
three thresholds) lives in `Dead_Letter_Queue`; the cursor and its advance live in
`Durable_Reader`, so no reader can forget either.

**Worker shutdown checkpoints both readers** ([`Worker_Base::checkpoint_durable_consumers()`](../includes/class-worker-base.php)),
and the graceful `attempts=0` stamp is half the crash detector, not just a progress save. The
handoff is deliberately SKIPPED on a fatal (`is_fatal_shutdown()`) — leaving the count
climbing is how a deterministic fatal-poison reaches the crawl threshold. (It also saves the
last <`CHECKPOINT_INTERVAL_S` of throttled progress from re-delivery each recycle.)

**Alternatives considered:** Drop-on-first-failure — rejected (loses data, no audit trail).
Unbounded retry — rejected (wedges the stream). A single shared read loop — rejected: the
buffer/line and SSE-push models genuinely differ; only the accounting/decision logic is
shared. Automatic retry (fair-shot block-and-climb) for caught-throws — rejected: a caught
throw is deterministic per message and the quarantined original is replayable, so retries
only risk wedging the stream; and the transient failures retries would target are UPSTREAM
(a recycling spoke drops the SSE stream — the reconnect path's problem), which never makes a
downstream `fill()` throw.

**Consequences:** Poison can't wedge a stream while its quarantine can be written, and is
never silently lost — every give-up emits a rate-limited alert and (when configured) a
replayable `:deadletter` entry, and a give-up the quarantine refuses raises instead. Cost:
per-cursor offsetlog bookkeeping and, in crawl, per-message checkpoint I/O, bounded by the
interval-survival exit. Poison handling is symmetric across both readers, and both self-heal
from a deterministic fatal-poison without operator intervention.

**Revisit if:** the shared trait surface starts carrying read-loop specifics (the wrong thing
was extracted), or a third durable reader appears whose model fits neither shape.

**Amendment:** a reader with no cursor and no quarantine, over a log many processes append
to, may skip a line that will not unpack, provided its caller surfaces the count. A
multi-writer append can land torn, and such a reader has no successor to replay the line and
no quarantine to file it in. [`Durable_Reader::set_skip_unparseable()`](../includes/trait-durable-reader.php)
opts a reader in and refuses one carrying an offsetlog or a deadletter dir, because a cursor
would commit past a line nothing replays and a quarantine is where the line belongs;
`take_unparseable_lines()` hands the count over. [`Consumer_Node::scan()`](../includes/class-consumer-node.php)
builds such a reader over one partition dir, and `Consumer_Node::take_unparseable_lines_of()`
takes and sums the counts of every reader a caller holds. Three callers take it, each reporting it where
its reader looks: [`SSE_Out_Node`](../includes/rest/class-sse-out-node.php) sends an
`unparseable_lines` event down the stream — which a hub's `SSE_In_Node` totals as
`UNPARSEABLE_LINES` and `Remote_Source_Node` publishes to the Aggregator card, moving its cursor
past the skip — event-logger-nodes' `grep_requests` verb returns it
in its reply, and `wp nodes reqgrep` prints a warning. [`Partition_Node::read_tail_frames_by()`](../includes/class-partition-node.php)
counts the same way for the tail read behind `wp nodes status` and the Workers dashboard,
under `unparseable_lines`. Raising was rejected: one torn line would end every read of that
segment until it rotated. Quarantining was rejected: a view has no quarantine, and every
viewer would file the same line again. Revisit if such a reader gains a cursor or a
quarantine, or its count stops reaching a surface its reader sees.

---

## ADR-13: `fill()` returns nothing

**Status:** Accepted

**Context:** [ADR-1](#adr-1-uniform-fill-contract) makes the *forward* direction an ownership boundary — a message handed to a
sink belongs to the downstream; the caller holds no reference and expects nothing preserved.
The return direction is that same boundary seen from the other side. If a node could read
what its `fill()` call returned, it would couple to the downstream's *disposition* of the
message — delivered, dropped, queued, transformed — and swapping that downstream would change
the caller. That is exactly the callee-coupling the uniform contract exists to remove. A
`Tee` filling N targets has no single disposition to hand back anyway, and flow control is the
single-threaded drain ([ADR-3](#adr-3-fire-and-forget-messaging)), not a return code the caller inspects.

Perl Tachikoma's [`fill` *does* return values](tachikoma-lineage.md#fill-returns-nothing) (`return $self->SUPER::fill(...)`,
`return $self->cancel(...)`) — an artifact of Perl having no way to declare a `void` return,
so every sub yields its last expression whether or not anyone is meant to read it. Nothing
downstream reads them; they are internal bookkeeping leaking into the signature.

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
reply ([ADR-7](#adr-7-sink-vs-target-and-tofrom-replies)) or a `TM_ERROR` (ADR-3) routed back through the graph, observable and loggable
like any other traffic — not a hidden return value.

**Consequences:** Outcomes are always messages, never return values; errors flow as
`TM_ERROR`, not an error code the caller reads. Testing a node stays "construct a message,
call `fill()`, inspect the *sink*" — never "inspect `fill()`'s return."

**Revisit if:** a node genuinely needs a synchronous in-process answer from its sink that
cannot be expressed as a routed reply. None does: the reply channel absorbs every case.

---

## ADR-14: Cooperative-stop propagates through broad catches

**Status:** Accepted

**Context:** [`Event_Framework::stop_check()`](../includes/class-event-framework.php) raises [`Worker_Should_Stop`](../includes/class-worker-should-stop.php) from inside a long
in-process job to unwind the worker's `fill()` stack and stop cooperatively (timeout / memory
/ shutdown). It extends `\RuntimeException`, so any broad `catch (\Throwable|\Exception)` on
the drain path catches it — and if that catch treats it as an error, the stop is swallowed.

**Decision:** A broad catch on the message/drain path re-throws `Worker_Should_Stop` before
handling anything else — `catch (Worker_Should_Stop $e) { throw $e; }`. A catch that prints,
returns a default or drops a throwable swallows it; a catch that turns it into a result the
caller sees — a TM_ERROR reply, a refusal — translates it and stays.

A loop that must attempt every step collects what the steps threw through
`Worker_Should_Stop::attempt_each()`, which keeps each failure under its item's key — or
`attempt()`, its form for a fixed list of closures — and raises it after the last through
`Worker_Should_Stop::raise()`, which ignores the keys: fan-out through `Fanout_Targets` (Tee, Tap and
`send_signed()`), `Settings_Sync_Node` over its options and their mappings,
`Vault_Group_Node` forwarding a config verb to its children, `LRU_Cache` over its evict
callbacks, and `HTTP_Out_Node` over the reply lines of one POST. `Worker_Should_Stop::combine()`
is the one rule for what escapes. Only when every catch is clean is the result clean. Any stop
among them makes the result a stop, carrying every failure — each non-stop throwable and each
stop's own previous — as its previous, one or all of them as `Failures`; a plain stop already
carrying exactly those, a `Failures` included, is raised as it came. With no stop, the
failures propagate as they are. A `Worker_Should_Stop_Clean` carrying a previous is not clean
(`Worker_Should_Stop::is_clean()`), because PHP chains an in-flight failure onto a stop thrown
in a `finally`, and every reader deciding to commit past a message asks that predicate. Nothing
caught is dropped: `Failures::all()` keeps every member, and only its message is bounded, at
64 KiB, counting the members it leaves out. `Deferred_Clean_Stop::deferring()` applies the same
rule to a snapshot node's message, after turning each held bare plain stop
(`Worker_Should_Stop::is_bare()`) clean.

A fan-out offers every item a stop included, because each target must see the message. A long
work loop is the other contract: `Worker_Should_Stop::attempt_until_stop()` collects every
failure the same way but returns at the first stop, so the stop is honoured before the next
item's work begins and the items never offered are the successor's to replay.

No site carves itself out. Two look as if they do. `Job_Worker_Node`'s `after_job` fires
whether the handler returned or threw, and a listener that throws joins the job's own outcome
through `raise()`, so neither masks the other. Event-logger-nodes' `Log_Manager::finish()`
writes the terminal whatever the drain threw, because terminal-last is a wire contract, then
raises both through `raise()`. The lifecycle attempts every step the same way: the reconcile
pass, `Worker_Base`'s shutdown and its sweepers, `Core::cleanup_all_nodes()`, the probes'
sweep and `Job_Intake::close()`.

![The rule as a decision: inside a broad catch on the drain path, a Worker_Should_Stop is re-thrown as control flow and anything else is propagated or translated into a result the caller sees; the failure prevented is a worker draining on past max_runtime or the memory watermark. Attempt-all loops — fan-out through Fanout_Targets, Settings_Sync, Vault_Group_Node::forward(), LRU_Cache eviction and HTTP_Out replies — attempt every step and raise everything caught after the last, Tap performing its passthrough first and adding its failure to the list. No carve-out: Job_Worker_Node's after_job joins a listener's throw to the job's own, and a before_job throw fails the job. Log_Manager::finish in event-logger-nodes writes the terminal whatever the drain threw, then raises both. A table for Worker_Should_Stop::combine shows nothing caught raising nothing, only bare clean stops raising the first clean stop, any stop among anything else raising a plain stop carrying every failure, and failures alone raising the one failure or all of them as Failures.](img/adr-stop-precedence.png)

**Alternatives considered:** A marker interface / `Control_Flow` exception base caught separately
— premature: the control-flow family today is `Worker_Should_Stop` plus its subclass
`Worker_Should_Stop_Clean`, so one explicit-first catch on the parent already covers both. A
third, unrelated one can share that pattern, or introduce the base then. Ranking what an
attempt-all loop caught and raising the one throwable an `outranks()` comparison judged safest
— rejected: every failure but the winner was dropped, so a fan-out reported one target's
failure however many had failed, and which one depended on the ranking rather than on what
broke. `combine()` raises all of them instead.

**Consequences:** Cooperative stop is guaranteed on every drain path, not just the direct
firehose write. Broad catches stay legal for real errors but must front the WSS re-throw.

**Revisit if:** a second control-flow exception appears (introduce a shared base and catch it).

**Amendment:** a snapshot node's save may write, and the checkpoint is not a stop boundary. A
reader co-commits each snapshot node's `save_state()` into its checkpoint frame, and one node
needs work to land before the cursor does: event-logger-nodes' `Flame_Builder_Node` writes its
pending buckets and per-URL stats to its stats Tables inside `save_state()`, because what the
checkpoint does not carry is lost to the successor once the cursor has passed it. A stop raised
while those writes run would split the state the save produced from the frame meant to carry it. [`Consumer_Node::write_checkpoint_frame()`](../includes/class-consumer-node.php)
therefore runs the saves and the commit inside [`Event_Framework::uninterruptible()`](../includes/class-event-framework.php),
a scoped window in which `stop_check()` — and so `pump()` — raises nothing, as it already raises
nothing while `Core::in_stderr()` holds. A held check leaves the pump throttle where it was, so a
stop that fell due inside the window raises at the first pump after the commit, with the frame
already durable. No snapshot node needs a bracket of its own for its save. Tachikoma's
`Nodes/Consumer.pm` is the precedent: `commit_offset` calls the edge's `on_save_snapshot` inside
the commit, before it fills the frame to the offsetlog, so the save runs as the commit's own
pre-commit step rather than as a getter the reader reads afterwards. Forbidding a writing save
was rejected: the flame builder's writes must land before the cursor, and a stop between a
commit and writes made after it loses what the checkpoint no longer carries. Holding the stop
per node — a bracket each snapshot node carries around its save, which the reader finds by
probing for the method — was rejected: it puts the checkpoint's integrity in every snapshot node
rather than in the one writer that owns the checkpoint. Revisit if a second node needs work to land before
its cursor, which would earn a declared pre-commit hook in place of a save that writes, or if a
save grows long enough that holding a due stop across it outlasts the worker's deadline.

A snapshot node's handling of the record the cursor still points at must be idempotent
([`Durable_Reader::add_snapshot_node()`](../includes/trait-durable-reader.php)). A plain stop —
one carrying a failure, or any stop outside a `deferring()` bracket — leaves the cursor on the
in-flight record, so the successor restores a state that may already hold it and replays it on
top. The current nodes meet this three ways: `Flame_Builder_Node` skips a record whose crumb
matches its saved `$counted`, `Request_Builder_Node` drops a line whose sequence number it
already folded, and newspack-intelligence's `Digest_Builder_Node` skips an item its `seen` map
already holds.

---

## ADR-15: Command authorization: LOCAL taint + the minter signs

**Status:** Accepted

**Context:** A command is graph construction with full interpreter authority — `make_node`,
`connect_node`, the config verbs. The *same* [`Command_Interpreter_Node`](../includes/class-command-interpreter-node.php) class runs in two
trust roles: in-process, where the browser console and the bare `wp nodes cli` mint their own
commands, and over the wire, where a worker reads them off an IPC partition and the
[`/command`](API.md#command-dispatch) request-scope CI reads them out of an HTTP body. WordPress authentication answers
"who is this request?" at the REST boundary. It cannot answer "who minted this message?",
and the two come apart the moment a message crosses an IPC partition into a worker that has
no request context at all. In-process provenance is free — a Shell knows what it minted.
Across a process boundary nothing survives that a sender could not equally forge.

**Decision:** Two tiers, keyed to whether an interpreter can trust its own process. The gate
is a per-instance `authorize` closure (`$this->authorize ?? self::$default_authorize`, falling
back to the bare LOCAL test), checked for EVERY command in `interpret()`; a refusal returns
`unauthorized: <verb>` instead of dispatching. The minter signs; the ingress only verifies;
and which key signs IS the destination binding.

![The signing string as four signed slots, ts, name, arguments and nonce, beside two excluded ones, TYPE and TO/FROM, with the reason each is left out. Two tiers: the client tier's Message::LOCAL at index 7, stamped by a Shell and by cmd_reply_to and sliced off before any wire; the server tier's Command_Auth::verifier, which accepts LOCAL or an envelope at VALUE['auth'] checked for age within 20 seconds past and 10 ahead, a matching HMAC, a nonce claimed once at NONCE_TTL_S 60 through local_first, and a handle whose scope Command_Auth::check() installs as the command's ceiling. Two keys: the per-site secret with no handle for the attached cli over IPC, and a session key from POST /v1/auth with a 16-byte handle, a 32-byte key, add() never set(), TTL 3600 clamped to 60..86400; sign_for( $destination ) pins a command to one remote and a missing session kicks ensure_session() instead of emitting. Six rejected shapes close the sheet.](img/adr-minter-signs.png)

In-process, `Message::LOCAL` (index 7) is the client tier. Two sites stamp it: a `Shell_Node`
on the command it mints from a console line, and `Command_Interpreter_Node::cmd_reply_to()` on
the sub-command it re-addresses, which is safe because the outer `reply_to` has already cleared
the same gate and a nested `reply_to` is refused. The default policy is
`isset( $message[ Message::LOCAL ] )`. Across a boundary, verifier processes install
`Command_Auth::verifier()`, which accepts LOCAL or a valid HMAC envelope at `VALUE['auth']`;
the envelope rides inside VALUE, so it survives IPC where LOCAL is sliced off. The canonical
signing string is `JSON.stringify([ ts, name, arguments, nonce ])`, semantics only. PHP
encodes it with `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE` to match byte for byte, and
`tests/fixtures/signatures.json` pins that parity from both languages.

Two keys exist. `Command_Auth::sign()` uses the per-site secret and stamps no handle: that is
the attached cli's Shell, same host, over a filesystem-gated IPC partition.
`sign_for( $destination )` signs under the session established with one remote and stamps its
handle, and a signature under one remote's key verifies only there, which pins a command to
its destination without signing TO. A client establishes that session first:
[`POST /newspack-nodes/v1/auth`](API.md#establishing-a-session) returns `{ handle, secret, scope, expires_in, now }`, a random
16-byte handle and 32-byte key stored under a site-namespaced address with `add()`, never
`set()`, so a colliding handle fails instead of displacing a live session. The key is
disclosed as `secret` because that is the field name `Core::is_secret_property()` recognises,
and every redactor on both sides of the wire asks that one rule. The TTL is
`SESSION_TTL_S` (3600) unless the request asks for its own, clamped to 60..86400. Freshness is
an age check (`MAX_PAST_S` 20, `MAX_FUTURE_S` 10). The nonce is claimed once with an atomic
`add()` at `NONCE_TTL_S` 60 through `Cache_Backend::local_first()`, because a claim only has
to be unique to the process that verifies it; sessions go through `shared_first()`, because a
session minted in a web request must resolve in a worker.

**A session's SCOPE is a ceiling, and that is why the gate is READ.** The route sits behind
[`Bootstrap::fleet_gate()`](../includes/class-bootstrap.php) — the fleet is network-global, so a subsite admin must not mint
against the main site's fleet — and then behind [`Capabilities::READ`](../includes/class-capabilities.php) rather than MANAGE: a
session minted by a read-only user can only ever do read-only things, whatever it asks for.
`issue()` clamps the requested scope to the highest of `read`/`tune`/`manage` the minting user
holds and refuses an unrecognized one, so the Sessions tab lists real authority rather than an
aspiration. The scope rides in the stored record, never in the envelope, so the holder of a
key cannot restate it: `Command_Auth::check()` installs the verified scope as
`Capabilities::$session_scope` for the command being handled, `verify()` slams it to
`Capabilities::NONE` on every refusal, and `interpret()` restores whatever stood before,
without which a worker would sit at its first caller's ceiling for its whole ~595s life.
A command signed under the per-site secret carries no handle and no ceiling: that is the site's
own authority. The `now` in the auth reply lets
the client align its TIMESTAMP to the verifier's clock, and the TTL is never slid on use, so a
leaked handle expires on a bounded schedule no matter how busy it is.

No session means no signature, and waiting alone DEADLOCKS: every minter refuses to queue
unsigned and nothing else would ever ask for the handshake, so the skip branch has to kick it.
A minter resolves its egress by running the target's head segment through `Core::node()`,
type-tests the result for `HTTP_Out_Node`, and calls
[`HTTP_Out_Node::ensure_session()`](../includes/class-http-out-node.php), which exists for that and nothing else: it fires the node
when `Command_Auth::has_session()` says there is none. [`Fanout_Targets::send_signed()`](../includes/trait-fanout-targets.php)
is that loop, written once: `Settings_Sync_Node` and ELN's [`Discovery_Collector_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/4437e383/includes/class-discovery-collector-node.php) both mint through it,
so a third minter calls it rather than copying the shape. On the JS side [`Node.command( name, args )`](../src/runtime/node.js)
builds the TM_COMMAND, stamps FROM from the node's name and TO from its target, and hands back
the message signed and LOCAL-marked — or null when `readyToMint()` finds no session, having
asked for one on the way. Signing is synchronous and cannot await `/auth`, so a null is the
caller's cue to hold and retry on a later tick rather than to emit: `PollerNode.fire()`
re-arms with `markDue()`, `HeartbeatNode` skips that poll, and `RemoteIpcNode` defers its
`connect_worker_input`. Nothing throws, and a JS node minting its own command goes through
`Node.command()` rather than hand-building a message.

Every failure refuses, and most name themselves through the handling interpreter's
`drop_message`: wrong type, bad envelope, stale or skewed timestamp, unencodable arguments
(logged as `invalid signature`), signature mismatch. An unknown or expired handle and a
replayed nonce log nothing, and a missing cache backend logs through
`Core::print_less_often()`, an environment fault rather than a verdict on the message.
[`HTTP_In`](../includes/rest/class-http-in-node.php) installs a fresh verifier per request and latches any refusal, so a batch
containing one answers **401** rather than a reassuring 202.

**Alternatives considered:**

- **Signing at the ingress**, letting `HTTP_In` confer authority after WordPress auth —
  rejected: it makes the boundary an ORACLE. Anything reaching it acquires authority regardless
  of what put it there, so a wire-arrived frame routed into the egress would go back out signed.
- **LOCAL alone, everywhere** — rejected: LOCAL cannot cross a process boundary, which makes it
  trustworthy in-process and useless to a worker that legitimately receives commands over IPC.
- **One shared site secret for every client** — rejected for browsers: anything shipped to
  wp-admin is readable by whoever sits there. A session key is a capability scoped to one
  session with a bounded life; the per-site secret survives only where the signer is already
  inside the trust boundary, same-host IPC.
- **Signing TO / FROM / TYPE** — rejected: Router peels TO and nodes stamp FROM in transit, so a
  signature over them breaks in flight, and TYPE is envelope too, left out so a mint can sign at
  build time before flags are OR'd in. Tachikoma's `Command.pm::sign` covers
  `id:timestamp:name:arguments:payload` for the same reason.
- **Asymmetric signing (Ed25519)** — rejected even for hub-to-spoke authority through
  `sign_for()`: both ends of a session are one trust domain, since the site that minted the key
  verifies it. Public-key signing buys non-repudiation and third-party verification, which no
  consumer needs, at the cost of a key-distribution problem.
- **`crypto.subtle` in the browser** — rejected: it returns promises, and awaiting one makes the
  Shell's dispatch async, moving every graph mutation a microtask later. The browser signs with
  synchronous `@noble/hashes`.
- **Filesystem permissions alone for IPC** — rejected as sufficient: they gate the directory,
  not the message. They remain the first gate; the signature is what makes a command believable
  however it reached the partition.

Stated non-goal: HMAC-SHA256 at every tier; no asymmetric signing anywhere.

**Consequences:** `Message::LOCAL` at index 7 is the one field outside [ADR-2](#adr-2-one-message-format-the-7-field-positional-array)'s seven, and it
exists solely for this decision — nothing else may be appended on that basis, and nothing may
rely on it surviving a boundary. A client must establish a session before it can mint at all,
and a minter without one skips instead of emitting, asking for the handshake as it goes.
Cross-port canonical parity is a standing maintenance obligation: each language's own suite
stays green through a drift only the shared fixture catches. A re-credentialed or removed
Vault entry must forget its session (`newspack_nodes/vault/changed`), or the next command
signs under a key the far side has already forgotten.

**Revisit if:** a party that cannot hold the signing key must verify a command — that is what
asymmetric signing buys, and it would earn its keep then — **or** a command must be
authorized between two sites that share no secret, **or** session state needs to outlive the
cache tier it lives in.

**Amendment:** a browser's stream presents its command session, `session=<handle>`, and that
handle is the head its attached replies carry ([ADR-7](#adr-7-sink-vs-target-and-tofrom-replies)). Verification is unchanged: the
head rides in FROM, which is never signed. On the stream side
[`SSE_Out_Node`](../includes/rest/class-sse-out-node.php) resolves the presented handle through
`load_session_record()` and answers `401 sse_session_refused` unless the record is live and
was minted by the user the request authenticated as. The slot lease is keyed by
the session too, qualified by a stream id the client names: a reconnect takes its own live
lease over and rotates the owner, while two streams on one page keep two leases. The old
process's next check fails and reads the lease as `superseded`, so it closes quietly rather
than holding a second slot until it notices the drop.

---

## ADR-16: JS node-class resolution — names are the TSL surface, classes are the API

**Status:** Accepted

**Context:** The browser runtime resolves `make_node <Type>` through
[`CommandInterpreterNode.includeNodes`](../src/runtime/command-interpreter-node.js), a per-bundle static each bundle extends at import time
via `registerNodeClasses()`. It works for TSL and the console palette, where the graph is
authored as text and the interpreter reading it is the one whose bundle registered the class,
and fails the moment a graph is built through *someone else's* interpreter. [ADR-10](#adr-10-class-naming--make_node-namespace-resolution) governs
the PHP side and explicitly refuses a class map; the JS side has one, and this is its
consequence.

**Decision:** A NAME is for the text path — TSL, the palette, `make_node` typed in the REPL.
A programmatic builder hands `makeNode` the **class itself**.

![Two bundles on one page, each with its own includeNodes table: the station backbone's holds the runtime's classes plus JobstatsView, the topology console's holds the runtime's plus ClassCatalogView, so a hook asking the backbone's interpreter for makeNode('ClassCatalogView') gets unknown class at runtime with every test green. The decision card shows makeNode accepting a class, the three conforming shapes, and the exported views map; the enforcement card names lint-contract's name-lookup-in-hook and name-lookup-in-option rules and when they stand down. Three rejected alternatives close the sheet.](img/adr-name-vs-class.png)

Where the class is imported from is the bundle's business, and three shapes conform. Views
written out as classes register the map and export it
([`src/event-dashboards/nodes/register.js`](../src/event-dashboards/nodes/register.js)):

```js
const OWN_CLASSES = { JobstatsView: JobstatsViewNode /* … */ };
CommandInterpreterNode.registerNodeClasses( OWN_CLASSES );
export const views = { ...OWN_CLASSES, ...registerSliceViews( { /* … */ } ) };
```

Views declared as slices let `registerSliceViews()` build each class, register the map and
return it ([`src/topology-console/nodes/register.js`](../src/topology-console/nodes/register.js)):

```js
export const views = registerSliceViews( { ClassCatalogView: { empty, parse } } );
```

A bundle whose views each have a module of their own imports them from those modules, and its
`register.js` registers without exporting anything. `examples/example-ai-newsletter` is that
shape: [`usePublisherInsightsGraph`](../examples/example-ai-newsletter/src/dashboard/hooks/usePublisherInsightsGraph.js) imports `SourceCountsViewNode` and its two siblings into
the `viewClass` entries of its `SLICES` table, and imports `../nodes/register` for the
registration side effect alone. All three conform; what this ADR forbids is the NAME, never a
particular import path.

`makeNode( type, name, args )` accepts either: `'function' === typeof type` selects the class
and skips resolution, so registration stays required for TSL and the palette while no hook
depends on it. [`scripts/lint-contract.mjs`](../scripts/lint-contract.mjs) enforces the rule: `name-lookup-in-hook` catches a
name passed to `makeNode`, and `name-lookup-in-option` catches one a hop out, in a hook
option's `viewClass` / `viewType` / `nodeClass`. Both read their builtin allow-list from
`includeNodes`'s own declaration, and both stand down behind a one-line `console.warn` when no
substrate is in reach to read it from, which is the standing state for pyrobase,
nuclear-gyrobase and cache-cozy; the other rules keep running.

**Alternatives considered:** A window-global registry, as
[`src/shared/tabs/tabRegistry.js`](../src/shared/tabs/tabRegistry.js) uses for tabs — rejected for classes: it makes every
bundle's node classes globally visible and collides on name, the ambiguity the per-bundle
static avoids; a station tab is meant to be reachable across bundles, and a view class is not.
Requiring every bundle to register every class — rejected: it couples each plugin's build to
the union of all of them, and the failure stays silent until the missing one is asked for.
Resolving names lazily against a chain of interpreters — rejected: it re-invents dynamic scope,
and picks arbitrarily between two bundles that both registered the name.

**Consequences:** A view class reaches its hook as an IMPORT — off a `views` map, or straight
from the module that defines it — so a dead one is a normal unused-export finding instead of a
name nobody notices is unreachable. A hook that still passes a name fails the contract gate
rather than the browser. Treat the builtin keys of `includeNodes` as reserved: registering
`Tee` replaces the runtime's `Tee` for every later `make_node Tee` in that bundle, with no
warning.

**Revisit if:** the runtime gains a single cross-bundle class registry with collision handling
— then names become safe again everywhere and the rule retires with the decision.

---

## ADR-17: Timers fire on a shared wall-clock grid

**Status:** Accepted

**Context:** Every browser poll rides the `_router` TIMER, and `HTTP_Out` batches whatever was
minted during one tick into a single POST. A hitchhiking timer whose interval exceeds the 1s
tick throws that benefit away the moment it paces itself from its OWN last fire.

**Decision:** [`TimerNode.fireCb()`](../src/runtime/timer-node.js) fires on a boundary of a wall-clock GRID, not on elapsed
time since its own last fire, with ONE phase (`GRID_PHASE_MS`, 360) serving every cadence:
`nextBoundary( after, intervalMs )` is
`( floor( ( after - phase ) / interval ) + 1 ) * interval + phase`. The grid lives in
`TimerNode` alone; a subclass picks a harmonic interval and never computes a boundary.

![A 32-second chart. Self-paced, two 5-second polls armed at :02 and :04 fire on alternating seconds forever, two POSTs per period. On the grid, the same two converge on the same boundaries after one short first period, and 10, 15 and 30-second cadences armed at arbitrary moments all meet at 30.36 seconds. Cards give the rejected self-pacing, per-interval phase, shared scheduler and snap-to-first-tick; the nextBoundary formula and its grid-math lint rule; markDue and markFired; and the one cost, a possible double fire at mount.](img/adr-timer-grid.png)

The grid is a pure function of the clock, so two timers on one cadence converge with nothing
shared, nothing persisted and no coordination — the same property that lets [`LRU_Cache`](../includes/class-lru-cache.php)'s
bucket rotation survive a process restart with its predecessor's phase intact. The
[`grid-math`](../scripts/lint-contract.mjs) rule reads JavaScript alone, matching the camelCase `nextBoundary` and
`GRID_PHASE_MS` under `src/` and `examples/`, and the invariant is scoped to match:
`LRU_Cache::next_boundary()` is a second grid on the PHP side, on purpose.

**Alternatives considered:** Pacing each timer from its own last fire — rejected: when a
surface opens then decides which second it polls in, so a 5s catalog opened at :02 and another
at :04 never share a tick and each pays its own POST forever, which no test sees because every
poll works. A per-interval phase — rejected: it slides each cadence a few hundred milliseconds
off the others and destroys the harmonics, where one phase makes every second 5s boundary a
10s one and every sixth a 30s one. A shared scheduler node every timer registers with —
rejected: the Router already is the one heartbeat, and a second coordinator is state where
arithmetic suffices. Snapping each timer to the first tick after arming — rejected: it makes the
phase depend on when a surface opened, the failure the grid removes.

**Consequences:** The first period after arming is the short remainder of the one the timer
opened in, so a poll can fire twice in quick succession at mount; a test asserting no second
fire pins the clock FORWARD to just past a boundary. `PollerNode`, `MetadataNode`,
`useRouterTick`, `useBatchedPoll`'s `pollNow()` and the topology console's `cd` refresh all go
through `markDue()` / `markFired()`
rather than pacing themselves.

**Revisit if:** the runtime gains sub-second cadences, where a 360ms phase is a large fraction
of a period and the grid would need its own scale.

---

## ADR-18: A Table can front a durable record; the walk that finds it stays in the app

**Status:** Accepted

**Context:** Read-through over a durable system of record — read a keyed store, miss, fall
back to the record, store the answer back — has two consumers in `newspack-event-logger-nodes`:
[`Rule_Set::hooks_for()`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-rule-set.php) over a non-autoloaded option, and the `performance` CI's `urls`
page cache over the page it builds. An idea two consumers in one plugin both need belongs lower
down. The Partition half below was written for a third, event-logger-nodes' stats mirror, which
needed key translation, TTL decay and a scope guard; the mirror's successor reads durable
Tables ([ADR-24](#adr-24-a-tables-backend-is-chosen-per-table)) and calls neither `locate_by()` nor `read_many()`, which
stay while a released event-logger-nodes still calls them. A restored entry needs the life it has
LEFT, and `Table_Node` fixes TTL at construction, so without a per-entry lifetime a consumer
reaches past its own store to write, through
[`Cache_Backend::shared_first()->set()`](../includes/class-cache-backend.php) with a hand-rolled `str_starts_with` namespace
check. Reaching under your own abstraction to write is the tell that it stops one parameter
short.

**Decision:** [`Table_Node::backed_by( \Closure $backing )`](../includes/class-table-node.php) on the read path, and
[`Partition_Node::locate_by( \Closure $extract, array $wanted )`](../includes/class-partition-node.php) + `read_many()` underneath.

![Eight hops across four lanes: the caller, Table_Node, the backing closure and Partition_Node. A miss, an expiry and a backend read error all fall through the backing; MGET asks once for every miss; the app calls locate_by with its line parser and the wanted keys, bounding the walk, and reads by key never by position; Partition walks the .idx sidecars newest-first so the first hit is the last write, skipping a segment whose index is unreadable; a class-level memo keyed by directory records what was found and what was searched and is discarded on a new extent or past MAX_LOCATOR_MEMO_KEYS 100,000; read_many reads one handle per segment; a spent ttl is served and not warmed while live entries are warmed grouped by lifetime, best-effort; a miss is never remembered, so every one reaches the backing; the caller cannot tell a backed miss from absent everywhere. Cards give the one wrong answer, the rejected shapes and why the remaining-TTL and newest-record rules are one rule.](img/adr-table-backing.png)

That does not reopen "one table, one lifetime", which governs what a CALLER stores: a
backing is re-materializing an entry that already had a life, and handing it a fresh full
TTL would extend what it is restoring. A spent remainder (`ttl <= 0`) is SERVED and not
warmed: a stated `ttl` bounds the cache and decays from the write, which says nothing about how
long the record is still read. Refusing it would make an evicted hourly URL index unrecoverable
from the fine buckets it derives from. What a re-materialized entry is warmed for is the
BACKING's to state, and the same call site is where a footprint bound belongs. Warming is
best-effort: a backend that went away must still serve the record the backing read, or a cache
failure becomes a data failure.

Finding WHICH durable record answers a key is the app's business, not the table's.
`Partition_Node` treats index lines as opaque strings because the formatter that wrote them
belongs to the caller (`with_index`), and a key is as opaque to Partition as a line is. The
memo caches "this index did not answer for this key" per process and never "this record does
not exist"; PHP statics end with the request, so it spares repeats inside one read and nothing
across reads.

A miss is never remembered. A key the backing does not return writes nothing to the cache,
so every read of it reaches the backing again, and the table reserves no value: whatever sits
in an entry's slot is data. A backing that could not look — a spent budget, a partition not
yet resolved — answers null, and the read is a miss; null and an empty answer reach the
caller alike, and the table stores nothing on the strength of either. `tests/unit/TableNodeTest.php`
pins each rule.

A failed cache read is a failed read only when a key went unread: a `GET` or `MGET` request
answers `TM_ERROR` when the arm failed and no backing looked at the misses, so a read the
backing answered is a read that succeeded.

`locate_by()` resolves a key to its NEWEST record in one newest-first pass, because the
remaining-`ttl` rule reads the lifetime off whichever record the key lands on: an older write
would make a live entry read as expired and vanish silently.
`tests/unit/PartitionTest.php::test_locate_by_resolves_a_repeated_key_to_its_newest_record`
pins it.

**Alternatives considered:** Leaving it in the application — rejected: two consumers in one
plugin need it, and each copy carries its own key translation, TTL decay and scope guard.
Pushing the line format down, so Partition parses index entries — rejected: every consumer's
fixed-width layout would land in the substrate, and the formatter is the caller's
(`with_index`). Letting the backing write through `store()` — rejected: `store()` applies the
table's TTL, which is exactly what a restore must not do. Remembering an absence in the table,
as a marker in the key's cache slot — rejected: the slot is shared with the values writers
store there, so keeping one reader's marker from hiding a writer's value took four rules and a
non-atomic `replace_absent()` with two races of its own, and no caller needs it. A backing whose
misses cost a walk bounds that cost itself, where it knows which keys can still gain a record.

**Consequences:** A table with a backing cannot report a miss the caller can
distinguish from "absent everywhere" — that is the point. The backing is invoked on the read
path, so a slow system of record becomes read latency; `MGET` batching keeps that to
one walk per read rather than one per key. A key the record does not hold costs that walk on
every read, because nothing records that it was absent.

**Revisit if:** a backing whose cost makes synchronous read-through wrong — at which point the
fill belongs on a queue rather than in `lookup()` — or a caller whose repeated absent keys cost
more than its backing can bound. Remembering them in the table again needs a marker no writer's
value can collide with and no other table sharing the key can read as a value or a miss.

---

## ADR-19: A node may DECLARE a destination it writes without routing

**Status:** Accepted

**Context:** [ADR-7](#adr-7-sink-vs-target-and-tofrom-replies) splits destinations two ways:
`sink` is the physical next hop, `target` is the logical TO path. A third kind exists in
practice, and neither names it: `Flame_Builder_Node` addresses each of its three stats Tables
through a per-message TO its `Table_Client` stamps, and `Request_Builder_Node` stamps TO per
message from one of four routes. Without a declaration the console draws those destinations with
no inbound edge while they fill.

**Decision:** [`Node::extra_targets(): list<string>`](../includes/class-node.php) is a DECLARATION, not a route.
A node returns the destinations it writes without going through `target`;
`Node::display_targets()` unions them with `target_list( target() )`, primary first,
de-duplicated, empties dropped, and only presentation reads the union: `ls`'s TARGET column
and `dump_metadata`'s `targets` key. `fill()` reads `$this->target` alone. This licenses no
second physical output: ADR-7's reopen condition stands, and a node filling a destination
directly, past its sink and past a TO, is the case that would trigger it.

![Three destination kinds side by side: sink, the physical next hop; target, the routing contract fill() reads and dump_config round-trips; and extra_targets(), the destinations a node writes without routing, such as the stats Tables Flame_Builder_Node addresses through a per-message TO and Request_Builder_Node's per-message TO. display_targets() unions target_list( target() ) with the extras, de-duplicated, for ls's TARGET column and dump_metadata's targets key only. Three slot rows show the union is positional: index 0 is the routing target only when one is set. Cards give the rejected alternatives and why this licenses no second physical output.](img/adr-display-targets.png)

**Alternatives considered:** Widening `target` to hold the extras — rejected: it is the
routing contract, `dump_config()` round-trips it as `connect_node` lines, and a display-only
entry would replay as a route that does not exist. Having the console infer edges from node
class — rejected: it puts one plugin's write topology inside the substrate's renderer, the
boundary [ADR-18](#adr-18-a-table-can-front-a-durable-record-the-walk-that-finds-it-stays-in-the-app) draws for `locate_by()`. Letting each dashboard synthesize the
missing edges — rejected: three consumers would draw three shapes, and only the node knows where
it writes.

**Consequences:** A node's declared extras and its actual writes can drift, and nothing detects
it — the declaration is prose the class keeps honest. `display_targets()` is not a routing
surface and must never acquire a caller in `fill()`. A consumer needing the routing value
reads `target`; one that must split the union splits by the routing COUNT, never at a fixed
index.

**Revisit if:** anything routes on `display_targets()`, at which point the two planes have
merged and ADR-7 is the decision in play; or if `edge` is reintroduced, which would absorb the
physical-write case and leave only the conditional-TO one.

---

## ADR-20: A config default lives in CODE; every config file is an override surface

**Status:** Accepted

**Context:** When the valid key set derives from the config FILE —
`array_keys( load_config_defaults() )` — the file is at once the override surface and the
declaration, and that coupling fails two ways, both of which have shipped. Forward: a deploy
preserves the operator's file, so a key added after it was copied never appears there, and a
default living only in the file reads null forever; `sse_idle_timeout` sat inert that way,
silently, for weeks. Backward: an operator's typo declares itself; `base_directroy` becomes a
valid key, the real `base_directory` falls back, and the runtime writes its whole tree
somewhere else with nothing in the log. With the file as the declaration, an environment
without one declares nothing at all, and the first `Config::value()` throws
`unknown config key` on every request, wp-admin included, as Nuclear Gyrobase's did.

**Decision:** The schema declares every key AND its default, in code, and
[`Config::declare_keys()`](../includes/class-config.php) derives the valid key set from
[`Settings_Schema`](../includes/class-settings-schema.php), never from a file. Every config file — the one in the plugin,
[`newspack-nodes-config.php`](../newspack-nodes-config.php), and the operator's — is an override surface and nothing more, and
an unrecognized key there is REPORTED, never thrown: `newspack-nodes.sh`, `newspack-pyrobase.sh`
and `newspack-nuclear-gyrobase.sh` all `cp -f` the deployment's own file over the shipped
path, so that file is the operator's, not ours. The first read is at `plugins_loaded:-10001`,
where a throw would take down every request including wp-admin the day a key is renamed,
recoverable only over SSH; the report is rate-limited and surfaces in Site Health and
`wp nodes doctor` as `config-keys`. It covers the shipped file alone:
`note_unrecognized_keys()` runs before the `LOCAL_NEWSPACK_NODES_CONF` layer applies, so a
typo in a local override is neither reported nor refused.

A plugin declares defaults one of two ways, both first-class. Where a
[`Config_System\Field`](../includes/config-system/class-field.php) carries the default, [`Schema::defaults()`](../includes/config-system/class-schema.php) is the base
(newspack-nodes, newspack-event-logger-nodes); otherwise a static `Config::config_defaults()`
array is (newspack-nuclear-gyrobase, which has no Field layer, and newspack-pyrobase).
Declaring a key in both places is the drift this ADR exists to prevent.

![Four layers stacked weakest first: Settings_Schema in code, the shipped newspack-nodes-config.php that a deploy replaces with the operator's own, the file LOCAL_NEWSPACK_NODES_CONF names, and a stored newspack_nodes_<key> option that wins by presence. The unknown-key report runs on the shipped file before the local file is applied. Side cards: the two declaration shapes, Schema::defaults() or a config_defaults() array; reading through a helper that falls back to the declared default. Three rejected shapes: the file as declaration failing forward (sse_idle_timeout inert) and backward (base_directroy self-declaring), and throwing on an unknown key, a card that also rejects putting every default in a Field, since pyrobase would carry 71 Fields no page shows. A note: uninstall never resolves the schema default.](img/adr-config-layers.png)

A key with no sensible universal value declares `null`, and that is not a missing default:
per-deployment identity has no default that is right anywhere else, and committing one
deployment's value as "the default" is worse than declaring none. The test is evidence, not
taste: a key every deployment overrides is identity.

**Alternatives considered:** Keeping the file as the base and adding a completeness test —
rejected: the test sees only the file in THIS checkout, and the failure is on an installed host
whose file is older. Throwing on an unknown file key — rejected: it converts an operator typo
into an outage, and the file is not ours to validate that strictly. Registering the file's keys
so nothing is ever refused — rejected: that is the backward failure, making typos
self-declaring and silently shadowing the real key. Putting every default in a `Field`,
including for plugins with no settings UI — rejected: pyrobase declares 86 config keys and
renders 15 as settings, so it would carry 71 Fields no page shows, and nuclear has no Field
layer at all.

**Consequences:** `Field::$default` is `mixed`, so array, string and bool defaults are
declarable alongside the int ones. `Schema::defaults()` OMITS a keyed Field written without
`default:`, which makes that key null on every install — a plugin using it as its base must
assert completeness itself; the shared `Schema` cannot enforce it, because plugins whose
defaults live in a `config_defaults()` array legitimately declare none. A reader must not
fall back to zero where the schema declares a value, and uninstall must not treat the schema
default as "this install's directory".

**Revisit if:** a plugin needs a default that genuinely cannot be expressed in code — a value
derived from the host at runtime — at which point the answer is a resolver called from the
declaration, not a value in a file.

---

## ADR-21: A node may derive its children from the Vault, and static analysis reads it

**Status:** Accepted

**Context:** A hub pulls every spoke's firehose through one `Remote_Source` and pushes
settings to every spoke through one `HTTP_Out`, and each was a hand-repeated TSL leg per spoke.
The spoke list therefore lived twice — in the [Vault](../includes/class-vault.php), which holds
each spoke's URL and credentials, and in the TSL — and adding a spoke meant editing the Vault,
regenerating the TSL, redeploying and restarting. Static analysis reads only TSL text: the
write set, `find_conflicts()`, `Log_Cleaner`'s GC and the console graph all take their nodes
from the flattened statements, so a node that builds children at runtime is invisible to every
one of them unless the flatten knows how to see it.

**Decision:** [`Vault_Group_Node`](../includes/class-vault-group-node.php) owns one child per
server `Vault::in_group()` returns, each published as an owned sibling
(`Node::publish_sibling()`) named `<group>:<vault id>`, and NOT patroned, so each keeps its own
`:config` interpreter and draws on the canvas like a hand-written node. It rebuilds its
children on the fleet's RELOAD through `update_graph()`, Tachikoma's `ConsumerBroker`
vocabulary: a new id is built and replays every recorded command and edge, a departed one hands
its cursor off and is retracted through its normal teardown. The sibling map is the one list
of members; `members()` reads it through `Node::siblings()`, in the order the group built them,
and answers `Node::members()`, the hook `Fanout_Targets` asks of every target, so a fan-out
connected to the group delivers to each member.

[`Topology_Analyzer`](../includes/class-topology-analyzer.php)'s flatten keeps each group
statement as written and appends the derived ones beside it — a child `make_node` per member,
and a per-child copy of each statement naming the group — through the same
`Vault_Group_Node::expand()` and `Node::sibling_name_of()` the runtime builds with, reading
membership through the same `Vault::in_group()`. The write set, conflicts, GC and graph
therefore see every member's cursor and every member's edge. `dump_config` emits only the
group and its recorded commands, since the group rebuilds its children from them.

Group configuration goes through the group: a verb sent to `<group>:config` reaches every
child and, when every child accepted it and it changed a child's configuration, is recorded
last-write-wins. A per-child verb sent straight to `<group>:<id>:config` is LIVE-ONLY — no
dump replays it, because `dump_config` replays the group and its recorded commands, never a
child.

**Alternatives considered:** Generating the TSL from the Vault — rejected: the list still lives
twice, and a spoke added to the Vault stays unwired until someone regenerates, redeploys and
restarts; the generator had also drifted, emitting `include` names no topology defines.
Hand-written legs per spoke — rejected: that is the problem. Patroned children — rejected: a
patroned node vanishes from the canvas and shares its patron's interpreter, so per-spoke
state and edges become invisible exactly where an operator diagnosing one spoke looks.
Runtime-only expansion, leaving the flatten alone — rejected: the write set would be blind to
every member's offsetlog and deadletter, and `wp nodes gc` would sweep live cursors once
`Log_Cleaner::DELETE_GRACE_S` passed.

**Consequences:** Analyzer output is no longer a pure function of the TSL text: it depends on
the Vault too, so the `newspack_nodes/vault/changed` handler resets the analyzer's
per-process caches before planning. A spoke dropped from its group has its cursor swept once
`DELETE_GRACE_S` passes, like any directory no active topology declares. Group semantics are
spelled twice — at runtime in the node, and in the flatten — so both call the one `expand()`
and the one sibling-name composer, and a change to either shape moves both. A group builds and
retracts members on RELOAD even after `secure`, because the topology declared Vault membership
before securing, and the Vault itself is MANAGE-gated — the same standing `Remote_Link` has when
it rebuilds its patroned siblings.

**Revisit if:** a second node type derives its children from runtime state rather than from
the TSL, at which point the flatten needs a general derivation hook instead of a
`Vault_Group` case; or analyzer results must be shared across processes, where a per-process
cache reset no longer reaches every reader.

---

## ADR-22: A worker id has one writer, one reader, and two layout owners

**Status:** Accepted

**Context:** A worker's id, `{type}.p{N}`, names its lock dir, its IPC tree, its liveness
keys, its REPL partition and its stop label. Each site that needed an id spelled it, and each
site that read one back carried a grammar of its own. They disagreed.
`connect_worker_input` and the SSE pool pick accepted only `[a-z0-9_-]+` types, so a dotted
or uppercase topology was refused or pooled under partition -1. `wp nodes cli`,
`wp nodes status` and the lock reconcile cast the partition through `(int)`, so `kea.p03`
read as `kea.p3` and an attach landed on an IPC tree no worker reads. Two grammars that
disagree let one pass retire a directory another pass never sees.

**Decision:** [`CLI::worker_id()`](../includes/class-cli.php) is the only writer of the id
and `CLI::parse_worker_id()` the only reader. The reader accepts exactly the strings the
writer can produce — a type holding no `/` or NUL, then the final `.p{N}` with no leading
zero — and answers null for anything else. Their JS twins, `workerId()` and
`parseWorkerId()` in [`src/topology-console/utils/scope.js`](../src/topology-console/utils/scope.js),
read one case list with the PHP pair, [`tests/fixtures/worker-ids.json`](../tests/fixtures/worker-ids.json).

Two layouts hang off the id, and each has one owner.
[`Spawn_Coordinator`](../includes/class-spawn-coordinator.php) owns the lock tree:
`locks_dir()` and `lock_path()` write it from a base directory, `signal_workers()` flags
the lock dirs `lock_path()` names, and `worker_lock_dirs()` walks it, each entry carrying
its `id`.
[`Worker_Base::ipc_dir()`](../includes/class-worker-base.php) builds every IPC path, its
`input`, `output` and `input.offsets` legs included, and `Spawn_Coordinator` is the one
class that walks the IPC tree (`cleanup_orphan_ipc()`), reads a worker back out of an IPC
path (`ipc_reader_of()`), or resolves a worker id to its channel (`worker_channel()`,
which wakes a sleeping on-demand worker and hands the `id` back with the channel). No other file globs, joins or
strips either tree. A process outside PHP receives type, partition and the resolved
directory, never an id to parse, because a second grammar accepts what the first refuses.

**Alternatives considered:** One regex constant shared by every site — rejected: it shares a
pattern, not the decision, and each site still wraps it in its own trim, cast and fallback,
which is where `kea.p03` became `kea.p3`. A lenient reader that normalizes a padded partition
— rejected: the normalized id names a lock dir the writer never made, so the attach succeeds
against an IPC tree nothing reads.

**Consequences:** An id the writer cannot produce names no worker anywhere:
`wp nodes cli kea.p03` refuses, `wp nodes stop` does not wait on a `kea.p03.lock.d`, and an
orphan IPC dir spelled that way is left alone rather than reaped. A new site needing a
worker's lock dir or IPC path calls an owner rather than `glob()`. The reader runs on
ordinary web requests — SSE subscriptions, the Workers dashboard — so it stays one anchored
match with no filesystem call.

**Revisit if:** the lock or IPC layout becomes operator-configurable, at which point the
owners read a template rather than a constant and an id stops being recoverable from a
path alone.

---

## ADR-23: A request carries no authority of its own

**Status:** Accepted

**Context:** TM_REQUEST is the runtime plane: a trigger or a query against a running graph.
A request may mutate — the example plugin's `TICK` emits items and its `FLUSH` writes a
draft, and intelligence's `RESET` empties the digest's items and `REGENERATE` composes a new
draft. Nothing verifies a request. `HTTP_In` installs its HMAC verifier as every interpreter's
default `authorize`, which `Command_Interpreter_Node::interpret()` calls for a TM_COMMAND alone, and
`Message::packed()` slices `Message::LOCAL` off, so no taint survives an IPC hop
([ADR-15](#adr-15-command-authorization-local-taint--the-minter-signs)). The authority for a
mutating request has to live somewhere else.

**Decision:** From outside a worker, a request reaches the worker's nodes only through that
worker's input Partition, and two things write there. `Bootstrap::register_worker_partition()`
mounts it into a request graph, and every verb reaching that call declares MANAGE:
`topologies connect_worker_input`, and intelligence's `insights generate` and
`insights collect`, each by declaring no capability, which `Service_CI_Node` gates at MANAGE.
The request graph is built per request, so a POST that does not mount the worker gets
`NOT_AVAILABLE` from the Router. An attached `wp nodes cli` appends to the same Partition
with the site's own filesystem authority, and refuses to run as root. That mount is the
gate, so a `node_schema()['requests']` entry declares no capability.

A Table is the one node a request reaches without its worker. `topologies mount_tables`
mounts every Table an active topology declares into the request graph through
`Bootstrap::mount_table()`, and it too declares MANAGE by declaring no capability. A mount
serves reads alone: it answers `GET` and `MGET`, and refuses every write request, an
INSERT, and its `:config` interpreter's `rm` and `vacuum`, because the declaring worker is the
Table's one writer ([ADR-6](#adr-6-crc32--31-bit-mask-partition-routing)). A `sqlite` mount
opens its file read-only, creates nothing, and reads as empty until its worker has written
([ADR-24](#adr-24-a-tables-backend-is-chosen-per-table)).

A request may drive a running graph. A declared request answers TO=FROM through
[`Schema_Reflection::answer_request()`](../includes/trait-schema-reflection.php) with
`TM_STRUCT | TM_RESPONSE` and VALUE `{ verb, data }`, or refuses an undeclared verb with a
`TM_ERROR`. `Table_Node`'s verbs answer bare instead, as
[`tachikoma-lineage.md`](tachikoma-lineage.md#a-declared-request-answers-in-an-envelope-tables-verbs-answer-bare)
records.

**Amendment:** a request carries a structure for `MSET` and `ADD` alone. A Table's `MSET` and
`ADD` carry `key => [ value, ttl ]` maps a string cannot hold without an encoding, so they
travel as `TM_REQUEST | TM_STRUCT` with VALUE `[ 'MSET' => … ]` or `[ 'ADD' => … ]`; every
other request stays a string. `topologies mount_tables` mounts Tables into a request graph and
declares MANAGE, as `connect_worker_input` does. A Table a verb below MANAGE mounts to read
stays mounted for the rest of that POST: a later verb or request in it reads through the same
mount, and `Bootstrap::mount_table()` keeps a mount already there and builds nothing. A verb may mount a Table only when every row it holds is data the verb's declared role may already read, because for the rest of the POST any caller holding that role can `MGET` any key through the mount; a Table holding more is mounted under MANAGE alone.

**Alternatives considered:** Signing requests as commands are signed — rejected: the mount
already demands MANAGE of every outside caller before a request can reach a worker, so a
signature would gate the same principal twice. A capability on each `requests` entry —
rejected: the handler runs in a worker, where no WordPress user is current, so
`Capabilities` has nothing to test and the declaration would be decoration no code enforces.

**Consequences:** A request handler may mutate, and its author weighs it as a MANAGE verb.
Inside a worker, a node filling a request into another — a Timer firing `TICK` at a source —
acts with the authority that loaded the topology. A verb whose caller must be told apart
from another MANAGE holder by session scope is a command, because only a command carries
the minter's session into the worker. A verb may mount a Table only when every row it holds is data the verb's declared role may already read, because for the rest of the POST any caller holding that role can `MGET` any key through the mount; a Table holding more is mounted under MANAGE alone. A mounting verb's output
is not the bound: `HTTP_In` filters no message type, so a raw `MGET` in the same POST names any
key, including one the verb never shows.

**Revisit if:** anything writes into a worker's input Partition below MANAGE — a verb that
mounts it under a lower role, or a second writer beside the attached cli — or a Table must be
readable below MANAGE while holding rows that role may not read, or a mount outlives the HTTP
request (the POST) that made it.

---

## ADR-24: A Table's backend is chosen per Table

**Status:** Accepted

**Context:** Tables sat on the shared cache tier, and memcache evicts. event-logger-nodes grew
a durable mirror, a sweep, held frames and restore lifetimes to repair the loss, and each
review round found holes in the last repair. Storage reached through helper instances built
inside classes was also invisible to `ls`, `dump_node` and the console.

**Decision:** `make_node Table <name> <namespace> <ttl> [auto|memcache|apcu|sqlite|wpdb]`.

- The TTL is required and at least one second. It is the lifetime of every entry a write does
  not time itself.
- `auto`, the default, is memcached, else APCu, chosen per call.
- A named backend opens once, in `arguments()`, and throws there naming the Table. A topology
  that cannot open its Tables fails loud at load.
- `sqlite` is one file per Table per partition, `{base}/tables/{table}.p{N}.sqlite`, on
  [ADR-4](#adr-4-pipe_buf-atomic-writes)'s local filesystem, in WAL with `synchronous=NORMAL`
  and a 1000 ms `busy_timeout`. The partition's worker is its one writer
  ([ADR-6](#adr-6-crc32--31-bit-mask-partition-routing)), and
  `Topology_Analyzer::write_set()` claims the file, so two active topologies cannot both
  write it.
- The writer alone creates the file, enters WAL and declares its table. A request-graph mount
  opens it read-only and changes nothing in it. A partition
  whose worker has not yet written has no file, and its mount reads as empty: every `GET` and
  `MGET` finds nothing, and each read looks for the file again, so one the worker creates
  mid-request is read from then on. Each partition mounts on its own, so one idle worker
  empties only its own partition. A path SQLite cannot open is `Table_Unavailable`; a file
  that opens but is no database, or holds no table, fails each read instead. A mount in a
  process running as root is refused as a plain `\RuntimeException`, the operator's to fix,
  because a root reader can leave `-wal` and `-shm` files its worker cannot open.
- `wpdb` is one shared table, `{base_prefix}newspack_nodes_table`, keyed by namespace, for
  low-volume Tables every host must read.
- Every arm stores the same key grammar (`Cache_Backend::site_key()`), so a salt rotation
  orphans durable rows as it orphans cached ones.
- A read ignores an expired row. `Router_Node`'s tick purges each durable Table its worker
  declared, once a minute, and `vacuum` is an operator verb, never automatic.

**Alternatives considered:**

- Repairing memcache loss further — rejected: see the Context.
- One durable store for every Table — rejected: nonces, sessions and page caches want a
  cache's speed and eviction.
- A SQL data model — out of scope: aggregates stay key-value.

**Consequences:**

- The PHP image needs `pdo_sqlite`. Without it a `sqlite` Table throws
  `sqlite backend needs the pdo_sqlite extension` at load.
- A reader on another host cannot see a `sqlite` Table.
- A long reader starves the WAL checkpoint, so the file grows until the reader ends. A reader
  never blocks the writer under WAL; a write that waits out `busy_timeout` met a second
  writer, and returns false.
- A co-tenant install sharing `{base}` shares the file and becomes its second writer.
- A Table built outside a graph, `Table_Node::table( $ns, $ttl, 'sqlite' )`, is opened by
  every web and CLI process that builds it, so its file has no one writer. Such a Table names
  `wpdb`.
- The purge walks the named Tables of a worker's graph and skips a request-graph mount. A
  durable Table that `table()` builds is never purged: reads ignore its expired rows, but
  they stay on disk. A durable Table that must be reclaimed is declared in a topology.
- The purge deletes expired rows and nothing else. A salt rotation leaves a durable Table's
  old-scope rows unreachable until they expire on the TTL they were written with, and every
  Table's TTL is at least one second, so the purge reclaims each of them in turn. `vacuum`
  returns free pages and deletes no row.
- A `wpdb` purge is scoped by the Table's own namespace, so rows under a namespace no active
  topology declares — a generation moved from `pyrobase:g47` to `pyrobase:g48` — are never
  reclaimed. Delete them by hand:
  `DELETE FROM {base_prefix}newspack_nodes_table WHERE namespace = '<old namespace>'`.
  Nothing sweeps `{base}/tables/` either, so a `sqlite` Table no active topology declares
  keeps its files until an operator deletes them.

**Revisit if:** a durable Table must be read from another host at volume, or a second writer
per file appears.
