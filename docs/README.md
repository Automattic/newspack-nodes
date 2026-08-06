# Newspack Nodes — Documentation Map

Fourteen docs, three reading orders. New here? Read **Start here** top to bottom. Shipping something? Jump to **Take it to production**. Need a fact? Go straight to **Reference**.

## Start here

Read these in order — each builds on the last.

- **[getting-started.md](getting-started.md)** — read when you've never touched a node graph: zero to a running example pipeline you can poke at by hand, in about five minutes.
- **[writing-a-plugin.md](writing-a-plugin.md)** — read when you want to build your own: the AI-newsletter digest from an empty directory, one node at a time, run after every step.
- **[writing-a-dashboard.md](writing-a-dashboard.md)** — read when the headless pipeline works and you want a React admin dashboard that reads its live state.

## Take it to production

The toy guides above stop at "works on my page." These pick up where they leave off.

- **[writing-a-real-plugin.md](writing-a-real-plugin.md)** — read when you're taking the toy pipeline to real sources: durable ingest partition, credentials in the Vault, terminal-`DONE` auto-compose.
- **[writing-a-real-dashboard.md](writing-a-real-dashboard.md)** — read when your dashboard has to survive the Topology Console, the DevTools overlay, and `release:archive` — the shared-surface contracts you didn't sign up for.
- **[writing-a-view-node.md](writing-a-view-node.md)** — read when you need the one-page contract for a dashboard slice's terminal view node: one reply in, one render model out.

## Reference

Facts, not tutorials.

- **[architecture-guide.md](architecture-guide.md)** — read when you need the full substrate design: message format, node contracts, drain loop, REPL.
- **[architecture-decisions.md](architecture-decisions.md)** — read when you want to change a load-bearing behavior: the ADRs, why each was chosen, and the condition that would reopen it.
- **[API.md](API.md)** — read when you're calling the runtime over HTTP: the REST endpoints, command signing, and their request/response shapes.
- **[cli.md](cli.md)** — read when you need a `wp nodes` verb: the one-page reference for every subcommand and the common flows.
- **[troubleshooting.md](troubleshooting.md)** — read when something live is misbehaving: the REPL, worker health, log paths, and the failure modes we actually hit.
- **[stability.md](stability.md)** — read when you need to know what you can build on: the frozen surfaces, the deprecation policy, and what stays internal.
- **[upgrading.md](upgrading.md)** — read when you're moving a consumer plugin across substrate versions: the breaking changes, with the fix beside each.
- **[tachikoma-lineage.md](tachikoma-lineage.md)** — read when you need the Perl this runtime varies from: what came from where, file and symbol, and why each deliberate difference was chosen.

## Glossary

The short expansions the rest of the docs assume.

- **node** — an object with one entry point, `fill( array $message ): void`; all capability is nodes wired together.
- **message** — the 7-field positional array `[ TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE ]`, always indexed via the `Message::*` constants.
- **sink** — a node's physical next hop: `fill()` hands the message there when done.
- **target** — a node's logical address string, stamped into `TO` when a message has none; `_router` resolves it.
- **topology** — a worker's node graph, described in a `.tsl` file.
- **TSL** — the topology script language: `.tsl` files of shell verbs (`make_node`, `connect_node`, …) that `Topology_Loader` executes to build a worker's graph. The format (and extension) comes from Tachikoma.
- **CI / command interpreter** — `Command_Interpreter_Node`, the verb dispatcher: it turns a TM_COMMAND like `make_node Log mylog` into the call, and its verb table is where `help` text comes from. "A CI verb" means an entry in one of these.
- **REPL** — `wp nodes cli`: an interactive shell speaking those verbs, either locally or pivoted into a live worker.
- **Topic / Partition** — the durable append-only segmented log (Partition is one partition's files; Topic routes writes across N of them by KEY hash).
- **Consumer** — the durable reader: tails a Partition with a crash-safe cursor (the **offsetlog**) so it resumes where it left off.
- **worker** — a long-running WP-CLI process draining one topology's graph; named `{type}.p{N}`.
- **`_fleet`** — the peer-spawn scan every worker runs on its router tick; WP-Cron cold-starts a fleet with nothing left running.
