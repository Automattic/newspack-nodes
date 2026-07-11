# Getting Started with Newspack Nodes

You know PHP and WordPress. You've never touched a "node graph." This page gets you from zero to a running pipeline you can poke at by hand — in about five minutes — and then points you at the walkthrough that teaches you to build your own.

## Before you start

A few things this runtime assumes. It's WordPress-internal — there is no standalone mode.

- **PHP 8.2+** — declared in the plugin header (`Requires PHP: 8.2`) and enforced by `composer.json` (`"php": ">=8.2"`).
- **WordPress, with WP-Cron and the REST API.** The substrate's lifecycle *is* WordPress: config in the options table, the supervisor's safety net on WP-Cron, worker spawn / commands / SSE over the REST API. (The plugin header declares no minimum WordPress version — run a current release.)
- **WP-CLI** — every command on this page (`wp plugin …`, `wp nodes status`, `wp nodes cli …`) is WP-CLI.
- **memcache — optional to boot, load-bearing in practice.** The runtime comes up without it: `Bootstrap::init_memcached()` degrades to a null handle when no servers are configured rather than failing. But several paths then fail closed — HMAC command-auth refuses wire-arrived commands (it can't enforce single-use nonces), SSE slots fail closed, and live position/stats never publish, so the dashboards go dark. Workers still spawn and drain; you just lose the remote-command and live-stats surfaces. For the full experience, point `memcache_servers` at a running memcached.

## The whole idea, one screen

A **node** is a small object with exactly one entry point:

```php
public function fill( array $message ): void
```

That's the contract. Every node — a data source, a transform, a file writer, the router itself — receives work the same way: a message arrives at `fill()`. A node does its job and forwards the message to the next node. There is no other API to learn.

Two wires connect nodes:

- **`sink`** — the *physical* next node. When a node is done, `fill()` hands the message to its sink.
- **`target`** — a *logical* address (a string path). When a message has no destination yet, the base `fill()` stamps `target` into the message's `TO` field. `_router` then resolves `TO` by peeling off the leading path segment and looking up that node.

A **message** is a 7-field indexed array — `[ TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE ]` — always addressed by the `Message::*` constants. `VALUE` is the payload: a string (`TM_BYTESTREAM`) or an array (`TM_STRUCT`). That's the entire data model.

That uniformity is the point. Any node can connect to any other node, because they all speak `fill()`. **You add capability by wiring a node, not by editing a system.** Fan-out is a `Tee`; a transform is your own `fill()`; file output is the built-in `Log`. New behavior is a new class with a new `fill()` body — never a change to the ones already running.

For the full model — the drain loop, workers, partitions, the REPL — see [architecture-guide.md](architecture-guide.md).

## Feel it in 5 minutes

The repo ships a runnable example: `examples/example-ai-newsletter/`, a scored, durable digest pipeline built from small nodes. It's deterministic — no API keys, no network — so it runs anywhere. Two sources (`releases`, `community`) emit canned items into a `summarizer` that condenses each, then a `scorer` adds a notional priority and appends each item to the durable `example-scored` partition. A `Consumer` tails that log into the `digest` builder, which assembles a markdown draft and fans it through a `Tee` to the built-in `Log` (which writes it to a file).

```bash
# 1. Install and activate the example from its release asset. The example is its
#    own plugin (own composer.json + vendor/autoload) and loads after the
#    substrate, so newspack-nodes must be active first — it no-ops if the
#    substrate is absent.
wp plugin activate newspack-nodes
wp plugin install https://github.com/Automattic/newspack-nodes/releases/latest/download/example-ai-newsletter.zip --activate

# 2. Where the digest gets written (Log appends here).
mkdir -p /tmp/example-ai-newsletter

# 3. Activate the topology, then see the worker. Activating the example
#    *registers* its `example-ai-newsletter` topology, but the shipped default
#    active set is empty — nothing spawns by surprise. Activate it either from
#    the Topology Manager (Nodes → Hub → Topologies) or from the CLI:
wp nodes activate example-ai-newsletter
#    Now the supervisor has spawned it:
wp nodes status
#   example-ai-newsletter  0  live  3s ago  2m 10s
```

Open the **topology console** (the Nodes admin page): you'll see the `example-ai-newsletter` graph — `releases` and `community` both feeding `summarizer`, then `scorer` appending to the durable `scored:partition`, a `scored:consumer` tailing that log into `digest`, then a `digest:tee` that fans to the built-in `digest:log` — with live message counts on every edge.

Now drive it by hand. Attach a REPL to the running worker and fire the runtime triggers — `TICK`/`FLUSH` are `TM_REQUEST`s (sent with `request_node`), not admin commands. The sources are fire-and-forget: a `TICK` emits items but sends no reply, so watch the edge counts climb in the topology console rather than expecting REPL output:

```bash
wp nodes cli example-ai-newsletter.p0
```
```
> request_node releases TICK      # releases source emits its items
> request_node community TICK      # the other source emits its items
> request_node digest FLUSH        # assemble + write the draft
```

Each `TICK` flows source → summarizer → scorer → scored:partition → scored:consumer → digest (watch the counts climb in the console). `FLUSH` writes the assembled draft:

```bash
cat /tmp/example-ai-newsletter/digest.md.0   # Log writes segments {file}.0, {file}.1, … — there is no bare {file}
# # Newsletter draft
#
# - Roundup Block ships — AI summarizes selected posts into a draft.
# - ...
```

You just watched a handful of independent nodes cooperate without any of them knowing about the others — only the message shape they pass.

## When you get it wrong

The runtime tries to make its errors tell you the fix. A few you'll likely meet:

- **`unknown class: Summarizer`** — from a `make_node` line (a topology, or `make_node` at the REPL). The type didn't resolve to a `{prefix}Summarizer_Node` class under any registered namespace. Either the name is wrong, or the class file hasn't reached the autoloader yet — see the next one.
- **A Node class you just added isn't in the topology-editor palette** (and `make_node` can't resolve it). The palette scans the *composer classmap* for concrete `*_Node` classes — `Classes_CI_Node::cmd_list()` walks `ClassLoader::getClassMap()` — so a brand-new class file stays invisible until you regenerate the map: `composer dump-autoload -o`.
- **``no worker 'exmaple-ai-newsletter.p0' (run `wp nodes status` to list active workers)``** — from `wp nodes cli <typo>`. The reader id doesn't match a live worker. Do what it says and run `wp nodes status`. A common cause isn't a typo at all: the topology's active set is empty (nothing spawns by surprise), so `wp nodes activate <topology>` first.
- **`Command_Auth: no memcache handle; refusing command (single-use unverifiable)`** in the log — a wire command reached a worker with no memcache handle, so it can't enforce single-use nonces and fails closed. Point `memcache_servers` at a running memcached (see *Before you start*).

## Next: build one yourself

The five-minute tour ran a pipeline. The walkthrough builds it from an empty file, one node at a time, and shows *why* this shape pays off — when a second author drops a new source into the running graph with a single line and changes nothing else.

→ **[writing-a-plugin.md](writing-a-plugin.md)**
