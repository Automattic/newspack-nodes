# Newspack Nodes

A node-graph runtime for composable services, built as WordPress plugin infrastructure. Nodes pass messages and sink into one another; underneath them the runtime is WordPress — settings and the active topology set in the options table, the cold-start safety net on WP-Cron, worker spawn and commands over the REST API, command sessions and SSE slot leases in the shared cache tier (memcached, else APCu). Worker liveness and reader position are the exception: they live on the runtime's own file tree, in lock dirs and durable logs. It is WordPress-internal, not a standalone PHP bus.

## Why

The traditional WordPress plugin shape — singletons, hooks-as-coupling, monolithic worker classes — makes composition hard. Each plugin grows its own private bus, its own private worker lifecycle, its own private read/write paths. Sharing pieces between plugins means cut-paste-modify, not Lego.

Newspack Nodes is a different bet. The substrate gives you one contract: every node receives messages via `fill( array $message )`, and every node sinks into another node. That uniformity is what makes composition work — any node connects to any other node, fan-out is a Tee, transforms are Hooks, file I/O is a Tail or Log. New behavior is a new Node class with a new `fill()` body.

The runtime is independent of any *application* — but not of WordPress. It owns the substrate (Node, Message, Router, Topic, Partition, Worker, Fleet, Job_Worker, REPL) and ships nothing application-specific. The four stock topologies are [`topologies/job-worker.tsl`](topologies/job-worker.tsl), which drives the generic Job_Worker_Node (its application context arriving through the `before_job` filter and the `after_job` action); [`topologies/job-intake.tsl`](topologies/job-intake.tsl), which drains the large-write job ingress on substrate-only installs; [`topologies/settings-sync.tsl`](topologies/settings-sync.tsl), the single-instance settings-sync control plane; and [`topologies/topic-probe.tsl`](topologies/topic-probe.tsl), the per-worker consumer-stats sweep. But every part of the lifecycle underneath belongs to WordPress, so "application-independent" is the honest claim and "standalone runtime" is not. The event logger, [`newspack-event-logger-nodes`](https://github.com/Automattic/newspack-event-logger-nodes), adds ten node classes of its own: seven that carry its pipelines and three service interpreters.

This is the Lego-bricks architecture in PHP and WordPress, on a platform with no resident daemon: a worker is an HTTP request that outlives its caller and hands its slot to a successor at ~595 seconds, under WordPress.com Atomic's 15-minute request cap.

## What a job queue does not give you

A job queue runs work. This runtime also lets you watch it, steer it and replay it while it runs:

- **A live topology console.** A graph editor over the running fleet: see every node and edge with live message counts, rewire a graph, save it as a `.tsl` — from the browser. The stock files stay immutable, so an edit saves under a new name that `include`s the stock one.
- **A REPL attached to a running worker.** [`wp nodes cli <worker>.p0`](docs/cli.md) pivots into a live worker over IPC, where `wp shell` starts a fresh process: inspect with `dump_node`, `trace`, and `stats`, rewire sinks, send test messages — no restart, no redeploy.
- **Time-travel debugging.** Readers checkpoint durable cursors, so a Consumer can pause, single-step, and seek back through the log's history while you watch downstream react.
- **A Jobs dashboard.** Runs and errors per handler, duration and queue latency per job identity, and the jobs Topic's backlog — replayed 24 hours deep from the durable jobstats log the workers already write.
- **Refusals that name the fix.** A refusal names the argument or the call that satisfies it — `Consumer source partition not initialized; call arguments() first` — and `help <NodeType>` in the REPL renders any node's schema, arguments, and verbs from the class itself.
- **A test suite that needs no infrastructure.** 9,200+ tests across PHP and JavaScript, with no containers, no database, no memcached server and no WordPress install.
- **Written-down architecture.** Twenty ADRs, each carrying the alternatives it rejected and the condition that would reopen it ([architecture-decisions.md](docs/architecture-decisions.md)).

## When NOT to use Nodes

Nodes is a runtime, and a runtime you don't need is overhead. Reach for the
incumbent when it already fits:

- **One background job, now and then** — [Action Scheduler](https://actionscheduler.org/)
  is one call, probably already installed, and runs anywhere WordPress does. Don't
  install a node-graph runtime to send a welcome email.
- **A scheduled task that tolerates drift** — [`wp_schedule_event()`](https://developer.wordpress.org/reference/functions/wp_schedule_event/) is free. WP-Cron's
  known weakness (it fires on traffic, so quiet sites drift) is only worth solving when
  it is your problem.
- **Request-scope glue** — actions and filters compose fine at request scale; that's
  what they're for.

Nodes earns its keep when the shape of the problem is a **pipeline or a stream**: durable ordered
logs you can replay, long-lived workers that hold state between messages, graphs you
rewire in a topology file instead of code, and a REPL/dashboard view into all of it.
The event logger — a firehose that fans out into routing and aggregation — is the
native case.

And one honest middle case: [`newspack-cache-cozy`](https://github.com/Automattic/newspack-cache-cozy) uses Nodes for one Timer node
that enqueues one job per interval — incumbent-shaped work — because the substrate
is *already installed* for the event logger, and its warm render needs a cadence
WP-Cron cannot hold: a minute event competing for a slot with the reconcile pass
and every other scheduled task. The marginal cost is near zero and it solves one
real weakness. That's the test: if Nodes is already there, a one-node use is fine; if it isn't,
don't add a runtime for one job.

## Learn it

**[docs/README.md](docs/README.md)** maps the whole set in reading order, in three groups:

- **Understand it.** Eight chapters, one mechanism each, with diagrams: [why a message runtime](docs/why-a-message-runtime.md), [the vocabulary](docs/vocabulary.md), [logs on disk](docs/logs-on-disk.md), [workers and the fleet](docs/workers-and-the-fleet.md), [commands, capabilities and sessions](docs/commands-capabilities-and-sessions.md), [hub and spoke](docs/hub-and-spoke.md), [the browser runtime](docs/browser-runtime.md) and [writing and running a plugin](docs/writing-and-running-a-plugin.md). Read them in order; each builds on the last.
- **Build with it.** Tutorials, run after every step. [getting-started.md](docs/getting-started.md) has the bundled example pipeline running in about five minutes; [writing-a-plugin.md](docs/writing-a-plugin.md) and [writing-a-dashboard.md](docs/writing-a-dashboard.md) build the AI-newsletter example and its dashboard from an empty directory; [writing-a-real-plugin.md](docs/writing-a-real-plugin.md), [writing-a-real-dashboard.md](docs/writing-a-real-dashboard.md) and [writing-a-view-node.md](docs/writing-a-view-node.md) take both to production.
- **Reference.** [architecture-guide.md](docs/architecture-guide.md), [architecture-decisions.md](docs/architecture-decisions.md), [security-model.md](docs/security-model.md), [API.md](docs/API.md), [cli.md](docs/cli.md), [troubleshooting.md](docs/troubleshooting.md), [sse-host-budget.md](docs/sse-host-budget.md), [stability.md](docs/stability.md), [upgrading.md](docs/upgrading.md) and [tachikoma-lineage.md](docs/tachikoma-lineage.md).

The complete code lives in [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/).

## Quick Start

You need PHP 8.2 or newer, WordPress 6.5 or newer, and a cache backend — Memcached, or APCu on a single web host. Workers spawn over the REST API, so the runtime itself needs no WP-CLI — the verbs below and the REPL do. Install as a standard WordPress plugin, then:

```bash
# Activate (no app — just the runtime).
wp plugin activate newspack-nodes

# Eight checks before wiring anything: cache backend, filesystem, ownership,
# the housekeeping cron, config keys, worker liveness, consumer lag and dead
# letters. Each miss names its degradation; a critical one exits non-zero.
wp nodes doctor

# List active workers (none until a topology is activated).
wp nodes status

# Open the bare REPL (local nodes only).
wp nodes cli
```

To get workers running, install an application plugin that registers a topology — one call, [`Topology_Registry::register_plugin`](includes/class-topology-registry.php)`( 'My_Namespace\\', __DIR__ . '/topologies' )` — then activate it with [`wp nodes activate <topology>`](docs/cli.md). Registration only makes the `.tsl` discoverable and the plugin's `*_Node` classes resolvable to `make_node`; the active set is the `topologies` config key, which defaults to empty, so nothing spawns until a name lands in it. [`wp nodes scaffold plugin my-pipeline`](docs/cli.md#the-common-flows) writes that plugin's starter files in the shapes [writing-a-plugin.md](docs/writing-a-plugin.md) teaches, and never overwrites an existing one. The bundled [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/) is the smallest complete example; `newspack-event-logger-nodes` is the production one.

## Concepts

- **[Node](includes/class-node.php)** — the base class. Subclasses override `fill( array $message )`.
- **[Message](includes/class-message.php)** — a 7-field indexed array: TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE.
- **[Router](includes/class-router-node.php)** — path-based dispatch. Splits TO on `/`, looks up the leading segment, forwards the remainder.
- **[Topic](includes/class-topic-node.php)** — multi-Partition wrapper, KEY-routed via CRC32.
- **[Partition](includes/class-partition-node.php)** — file-segmented append-only log of packed message envelopes. Storage primitive AND Node.
- **[Log](includes/class-log-node.php)** — a Partition subclass that writes the message VALUE rather than the packed envelope, so its segments hold the producer's own lines. It inherits segments, monotonic rotation and the three retention rules, and drops exactly three types instead of writing them: TM_ERROR, TM_EOF and TM_REQUEST. Every other type falls through, so a ping, a command or a command reply that reaches a Log lands in the file as a data record carrying that message's VALUE.
- **[Consumer](includes/class-consumer-node.php)** — Partition reader with offsetlog checkpointing, and the pause / step / seek time travel that rides on the same cursor.
- **[Tail](includes/class-tail-node.php)**, **[File_Tail](includes/class-file-tail-node.php)** — log followers. Tail reads a Log's `{file}.{seg}` segments through the Consumer read model, forwarding each complete line as a TM_BYTESTREAM; File_Tail subclasses it to follow a single filename with `tail -F` logrotate semantics.
- **[Tee](includes/class-tee-node.php)**, **[Tap](includes/class-tap-node.php)** — fan-out. Tee attempts every target, then re-throws the one deferred failure, so a late target still receives the message before the poison path advances the cursor; dead targets are pruned on every read of the target list. Tap adds hard-addressed targets and passes the original on, for a graph that must continue past the fan-out.
- **[Table](includes/class-table-node.php)** — keyed store on the shared cache tier, so any process reads or writes a value via `Table_Node::table( $ns, $ttl )` and then `lookup()` / `store()` / `forget()`. Write-through, so it composes mid-graph. Two tiers hang off it, both off until a caller opts in: `accumulator()` folds values in memory, and `backed_by()` names the durable record a miss falls through to.
- **[Grep](includes/class-grep-node.php)**, **[Age_Sieve](includes/class-age-sieve-node.php)**, **[Value_Timeout](includes/class-value-timeout-node.php)** — filters. Grep forwards a message whose VALUE matches a PCRE and drops the rest; Age_Sieve drops messages whose TIMESTAMP is older than `max_age`; Value_Timeout coalesces repeated triggers carrying the same VALUE within a timeout window, then re-emits the last one as the window ages out.
- **[JSON_To_Struct](includes/class-json-to-struct-node.php)**, **[Struct_To_JSON](includes/class-struct-to-json-node.php)** — the TM_STRUCT to JSON-line pair. Splice them around a Log so a struct producer's array VALUE round-trips through a bytestream.
- **[Topic_Probe](includes/class-topic-probe-node.php)**, **[Job_Probe](includes/class-job-probe-node.php)** — periodic stats sweeps. Topic_Probe logs each Consumer's cursor, backlog and per-sweep throughput; Job_Probe logs one per-interval record per job identity, sweeping only the Job_Workers in its own process. Every job-worker partition appends to one fixed `jobstats.p0`, and an identity is `handler:id` with no partition in it, so past the `num_partitions` default of 1 a reader sees one record per identity per process per sweep, each covering that process's window alone — sum them rather than reading one. Both feed the dashboards, and the topicprobe log is the only live-position source `wp nodes status` reads.
- **[Graphite](includes/class-graphite-node.php)**, **[Probe_To_Graphite](includes/class-probe-to-graphite-node.php)**, **[Newspack_Log](includes/class-newspack-log-node.php)** — metrics egress. Probe_To_Graphite accumulates every probe record arriving inside its emit interval and renders that whole window as plaintext `path value ts` lines, summing `msgs_delta` and `bytes_read_delta` across the sweeps it held and sampling the newest `distance` and `cache_size`, because the first two partition the work while the last two are levels. Each line carries the timestamp of the newest probe folded in rather than the emit instant. Graphite ships the lines over UDP, and Newspack_Log fires `do_action( 'newspack_log', … )`.
- **[Null](includes/class-null-node.php)** — counts and discards. The destination for traffic that must go somewhere and do nothing.
- **[Job_Worker](includes/class-job-worker-node.php)** — generic async-job dispatch. Local and remote handler maps arrive through the `newspack_nodes/{job,remote_job}_handlers` filters, per-job context through the `newspack_nodes/job_worker/before_job` filter and the matching `after_job` action. Ships `topologies/job-worker.tsl`.
- **[Echo](includes/class-echo-node.php)** — routing helper that re-addresses on the way through (path-prepend, return-to-sender).
- **[Callback](includes/class-callback-node.php)** — closure-as-Node adapter: the terminal that runs arbitrary PHP once per message, so a one-off needs no subclass of its own. It forwards nothing unless the closure fills the sink itself.
- **[Hook](includes/class-hook-node.php)** — a WordPress action or filter as a node. The plugin-extensibility surface.
- **[Timer](includes/class-timer-node.php)** — base class for time-driven nodes (Router extends it).
- **[HTTP_Out](includes/class-http-out-node.php)**, **[SSE_In](includes/class-sse-in-node.php)**, **[Remote_Link](includes/class-remote-link-node.php)**, **[Remote_Source](includes/class-remote-source-node.php)** — the cross-site channels. HTTP_Out batches outbound TM_COMMAND envelopes into one POST per drain tick; SSE_In pulls a remote stream over the cURL-multi; Remote_Link owns three patron siblings — the SSE_In, the HTTP_Out and the Null that arms HTTP_Out's wire-inbound clause — and mints the heartbeat and drives the reconnect; Remote_Source extends Remote_Link with a durable offsetlog cursor for aggregating a remote log. The status seams are empty in Remote_Link and filled only by Remote_Source, so connection state reaches a dashboard through a Remote_Source and never through a bare Remote_Link.
- **[Vault](includes/class-vault.php)**, **[Sessions](includes/class-sessions.php)** — the credential stores, one per direction. Vault holds what this site sends OUT — a URL and a credential per spoke, addressed by id, the password sealed at rest under a key derived from `wp_salt( 'auth' )`, and `credential_header()` the one place Basic wins over Bearer — so `HTTP_Out` and `Remote_Link` resolve their wire there rather than from a caller. Sessions is the mirror: the command sessions this site issues to callers coming IN.
- **[Settings_Sync](includes/class-settings-sync-node.php)** — the hub end of the settings control plane. A Consumer tails the watched-option changes into it, and it pushes each option's current value to the spokes, minting one command per spoke and signing that command under the spoke's own session key. Ships `topologies/settings-sync.tsl`.
- **[Lock](includes/class-lock-node.php)**, **[Fleet](includes/class-fleet-node.php)** — the worker lifecycle. Lock claims one `{type}.p{N}` slot with an atomic `mkdir`, heartbeats inside it, and carries restart, stop and reload flags in to whoever holds it; Fleet mounts as `_fleet` in every worker and respawns any peer whose heartbeat has gone stale, every 15 seconds.
- **[Service_CI](includes/class-service-ci-node.php)** — the verb-table base. An interpreter declares each verb once in `node_schema()`, and this class derives the dispatch table, wraps every handler in the capability that schema names, and shares the argument parsers. Every console, dashboard and settings command surface is one: the substrate mounts ten on each request graph — `classes`, `layouts`, `topologies`, `raw-logs`, `vault`, `aggregator`, `settings`, `status`, `sessions` and `workers` — and an application adds its own on `newspack_nodes/request_graph_ready`.
- **[Shell](includes/class-shell-node.php)** + **[Command_Interpreter](includes/class-command-interpreter-node.php)** + **[Dumper](includes/class-dumper-node.php)** — REPL components. `wp nodes cli` wires them between `TTY_In` and `TTY_Out`, the readline-aware terminal pair; `Stdin`, `Stdout` and `Stderr` are the bare stream counterparts a graph splices in with no terminal attached. `make_node` (resolves a node type by namespace prefix + `_Node` suffix) is callable as both a shell verb and a PHP method.

The runtime ships two admin surfaces. The top-level **Nodes** page is a station whose nine tabs — Overview, Jobs, Console, Partition Viewer, Log Viewer, Config Audit, Vault, Sessions and Aggregator — arrive in five build bundles, and a consumer contributes its own through the `newspack_nodes/station_tab_bundles` filter. **Settings → Nodes Runtime** is the server-rendered settings form, backed by a shared Config System ([`includes/config-system/`](includes/config-system/)) that consumer plugins reuse — declarative fields with per-field reset toggles and an `allowed_users` login allow-list narrowing every capability role, so it governs the REST control plane as well as the admin surface. Three capability roles cut the command surface by blast radius: `read` (introspection, dashboards, and the SSE streams — which carry the raw log firehose, not shaped dashboards alone), `tune` (declared configuration and application data) and `manage` (fleet control and credentials). A verb names its role in `node_schema()` and an endpoint checks one directly; all three default to `manage_options` until a site filters [`newspack_nodes/capability_map`](docs/API.md#filters) or runs [`wp nodes caps install`](docs/cli.md#capabilities-and-the-hub-user).

For the full mental model, see [architecture-guide.md](docs/architecture-guide.md). For the substrate's contracts and invariants, see [AGENTS.md](AGENTS.md).

## REST API

The runtime ships six REST endpoints: the worker spawn handler; a session issuer that hands a client the key it signs commands with; a unified command-dispatch endpoint ([`HTTP_In_Node`](includes/rest/class-http-in-node.php), which routes a posted command envelope through the request-scope graph to a service CI); two server-sent-events streams ([`SSE_Out_Node`](includes/rest/class-sse-out-node.php) drains partitions to dashboards, [`Log_Stream_Out_Node`](includes/rest/class-log-stream-out-node.php) tails a named log source); and an internal loopback probe that reports the web runtime's cache posture to `wp nodes doctor`. An application extends that surface with service-CI verbs behind `/command` and dashboards subscribed to the streams, rather than with routes of its own — `newspack-event-logger-nodes` registers exactly one, [its MCP controller](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/app/class-mcp-controller.php).

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

WP stubs and an in-memory memcache double remove the infrastructure, so both
suites run on a bare laptop, macOS included. The PHP half needs the `memcached`
extension, because that double subclasses `\Memcached`, but it never needs a server.
`npm install && composer install && npm run build` sets up a fresh clone;
`cd tests && ../vendor/bin/phpunit --enforce-time-limit` runs the PHP half and
`npm run test:js` the JavaScript half. Use the vendored PHPUnit rather than a
system one — composer constrains it to 10.x, and a newer major dies on the
bootstrap.

## Status

**[docs/stability.md](docs/stability.md)** is the contract — the ten declared surfaces (the node contract, the message, TSL, the stock node types, the CLI, REST, hooks, Config_System, Config_Utils, consumer boot) and what stays internal. The list is a reference, not a promise of stillness: a minor may still move one of those names, and nothing in the tree carries `@deprecated`, so an old spelling is rejected rather than aliased. That is why every consumer-facing change lands in [docs/upgrading.md](docs/upgrading.md) with its rewrite beside it — start at your installed version and apply everything above it; [CHANGELOG.md](CHANGELOG.md) has the full story per release. `newspack-cache-cozy`, `newspack-event-logger-nodes`, `newspack-intelligence`, `newspack-nuclear-gyrobase` and `newspack-pyrobase` each declare `Requires Plugins: newspack-nodes`.

## License

GPL-2.0-or-later
