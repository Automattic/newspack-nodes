# Getting Started with Newspack Nodes

You know PHP and WordPress. You've never touched a "node graph." This page gets you from zero to a running pipeline you can poke at by hand — in about five minutes — and then points you at the walkthrough that teaches you to build your own.

## The whole idea, one screen

A **node** is a small object with exactly one entry point:

```php
public function fill( array &$message ): void
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
# 1. Build the example's autoloader and activate it. The example is its own
#    plugin (own composer.json + vendor/autoload) and loads after the substrate,
#    so newspack-nodes must be active first — it no-ops if the substrate is absent.
cd examples/example-ai-newsletter && composer dump-autoload -o && cd -
wp plugin activate newspack-nodes example-ai-newsletter

# 2. Where the digest gets written (Log appends here).
mkdir -p /tmp/example-ai-newsletter

# 3. Activate the topology, then see the worker. Activating the example
#    *registers* its `example-ai-newsletter` topology, but the shipped default
#    active set is empty — nothing spawns by surprise. Activate it either from
#    the Topology Manager (Nodes → Hub → Topologies) or from the REPL:
#        wp nodes cli   →   topologies activate example-ai-newsletter
#    Now the supervisor spawns it:
wp nodes ls
#   ... example-ai-newsletter.p0   [live]
```

Open the **topology console** (the Nodes admin page): you'll see the `example-ai-newsletter` graph — `releases` and `community` both feeding `summarizer`, then `scorer` appending to the durable `scored:partition`, a `scored:consumer` tailing that log into `digest`, then a `digest:tee` that fans to the built-in `digest:log` — with live message counts on every edge.

Now drive it by hand. Pivot a REPL into the running worker and fire the runtime triggers — `TICK`/`FLUSH` are `TM_REQUEST`s (sent with `request_node`), not admin commands. The sources are fire-and-forget: a `TICK` emits items but sends no reply, so watch the edge counts climb in the topology console rather than expecting REPL output:

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
cat /tmp/example-ai-newsletter/digest.md
# # Newsletter draft
#
# - Roundup Block ships — AI summarizes selected posts into a draft.
# - ...
```

You just watched a handful of independent nodes cooperate without any of them knowing about the others — only the message shape they pass.

## Next: build one yourself

The five-minute tour ran a pipeline. The walkthrough builds it from an empty file, one node at a time, and shows *why* this shape pays off — when a second author drops a new source into the running graph with a single line and changes nothing else.

→ **[writing-a-plugin.md](writing-a-plugin.md)**
