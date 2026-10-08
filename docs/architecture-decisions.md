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
| [25](#adr-25-a-verbs-arguments-are-bound-by-its-schema) | A verb's arguments are bound by its schema |
| [26](#adr-26-every-verb-is-gated-by-the-role-its-schema-declares) | Every verb is gated by the role its schema declares |
| [27](#adr-27-withdrawn-a-ledger-of-write-once-rows) | Withdrawn: a Ledger of write-once rows |
| [28](#adr-28-withdrawn-a-ledger-file-per-partition) | Withdrawn: a Ledger file per partition |
| [29](#adr-29-a-log-stamp-has-one-writer-one-reader-and-one-resolver-per-kind) | A log stamp has one writer, one reader, and one resolver per kind |
| [30](#adr-30-a-read-position-has-one-writer-and-one-reader) | A read position has one writer and one reader |
| [31](#adr-31-a-broker-derives-its-readers-from-what-its-remote-sends) | A broker derives its readers from what its remote sends |
| [32](#adr-32-a-transport-answers-what-it-could-not-deliver) | Proposed: a transport answers what it could not deliver |
| [33](#adr-33-a-line-naming-no-partition-runs-once-per-fleet) | A line naming no partition runs once per fleet |

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

**Amendment: a broker's reader takes its stream through `receive()`.**
[`Remote_Consumer_Node::receive( $raw, $message )`](../includes/class-remote-consumer-node.php)
is a second entry point, and the drain loop is what pays for it. The broker,
[`Remote_Source_Node`](../includes/class-remote-source-node.php), decodes each line its SSE
connection carries to read the FROM stamp it routes by. The reader's `Durable_Reader` buffer
holds raw lines, its dead letters and sizes are the line's bytes, and its cursor comes from the
decoded message's breadcrumb, so it needs both forms. Through `fill()`, it gets one of them.
A decoded hand-off re-encodes the line for the buffer, and a packed hand-off decodes it a
second time.

The cost was measured on a hub's real path. A broker's reader drained into the hub's
downstream: `Remote_Job_Rewrite_Node::fill()`, then a four-partition `Topic`, then its
`Partition`s writing to disk. 20,000 TM_STRUCT records of 1,599 bytes each passed through
it, and each figure is the median of three runs. The runs used PHP 8.4.26 in
`eve-pyrobase1-1`, with `XDEBUG_MODE=off` (the extension still loaded) and
`opcache.enable_cli` at 0. One line cost 16.78 µs through `receive()`. A packed `fill()`
cost 20.48 µs, 3.70 µs more and 22.1% of the path. A decoded `fill()` cost 21.99 µs,
5.21 µs more and 31.0%. Into a `Null_Node` instead of the hub, the line cost 6.32 µs, and the
fold added 3.57 µs (56%) or 4.78 µs (76%). The fold's own cost, about 3.6 to 5.2 µs a line, is
the same in both. It costs more than a fifth of the real per-line path, and the budget
for folding was 5%.

Only the broker calls `receive()`, on the line it has just routed by FROM. A step reply still
arrives through `fill()`, which takes that reply and nothing else. Nothing outside the broker
reaches the reader's stream except the reader's own verbs.

**Revisit if:** a line reaches the reader already decoded, so a hand-off through `fill()` costs
no second encode or decode; or the reader's buffer stops holding raw lines.

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
`_output` and bounce a dropped `NOT_AVAILABLE` every startup. With no reply to carry
it, a TM_NOREPLY command's failure propagates to whatever filled the command, so a broken
topology line fails the load: [`Command_Interpreter_Node::interpret()`](../includes/class-command-interpreter-node.php)
re-throws a refusal or a verb's throwable, and [`Router_Node::send_error()`](../includes/class-router-node.php)
throws `NOT_AVAILABLE` for a command addressed to no node instead of bouncing it. Both browser
twins do the same. Tachikoma prints the one and bounces the other while the script runs on;
the lineage records [why this differs](tachikoma-lineage.md#a-tm_noreply-failure-raises-instead-of-printing).

![Two panels. Rejected, Tachikoma's handshake: a producer sends TM_PERSIST into a Buffer whose max_unanswered caps what is in flight, and the consumer later answers or cancels with a TM_PERSIST | TM_RESPONSE sent TO=FROM, because consumption is asynchronous from delivery and the ack is the tier's advance-or-discard signal. Chosen: Consumer::poll() reads a record, fill() runs down one call stack to the last sink, and only then does the cursor advance, Consumer chopping past the record and Remote_Consumer_Node committing on arrival at each message's start; the next poll() waits for all of it, which is the backpressure. Three cards below: TM_NOREPLY, which a Shell with want_reply(false) ORs onto its commands so a booting worker's replies do not bounce NOT_AVAILABLE from the absent _output; flow control belonging at the producer that needs it; and the three revisit conditions.](img/adr-no-ack.png)

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

**Amendment:** a node that owns non-blocking I/O may hold an in-flight window, because its
`fill()` returns before the transfer it starts completes, so delivery and completion are no
longer one call stack. The node chooses how the window is bounded, and says so.
[`Curl_Node`](../includes/class-curl-node.php) caps it by count, which is flow control at the
producer: it holds at most `MAX_IN_FLIGHT` fetches and answers the next with a `busy:`
TM_ERROR, queueing nothing. [`HTTP_Out_Node`](../includes/class-http-out-node.php) caps it
by time alone: each flush tick starts its own POST, so several may be in flight to one
spoke at once, each bounded by `REQUEST_TIMEOUT`. A transfer still in flight at stop is
lost: [`Curl_Transfer::release_all()`](../includes/trait-curl-transfer.php) releases every
handle and logs one rate-limited line counting the transfers it discarded. A cursor upstream
has already advanced past the message that started it, so durability belongs upstream of such
a node — a producer that must not lose a fetch writes it to a log and replays what it never
saw answered. The revisit condition above stands for every other node; for a window-holding
node it reopens when a caller needs the window to survive a stop, or needs its cursor held
until the transfer completes rather than until `fill()` returns.

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
sets `routeTo` to its `targetsFor()` and sends every non-command record to each target its
stamp routes to, `RemoteIpc` answers null from `targetsFor()` so every TO stands, and a command reply keeps the TO the server addressed to its minter
either way, because overwriting it would deliver the reply to the subscription's view instead of
its receiver.

**Observed benefits:**

- **A TO path is a serializable address**, so cd'ing into a worker and the
  `_output/_cli:<pid>` cross-process replies work where an object reference cannot. Tachikoma's `pivot_client`
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
  past the substrate's `MAX_FROM_SIZE`. The address names the subject and a reply's echoed
  `arguments` name its question, so a Fetcher settles the ask carrying both, or, for a reply
  echoing none such as the Router's `NOT_AVAILABLE`, the first ask on its address
  ([`FetcherNode`](../src/runtime/fetcher-node.js)). Each slice's `Current` gate passes only a
  reply its Fetcher `answers()`, and withdrawing an ask (`withdraw()`) is how a view stops
  wanting an answer without asking anew: the request completes, and its answer stops there.
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

**Amendment:** a reply to an attached-worker command is addressed to the command SESSION
that sent it, named in one head segment, `<realm>:<session>`, and every session reading a
worker's shared output Partition gates on its own head through one
[`HTTP_Filter_Node`](../includes/class-http-filter-node.php). A browser's head is `_sse:<handle>`,
the handle of the page's command session: [`RemoteIpcNode`](../src/runtime/remote-ipc-node.js)
heads the FROM it sends with it, `/command` adds the `_output` boundary, and a stream presents
`session=<handle>`, so its gate passes the replies headed with it on whichever connection that
session holds when they land. A session re-minted on expiry changes the handle, so a reply in
flight across a re-mint is lost, about once an hour per tab at most; a stream that presented no
session, the server-to-server pull, passes no reply at all. A cli process's head is `_cli:<pid>`:
`wp nodes cli` and `wp nodes tables` attach to the IPC files directly and never reconnect, so the
process is its session, and each mints FROM `_output/_cli:<pid>/<reply-node>` itself, sharing the
`_output` boundary so a stream's gate drops a cli's replies as it drops another tab's. Each
channel's gate is named `<worker-id>:replies`, so `ls -a` and `dump_node` show it. A head is
matched as the whole segment and stripped, never read off the tail, so the subject a reply
carries past its reply node can never pose as a session. The addressing is still the
correlation — nothing is minted, stored or matched beyond the head the minter wrote.

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

**Amendment: a constructor's trailing tail is a variadic argument, never bound.** A spec in
`node_schema()['arguments']` may declare `variadic`, and only as the LAST spec. `parse_schema_args()`
and the browser's `walkSchemaArgs` skip it, and the node reads the tokens past the bound
positionals through [`Schema_Reflection::variadic_in()`](../includes/trait-schema-reflection.php),
whose start is the bound count, so the schema declares where the tail begins once. A `variadic`
declared anywhere else is refused with `Invalid argument specification: variadic argument <name>
must be the last`. This differs from [ADR-25](#adr-25-a-verbs-arguments-are-bound-by-its-schema),
where a verb's `variadic` IS bound, as a list, and may precede named arguments: a constructor
keeps the tail as raw tokens because a node such as `Remote_Source` or `Vault_Group` parses them
into a structure of its own.

---

## ADR-12: Dead-letter poison / crash lifecycle

**Status:** Accepted. Shared by `Consumer_Node` and `Remote_Consumer_Node`, a broker's reader for one stream, via the
[`Dead_Letter_Queue`](../includes/trait-dead-letter-queue.php) and [`Durable_Reader`](../includes/trait-durable-reader.php) traits. Roadmap item [42] (the "(dead-letter [42])"
[CHANGELOG](../CHANGELOG.md) tags).

**Context:** A durable reader (Consumer tailing a Partition; Remote_Consumer reading one stream
of a remote SSE connection) can hit a *poison* message that always fails downstream. Two failure shapes: a
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
`UNPARSEABLE_LINES`, which `Remote_Source_Node` publishes to the Aggregator card, while each
`Remote_Consumer_Node` moves its cursor past the skip — event-logger-nodes' `grep_requests` verb returns it
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
own authority. In a worker, where no user is current, the ceiling is the whole gate
([ADR-26](#adr-26-every-verb-is-gated-by-the-role-its-schema-declares)). The `now` in the auth reply lets
the client align its TIMESTAMP to the verifier's clock, and the TTL is never slid on use, so a
leaked handle expires on a bounded schedule no matter how busy it is.

No session means no signature, and waiting alone DEADLOCKS: every minter refuses to queue
unsigned and nothing else would ever ask for the handshake, so the skip branch has to kick it.
A minter resolves its egress by running the target's head segment through `Core::node()`,
type-tests the result for `HTTP_Out_Node`, and calls
[`HTTP_Out_Node::ensure_session()`](../includes/class-http-out-node.php), which exists for that and nothing else: it fires the node
when `Command_Auth::has_session()` says there is none. [`Command_Auth::mint_for()`](../includes/class-command-auth.php)
is that body, written once: it checks the session, asks for one through the closure its
caller passes when there is none, then mints and signs, handing the command back for the
caller to fill, as `Node.command()` does below. The closure is the caller's throttle, so a
minter retrying every tick never handshakes every tick. [`Fanout_Targets::send_signed()`](../includes/trait-fanout-targets.php) calls it once per target
for `Settings_Sync_Node` and ELN's [`Discovery_Collector_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/4437e383/includes/class-discovery-collector-node.php), passing `ensure_session()`, which its send
cadence paces; a paused `Remote_Consumer`'s step and `Remote_Link`'s slot heartbeat call it
through `Remote_Link_Node::mint()`, which asks on the link's own second of the heartbeat
cadence, so another minter calls it rather than copying the shape. On the JS side [`Node.command( name, args )`](../src/runtime/node.js)
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

The write side carries the same parameter. [`Table_Node::add( $key, $value, $ttl )`](../includes/class-table-node.php)
stores an entry only where no live one holds its key, under a lifetime of its own, down the
path the `ADD` request takes; a command session, whose row lives exactly as long as the
session, is its first caller. On a durable Table, `lookup_entries()` reads that lifetime
back as the `{ value, ttl }` a backing answers, so the store's expiry is the one copy a
reader needs and no value carries a second.

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
and `dump_metadata`'s `targets` key. A class whose extras follow from its `make_node` arguments
declares them once, in the static `Node::declared_targets( $args )`: the default
`extra_targets()` reads it with the node's own arguments, and `Topology_Analyzer` reads it off
every `make_node` line, whatever the class, and draws each as a `pair` edge, so the live canvas
and the static graph cannot drift. `fill()` reads `$this->target` alone. This licenses no
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
`:config` interpreter and draws on the canvas. Unlike a hand-written node, a child cannot be
removed or renamed from the console or the shell: `remove_node` and `move_node` refuse an owned
sibling, and `dump_metadata` names the group as the child's `owner`. A child leaves through the
Vault — `vault update <id> --group=` takes its entry out of the group, and the next reload
retracts it — or with the group itself. It rebuilds its
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
group and its recorded commands, since the group rebuilds its children from them. The
console's editor is the one exception: it seeds from a flatten that keeps each group as written
(`group_children` false on `topologies get` and `expand`), so its document holds no line about
a member. The group declares its child class's targets as its own (ADR-19), so its `pair`
edges draw on it in every view, the live canvas and both flattens alike.

Group configuration goes through the group: a verb sent to `<group>:config` reaches every
child and, when every child accepted it and it changed a child's configuration, is recorded
last-write-wins. A per-child verb sent straight to `<group>:<id>:config` is LIVE-ONLY — no
dump replays it, because `dump_config` replays the group and its recorded commands, never a
child.

**Alternatives considered:** Generating the TSL from the Vault — rejected: the list still lives
twice, and a spoke added to the Vault stays unwired until someone regenerates, redeploys and
restarts; the generator had also drifted, emitting `include` names no topology defines.
Hand-written legs per spoke — rejected: that is the problem. Patroned children — rejected: a
patroned node vanishes from the canvas and drops its own `:config` interpreter — only an
owned Table keeps both — so per-spoke state and edges become invisible exactly where an
operator diagnosing one spoke looks.
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

**Amendment:** `Remote_Source_Node` is that second node type, and [ADR-31](#adr-31-a-broker-derives-its-readers-from-what-its-remote-sends) answers it without a derivation hook: the analyzer claims a broker's roots rather than flattening its readers.

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
`parseWorkerId()` in [`src/shared/utils/workerId.js`](../src/shared/utils/workerId.js),
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

**A worker in a FROM trail has one reader.** A writer appending to a log many workers
share (`topicprobe.p0`, `jobstats.p0`, `tablestats.p0`) stamps FROM `{worker-id}/{name}`
through `CLI::worker_id()`, because no per-worker boundary exists to stamp it. Only a worker
runs such a writer, and `Topology_Loader` binds its topology and partition there, so a probe
built with either unbound is refused by `arguments()`, as `make_node`'s TM_ERROR, rather than
stamp a FROM no reader can attribute. The browser's
SSE reader prepends its own stamp, the log's dir name (one segment, two when the first is a
stamp prefix: `stamp_for()` refuses a log dir named `logs`, `offsets`, `deadletter` or
`sources`, so no bare stamp is one, and a Partition or Log declaration refuses it too; the
first three name a root dir, while `sources` names a registry entry, not a dir). The stamp's
own writer, reader and resolvers are [ADR-29](#adr-29-a-log-stamp-has-one-writer-one-reader-and-one-resolver-per-kind).
[`workerOfFrom()`](../src/shared/utils/workerId.js) strips that stamp through
[`splitStamp()`](../src/runtime/log-stamp.js), which `tests/fixtures/log-stamps.json` holds
to PHP `Log_Discovery::dir_from_stamp()`, and reads what remains, `{worker}/{name}`, validating the worker through
`parseWorkerId()`; any other shape — a malformed or foreign FROM — names no worker. It is the one reader of a FROM trail's
worker, as `workerOfPath()` is of a TO path's. Rejected: a WORKER slot in each record layout,
which costs three layout changes and their parity pins for what FROM already carries.

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
path alone; or a shared log's name stops sharing the `{name}.p{N}` spelling with worker ids,
at which point a stamp and a worker id can no longer be told apart by position.

---

## ADR-23: A request carries no authority of its own

**Status:** Accepted

**Context:** TM_REQUEST is the runtime plane: a trigger or a query against a running graph.
A request may mutate — the example plugin's `TICK` emits items and its `FLUSH` writes a
draft, and intelligence's `RESET` appends a fence to its ingest Partition, on whose return the
digest empties its items, and `REGENERATE` composes a new draft. Nothing verifies a request. `HTTP_In` installs its HMAC verifier as every interpreter's
default `authorize`, which `Command_Interpreter_Node::interpret()` calls for a TM_COMMAND alone, and
`Message::packed()` slices `Message::LOCAL` off, so no taint survives an IPC hop
([ADR-15](#adr-15-command-authorization-local-taint--the-minter-signs)). The authority for a
mutating request has to live somewhere else.

**Decision:** From outside a worker, a request reaches the worker's nodes only through that
worker's input Partition, and two things write there. `Bootstrap::register_worker_partition()`
mounts it into a request graph, and every verb reaching that call declares MANAGE:
`topologies connect_worker_input`, and intelligence's `insights generate` and
`insights collect`, each by declaring no capability, which `dispatch()` holds at MANAGE
([ADR-26](#adr-26-every-verb-is-gated-by-the-role-its-schema-declares)).
The request graph is built per request, so a POST that does not mount the worker gets
`NOT_AVAILABLE` from the Router. An attached `wp nodes cli` appends to the same Partition
with the site's own filesystem authority, and refuses to run as root. That mount is the
gate, so a `node_schema()['requests']` entry declares no capability.

A Table is the one node a request reaches without its worker. `topologies mount_tables`
mounts every Table an active topology declares into the request graph through
`Bootstrap::mount_table()`, and it too declares MANAGE by declaring no capability. A mount
serves reads alone: it answers `GET`, `MGET`, `SMEMBERS` and `SSCAN`, and refuses every write request, an
INSERT, and its `:config` interpreter's `flush` and `vacuum`, because the declaring worker is the
Table's one writer ([ADR-6](#adr-6-crc32--31-bit-mask-partition-routing)). A `sqlite` mount
opens its file read-only, creates nothing, and reads as empty until its worker has written
([ADR-24](#adr-24-a-tables-backend-is-chosen-per-table)).

A request may drive a running graph. A declared request answers TO=FROM through
[`Schema_Reflection::answer_request()`](../includes/trait-schema-reflection.php) with
`TM_STRUCT | TM_RESPONSE` and VALUE `{ verb, data }`, or refuses an undeclared verb with a
`TM_ERROR`. `Table_Node`'s verbs answer bare instead, as
[`tachikoma-lineage.md`](tachikoma-lineage.md#a-declared-request-answers-in-an-envelope-tables-verbs-answer-bare)
records.

**Amendment:** a request carries a structure for `MSET`, `ADD` and `SADD` alone. A Table's
`MSET` and `ADD` carry `key => [ value, ttl ]` maps, and its `SADD` carries
`set_key => [ [ member => value, … ], ttl ]` maps, that a string cannot hold without an
encoding, so they travel as `TM_REQUEST | TM_STRUCT` with VALUE `[ 'MSET' => … ]`,
`[ 'ADD' => … ]` or `[ 'SADD' => … ]`; every other request, `SMEMBERS` and `SSCAN` included, stays a
string. Each of the three declares it on its `requests` entry, `'value' => 'struct'`, and
every sender reads that declaration: the console's verb dialog sends `TM_REQUEST | TM_STRUCT`
for such an entry alone, and never infers one from the types of its args. `SMEMBERS` answers one message per set, as `MGET` answers one per key: `TM_STRUCT`
with the set's `[ member, value ]` pairs, or `TM_BYTESTREAM "OVER <limit>"` and no members for
a set holding more than the limit, told from a member list by its type as `MGET` tells a
string value from an array. `topologies mount_tables` mounts Tables into a request graph and
declares MANAGE, as `connect_worker_input` does. A Table a verb below MANAGE mounts to read
stays mounted for the rest of that POST: a later verb or request in it reads through the same
mount, and `Bootstrap::mount_table()` keeps a mount already there and builds nothing. A verb may mount a Table only when every row it holds is data the verb's declared role may already read, because for the rest of the POST any caller holding that role can `MGET` any key, or `SMEMBERS` or `SSCAN` any set, through the mount; a Table holding more is mounted under MANAGE alone.

**Alternatives considered:** Signing requests as commands are signed — rejected: the mount
already demands MANAGE of every outside caller before a request can reach a worker, so a
signature would gate the same principal twice. A capability on each `requests` entry —
rejected: the handler runs in a worker, where no WordPress user is current, so
`Capabilities` has nothing to test and the declaration would be decoration no code enforces.

**Consequences:** A request handler may mutate, and its author weighs it as a MANAGE verb.
Inside a worker, a node filling a request into another — a Timer firing `TICK` at a source —
acts with the authority that loaded the topology. A verb whose caller must be told apart
from another MANAGE holder by session scope is a command, because only a command carries
the minter's session into the worker. A verb may mount a Table only when every row it holds is data the verb's declared role may already read, because for the rest of the POST any caller holding that role can `MGET` any key, or `SMEMBERS` or `SSCAN` any set, through the mount; a Table holding more is mounted under MANAGE alone. A mounting verb's output
is not the bound: `HTTP_In` filters no message type, so a raw `MGET`, `SMEMBERS` or `SSCAN` in the same POST names any
key or set, including one the verb never shows.

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
  [ADR-4](#adr-4-pipe_buf-atomic-writes)'s local filesystem, in WAL with `synchronous=NORMAL`,
  a 1000 ms `busy_timeout`, `wal_autocheckpoint=0` and a 64 MiB `journal_size_limit` on
  the writer, and a 64 MiB `cache_size` on every connection. The partition's worker is its one writer
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
  low-volume Tables every host must read, beside `{base_prefix}newspack_nodes_members` for
  its set members. Plugin activation creates both, `Wpdb_Arm::install()`, and records the
  schema in an autoloaded option; an arm reads that option alone and installs only when it
  records another schema, so the request path runs no DDL, and `max_allowed_packet` is read
  on a connection's first write.
- A volatile arm's key is `Cache_Backend::entry_key( $namespace, $key )`, built through
  `Cache_Backend::site_key()` with the install's salt, and a salt rotation is its flush. A
  durable arm answers `row_key( $key )` over the namespace it holds, and carries no salt:
  its file or table already belongs to this install, so `wp nodes memcache flush` leaves its
  rows. `Sqlite_Arm` stores `{namespace}:{key}`; `Wpdb_Arm` stores the key alone, because
  its `namespace` column already scopes the row (`PRIMARY KEY ( namespace, cache_key )`).
- `flush`, a `:config` verb, empties a durable Table. A `sqlite` Table's writer, the file's
  one writer, unlinks the database and its `-wal` and `-shm` and opens a new file with the
  same pragmas and tables, a cost that never grows with the rows, and answers the bytes the
  old files held; a mount in another process that opened the old file reads its rows until
  that request ends. A `wpdb` Table deletes its namespace's rows and answers how many,
  because every wpdb Table shares one MySQL table, which a TRUNCATE would empty for all of
  them. On eve a DELETE of 2,000,016 SQLite rows took 57.9 s and, sent to a live worker,
  held its drain loop until the fleet revived it; replacing the same 555 MB of files took
  0.9 s, the command included. The
  checkpoint schedule, the WAL stall count and a purge left behind start over. It declares
  no role, so `dispatch()` holds it at MANAGE
  ([ADR-26](#adr-26-every-verb-is-gated-by-the-role-its-schema-declares)), and a mount
  refuses it.
  `wp nodes tables flush` sends it to each partition's owning worker over the worker's
  command channel, and flushes a partition no worker owns from the CLI only under the fleet
  hold; `wp nodes tables list` asks the owners for their counters the same way.
- Command sessions live in a Table, `Table_Node::table( 'nodes-sessions', 3600, 'wpdb' )`,
  one row per session keyed by its handle: every web host mints and every host verifies,
  which one host's SQLite file cannot serve and an evicting cache loses. Every session read
  and write goes through that Table, and `scripts/lint-contract.mjs`'s
  `durable-arm-outside-table` rule refuses a durable arm built anywhere else, so a topology declaring `make_node Table <name>
  nodes-sessions <ttl> wpdb` reads the same rows under the same keys. A mint `add()`s its
  row under the session's own TTL ([ADR-18](#adr-18-a-table-can-front-a-durable-record-the-walk-that-finds-it-stays-in-the-app)'s one parameter), never slid, and `purge()`s up to 64
  expired rows, because no worker's tick purges a Table built in code. A process builds that
  Table once. The row's expiry is
  the one record of when a session lapses: `lookup_entries()` answers each live row with the
  whole seconds it has left, as a backing's restored entry carries its remaining `ttl`, and
  the row's value keeps no copy. The row carries the label and when it was minted, and a
  labelled session's handle is a member of the set `labelled` in the same Table under the
  same TTL, because a key-range scan is refused and a set read by its key is how a durable
  Table enumerates: the listing is `members_of()` then `lookup_entries()`, two statements
  however long, and a flush empties the set with the rows. Nothing caps the labelled
  sessions; the set is read up to `MAX_MEMBERS_LIMIT` handles, and past that the listing
  refuses, naming the flush. A store that will not open fails the mint, naming why.
- A read ignores an expired row. `Router_Node`'s tick purges each durable Table its worker
  declared, once a minute, and `vacuum` is an operator verb, never automatic.
- No COMMIT checkpoints a `sqlite` file. The writer turns `wal_autocheckpoint` off, and the
  tick runs a `wal_checkpoint(PASSIVE)` per Table at most once every
  `Table_Node::CHECKPOINT_INTERVAL_S` (30 s), after the tick's timers have flushed and after
  the purge, inside the purge's deadline; a mount never checkpoints. On staging a 38 MB
  rewrite spent 400–500 ms in COMMIT and 650–790 ms more in the checkpoint SQLite ran inside
  that COMMIT, so a write paid for copying the WAL back. On eve the same 38,000-row rewrite
  took 191–199 ms with the checkpoint inside COMMIT, and 111–126 ms of COMMIT plus 45–62 ms
  of tick checkpoint without.
- A checkpoint copies each page in the WAL back once however many writes dirtied it, so the
  interval sets how often a hot page is copied. Checkpointing every tick, staging's
  aggregate Table spent 1,686 ms in 133 checkpoints (83,869 frames), 39% of its time, beside
  1,879 ms of `SADD` and 614 ms of `MSET`; its URL Table spent 512 ms in 44, one of them
  367 ms. At ~630 frames a second, 30 s leaves ~19,000 frames, ~75 MB, to each checkpoint.
- PASSIVE never waits on a reader or blocks one: frames past an open reader's snapshot wait
  for the next checkpoint, and `WAL_STALL_CHECKPOINTS` (4) of those in a row while the WAL
  grows log a rate-limited warning. A mount's reader ends within PHP's 30-second
  `max_execution_time`, so one request straddles two checkpoints at most, and four span at
  least 90 seconds.
- `journal_size_limit`, `Sqlite_Arm::WAL_LIMIT_BYTES` (64 MiB), cuts the WAL file back when
  a checkpoint has rewound it, where SQLite would keep it at its high-water mark. A steady
  30-second interval regrows ~10 MB past it; a burst — a stall, a backfill — gives back
  everything above it.
- `cache_size` is 64 MiB, `Sqlite_Arm::CACHE_KIB`, against SQLite's 2 MB default. Staging's
  aggregate file is ~300 MB, and its worker reads the current hour's keys back before each
  write; 500 random keys took 46 ms there against 5.7 ms for adjacent ones. SQLite allocates
  a cache page when a statement touches it, so the size is a ceiling: on eve a reader grew
  4 KiB at open and 4.6 MB reading 500 random keys of a 266 MB file. `mmap_size` stays 0: it
  cost a fresh connection 0.5 ms per 500 random keys on eve and paid only on a warm one, and
  a mount's connection lives one request.
- Set members are durable-only. `SADD` and `SMEMBERS` store and read one row per member in a
  table of their own beside the keyed rows — `members` in the SQLite file,
  `{base_prefix}newspack_nodes_members` for wpdb — keyed `( set_key, member )`, so a member
  read is an exact set-key seek, `ORDER BY member` with a LIMIT one past the asked limit,
  at most `Table_Node::MAX_MEMBERS_LIMIT` + 1, and never a range. Each set is read and let
  go before the next, so a set past its limit costs its rows once, never all sets' at once,
  and a row no serializer wrote fails the read as it fails a keyed read. `SSCAN` pages one
  set past that ceiling: the same seek with `member > ?` from a cursor, the page's last
  member percent-encoded as `after=<member>`, so no set is too large to read and none is read
  by offset. `add_members()`, `members()`, `member_page()`, `move_members()` and
  `remove_members()` are `Durable_Arm`'s alone, and a Table whose backend is not durable
  refuses all five verbs as it refuses `vacuum`, on
  `instanceof Durable_Arm`: `<VERB>: needs a durable backend; <table> is <backend>`. `SMOVE`
  and `SREM`, which move and delete members, are one transaction on sqlite; `SMOVE` on wpdb
  holds none, so a racing caller or a mid-move failure can leave a member in both sets. Nothing
  is caught around the arm call, so anything an arm throws while it works escapes
  ([ADR-14](#adr-14-cooperative-stop-propagates-through-broad-catches)). A `sqlite`
  mount of a file its writer declared before members reads every set as empty, as it reads
  a file that is not there. The purge deletes expired members inside the same per-batch
  limit as expired keyed rows.
- The purge catches up. A tick that stops with a Table's last batch full leaves it behind
  and says so in a rate-limited line. The Tables due on one tick share one deadline:
  `PURGE_BACKLOG_BUDGET_S` (250 ms) while any is behind, 50 ms otherwise, and the first
  short batch catches a Table up. Every due Table runs at least one batch, so a tick holds
  the loop for one budget plus one batch a Table. The one 5,000-row batch a minute the
  normal budget guarantees sits below the ~5,300 rows a minute one partition's aggregate
  Table in event-logger-nodes expires at 12.0 M entries, ~4,200 of them search-index
  members. A SQLite batch cost 7 to 16 ms on a small local file, where the backlog budget
  reclaims at least 75,000 rows a minute; on staging's 15.9 M-row file it cost 597 ms, so
  the budget buys the one batch a tick every Table runs anyway, and whether the purge
  keeps pace there is unmeasured. A wpdb batch may cost more, and gets one a tick at least.

**Alternatives considered:**

- Repairing memcache loss further — rejected: see the Context.
- Members on a volatile arm — rejected: an evicted member vanishes from its set without a
  trace, so a member read could not tell a whole set from a partial one.
- A key-range SCAN over kv — rejected: reads scale with the range, not the set.
- One durable store for every Table — rejected: nonces and page caches want a cache's speed
  and eviction.
- Salting durable keys — rejected: a rotation meant to flush the caches orphaned every
  durable row, which then sat until its TTL, and it logged out every session with it.
- Sessions on the cache tier — rejected: an eviction or a flush logs a client out with hours
  left on its session.
- A SQL data model — out of scope: aggregates stay key-value.

**Consequences:**

- The PHP image needs `pdo_sqlite`. Without it a `sqlite` Table throws
  `sqlite backend needs the pdo_sqlite extension` at load.
- A reader on another host cannot see a `sqlite` Table.
- A long reader starves the WAL checkpoint, so the WAL grows until the reader ends, and
  four incomplete checkpoints in a row while it grows say so. A reader never blocks the
  writer under WAL; a write that waits out `busy_timeout` met a second writer, and returns
  false.
- The WAL holds up to one `CHECKPOINT_INTERVAL_S` of writes, ~75 MB at staging's rate, which
  is also what a crash replays from it; a stall holds more, until its reader ends.
- A co-tenant install sharing `{base}` shares the file and becomes its second writer.
- A Table built outside a graph, `Table_Node::table( $ns, $ttl, 'sqlite' )`, is opened by
  every web and CLI process that builds it, so its file has no one writer. Such a Table names
  `wpdb`.
- The purge walks the named Tables of a worker's graph and skips a request-graph mount. A
  durable Table that `table()` builds is never purged by the tick: reads ignore its expired
  rows, but they stay on disk until its own writer calls `purge()`, as the session mint
  does. Any other durable Table that must be reclaimed is declared in a topology.
- The purge deletes expired rows and nothing else, `vacuum` returns free pages and deletes no
  row, and `flush` empties the Table. A row written under an earlier key — the salted one
  before 2.79.0, or a `wpdb` Table's `{namespace}:{key}` before 2.79.1 — is unreachable,
  expires on the TTL it was written with, and the purge reclaims it in turn.
- A flushed session store revokes every issued session at once, so `wp nodes tables flush`
  flushes it only when named.
- A `wpdb` purge is scoped by the Table's own namespace, so rows under a namespace no active
  topology declares — a generation moved from `pyrobase:g47` to `pyrobase:g48` — are never
  reclaimed. Delete them by hand:
  `DELETE FROM {base_prefix}newspack_nodes_table WHERE namespace = '<old namespace>'`.
  Nothing sweeps `{base}/tables/` either, so a `sqlite` Table no active topology declares
  keeps its files until an operator deletes them.

**Revisit if:** a durable Table must be read from another host at volume, or a second writer
per file appears.

**Amendment:** a `sqlite` Table rewrites a row in place, prepares each fixed statement once,
and runs the keys of one `TOUCH` or `RM` as one batch.

- A rewrite is an UPSERT: `kv` writes `INSERT … ON CONFLICT ( "key" ) DO UPDATE`, which keeps
  the row's rowid and so its autoindex entry, and `members` writes
  `ON CONFLICT ( set_key, member ) DO UPDATE`. `ADD` keeps its `INSERT OR IGNORE` and its
  expired-row `DELETE`. Every fixed statement is prepared once per connection, in one map
  keyed by its SQL that a `flush` empties; a keyed read's `IN` list varies with its chunk and
  is prepared per call. UPSERT needs SQLite 3.24; eve's `pdo_sqlite` links 3.46.1. On eve,
  against a staging-shaped 671 MB file, an `MSET` call wrote 724 WAL frames as
  `INSERT OR REPLACE` and 540 as an UPSERT.
- `Cache_Backend::delete_multi()` and `touch_multi()` take the keys of one request and answer
  the ones that took effect. A volatile arm loops over `delete()` and `touch()`. `Durable_Arm`
  runs the whole batch of an atomic arm in one `write_scope()`, so on SQLite it is one
  transaction for the request rather than one per key, and a statement that fails fails
  the batch: the arm answers no keys, and SQLite has rolled every one back. A non-atomic arm
  (`wpdb`) loops per key and answers the keys that took effect.

Frames are the cost that transfers: staging pays about 160 µs a WAL frame in a commit and
53 µs in a checkpoint, 20 to 40 times eve.

A transaction held across requests, bracketed by `BEGIN` and `COMMIT`, was built and dropped
before release. Its only caller moved to a Ledger, and a hold needs a lifecycle (the tick, a
stop, a teardown, `vacuum`, `flush`) plus a poison state for a transaction SQLite ends itself,
all for a caller that no longer exists.

---

## ADR-25: A verb's arguments are bound by its schema

**Status:** Accepted

**Context:** A verb's `args` declaration fed the console, `help` and `classes dump`, and the
runtime ignored it. Each handler re-read its tokens by hand — `Command_Args::parse()`,
`$args[0]`, `split_first_token()` — and was free to disagree with what it advertised.
`sessions create chris-claude tune 86400` minted `manage` for an hour, because the handler
read scope and ttl only as options while the schema ordered them positionally. `raw-logs
read_message` declared `log` required and never refused its absence, and `vault` hand-rolled
the unknown-option refusal its schema could have stated. The console's verb dialog joined its
filled fields by position, so a blank middle field shifted every later value into the wrong
slot.

**Decision:** `Command_Interpreter_Node::dispatch()` binds a verb's tokens against the `args`
its schema declares — a service CI's own schema, a `:config` interpreter's patron's — through
`Command_Args::bind()`, before `$around_dispatch` runs, as the unknown-verb refusal does, and
hands the handler the bound values by name. A handler never parses.

- Each arg arrives by position, in declared order, or as `--name=value`, and the two forms
  mix. The i-th positional binds to the i-th declared arg. A bare `--name` is `true`, which
  only a `bool` arg takes. Any token opening `--` is an option; there is no `--`
  end-of-options marker, so a value that itself opens `--` — a password, a body — is given
  by name, `--password=--x`.
- An absent arg takes its declared `default`, refuses when `required`, and otherwise binds
  null. `Command_Args::unsupplied()` reads two blanks as absent: a blank `int`, `float` or
  `bool` token, the placeholder an editor writes to hold a slot, and a blank for a
  `required` arg, which names nothing. A blank optional string is a value.
- A default is resolved by `Command_Args::default_of()`, the one rule `bind()` and
  `Schema_Reflection::parse_schema_args()` share: a `<ns:key>` token default resolves
  strictly through its namespace and is typed as a token would be; any other is verbatim.
  `Core::resolve_config_token()` renders a resolver's PHP bool as `1` or `0`, so a bool
  token binds a `bool` arg rather than reading as a blank.
- Refused, each by name: an unknown option, a name given twice, an arg given by position and
  by name, a surplus positional, a `secret` arg given by position, a missing required arg, a
  bare flag for an arg taking a value, and a token not of its declared `int`, `float` or
  `bool` type — a `bool` takes `1`, `true`, `yes`, `on`, `0`, `false`, `no` or `off`.
- An arg declaring `variadic` collects every positional from its position on, or every
  `--name=` repeat, as a list of typed members, and binds `[]` when absent. An arg declared
  after it is reachable by name alone, which is how
  `workers restart <type>… [--partition=<n>]` reads, and repeating by name is how a form
  with one field per arg fills it.
- `int`, `float` and `bool` are typed through `Command_Args::typed()`, the one rule
  `Schema_Reflection::parse_schema_args()` reads for `make_node` positionals. Every other
  declared type — `string`, `node_name`, `json`, `text` — binds as its string.
- A `secret` arg is named, never positional, because the browser masks only `--name=`
  tokens in its history and transcript; the command line `$around_dispatch` hands a wrapper
  masks it as `--<name>=<redacted>`. A refused command never reaches a wrapper, so no
  refusal is logged with its tokens.
- A verb whose schema carries no `args` key receives its tokens as they came. A declared
  `'args' => []` binds too, so a stray token refuses.
- A binding refusal throws `\InvalidArgumentException`, which `interpret()` answers as the
  verb's TM_ERROR.
- A `toggle` or `setter` verb declares its one arg, and the synthesized handler reads it by
  name; one declaring none refuses at wiring.
- A request is not a verb. Its VALUE is words, answered in the addressed node's `fill()`
  ([ADR-23](#adr-23-a-request-carries-no-authority-of-its-own)), and nothing binds it.

**Alternatives considered:**

- Bind in `Service_CI_Node`'s table build — rejected: it covers service CIs and misses every
  `:config` verb. `dispatch()` is the one door both reach, and `Vault_Group_Node`'s forwarder
  re-enters it through each child's interpreter.
- Keep hand-parsing and hold each handler to its schema with a test — rejected: a declaration
  the runtime ignores drifts at the next handler written.
- Positionals fill whichever args no name claimed — rejected: `create x --ttl=9 tune` would
  bind `tune` to whatever slot a reader re-derives. Strict order refuses the ambiguity.

**Consequences:**

- The handler signature changed for every consumer: `$args` is `array<string,mixed>`, one key
  per declared arg, and a handler reads it through the `Core` coercions.
- The declaration is load-bearing. A wrong `required`, type or order is a runtime bug, not a
  palette blemish.
- Binding runs after the verb's role check
  ([ADR-26](#adr-26-every-verb-is-gated-by-the-role-its-schema-declares)), so a malformed
  command from a caller without the role hears `permission denied` and nothing of the args
  the verb declares. A binding refusal echoes a caller's token only in a type refusal on a
  non-secret arg, and counts a surplus rather than echoing it, since a surplus token may be a
  mis-slotted secret. `SessionsCINodeTest` pins the order.
- A binding refusal is not a dispatch span: like an unknown verb, it never reaches
  `$around_dispatch`.
- `Command_Args::parse()`, `Service_CI_Node::split_first_token()` and `require_option_int()`
  are gone, and with them the browser's `parseCommandArgs()`.

**Revisit if:** a verb needs a grammar the declaration cannot state — a repeated named option,
a named list — or `dispatch()` stops being the one door a verb enters through.

---

## ADR-26: Every verb is gated by the role its schema declares

**Status:** Accepted

**Context:** Roles were enforced in two places, and neither reached a worker. `Service_CI_Node`
wrapped each handler in `Capabilities::require()` for the role its schema declared, and
`dispatch()` held the base interpreter's vocabulary to a `required_capability` floor that
only `HTTP_In` pinned. A `:config` interpreter — a Table's, a Consumer's, every patron's —
gated nothing, in a worker or in a request graph, so a session's scope, which
[ADR-15](#adr-15-command-authorization-local-taint--the-minter-signs) makes a ceiling, bounded
no worker verb: a READ session signed for a spoke could `vacuum` its Tables or `dl_purge` its
dead letters. The one scope check on a worker verb was written by hand inside
`Table_Node::flush()`.

**Decision:** `Command_Interpreter_Node::dispatch()` refuses every verb, before anything else
runs, against the role its schema declares: the `capability` of the verb's `commands` entry —
a service CI's own schema, a `:config` interpreter's patron's — and MANAGE when the entry
declares none. A verb no schema names — the base interpreter's vocabulary, and the `help`
every interpreter answers — demands MANAGE, except the read-only builtins `READ_VERBS` lists,
which answer READ. One function, `Capabilities::require_verb()`, makes the decision:

- where a WordPress user is current, `Capabilities::can( $role )`: the user's capability,
  under whatever ceiling the command's session installed;
- where none is — a worker, WP-CLI without `--user`, WP-Cron —
  `Capabilities::scope_covers( $session_scope ?? MANAGE, $role )`: the verified session's
  scope alone. A command carrying no ceiling, signed by the site's own secret or LOCAL to the
  process, runs at MANAGE, the authority that loaded the topology.

No handler checks a role. A `:config` verb that only reports declares `read` — a Table's
`stats`, a dead-letter queue's `dl_list` and `dl_show` — and every other declares nothing. [`scripts/lint-contract.mjs`](../scripts/lint-contract.mjs)'s
`scope-check-in-handler` rule refuses a line reading `Capabilities::$session_scope` to check a
role, so a handler cannot grow its own check back.
The role check precedes the secure-level refusal, the unknown-verb throw and argument binding,
so a caller without the role learns neither whether the verb exists nor what it binds, and a
refused verb never reaches `$around_dispatch`.

**Alternatives considered:**

- A role check in each handler — rejected: it drifts verb by verb, and `Table_Node::flush()`'s
  was the only one ever written.
- Gating in `Service_CI_Node`'s table build — rejected: it misses every `:config` verb, which
  no service CI builds.
- Keep `required_capability` as an endpoint floor — rejected: with MANAGE the role of every
  undeclared verb, the floor `HTTP_In` pinned is what `dispatch()` now does unprompted, and a
  floor a worker left null was the hole.
- A role per argument, `stats` at read and `stats reset` at manage — rejected: a role belongs
  to a verb, so the reset is its own verb, `reset_stats`.

**Consequences:**

- A READ or TUNE session reaches a worker's verbs only where they declare that role: `stats`,
  `dl_list`, `dl_show` and the base `READ_VERBS`. Every other `:config` verb, and the graph
  vocabulary, demands MANAGE of a session in a worker, where it demanded nothing before.
- A service CI's `help` answers READ, as the base interpreter's does, where
  `Service_CI_Node` held it at MANAGE.
- `Service_CI_Node::gate_table()`, its `commands()` override and `require_manage_options()`
  are gone, as is `Command_Interpreter_Node::$required_capability`.
- A consumer's `:config` verbs follow the same rule; event-logger-nodes' and intelligence's
  declare nothing, so each demands MANAGE.
- A verb refused by role emits no dispatch span, because `$around_dispatch` never runs.
- A `Vault_Group_Node` forwards its child class's verbs through an interpreter whose patron is
  the group, whose schema declares none of them, so the group holds each at MANAGE; the
  child's own interpreter then applies the child's declared role.
- A test reaching a verb as a REST request would has to make a user current. With none
  current the scope decides, so an unscoped test command runs at MANAGE.

**Revisit if:** a worker gains a current user — `require_verb()` would then ask that user's
capabilities in place of the session's ceiling alone — or a verb's blast radius turns on its
arguments in a way a second verb cannot split.

---

## ADR-27: Withdrawn: a Ledger of write-once rows

Released in 2.80.0 and removed in 2.83.0, with the `Ledger_Node` it governed. A Ledger kept stats as write-once delta rows clustered by time and aggregated every read. A page ranking a day's URLs had to regroup every row in the window: on staging, five groupings over about 1.8M rows took 75 s and wrote 2.5 GB of temporary B-tree. The stats returned to Tables. The number stays retired.

---

## ADR-28: Withdrawn: a Ledger file per partition

Released in 2.82.0 and removed in 2.83.0 with ADR-27. It moved each partition's Ledger rows into a file of its own, after one shared file made every partition's APPEND wait on another's write lock. The number stays retired.

---

## ADR-29: A log stamp has one writer, one reader, and one resolver per kind

**Status:** Accepted

**Context:** A log stamp names one log everywhere: an SSE subscription, a record's FROM, a
picker key, `read_message` and `dump_log` all use it. Eight sites wrote the `sources/<name>`
stamp or parsed the `{group}/{name}` grammar by hand, across `Log_Sources`,
`Raw_Logs_CI_Node` and `SSE_Out_Node`, and two resolvers turned a stamp into a dir. The
stream split the prefix, held the name to its guard and globbed the live tree;
`Log_Discovery::dir_of()` scanned a memoized catalog and inverted `stamp_for()` over every
dir. They disagreed: the step accepted names the stream's guard refuses, read a scan as old
as the process, and threw on every lookup once a `logs/sources` dir existed. Two footprints
answered one question, and a refusal came back as a returned string in one place and a throw
in another.

**Decision:** [`Log_Discovery::stamp_for()`](../includes/class-log-discovery.php) is the one
writer of a stamp, for the dir roots and for `sources/<name>`. A stamp has one reader of a
subscription, `Log_Discovery::split()`, and one of a FROM trail, `dir_from_stamp()`, whose
twin [`splitStamp()`](../src/runtime/log-stamp.js) `tests/fixtures/log-stamps.json` holds to
it. The two differ on `logs/x`: `split()` refuses it, because a subscription has one
spelling, while `dir_from_stamp()` reads a FROM it did not write and takes `logs/x` as that
two-segment stamp. One resolver per kind turns a stamp into a reader: a dir by direct path
under the stream's guard, `Log_Discovery::dir_of()`, a glob by `dirs_matching()` under the
same guard and the same one join of `{base}/{group}/`, and a source through the registry,
`Log_Sources::entry()`. A File_Tail a topology declares names a source as
`sources/<name>` and reaches the narrower sibling `Log_Sources::file_source_path()`:
built-in and config files only, because the topology family reads the active
topologies, which a loading topology cannot depend on, and its entries are segmented
logs, not files. Its `known:` list therefore names those files alone, where `entry()`'s
names every source. The stream and the
step both reach the resolvers; nothing else parses a prefix, joins a root or scans a catalog to invert
a stamp. A refusal throws, and a position holding no record is a result whose `message` is
null.

**Alternatives considered:** A shared constant each site wraps — rejected, as ADR-22 rejected
it for worker ids: it shares a spelling, not the decision, and each site keeps its own
fallback. A scanning inverse beside a guarded parse — rejected: a step then reads what the
stream refuses, from a scan that cannot see a dir made after it.

**Consequences:** A name the stream refuses is refused by `read_message` and `dump_log` with
the stream's message, and a dir named like a group is refused by name wherever it is
addressed without breaking a lookup of any other. An unreadable topology keeps its picker row
with a label and an error but no key, because it names no log. `scripts/lint-contract.mjs`
holds the rule mechanically: outside `class-log-discovery.php`, no PHP joins
`SOURCES_PREFIX` to a slash, reads `GROUPS` or `STAMP_PREFIXES`, compares `'logs'` with
`$group`, joins `{$group}/` into a path, or spells a `sources/`, `offsets/`, `deadletter/` or
`remote/` literal.

**Revisit if:** a stamp must name something that is neither a dir nor a registry entry.

**Amendment: a stamp's kind has one codec.** A broker publishes each reader as a sibling
under the stamp's KIND, which is also that reader's name suffix and the basename of its cursor
and dead-letter dirs: the stamp with `/` spelled `:`, because the Router splits a TO on `/` and
a step reply returns addressed to the reader's name. [`Log_Discovery::kind_of()`](../includes/class-log-discovery.php)
writes a kind and `stamp_of()` reads one back, and `tests/fixtures/log-kinds.json` holds both
directions to one case list. The broker builds a reader's slot through `kind_of()` and reads a
kind dir under its offsetlog root through `stamp_of()`.

**Amendment: a spoke's log has a name of its own.** A hub's broker reader reports its
position on the hub's own probe log, and a spoke's `firehose.p0` is not the hub's: two logs
sharing one stamp merged the spoke's read rate into the hub's series, and a spoke's `jobs.p0`
into the hub's jobs backlog. So a remote log's name is `remote/<vault_id>:<kind>` — the spoke's
Vault id, then the stamp's kind — which [`Log_Discovery::remote_for()`](../includes/class-log-discovery.php)
writes and `remote_of()` reads back, held to the browser's `remoteOf()` in
[`src/runtime/log-stamp.js`](../src/runtime/log-stamp.js) by `tests/fixtures/log-remotes.json`.
Neither a Vault id nor a stamp carries `:`, so the first `:` parts the two. A remote name is no
stamp: it exists only in the hub's probe channel, as a broker reader's SOURCE, and `remote_of()`
is its one reader. The FROM trail and the SSE wire keep the spoke's stamp, so `REMOTE_PREFIX`
stays out of `STAMP_PREFIXES`: no stamp reader, resolver or subscription ever meets one, and a
local log dir may be named `remote`. A local stamp never opens `remote/`, because a bare stamp
holds no `/`. Rejected: `remote/<vault_id>/<stamp>`, which a FROM reader would cut at the second
segment if one ever met it.

---

## ADR-30: A read position has one writer and one reader

**Status:** Accepted

**Context:** A reader's position travels as text: a `cursor_position()`, a record's ID
breadcrumb, a `CURSORS` entry in the stream's `connected` and `unparseable_lines` frames, a
`read_message` argument, a value in the `positions` map a stream opens with, a paused reader's
step and a pasted Jump. The breadcrumb is the same grammar carrying the record's length,
`<segment>:<offset>:<length>`, and that length is why a position may carry a third field.
Eight sites wrote it:

- `Consumer_Node::cursor_position()` wrote `<segment>:<offset>`.
- `File_Tail_Node` and `Remote_Consumer_Node` wrote `:<offset>` for a generation not known yet,
  and the browser's `stepPosition()` did the same.
- `Tail_Node`, `Durable_Reader` and `Dead_Letter_Queue` wrote breadcrumbs, the last twice.

Seven sites read it, each under a grammar of its own:

- `Log_Sources::read()` took padded digits and a `:<length>`.
- `SSE_In_Node`'s CURSORS reader took canonical decimals and no length.
- `Remote_Consumer_Node::crumb_of()` took padded digits.
- The browser's `_seedPositions()` took whatever `Number()` parses.
- Its breadcrumb readers in `SseInNode` and `SeekTracker`, and the Jump box's
  `parseOffsetJump()`, each kept a regex.
- `SSE_Out_Node::position_arg()` passed a string through as a word.

So the browser and the hub could disagree on what one entry said. The seek words lived on
`Log_Sources`, and their resolution to a sentinel on `Consumer_Node`.

**Decision:** [`Log_Position`](../includes/class-log-position.php) owns the grammar:
`<segment>:<offset>`, the segment-less `:<offset>`, either with a `:<length>`, and the words in
`Log_Position::WORDS`, one table from each word to its `Consumer_Node::SEEK_*` sentinel.
`format( ?int $segment, int $offset, ?int $length )` is the one writer: a null segment writes
`:<offset>`, because segment 0 names a real segment or a foreign inode, and a null length writes
a position rather than a breadcrumb. `parse( string $position )` is the one reader, one anchored
match. It answers the place, its length included when present, or null; every number is a
canonical decimal that fits an int. A word is no place: the two readers that speak the words,
`Log_Sources::read()` and `SSE_Out_Node::position_arg()`, look one up in `WORDS` first. `crumb()`
narrows `parse()` to a breadcrumb, which names its segment and its length. Each
caller states its own refusal, as `CLI::parse_worker_id()` lets its callers do
([ADR-22](#adr-22-a-worker-id-has-one-writer-one-reader-and-two-layout-owners)):
`read_message` throws, a `CURSORS` entry or an ID naming no place is skipped, and a
`positions` string naming none seeks to the start. `sentinel()` and `word()` read the `WORDS`
table in each direction, which is how a paused remote reader asks the spoke for a seek.
Every `cursor_position()` and every breadcrumb writes through `format()`. `Log_Sources::read()`,
`SSE_In_Node`'s CURSORS reader, `SSE_Out_Node::position_arg()` and `Remote_Consumer_Node`'s
breadcrumb read through `parse()` and `crumb()`. The browser's twins, `formatPosition()`,
`parsePosition()` and `parseCrumb()` in [`src/runtime/log-position.js`](../src/runtime/log-position.js),
are what `stepPosition()`, `SseInNode`, `SeekTracker` and `parseOffsetJump()` call.
`tests/fixtures/log-positions.json` holds both languages to one case list. The `positions`
map's object and number forms are its transport, not this grammar: a `{ segment, offset }`
object and a sentinel number pass through as they are.

**Alternatives considered:** A shared regex constant each site wraps. It was rejected for the
reason [ADR-22](#adr-22-a-worker-id-has-one-writer-one-reader-and-two-layout-owners) gives:
it shares a pattern, not the decision, and each site keeps its own cast and fallback. A reader
that throws on every refusal was rejected too. Its callers refuse three ways, and a reader
catching to recover the other two has turned the throw into control flow. A breadcrumb grammar
of its own, beside the position's, was the third: the two differ by one field, and a second
grammar is two places to drift. `Log_Discovery` as the owner was the fourth. It owns where a
log is, and a position is where a reader stands inside one.

**Consequences:** A position one surface writes reads the same on every other: a padded number,
a sign, another base or an empty `:<length>` names no position anywhere. So `read_message`
refuses `047:5`, which it used to read as segment 47, and a record whose ID is `07:12:9` carries
no breadcrumb on either side. A `CURSORS` entry carrying a length is read where it was skipped,
and a `positions` string naming a place seeks there instead of to the start. The browser bounds
a number at `Number.MAX_SAFE_INTEGER` and PHP at `PHP_INT_MAX`, so the fixture keeps out of
the gap between them.

**Revisit if:** a position must carry more than a segment, an offset and a length, such as a
record's index within a batch; or the wire's `positions` map moves to the string grammar, at
which point its object form goes and `parse()` reads every value.

---

## ADR-31: A broker derives its readers from what its remote sends

**Status:** Accepted

**Context:** A [`Remote_Source_Node`](../includes/class-remote-source-node.php) carries every
stream its `<source>:<target>` pairs name over one SSE connection, and reads each stream with
its own [`Remote_Consumer_Node`](../includes/class-remote-consumer-node.php). A pair's source
may be a glob (`firehose.p*`), and which stamps match it is runtime data: the spoke names them,
in each record's FROM and in its handshake's CURSORS. So the broker is the second node type to
build children from runtime state, which is [ADR-21](#adr-21-a-node-may-derive-its-children-from-the-vault-and-static-analysis-reads-it)'s
reopen condition. ADR-21 answers it for `Vault_Group` by flattening each member into the
statements static analysis reads; a broker's members cannot be flattened, because no reader of
the TSL can know which stamps a spoke will send.

**Decision:** A broker builds a reader on first sight of a stamp a pair claims — in a routed
line's FROM, in a handshake's CURSORS, or, for an exact pair, on its first tick — through the
one builder, `consumer_for()`. The reader is published as a hidden sibling named
`<broker>:<kind>`, where `<kind>` is the stamp through `Log_Discovery::kind_of()`
([ADR-29](#adr-29-a-log-stamp-has-one-writer-one-reader-and-one-resolver-per-kind)), so the sibling map
is the one list of readers. Its cursor sits at `<offsetlog_root>/<kind>` and its dead letters at
`<deadletter_root>/<kind>`. Static analysis does not flatten readers: `Topology_Analyzer`'s write
set claims both roots, so the conflict check and `wp nodes gc` cover every reader a glob builds
later, and its graph draws one `pair` edge from the broker to each pair's target
([ADR-19](#adr-19-a-node-may-declare-a-destination-it-writes-without-routing)); the console's TSL
reader draws the same edges for a file being edited, held to the PHP split by
`tests/fixtures/pair-split.json`. `MAX_READERS` (256) caps the stamps glob pairs may claim,
counting the readers built in this process and the reader dirs earlier processes left under the
offsetlog root, so a spoke inventing stamps cannot grow the graph or the disk without bound. An
exact pair is bounded by configuration and never counts.

**Alternatives considered:** Flattening each reader statically, as `Vault_Group` does —
rejected: the stamps are runtime data, so the flatten would have to guess which a glob matches,
and a guess that misses a stamp leaves its cursor outside the write set for `wp nodes gc` to
sweep. One connection per stream, each a node of its own in the TSL — rejected: every stream
holds a slot from the spoke's finite SSE pool, so a hub pulling two streams from each spoke
would spend two slots per spoke.

**Consequences:** A reader appears in no `dump_config` and in no TSL: `dump_config` replays the
broker, which rebuilds its readers from the stream, and the canvas shows each one as the broker's
sibling only once it exists. A reader's configuration therefore goes through the broker's own
verbs — `assume_clean_shutdown` reaches every reader present or built later — and a verb sent
straight to one reader's `:config` is live-only, as a `Vault_Group` child's is. The analyzer reads a broker's roots and
pairs, never its readers, so an analysis question about one reader — its exact cursor dir, its
lag — is answered at runtime: by the probe log, where each reader reports under
`Remote_Source_Node::reader_id()`.

**Revisit if:** a reader must appear in `dump_config` or the TSL — an operator wiring one
reader to its own target, or a verb on one reader that must survive a restart — at which point
the reader becomes a declared node and the glob a configuration-time expansion.

**Amendment: a reader of a source naming no partition runs once per fleet.** A pair whose
source is written with no partition token builds its reader on one worker only, and a pair
written `{partition}` builds one in every worker. [ADR-33](#adr-33-a-line-naming-no-partition-runs-once-per-fleet)
states the rule for every node that reads a source, the broker included.

---

## ADR-32: A transport answers what it could not deliver

**Status:** Proposed. Not decided; nothing in the code implements it.

**Context:** [`HTTP_Out_Node`](../includes/class-http-out-node.php) batches every command filled
into it during a tick into one POST to a spoke. When a batch does not land it reports the
failure once, rate-limited, and tells no sender: it drops a batch whose spoke has no Vault entry
or url, or whose plaintext url `vault_require_ssl` refuses (`drop_batch()`), and it reads a
transport error or a non-200 answer other than 202 in `on_transfer_done()`, keeping nothing of
the batch it sent. A sender waiting on a reply cannot tell that silence from a slow spoke, so a
sender that must not wait forever keeps a clock of its own. `Remote_Consumer_Node` does: a
paused reader's step re-sends `read_message` once `step_requested_at` is older than
`HTTP_Out_Node::REQUEST_TIMEOUT`. [ADR-13](#adr-13-fill-returns-nothing) says an outcome comes back
as a message, and the browser's `HttpOutNode` already answers this way: a POST that never
landed fills each sender a `TM_COMMAND|TM_ERROR` built by `failureReply()`, carrying the
command's `name` and `arguments`, `payload` `Command not delivered: <reason>` and
`undelivered: true`, which `FetcherNode` reads to re-ask a read and settle a write.

**Decision (proposed):** `HTTP_Out_Node` answers every command in a batch it dropped or failed —
a dropped batch, a transport error, a non-200 answer other than 202 — with a
`TM_COMMAND|TM_ERROR` to that command's FROM, in the browser twin's shape. It answers no message
that carried no FROM, that already carried TM_ERROR (as `Router_Node::send_error()` declines a
bounce, so the loop closes after one hop), that carried TM_RESPONSE, or that asked for no reply
with TM_NOREPLY. A batch held for a missing session is not undelivered and answers nothing. The
transfer context carries the batch until its completion, which `REQUEST_TIMEOUT` bounds.
`Remote_Consumer_Node`'s `step_requested_at` clock goes: an undelivered step re-sends on the next
tick, and a request still in flight is the only reason not to.

**Alternatives considered:** A timeout copied into every minter — rejected: it is what
`step_requested_at` is, and each copy re-derives what the transport already knows, at a delay of
its own choosing, with the transport's own `CURLOPT_TIMEOUT` as the floor every copy must clear.

**Consequences:** Every PHP sender through an `HTTP_Out` starts receiving TM_ERRORs it receives
none of today. The blast radius, sender by sender, with what each does with one now:

- **`Remote_Link_Node::maybe_send_heartbeat()`** (FROM the link; `workers heartbeat`). Its
  `fill()` reads any `TM_COMMAND|TM_ERROR` as a failed heartbeat: `stderr()` prints
  `client heartbeat failed`, unthrottled, once per `HEARTBEAT_INTERVAL` (15 s), beside
  HTTP_Out's own rate-limited line, and a broker's `record_heartbeat_failure()` nulls the
  round-trip and sets `last_error`, so the Aggregator badge goes red on the first lost heartbeat
  instead of when the 60 s age-out lapses. It would need to read `undelivered` as the transport's
  failure, already reported.
- **`Remote_Source_Node::request_read()`** (FROM the reader `<broker>:<kind>`;
  `raw-logs read_message`). The reader's `fill()` clears `step_requested_at` on any command
  reply. A bounce echoing the step's arguments takes the refusal branch: it prints
  `step refused` and forgives every owed step, so the operator's click is lost rather than
  retried. It would need to keep the step owed on `undelivered`, as `FetcherNode` re-arms a read.
- **`Fanout_Targets::send_signed()` from `Settings_Sync_Node`** (FROM the node; the spoke's
  `settings` verbs). Its `fill()` returns on anything not TM_STRUCT, so the bounce is counted and
  dropped; the periodic re-push already covers a lost push. No change needed.
- **`Fanout_Targets::send_signed()` from event-logger-nodes' `Discovery_Collector_Node`** (FROM
  the node; `discovery get`). Its `fill()` returns on a payload that is not an array, so the
  string payload is dropped; the next tick probes again. No change needed.
- **Any message routed to an `HTTP_Out`, or to a link that relays it to one.**
  `Remote_Link_Node::fill()` hands every message that is not a heartbeat reply to `send()`,
  which fills its patron `HTTP_Out` verbatim, FROM untouched; a bare `HTTP_Out` takes whatever
  a TO path addresses to it. So every node in the graph that can address a link or an egress
  is a sender: an operator's Shell (`wp nodes cli` attached to a hub worker, FROM
  `_output/_cli:<pid>/_output`), a `cmd` or `command_node` aimed past an egress, a dashboard
  command routed through the hub, an application node targeting one. Today a lost POST
  answers none of them; under the proposal each gets a TM_ERROR at its FROM, which a Shell
  prints and any other node handles as its `fill()` handles any TM_ERROR. A topology line
  carries TM_NOREPLY and is not answered. These commands are whatever their senders wrote,
  writes included: an operator's `cmd … set` or `vault` verb applies state.

**Revisit if:** a transport cannot tell delivered from lost — a non-200 a proxy answers after
the spoke applied the command — at which point a bounce invites a retry that applies a write
twice. The first four senders above are idempotent; the routed messages of the fifth are not,
since an operator's command may be a write. A bounce does not retry anything itself, but a
sender that re-sends on one would apply such a write twice, so the fifth already decides
between marking a bounce `undelivered` as possibly applied and keeping a per-sender clock.

---

## ADR-33: A line naming no partition runs once per fleet

**Status:** Accepted

**Context:** A topology mounts once per worker partition, so every `make_node` line builds a
node in every worker. A line reading a source that names no partition — `sources/php`, a fixed
file, a spoke's `firehose.p0` — therefore read it once per worker: every line relayed N times,
and N workers committing one offsetlog. A line meant to read one source per worker names its
partition, but the Shell resolves `<partition>` before `make_node` runs, so the node sees
`app.2.log` and cannot tell a per-worker file from a fixed one. Two nodes decided ownership
two ways: [`Remote_Source_Node`](../includes/class-remote-source-node.php) kept a pair written
`{partition}` everywhere and a fixed one on partition 0, while
[`File_Tail_Node`](../includes/class-file-tail-node.php) idled off partition 0 whatever its
file, so `File_Tail t /var/log/app.{partition}.log` could not be written. And the two
spellings, `<partition>` resolved by the Shell and `{partition}` by the node, needed a refusal
of the first in sources, which the analyzer made per class, counting arguments by offset and
judging quote rules a single-quoted `'<partition>'` escaped.

**Decision:** What a node reads is defined by its TSL, and one predicate reads it.
[`Core::owns( $written, $partition )`](../includes/class-core.php) is true when the source as written
carries `{partition}`, and otherwise on partition 0 or, where `$partition` is null, in a
process bound to no partition. Nothing else decides ownership: a node passes
`Core::bound_partition()`, and the on-demand wake map passes each worker's partition, so it
wakes only the worker that reads a fixed source. Every durable reader asks it:
[`Durable_Reader`](../includes/trait-durable-reader.php) judges the argument its class names
through `source_argument()` — a `Consumer`'s `source_dir`, a `Tail`'s and `File_Tail`'s
`source_file` — as written, in `idle_unless_owned()`, which each reader's `arguments()` calls
before it builds anything. `Remote_Source_Node::owned_pairs()` asks it per pair and builds a
reader only for a pair it owns, so that log stays out of `stream_request()`; a
`Remote_Consumer_Node` names no source argument, because its broker already judged it, and
never idles.

`{partition}` is the one spelling, and the node resolves it. Each node type's `node_schema()`
marks the arguments that take one: `'partition' => 'bound'` on a reader's source, an
offsetlog or dead-letter dir, a Partition or Log path, a Table namespace and a link's
subscription, and `'partition' => 'each'` on a Topic's `dir_template`, where the token means
each of its N partitions rather than the worker's. `Schema_Reflection::schema_values()` is the
one resolver: it resolves a `bound` argument's `{partition}` at the bound partition and its
`{topology}` at the bound fleet, and leaves an `each` argument to the node. Where neither is
bound, outside a worker, a path naming either is refused rather than resolved at partition 0,
which would name worker p0's own file; ownership keeps its rule that an unbound process owns a
fixed source, and a `Remote_Source` pair naming `{partition}` is refused there as well. `{partition}` in an unmarked argument is refused by
`Schema_Reflection::refuse_unmarked_partition()`, a static the analyzer calls too, so a line
the load would refuse fails `wp nodes activate` and `topologies save` first. The
node keeps the tokens as written in `$this->arguments`, so `written_argument()` answers what
the TSL said for ownership, and `dump_config()` replays `{partition}`, so a dump taken on p2
rebuilds on p3. The Shell refuses `<partition>`, however it is quoted or escaped, in
`parse()` and in the static `parse_statements()` alike, as does the JS twin, so the analyzer,
the editor and a load all fail the same line with `<partition> resolves before the node sees
it; write {partition}`. A template no Shell reads — a registered log producer, a config log
source — reaches `Core::has_partition_token()` or `resolve_partition_template()`, which
refuse `<partition>` rather than read it as a fixed name and declare one literal dir.

A reader that owns nothing idles in one state, held by `Durable_Reader`: it builds no source,
opens nothing, arms no timer, blanks its offsetlog and dead-letter dirs so no sidecar is built
and no `dl_*` verb finds a quarantine, reports `POLLING` as `IDLE` with `idle: { since,
reason }` beside it, refuses `poll`, `step`, `pause`, `play`, `seek_frame` and a seek with that
reason, and writes no stderr line, because idling is normal operation. Every line is still
parsed on every partition, so a bad one fails everywhere.

**Alternatives considered:** A `num_partitions = 1` pin on a topology reading a fixed source —
rejected: a hub pulling a multi-partition spoke's firehose needs a worker per partition, and
the pin would take them with the fixed reader. A lock on the shared offsetlog — rejected: it
would serialize readers that should not exist, and every worker would still build its node,
connect and hold its slot. Keeping the per-class refusal in the analyzer — rejected: it names
classes, counts offsets the classes own, and judged values where the Shell judges quotes.
Keeping both spellings with a refusal of the eager one in sources — rejected: the refusal
needed a per-class override, an analyzer pass and a quote rule a single-quoted token escaped,
where one spelling needs none of them.

**Consequences:** A per-worker source is written `{partition}`; a topology writing
`<partition>` anywhere fails to load, in the analyzer, the editor and `wp nodes doctor`. A fixed
source is read on one worker only, so its reader's lag and dead letters live on partition 0: a
`Consumer` of a fixed log in a multi-partition topology runs on p0 alone, and every other
worker's copy idles. A per-partition source keeps per-partition state: a reader resolves
`{partition}` in its offsetlog and dead-letter dirs as in its source, and
`Durable_Reader::refuse_shared_dirs()`, which the analyzer and every reader's load both call,
refuses a per-partition source beside a named dir carrying no `{partition}`, which every worker
would commit one cursor to and quarantine one queue into. A new durable reader names its
source argument and inherits the rest; a reader built in code inside a worker, after the
topology bound its partition, is judged as a line is, so a builder that has already decided
ownership, as the broker has, names no source argument.

**Revisit if:** a fixed source must be read by more than one worker — split across them, or
failed over when partition 0 is down — at which point ownership becomes a lease rather than a
partition number; or a topology must place a fixed reader on a partition other than 0.

