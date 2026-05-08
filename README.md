# Newspack Nodes

A node-graph runtime for composable PHP services. Tachikoma-style message passing, expressed as WordPress plugin infrastructure.

## Why

The traditional WordPress plugin shape — singletons, hooks-as-coupling, monolithic worker classes — makes composition hard. Each plugin grows its own private bus, its own private worker lifecycle, its own private read/write paths. Sharing pieces between plugins means cut-paste-modify, not Lego.

Newspack Nodes is a different bet. The substrate gives you one contract — every node receives messages via `fill( array &$message )`, every node sinks into another node — and that's it. With that uniformity, composition just works: any node connects to any other node, fan-out is a Tee, transforms are Hooks, file I/O is a Tail or Partition. New behavior is a new Node class with a new `fill()` body.

The runtime is independent of any application. It owns the substrate (Node, Message, Router, Topic, Partition, Worker, Supervisor, REPL) and ships nothing application-specific. The first application built on top is `newspack-event-logger-nodes`, replacing a 10-plugin event-logging monorepo with a graph of ~10 node classes.

This is a working prototype of an idea pitched at the team meetup: the Lego-bricks architecture, brought to PHP/WordPress, without giving up production fitness on Atomic / WP-Cloud.

## Quick Start

```bash
# Deploy to dndocker container.
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-nodes.sh

# Activate plugin (no app — just the runtime).
docker exec -u bend eve-pyrobase1-1 wp plugin activate newspack-nodes \
    --allow-root --path=/var/www/html

# List active workers (none, until an application registers a topology).
docker exec eve-pyrobase1-1 wp nodes ls --allow-root --path=/var/www/html

# Open the bare REPL (local nodes only).
docker exec -it eve-pyrobase1-1 wp nodes cli --allow-root --path=/var/www/html
```

To get workers running, install an application plugin (e.g., `newspack-event-logger-nodes`) that registers via the `newspack_nodes/topologies` filter.

## Concepts

- **Node** — base class. Subclasses override `fill( array &$message )`.
- **Message** — 7-field indexed array: TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE.
- **Router** — path-based dispatch. Splits TO on `/`, looks up the leading segment, forwards remainder.
- **Topic** — multi-Partition wrapper, KEY-routed via CRC32.
- **Partition** — file-segmented append-only log. Storage primitive AND Node.
- **Tee** — fan-out. TM_PERSIST aggregation with cancel-dominates.
- **Tail** — file follower. Three buffer modes; inode + size-shrink rotation detection.
- **Consumer** — Partition reader with offsetlog checkpointing.
- **Hook** — WordPress action / filter as a node. Plugin-extensibility surface.
- **CommandInterpreter** — admin shell vocabulary AND graph builder. `make_node` is callable as both a shell verb and a PHP method.

For the full mental model, see [ARCHITECTURE.md](ARCHITECTURE.md). For the substrate's contracts and invariants, see [AGENTS.md](AGENTS.md).

## REST API

The runtime ships exactly one REST endpoint — the worker spawn handler. Application plugins register their own endpoints (status, dashboards, SSE streams, etc.) on top.

```
POST  /wp-json/newspack-nodes/v1/workers/spawn
```

See [API.md](API.md) for the request/response shape.

## License

GPL-2.0-or-later

## Status

Prototype. Drawer-stable substrate; first application port (`newspack-event-logger-nodes`) in progress. Not yet in production.
