# Newspack Nodes

A node-graph runtime for composable services, built as WordPress plugin infrastructure. Nodes pass messages and sink into one another; underneath them the runtime is WordPress — config in the options table, the cold-start safety net on WP-Cron, worker spawn and commands over the REST API, position and stats in memcache. It is WordPress-internal, not a standalone PHP bus.

## Why

The traditional WordPress plugin shape — singletons, hooks-as-coupling, monolithic worker classes — makes composition hard. Each plugin grows its own private bus, its own private worker lifecycle, its own private read/write paths. Sharing pieces between plugins means cut-paste-modify, not Lego.

Newspack Nodes is a different bet. The substrate gives you one contract: every node receives messages via `fill( array $message )`, and every node sinks into another node. That uniformity is what makes composition work — any node connects to any other node, fan-out is a Tee, transforms are Hooks, file I/O is a Tail or Log. New behavior is a new Node class with a new `fill()` body.

The runtime is independent of any *application* — but not of WordPress. It owns the substrate (Node, Message, Router, Topic, Partition, Worker, Fleet, Job_Worker, REPL) and ships nothing application-specific. The four stock topologies are `topologies/job-worker.tsl`, which drives the generic Job_Worker_Node (its application context arriving through `before_job` / `after_job` hooks); `topologies/job-intake.tsl`, which drains the large-write job ingress on substrate-only installs; `topologies/settings-sync.tsl`, the single-instance settings-sync control plane; and `topologies/topic-probe.tsl`, the per-worker consumer-stats sweep. But every part of the lifecycle underneath belongs to WordPress, so "application-independent" is the honest claim and "standalone runtime" is not. The first application built on top is `newspack-event-logger-nodes`, replacing a 10-plugin event-logging monorepo with a graph of ~10 node classes.

This is the Lego-bricks architecture pitched at the team meetup, brought to PHP/WordPress — and running in production on WordPress.com Atomic.

## The parts nothing else ships

Job queues exist. These don't, anywhere else in WordPress:

- **A live topology console.** A graph editor over the running fleet: see every node and edge with live message counts, rewire a graph, save it back to its `.tsl` — from the browser.
- **An attached REPL.** `wp nodes cli <worker>.p0` pivots into a live worker over IPC: inspect with `dump_node`, `trace`, and `stats`, rewire sinks, send test messages — no restart, no redeploy.
- **Time-travel debugging.** Readers checkpoint durable cursors, so a Consumer can pause, single-step, and seek back through the log's history while you watch downstream react.
- **A Jobs dashboard.** Per-handler throughput, failures, run duration, queue latency, and backlog — replayed 24 hours deep from the durable jobstats log the workers already write.
- **Errors as docs.** Runtime errors name their fix; `help <NodeType>` in the REPL renders any node's schema, arguments, and verbs from the class itself.
- **An infra-free test suite.** 3,400+ tests on a bare laptop — no containers, no database, no memcached, under a minute.
- **Written-down architecture.** Fourteen ADRs with context, alternatives, and the condition that would reopen each ([architecture-decisions.md](docs/architecture-decisions.md)).

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
the failure it needed to escape. Marginal cost near zero, one real weakness solved.
That's the test: if Nodes is already there, a one-node use is fine; if it isn't,
don't add a runtime for one job.

## Learn it

New to Nodes? Start with **[getting-started.md](docs/getting-started.md)** — run the bundled example pipeline in about five minutes — then work through the `docs/` set (mapped by reading order in **[docs/README.md](docs/README.md)**):

- **[getting-started.md](docs/getting-started.md)** — zero to a running pipeline you can poke at by hand.
- **[writing-a-plugin.md](docs/writing-a-plugin.md)** — build the AI-newsletter example from an empty directory, one node at a time.
- **[writing-a-real-plugin.md](docs/writing-a-real-plugin.md)** — take that toy to the production version, two method bodies away.
- **[writing-a-dashboard.md](docs/writing-a-dashboard.md)** — add a React admin dashboard that reads the pipeline's live state.
- **[writing-a-real-dashboard.md](docs/writing-a-real-dashboard.md)** — the production realities of shipping a dashboard (console, DevTools overlay, release).
- **[writing-a-view-node.md](docs/writing-a-view-node.md)** — the one-page contract for a dashboard slice's terminal view node.
- **[architecture-guide.md](docs/architecture-guide.md)** — full substrate design: message format, node contracts, drain loop, REPL.
- **[architecture-decisions.md](docs/architecture-decisions.md)** — the load-bearing ADRs and the conditions that would reopen them.
- **[API.md](docs/API.md)** — REST endpoint reference.
- **[cli.md](docs/cli.md)** — every `wp nodes` subcommand and the flows they combine into.
- **[troubleshooting.md](docs/troubleshooting.md)** — the REPL, worker health, log paths, and the failure modes we actually hit.

The complete code lives in [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/).

## Quick Start

Install as a standard WordPress plugin, then:

```bash
# Activate (no app — just the runtime).
wp plugin activate newspack-nodes

# List active workers (none, until an application registers a topology).
wp nodes status

# Open the bare REPL (local nodes only).
wp nodes cli
```

To get workers running, install an application plugin that registers a topology — one call, `Topology_Registry::register_plugin( 'My_Namespace\\', __DIR__ . '/topologies' )`. The bundled [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/) is the smallest complete example; `newspack-event-logger-nodes` is the production one.

## Concepts

- **Node** — base class. Subclasses override `fill( array $message )`.
- **Message** — 7-field indexed array: TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE.
- **Router** — path-based dispatch. Splits TO on `/`, looks up the leading segment, forwards remainder.
- **Topic** — multi-Partition wrapper, KEY-routed via CRC32.
- **Partition** — file-segmented append-only log. Storage primitive AND Node.
- **Tee** — fan-out. Attempts every target, then re-throws the one deferred failure, so a late target still receives the message before the poison path advances the cursor. Dead targets pruned at fill.
- **Tail** — line-oriented file follower; inode + size-shrink rotation detection.
- **Log** — file writer (inverse of Tail). Append/overwrite, optional size-based auto-rotate, retention pruning.
- **Consumer** — Partition reader with offsetlog checkpointing.
- **Table** — keyed store backed by memcache, so any process reads or writes a value via `Table_Node::lookup()` / `store()` / `forget()`. Write-through, so it composes mid-graph.
- **Grep**, **Age_Sieve**, **Value_Timeout** — filters. Grep forwards VALUEs matching a regex; Age_Sieve drops messages older than `max_age`; Value_Timeout dedups by VALUE within a timeout window.
- **Topic_Probe**, **Job_Probe** — periodic stats sweeps. Topic_Probe logs each Consumer's cursor distance; Job_Probe logs one per-interval record per job identity. Both feed the dashboards.
- **Null** — counts and discards. The destination for traffic that must go somewhere and do nothing.
- **Job_Worker** — generic async-job dispatch; local/remote handler maps via the `newspack_nodes/{job,remote_job}_handlers` filters, with per-job context delivered through the `newspack_nodes/job_worker/{before,after}_job` actions. Ships `topologies/job-worker.tsl`.
- **Echo** — routing helper that re-addresses on the way through (path-prepend, return-to-sender).
- **Callback** — closure-as-Node adapter for inline transforms.
- **Hook** — WordPress action / filter as a node. Plugin-extensibility surface.
- **Timer** — base class for time-driven nodes (Router extends it).
- **Shell** + **Command_Interpreter** + **Dumper** — REPL components. `make_node` (resolves a node type by namespace prefix + `_Node` suffix) is callable as both a shell verb and a PHP method.

The runtime also exposes an admin settings page, backed by a shared Config System (`includes/config-system/`) that consumer plugins reuse — declarative fields with per-field reset toggles and an `allowed_users` access whitelist gating the substrate's admin surface.

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

## License

GPL-2.0-or-later

## Testing

The full suite — 3,400+ tests — runs on plain `phpunit` with WP stubs and an
in-memory memcache double: no containers, no database, no memcached server, no
WordPress install. `npm install && composer install && npm run build` sets
up a fresh clone. `composer install && cd tests && ../vendor/bin/phpunit
--enforce-time-limit` works on a bare laptop (macOS included) and finishes in
under a minute.

## Status

1.0: the load-bearing names are frozen. **[docs/stability.md](docs/stability.md)** is the contract — which surfaces are frozen (the node contract, the message, TSL, the CLI, REST, hooks), the deprecation policy, and what stays internal. Breaking changes are curated with their fix in [docs/upgrading.md](docs/upgrading.md) (start at your installed version, apply everything above it); [CHANGELOG.md](CHANGELOG.md) has the full story per release. Five production plugins declare `Requires Plugins: newspack-nodes`, `newspack-event-logger-nodes` first among them.
