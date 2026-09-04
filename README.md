# Newspack Nodes

A node-graph runtime for composable services, built as WordPress plugin infrastructure. Nodes pass messages and sink into one another; underneath them the runtime is WordPress — config in the options table, the cold-start safety net on WP-Cron, worker spawn and commands over the REST API, command sessions and SSE slot leases in the shared cache tier (memcached, else APCu). Worker liveness and reader position are the exception: they live on the runtime's own file tree, in lock dirs and durable logs. It is WordPress-internal, not a standalone PHP bus.

## Why

The traditional WordPress plugin shape — singletons, hooks-as-coupling, monolithic worker classes — makes composition hard. Each plugin grows its own private bus, its own private worker lifecycle, its own private read/write paths. Sharing pieces between plugins means cut-paste-modify, not Lego.

Newspack Nodes is a different bet. The substrate gives you one contract: every node receives messages via `fill( array $message )`, and every node sinks into another node. That uniformity is what makes composition work — any node connects to any other node, fan-out is a Tee, transforms are Hooks, file I/O is a Tail or Log. New behavior is a new Node class with a new `fill()` body.

The runtime is independent of any *application* — but not of WordPress. It owns the substrate (Node, Message, Router, Topic, Partition, Worker, Fleet, Job_Worker, REPL) and ships nothing application-specific. The four stock topologies are `topologies/job-worker.tsl`, which drives the generic Job_Worker_Node (its application context arriving through the `before_job` filter and the `after_job` action); `topologies/job-intake.tsl`, which drains the large-write job ingress on substrate-only installs; `topologies/settings-sync.tsl`, the single-instance settings-sync control plane; and `topologies/topic-probe.tsl`, the per-worker consumer-stats sweep. But every part of the lifecycle underneath belongs to WordPress, so "application-independent" is the honest claim and "standalone runtime" is not. The first application built on top is `newspack-event-logger-nodes`, replacing a 10-plugin event-logging monorepo with a graph of ten node classes.

This is the Lego-bricks architecture pitched at the team meetup, brought to PHP/WordPress — and running in production on WordPress.com Atomic.

## The parts nothing else ships

Job queues exist. These don't, anywhere else in WordPress:

- **A live topology console.** A graph editor over the running fleet: see every node and edge with live message counts, rewire a graph, save it back to its `.tsl` — from the browser.
- **An attached REPL.** `wp nodes cli <worker>.p0` pivots into a live worker over IPC: inspect with `dump_node`, `trace`, and `stats`, rewire sinks, send test messages — no restart, no redeploy.
- **Time-travel debugging.** Readers checkpoint durable cursors, so a Consumer can pause, single-step, and seek back through the log's history while you watch downstream react.
- **A Jobs dashboard.** Per-handler throughput, failures, run duration, queue latency, and backlog — replayed 24 hours deep from the durable jobstats log the workers already write.
- **Errors as docs.** Runtime errors name their fix; `help <NodeType>` in the REPL renders any node's schema, arguments, and verbs from the class itself.
- **An infra-free test suite.** 4,200+ tests, with no containers, no database, no memcached server and no WordPress install.
- **Written-down architecture.** Twenty ADRs with context, alternatives, and the condition that would reopen each ([architecture-decisions.md](docs/architecture-decisions.md)).

## When NOT to use Nodes

Nodes is a runtime, and a runtime you don't need is overhead. Reach for the
incumbent when it already fits:

- **One background job, now and then** — [Action Scheduler](https://actionscheduler.org/)
  is one call, probably already installed, and runs anywhere WordPress does. Don't
  install a node-graph runtime to send a welcome email.
- **A scheduled task that tolerates drift** — `wp_schedule_event()` is free. WP-Cron's
  known weakness (it fires on traffic, so quiet sites drift) is only worth solving when
  it is your problem.
- **Request-scope glue** — actions and filters compose fine at request scale; that's
  what they're for.

Nodes earns its keep when the shape of the problem is a **pipeline**: durable ordered
logs you can replay, long-lived workers that hold state between messages, graphs you
rewire in a topology file instead of code, and a REPL/dashboard view into all of it.
The event logger — a firehose that fans out into routing and aggregation — is the
native case.

And one honest middle case: `newspack-cache-cozy` uses Nodes for a single
Timer-enqueues-one-job loop — incumbent-shaped work — because the substrate was
*already installed* for the event logger, and WP-Cron's traffic-dependence was exactly
the failure it needed to escape. The marginal cost was near zero and it solved one
real weakness. That's the test: if Nodes is already there, a one-node use is fine; if it isn't,
don't add a runtime for one job.

## Learn it

New to Nodes? Start with **[getting-started.md](docs/getting-started.md)** — run the bundled example pipeline in about five minutes — then work through the `docs/` set (mapped by reading order in **[docs/README.md](docs/README.md)**):

- **[getting-started.md](docs/getting-started.md)** — zero to a running pipeline you can poke at by hand.
- **[writing-a-plugin.md](docs/writing-a-plugin.md)** — build the AI-newsletter example from an empty directory, one node at a time.
- **[writing-a-dashboard.md](docs/writing-a-dashboard.md)** — add a React admin dashboard that reads the pipeline's live state.
- **[writing-a-real-plugin.md](docs/writing-a-real-plugin.md)** — take that toy to the production version, two method bodies away.
- **[writing-a-real-dashboard.md](docs/writing-a-real-dashboard.md)** — the production realities of shipping a dashboard (console, DevTools overlay, release).
- **[writing-a-view-node.md](docs/writing-a-view-node.md)** — the one-page contract for a dashboard slice's terminal view node.
- **[architecture-guide.md](docs/architecture-guide.md)** — full substrate design: message format, node contracts, drain loop, REPL.
- **[architecture-decisions.md](docs/architecture-decisions.md)** — the load-bearing ADRs and the conditions that would reopen them.
- **[API.md](docs/API.md)** — REST endpoint reference.
- **[cli.md](docs/cli.md)** — every `wp nodes` subcommand and the flows they combine into.
- **[troubleshooting.md](docs/troubleshooting.md)** — the REPL, worker health, log paths, and the failure modes we actually hit.
- **[sse-host-budget.md](docs/sse-host-budget.md)** — what one SSE stream costs in php-fpm children, and what happens when they run out.
- **[stability.md](docs/stability.md)** — the frozen surfaces, the deprecation policy, and what stays internal.
- **[upgrading.md](docs/upgrading.md)** — each breaking change with its fix, for moving a consumer across substrate versions.
- **[tachikoma-lineage.md](docs/tachikoma-lineage.md)** — the Perl this runtime varies from, file and symbol, and why each divergence was chosen.

The complete code lives in [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/).

## Quick Start

You need PHP 8.2 or newer, WordPress 6.5 or newer, WP-CLI, and a cache backend (Memcached, or APCu on a single web host). Install as a standard WordPress plugin, then:

```bash
# Activate (no app — just the runtime).
wp plugin activate newspack-nodes

# Check the environment before wiring anything: cache backend, filesystem,
# ownership, the housekeeping cron, config keys. Each miss names its
# degradation.
wp nodes doctor

# List active workers (none, until an application registers a topology).
wp nodes status

# Open the bare REPL (local nodes only).
wp nodes cli
```

To get workers running, install an application plugin that registers a topology — one call, `Topology_Registry::register_plugin( 'My_Namespace\\', __DIR__ . '/topologies' )`. `wp nodes scaffold plugin my-pipeline` writes that plugin's starter files in the shapes [writing-a-plugin.md](docs/writing-a-plugin.md) teaches, and never overwrites an existing one. The bundled [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/) is the smallest complete example; `newspack-event-logger-nodes` is the production one.

## Concepts

- **Node** — the base class. Subclasses override `fill( array $message )`.
- **Message** — a 7-field indexed array: TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE.
- **Router** — path-based dispatch. Splits TO on `/`, looks up the leading segment, forwards the remainder.
- **Topic** — multi-Partition wrapper, KEY-routed via CRC32.
- **Partition** — file-segmented append-only log of packed message envelopes. Storage primitive AND Node.
- **Log** — a Partition subclass that writes the message VALUE rather than the packed envelope, so its segments hold the producer's own lines. It inherits segments, monotonic rotation and the three retention rules, and drops control messages instead of writing them.
- **Consumer** — Partition reader with offsetlog checkpointing, and the pause / step / seek time travel that rides on the same cursor.
- **Tail**, **File_Tail** — log followers. Tail reads a Log's `{file}.{seg}` segments through the Consumer read model, forwarding each complete line as a TM_BYTESTREAM; File_Tail subclasses it to follow a single filename with `tail -F` logrotate semantics.
- **Tee**, **Tap** — fan-out. Tee attempts every target, then re-throws the one deferred failure, so a late target still receives the message before the poison path advances the cursor; dead targets are pruned on every read of the target list. Tap adds hard-addressed targets and passes the original on, for a graph that must continue past the fan-out.
- **Table** — keyed store on the shared cache tier, so any process reads or writes a value via `Table_Node::table( $ns, $ttl )` and then `lookup()` / `store()` / `forget()`. Write-through, so it composes mid-graph. Two tiers hang off it, both off until a caller opts in: `accumulator()` folds values in memory, and `backed_by()` names the durable record a miss falls through to.
- **Grep**, **Age_Sieve**, **Value_Timeout** — filters. Grep forwards a message whose VALUE matches a PCRE and drops the rest; Age_Sieve drops messages whose TIMESTAMP is older than `max_age`; Value_Timeout coalesces repeated triggers carrying the same VALUE within a timeout window, then re-emits the last one as the window ages out.
- **JSON_To_Struct**, **Struct_To_JSON** — the TM_STRUCT to JSON-line pair. Splice them around a Log so a struct producer's array VALUE round-trips through a bytestream.
- **Topic_Probe**, **Job_Probe** — periodic stats sweeps. Topic_Probe logs each Consumer's cursor distance; Job_Probe logs one per-interval record per job identity. Both feed the dashboards.
- **Graphite**, **Probe_To_Graphite**, **Newspack_Log** — metrics egress. Probe_To_Graphite formats a sweep into plaintext `path value ts` lines, Graphite ships them over UDP, and Newspack_Log fires `do_action( 'newspack_log', … )`.
- **Null** — counts and discards. The destination for traffic that must go somewhere and do nothing.
- **Job_Worker** — generic async-job dispatch. Local and remote handler maps arrive through the `newspack_nodes/{job,remote_job}_handlers` filters, per-job context through the `newspack_nodes/job_worker/before_job` filter and the matching `after_job` action. Ships `topologies/job-worker.tsl`.
- **Echo** — routing helper that re-addresses on the way through (path-prepend, return-to-sender).
- **Callback** — closure-as-Node adapter, for an inline transform or a terminal used once.
- **Hook** — a WordPress action or filter as a node. The plugin-extensibility surface.
- **Timer** — base class for time-driven nodes (Router extends it).
- **HTTP_Out**, **SSE_In**, **Remote_Link**, **Remote_Source** — the cross-site channels. HTTP_Out batches outbound TM_COMMAND envelopes into one POST per drain tick; SSE_In pulls a remote stream over the cURL-multi; Remote_Link owns the pair and adds heartbeat, reconnect and status; Remote_Source extends Remote_Link with a durable cursor for aggregating a remote log.
- **Lock**, **Fleet** — the worker lifecycle. Lock claims one `{type}.p{N}` slot with an atomic `mkdir`, heartbeats inside it, and carries restart, stop and reload flags in to whoever holds it; Fleet mounts as `_fleet` in every worker and respawns any peer whose heartbeat has gone stale, every 15 seconds.
- **Service_CI** — the verb-table base. An interpreter declares each verb once in `node_schema()`, and this class derives the dispatch table, wraps every handler in the capability that schema names, and shares the argument parsers. Every console, dashboard and settings command surface is one.
- **Shell** + **Command_Interpreter** + **Dumper** — REPL components. `wp nodes cli` wires them between `TTY_In` and `TTY_Out`, the readline-aware terminal pair; `Stdin`, `Stdout` and `Stderr` are the bare stream counterparts a graph splices in with no terminal attached. `make_node` (resolves a node type by namespace prefix + `_Node` suffix) is callable as both a shell verb and a PHP method.

The runtime also exposes an admin settings page, backed by a shared Config System (`includes/config-system/`) that consumer plugins reuse — declarative fields with per-field reset toggles and an `allowed_users` login allow-list narrowing the substrate's admin surface. Three capability roles cut the command surface by blast radius: `read` (introspection, dashboards, and the SSE streams — which carry the raw log firehose, not shaped dashboards alone), `tune` (declared configuration and application data) and `manage` (fleet control and credentials). A verb names its role in `node_schema()` and an endpoint checks one directly; all three default to `manage_options` until a site filters `newspack_nodes/capability_map` or runs `wp nodes caps install`.

For the full mental model, see [architecture-guide.md](docs/architecture-guide.md). For the substrate's contracts and invariants, see [AGENTS.md](AGENTS.md).

## REST API

The runtime ships six REST endpoints: the worker spawn handler; a session issuer that hands a client the key it signs commands with; a unified command-dispatch endpoint (`HTTP_In_Node`, which routes a posted command envelope through the request-scope graph to a service CI); two server-sent-events streams (`SSE_Out_Node` drains partitions to dashboards, `Log_Stream_Out_Node` tails a named log source); and an internal loopback probe that reports the web runtime's cache posture to `wp nodes doctor`. Application plugins register their own endpoints (status, dashboards, additional streams, etc.) on top.

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
POST  /wp-json/newspack-nodes/v1/auth
POST  /wp-json/newspack-nodes/v1/command
POST  /wp-json/newspack-nodes/v1/health/cache
GET   /wp-json/newspack-nodes/v1/messages/stream
GET   /wp-json/newspack-nodes/v1/log/stream
```

See [API.md](docs/API.md) for the request/response shapes.

## Testing

WP stubs and an in-memory memcache double are what remove the infrastructure, so
the whole suite runs on a bare laptop, macOS included.
`npm install && composer install && npm run build` sets up a fresh clone, and
`composer install && cd tests && ../vendor/bin/phpunit --enforce-time-limit`
runs it. Use the vendored binary rather than a system `phpunit` — composer
constrains PHPUnit to 10.x, and a newer major dies on the bootstrap.

## Status

The load-bearing names are frozen for the current major. **[docs/stability.md](docs/stability.md)** is the contract — which surfaces are frozen (the node contract, the message, TSL, the stock node types, the CLI, REST, hooks, Config_System, consumer boot), the deprecation policy, and what stays internal. Breaking changes are curated with their fix in [docs/upgrading.md](docs/upgrading.md) (start at your installed version, apply everything above it); [CHANGELOG.md](CHANGELOG.md) has the full story per release. Five production plugins declare `Requires Plugins: newspack-nodes`, `newspack-event-logger-nodes` first among them.

## License

GPL-2.0-or-later
