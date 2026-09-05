# Getting Started with Newspack Nodes

You know PHP and WordPress. You've never touched a "node graph." This page gets you from zero to a running pipeline you can poke at by hand — in about five minutes — and then points you at the walkthrough that teaches you to build your own.

## Before you start

This runtime is WordPress-internal; there is no standalone mode. It assumes four things.

- **PHP 8.2+** — declared in the plugin header (`Requires PHP: 8.2`) and enforced by `composer.json` (`"php": ">=8.2"`).
- **WordPress 6.5+, with WP-Cron and the REST API.** The substrate's lifecycle *is* WordPress: config in the options table, the cold-start safety net on WP-Cron, worker spawn / commands / SSE over the REST API.
- **WP-CLI** — every command on this page (`wp plugin …`, `wp nodes status`, `wp nodes cli …`) is WP-CLI.
- **A cache backend — APCu covers one cache domain; Memcached spans several.** Either one alone brings the runtime up; with neither, command verification fails closed.

`Cache_Backend` resolves a tier two ways: `local_first()` takes APCu and falls back to Memcached, which is what a same-host surface such as the single-use command nonce wants; `shared_first()` takes Memcached and falls back to APCu, which is what cross-process state wants. Workers are long-running REST-spawned web requests, so they share the web server's APCu domain with the browser and hub endpoints that mint commands, and an attached `wp nodes cli` needs no APCu of its own — it signs each command with the per-site secret and ships it over filesystem IPC for the worker to verify. A directly launched `wp nodes run` is the exception for its first lifetime, because it runs inside WP-CLI: without Memcached it needs CLI APCu until its REST-spawned successor takes over. A second host, or an independent PHP-FPM/APCu pool, requires Memcached.

Once the plugin is active, `wp nodes doctor` grades that environment — the cache backend, the runtime directory, its ownership, the WP-Cron housekeeping pass, the configuration keys and the fleet's worker-liveness, consumer-lag and dead-letter alerts — marking each result `ok`, `WARN` or `FAIL` and exiting non-zero on a `FAIL`.

## Rosetta: WordPress → Nodes

You already know these ideas — they wear different names here. The right column
is what the left column becomes when it needs durability, ordering, or a live view.

| You know… | In Nodes… | The difference that matters |
|---|---|---|
| `add_action()` / `do_action()` | `Hook_Node`, or `register()` / `notify()` on any node | Same pub/sub idea, wired in a topology file instead of scattered through code |
| `wp_schedule_event()` (cron) | `Timer_Node` | Fires inside an always-on worker: no traffic dependence, no drift |
| `wp_schedule_single_event()` | `Job_Intake::queue( …, [ 'delay' => $s ] )` | Durable: the entry parks in the `jobdelay.p0` log and survives a restart. The sweep that delivers it rides the minute cadence, so it fires late, never early |
| Action Scheduler job | `Job_Intake::queue()` + a `newspack_nodes/job_handlers` handler | Adds opt-in retries with exponential backoff, batch fan-in, per-job stats |
| `error_log()` (debug.log) | `Log_Node` | Segmented, size/age-rotated, tailable from the dashboard |
| Custom events table (`$wpdb`) | `Topic` / `Partition` | An append-only log you can replay from any offset |
| Reading that table in a loop | `Consumer_Node` | A durable cursor: crash, respawn, resume where you left off |
| Transient / object-cache value | `Table_Node` | Keyed store any process reads via `Table_Node::table( $ns )->lookup( $key )` |
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

Before any pipeline, meet the thing you'll poke at every pipeline with. Given no worker argument, `wp nodes cli` opens a **bare REPL** — a local node graph running inside the wp-cli process, whether or not anything else is live:

```
$ wp nodes cli
/> list_nodes -a            # the REPL is itself a node graph: shell, interpreter, router, output
_command_interpreter
_output
_router
_shell
_stdout
/> make_node Echo hello     # construct a live node
ok
/> dump_node hello          # its properties, alphabetical (note sink: where fill() forwards)
Echo_Node {
    "arguments": [],
    ...
    "name": "hello",
    ...
    "sink": "_command_interpreter",
    "target": ""
}
/> help make_node           # every verb documents itself; bare `help` lists all
```

Run it as the same user as the workers; `wp nodes cli` refuses root. Exit with ctrl-D. Everything else in these docs — building graphs, inspecting workers, rewiring live topologies — is these same verbs, either here or pivoted into a running worker (`wp nodes cli <worker>.p<N>`). The full verb table is in [troubleshooting.md](troubleshooting.md), every `wp nodes` subcommand is in [cli.md](cli.md), and the terms are in the [glossary](README.md#glossary).

## Feel it in 5 minutes

The repo ships a runnable example: `examples/example-ai-newsletter/`, a scored, durable digest pipeline built from small nodes. It is deterministic — no API keys, no network — so it runs anywhere. Two sources (`releases`, `community`) emit canned items into a `summarizer` that condenses each; a `scorer` then adds a notional priority and appends each item to the durable `scored:partition`. A `Consumer` tails that log into the `digest` builder, which assembles a markdown draft and fans it through a `Tee` into the built-in `Log`, which writes it to a file.

```bash
# 1. Install the runtime and the example from their release assets — the same
#    release publishes both zips. The example is its own plugin (own
#    composer.json + vendor/autoload); it registers itself on `plugins_loaded`
#    and no-ops when the substrate is absent, so newspack-nodes has to be
#    active — but activation order does not matter. An install that already
#    carries the runtime needs only `wp plugin activate newspack-nodes`.
wp plugin install https://github.com/Automattic/newspack-nodes/releases/latest/download/newspack-nodes.zip --activate
wp plugin install https://github.com/Automattic/newspack-nodes/releases/latest/download/example-ai-newsletter.zip --activate

# 2. Activate the topology, then look at the fleet. Activating the example
#    *registers* its `example-ai-newsletter` topology, but the shipped default
#    active set is empty — nothing spawns by surprise. Activate it from the
#    Nodes admin menu's Overview tab, or from the CLI:
wp nodes activate example-ai-newsletter
#   Success: Activated 'example-ai-newsletter' and spawned 1 worker(s).
wp nodes status
#   Worker                    State  Heartbeat  Uptime
#   example-ai-newsletter.p0  live   3s ago     12s
```

Every path the pipeline writes hangs off the runtime's base directory, and the nodes create each directory as they need it, so you make nothing by hand.

Open the **topology console** (the Console tab of the Nodes admin menu): you'll see the `example-ai-newsletter` graph — `releases` and `community` both feeding `summarizer`, then `scorer` appending to the durable `scored:partition`, a `scored:consumer` tailing that log into `digest`, then a `digest:tee` that fans to the built-in `digest:log` — with live message counts on every edge.

Now drive it by hand. Attach a REPL to the running worker and fire the runtime triggers — `TICK` and `FLUSH` are `TM_REQUEST`s (sent with `request_node`), not admin commands. Each node answers along the FROM breadcrumb, so the REPL prints a small JSON reply while the items themselves flow downstream:

```bash
wp nodes cli example-ai-newsletter.p0
```
```
/example-ai-newsletter.p0> request_node releases TICK    # the releases source emits its 2 canned items
{
    "emitted": 2
}
/example-ai-newsletter.p0> request_node community TICK   # the other source emits its 3
{
    "emitted": 3
}
/example-ai-newsletter.p0> request_node digest FLUSH     # assemble and write the draft
{
    "flushed": 5
}
```

Each `TICK` sends its items down the whole chain — summarizer, scorer, `scored:partition`, `scored:consumer`, digest — so watch the counts climb on every edge in the console. `flushed` counts what the consumer had delivered by the time you typed `FLUSH`; `scored:partition` is durable and the consumer paces it, so give the ticks a beat first. `FLUSH` writes the assembled draft under the runtime's logs directory:

```bash
# {base_directory}/logs, where base_directory defaults to /tmp/newspack-nodes.
# `wp nodes doctor` names the resolved path; the Nodes Runtime settings page sets it.
# Log writes segments {file}.0, {file}.1, … and never a bare {file}. This demo
# rotates on every write, so a second FLUSH lands in digest.md.1.
cat /tmp/newspack-nodes/logs/digest.md.0
# # Newsletter draft
#
# - Roundup Block ships — AI summarizes selected posts into a draft.
# - ...
```

You just watched a handful of independent nodes cooperate without any of them knowing about the others — only the message shape they pass.

## When you get it wrong

The runtime tries to make each error name its own fix. Five you'll probably meet:

- **`unknown class: Summarizer`** — from a `make_node` line (a topology, or `make_node` at the REPL). The type didn't resolve to a `{prefix}Summarizer_Node` class under any registered namespace. Either the name is wrong, or the class file hasn't reached the autoloader yet — see the next one.
- **A Node class you just added isn't in the topology-editor palette** (and `make_node` can't resolve it). The palette scans the *composer classmaps* for concrete `*_Node` classes — `Classes_CI_Node::cmd_list()` walks every registered `ClassLoader`'s `getClassMap()` — so a brand-new class file stays invisible until you regenerate the map: `composer dump-autoload -o`. A class already in a fresh map but still missing from the palette is hiding itself — an empty or `Hidden` `category`, or a `hidden` flag, in its `node_schema()`. `make_node` builds it all the same.
- **``no worker 'exmaple-ai-newsletter.p0' (run `wp nodes status` to list active workers)``** — from `wp nodes cli <typo>`. The reader id doesn't match a live worker. Do what it says and run `wp nodes status`. The cause is often not a typo at all: the active set is empty (nothing spawns by surprise), so run `wp nodes activate <topology>` first.
- **`wp nodes cli must run as the same user as the workers, not root.`** — the guard that keeps a root session from seeding the worker's IPC directory as root and locking the web user out. Re-run under the web user. If a root run already created those directories, recover with `chown -R <web-user>:<web-user> {base_directory}/ipc/`.
- **`Command_Auth: no APCu and no memcache; refusing command (single-use unverifiable)`** in the log — a wire command reached a verifier with no usable cache backend, so it cannot enforce single-use nonces and fails closed. For a normal REST-spawned worker, enable web APCu or configure Memcached. For a directly launched `wp nodes run`, enable CLI APCu or configure Memcached; across hosts or independent web pools, use Memcached (see *Before you start*).

## Next: build one yourself

The five-minute tour ran a pipeline. The walkthrough builds it from an empty file, one node at a time, and shows *why* the shape pays off — a second author drops a new source into the running graph with a node and one wire, and changes nothing else.

→ **[writing-a-plugin.md](writing-a-plugin.md)**
