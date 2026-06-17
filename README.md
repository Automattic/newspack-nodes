# Newspack Nodes

A node-graph runtime for composable services, built as WordPress plugin infrastructure. Nodes pass messages and sink into one another; underneath them the runtime is WordPress — config in the options table, the supervisor on WP-Cron, worker spawn and commands over the REST API, position and stats in memcache. WordPress-internal, not a standalone PHP bus.

## Why

The traditional WordPress plugin shape — singletons, hooks-as-coupling, monolithic worker classes — makes composition hard. Each plugin grows its own private bus, its own private worker lifecycle, its own private read/write paths. Sharing pieces between plugins means cut-paste-modify, not Lego.

Newspack Nodes is a different bet. The substrate gives you one contract — every node receives messages via `fill( array &$message )`, every node sinks into another node — and that's it. With that uniformity, composition just works: any node connects to any other node, fan-out is a Tee, transforms are Hooks, file I/O is a Tail or Log. New behavior is a new Node class with a new `fill()` body.

The runtime is independent of any *application* — but not of WordPress. It owns the substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, Job_Worker, REPL) and ships nothing application-specific — the lone stock topology, `topologies/job-worker.tsl`, drives the generic Job_Worker_Node, and its application context arrives through `before_job` / `after_job` hooks. But the lifecycle underneath is all WordPress: config lives in the options table, the supervisor's safety net runs on WP-Cron, workers spawn and take commands over the REST API behind HMAC + nonce auth, and live position/stats ride in memcache. So "application-independent" is the honest claim; "standalone runtime" is not. The first application built on top is `newspack-event-logger-nodes`, replacing a 10-plugin event-logging monorepo with a graph of ~10 node classes.

This is an early implementation of an idea pitched at the team meetup: the Lego-bricks architecture, brought to PHP/WordPress, without giving up production fitness on Atomic / WP-Cloud.

## Learn it

New to Nodes? Start with **[getting-started.md](docs/getting-started.md)** — run the bundled example pipeline in about five minutes — then **[writing-a-plugin.md](docs/writing-a-plugin.md)** builds that example from an empty directory, one node at a time, and shows why the shape pays off. The complete code lives in [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/).

## Quick Start

Install as a standard WordPress plugin, then:

```bash
# Activate (no app — just the runtime).
wp plugin activate newspack-nodes

# List active workers (none, until an application registers a topology).
wp nodes ls

# Open the bare REPL (local nodes only).
wp nodes cli
```

To get workers running, install an application plugin that registers a topology — one call, `Topology_Registry::register_plugin( 'My_Namespace\\', __DIR__ . '/topologies' )`. The bundled [`examples/example-ai-newsletter/`](examples/example-ai-newsletter/) is the smallest complete example; `newspack-event-logger-nodes` is the production one.

## Concepts

- **Node** — base class. Subclasses override `fill( array &$message )`.
- **Message** — 7-field indexed array: TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE.
- **Router** — path-based dispatch. Splits TO on `/`, looks up the leading segment, forwards remainder.
- **Topic** — multi-Partition wrapper, KEY-routed via CRC32.
- **Partition** — file-segmented append-only log. Storage primitive AND Node.
- **Tee** — fan-out. Per-target try/catch isolates failures; dead targets pruned at fill.
- **Tail** — line-oriented file follower; inode + size-shrink rotation detection.
- **Log** — file writer (inverse of Tail). Append/overwrite, optional size-based auto-rotate, retention pruning.
- **Consumer** — Partition reader with offsetlog checkpointing.
- **Job_Worker** — generic async-job dispatch; local/remote handler maps via the `newspack_nodes/{job,remote_job}_handlers` filters, with per-job context delivered through the `newspack_nodes/job_worker/{before,after}_job` actions. Ships `topologies/job-worker.tsl`.
- **Echo** — routing helper that re-addresses on the way through (path-prepend, return-to-sender).
- **Callback** — closure-as-Node adapter for inline transforms.
- **Hook** — WordPress action / filter as a node. Plugin-extensibility surface.
- **Timer** — base class for time-driven nodes (Router extends it).
- **Shell** + **Command_Interpreter** + **Dumper** — REPL components. `make_node` (resolves a node type by namespace prefix + `_Node` suffix) is callable as both a shell verb and a PHP method.

The runtime also exposes an admin settings page, backed by a shared Config System (`includes/config-system/`) that consumer plugins reuse — declarative fields with per-field reset toggles and an `allowed_users` access whitelist gating the substrate's admin surface.

For the full mental model, see [architecture-guide.md](docs/architecture-guide.md). For the substrate's contracts and invariants, see [AGENTS.md](AGENTS.md).

## REST API

The runtime ships three REST endpoints — the worker spawn handler, a unified command-dispatch endpoint (`HTTP_In_Node`, which routes a posted command envelope through the request-scope graph to a service CI), and a server-sent-events stream (`SSE_Out_Node`, drains log/IPC partitions to dashboards). Application plugins register their own endpoints (status, dashboards, additional streams, etc.) on top.

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
POST  /wp-json/newspack-nodes/v1/command
GET   /wp-json/newspack-nodes/v1/messages/stream
```

See [API.md](docs/API.md) for the request/response shapes.

## License

GPL-2.0-or-later

## Status

v0.18.x. The first application built on the substrate, `newspack-event-logger-nodes`, ships alongside this runtime; the substrate's API is stabilizing toward 1.0 but still pre-1.0 — expect schema-field renames and incremental contract tightening. See [CHANGELOG.md](CHANGELOG.md) for the per-version history.
