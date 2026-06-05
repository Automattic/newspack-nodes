# Getting Started with Newspack Nodes

You know PHP and WordPress. You've never touched Tachikoma or a "node graph." This page gets you from zero to a running pipeline you can poke at by hand — in about five minutes — and then points you at the walkthrough that teaches you to build your own.

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

For the full model — the drain loop, workers, partitions, the REPL — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Feel it in 5 minutes

The repo ships a runnable example: `examples/newspack-ai-newsletter/`, a digest pipeline built from four small nodes. It's deterministic — no API keys, no network — so it runs anywhere. Two sources emit canned items, a summarizer condenses each, a builder assembles a markdown draft, and the built-in `Log` writes it to a file.

```bash
# 1. Build the example's autoloader and activate it (alongside newspack-nodes).
cd examples/newspack-ai-newsletter && composer dump-autoload -o && cd -
wp plugin activate newspack-nodes newspack-ai-newsletter

# 2. Where the digest gets written (Log appends here).
mkdir -p /tmp/newspack-ai-newsletter

# 3. See the worker. Activating the example registers its `digest` topology;
#    if you haven't curated an active set, the full catalog is active, so the
#    supervisor spawns it. (Otherwise enable `digest` under
#    Settings → Nodes Runtime → Topologies.)
wp nodes ls
#   ... digest.p0   [live]
```

Open the **topology console** (the Nodes admin page): you'll see the `digest` graph — `releases` and `community` both feeding `summarizer`, then `digest`, then `out` — with live message counts on every edge.

Now drive it by hand. Pivot a REPL into the running worker and fire the verbs:

```bash
wp nodes cli digest.p0
```
```
> command_node releases:config tick     # releases source emits its items
emitted 2 item(s)
> command_node community:config tick     # the other source emits its items
emitted 2 item(s)
> command_node digest:config flush       # assemble + write the draft
flushed 4 summary(ies)
```

Each `tick` flows source → summarizer → digest (watch the counts climb in the console). `flush` writes the assembled draft:

```bash
cat /tmp/newspack-ai-newsletter/digest.md
# # Newsletter draft
#
# - Roundup Block ships — AI summarizes selected posts into a draft.
# - ...
```

You just watched four independent nodes cooperate without any of them knowing about the others — only the message shape they pass.

## Next: build one yourself

The five-minute tour ran a pipeline. The walkthrough builds it from an empty file, one node at a time, and shows *why* this shape pays off — when a second author drops a new source into the running graph with a single line and changes nothing else.

→ **[WRITING-A-PLUGIN.md](WRITING-A-PLUGIN.md)**
