# Getting Started with Newspack Nodes

You know PHP and WordPress. You've never touched a "node graph." This page gets you from zero to a running pipeline you can poke at by hand — in about five minutes — and then points you at the walkthrough that teaches you to build your own.

## Before you start

This runtime is WordPress-internal; there is no standalone mode. It assumes four things.

- **PHP 8.2+** — declared in the plugin header (`Requires PHP: 8.2`) and enforced by `composer.json` (`"php": ">=8.2"`).
- **WordPress, with WP-Cron and the REST API.** The substrate's lifecycle *is* WordPress: config in the options table, the supervisor's safety net on WP-Cron, worker spawn / commands / SSE over the REST API. (The plugin header declares no minimum WordPress version — run a current release.)
- **WP-CLI** — every command on this page (`wp plugin …`, `wp nodes status`, `wp nodes cli …`) is WP-CLI.
- **Cache backend — APCu covers one web cache domain; Memcached spans domains.** The runtime comes up without Memcached: `shared_first()` prefers a configured Memcached and otherwise takes usable APCu. Normal workers are long-running REST-spawned web requests, so they share the web server's APCu domain with the browser/hub command-auth endpoints. An attached `wp nodes cli` need not see that APCu: it signs commands with the site secret and ships them to the worker over filesystem IPC, where the web worker verifies them and records nonce claims through its own backend. A debugging-only direct `wp nodes run` differs for its first lifetime because it runs in WP-CLI — without Memcached it needs CLI APCu enabled until its REST-spawned successor takes over. Another host, or an independent PHP-FPM/APCu pool, requires Memcached. With neither backend, or on a command-session miss, command verification fails closed.

## Rosetta: WordPress → Nodes

You already know these ideas — they wear different names here. The right column
is what the left column becomes when it needs durability, ordering, or a live view.

| You know… | In Nodes… | The difference that matters |
|---|---|---|
| `add_action()` / `do_action()` | `Hook_Node`, or `register()` / `notify()` on any node | Same pub/sub idea, wired in a topology file instead of scattered through code |
| `wp_schedule_event()` (cron) | `Timer_Node` | Fires inside an always-on worker: no traffic dependence, no drift |
| `wp_schedule_single_event()` | `Job_Intake::queue( …, [ 'delay' => $s ] )` | Durable (survives restarts), visible in `wp nodes status` |
| Action Scheduler job | `Job_Intake::queue()` + a `newspack_nodes/job_handlers` handler | Adds retries with backoff, batch fan-in, per-job stats |
| `error_log()` → debug.log | `Log_Node` | Segmented, size/age-rotated, tailable from the dashboard |
| Custom events table (`$wpdb`) | `Topic` / `Partition` | An append-only log you can replay from any offset |
| Reading that table in a loop | `Consumer_Node` | A durable cursor: crash, respawn, resume where you left off |
| Transient / object-cache value | `Table_Node` | Keyed store any process reads via `Table_Node::lookup()` |
| REST endpoint per admin action | a CI verb (`Service_CI_Node`) | One schema entry: dispatch, auth, and help come free |
| admin-ajax polling | the SSE stream | Push, not poll; every dashboard rides the same stream |

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

That uniformity is the point. Any node connects to any other, because they all speak `fill()`. **You add capability by wiring a node, not by editing a system.** Fan-out is a `Tee`; a transform is your own `fill()`; file output is the built-in `Log`. New behavior is a new class with a new `fill()` body — never a change to the ones already running.

For the full model — the drain loop, workers, partitions, the REPL — see [architecture-guide.md](architecture-guide.md).

## Step 0: sixty seconds in the REPL

Before any pipeline, meet the thing you'll poke at every pipeline with. With only the plugin active (no workers, no topologies), `wp nodes cli` opens a **bare REPL** — a local interpreter in the wp-cli process:

```
$ wp nodes cli
> list_nodes -a            # the REPL is itself a node graph: shell, interpreter, router, output
_command_interpreter
_output
_router
_shell
_stdout
> make_node Echo hello     # construct a live node
ok
> dump_node hello          # its config + state (note sink: where fill() forwards)
Echo_Node {
    "name": "hello",
    "sink": "_command_interpreter",
    ...
}
> help make_node           # every verb documents itself; bare `help` lists all
```

Exit with ctrl-D. Everything else in these docs — building graphs, inspecting workers, rewiring live topologies — is these same verbs, either here or pivoted into a running worker (`wp nodes cli <worker>.p<N>`). The full verb table is in [troubleshooting.md](troubleshooting.md); the terms are in the [glossary](README.md#glossary).

## Feel it in 5 minutes

The repo ships a runnable example: `examples/example-ai-newsletter/`, a scored, durable digest pipeline built from small nodes. It is deterministic — no API keys, no network — so it runs anywhere. Two sources (`releases`, `community`) emit canned items into a `summarizer` that condenses each; a `scorer` then adds a notional priority and appends each item to the durable `example-scored` partition. A `Consumer` tails that log into the `digest` builder, which assembles a markdown draft and fans it through a `Tee` into the built-in `Log`, which writes it to a file.

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
#    active set is empty — nothing spawns by surprise. Activate it from the
#    Nodes admin page's Overview tab, or from the CLI:
wp nodes activate example-ai-newsletter
#    Now the supervisor has spawned it:
wp nodes status
#   example-ai-newsletter.p0  live  3s ago  2m 10s
```

Open the **topology console** (the Console tab of the Nodes admin page): you'll see the `example-ai-newsletter` graph — `releases` and `community` both feeding `summarizer`, then `scorer` appending to the durable `scored:partition`, a `scored:consumer` tailing that log into `digest`, then a `digest:tee` that fans to the built-in `digest:log` — with live message counts on every edge.

Now drive it by hand. Attach a REPL to the running worker and fire the runtime triggers — `TICK` and `FLUSH` are `TM_REQUEST`s (sent with `request_node`), not admin commands. Each node answers along the FROM breadcrumb, so the REPL prints a small JSON reply while the items themselves flow downstream:

```bash
wp nodes cli example-ai-newsletter.p0
```
```
> request_node releases TICK       # releases source emits its 2 canned items
{
    "emitted": 2
}
> request_node community TICK      # the other source emits its 3
{
    "emitted": 3
}
> request_node digest FLUSH        # assemble + write the draft
{
    "flushed": 5
}
```

Each `TICK` sends its items down the whole chain — summarizer, scorer, `scored:partition`, `scored:consumer`, digest — so watch the counts climb on every edge in the console. `flushed` counts what the consumer had delivered by the time you typed `FLUSH`; the `scored` partition is durable and the consumer paces it, so give the ticks a beat first. `FLUSH` writes the assembled draft:

```bash
cat /tmp/example-ai-newsletter/digest.md.0   # Log writes segments {file}.0, {file}.1, … — there is no bare {file}
# # Newsletter draft
#
# - Roundup Block ships — AI summarizes selected posts into a draft.
# - ...
```

You just watched a handful of independent nodes cooperate without any of them knowing about the others — only the message shape they pass.

## When you get it wrong

The runtime tries to make each error name its own fix. Four you'll probably meet:

- **`unknown class: Summarizer`** — from a `make_node` line (a topology, or `make_node` at the REPL). The type didn't resolve to a `{prefix}Summarizer_Node` class under any registered namespace. Either the name is wrong, or the class file hasn't reached the autoloader yet — see the next one.
- **A Node class you just added isn't in the topology-editor palette** (and `make_node` can't resolve it). The palette scans the *composer classmap* for concrete `*_Node` classes — `Classes_CI_Node::cmd_list()` walks `ClassLoader::getClassMap()` — so a brand-new class file stays invisible until you regenerate the map: `composer dump-autoload -o`.
- **``no worker 'exmaple-ai-newsletter.p0' (run `wp nodes status` to list active workers)``** — from `wp nodes cli <typo>`. The reader id doesn't match a live worker. Do what it says and run `wp nodes status`. The cause is often not a typo at all: the active set is empty (nothing spawns by surprise), so run `wp nodes activate <topology>` first.
- **`Command_Auth: no APCu and no memcache; refusing command (single-use unverifiable)`** in the log — a wire command reached a verifier with no usable cache backend, so it cannot enforce single-use nonces and fails closed. For a normal REST-spawned worker, enable web APCu or configure Memcached. For a directly launched `wp nodes run`, enable CLI APCu or configure Memcached; across hosts or independent web pools, use Memcached (see *Before you start*).

## Next: build one yourself

The five-minute tour ran a pipeline. The walkthrough builds it from an empty file, one node at a time, and shows *why* the shape pays off — a second author drops a new source into the running graph with a node and one wire, and changes nothing else.

→ **[writing-a-plugin.md](writing-a-plugin.md)**
