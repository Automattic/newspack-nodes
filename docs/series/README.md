# Newspack Nodes: a message runtime inside WordPress

Newspack Nodes is a message runtime inside a WordPress plugin, on managed hosting with no daemon. A node has one entry point, `fill()`, which takes a seven-field message and returns nothing. A topology wires nodes into a graph, and a worker is an HTTP request that runs that graph for about 595 seconds, then spawns its successor. Durable state is append-only logs on disk and live state is a shared cache; the database gets no table, only option rows, among them settings, the active topology set, the deploy hold, sessions and the Vault. Workers watch each other and WP-Cron revives a dead fleet, so there is no supervisor. A topology with an idle window, `on_demand_idle`, exits once its readers are caught up and respawns on the next write, so an idle topology holds no PHP worker.

Each part is its own post, linked below, with its own diagrams; Part 6, The Event Logger, is indexed from that application's own post, because the logger is what the runtime exists for.

| Part | Title | What it covers |
|---|---|---|
| 1 | [Why a message runtime inside WordPress](01-why-a-message-runtime-inside-wordpress.md) | The problem, the shape of the answer, the CPU budget, the hub that pulls |
| 2 | [The vocabulary](02-the-vocabulary.md) | The message, the node with its sink and target, the command interpreter and router, the reply, the topology |
| 3 | [Logs on disk](03-logs-on-disk.md) | The Partition and its retention, the 4 KB rule, the Topic, the Consumer and its offsetlog, dead letters, the Log, the base directory |
| 4 | [Workers and the fleet](04-workers-and-the-fleet.md) | Spawn, lock and heartbeat, the drain loop, release then respawn, the two-tier safety net, on-demand workers, deploy holds, status and doctor |
| 5 | [Commands, capabilities and sessions](05-commands-capabilities-and-sessions.md) | The command as a message, the minter and its signature, sessions, the three capabilities, the command endpoint, the MCP server |
| 7 | [Hub and spoke](07-hub-and-spoke.md) | Remote_Source and the SSE pull, the Vault and the hub user, the reply gate, settings sync and discovery, remote jobs, the live hub |
| 8 | [Dashboards and the browser runtime](08-dashboards-and-the-browser-runtime.md) | The same graph in JavaScript, the two channels to a worker, the slot pool, the pages, the build kit |
| 9 | [Writing a plugin and running it](09-writing-a-plugin-and-running-it.md) | Scaffold, the node, the topology, the service interpreter and dashboard, the operator's loop, releasing |
| 10 | [What we asked SecOps to review](10-what-we-asked-secops-to-review.md) | The review request to SecOps, in the terms Parts 1 to 9 define |

Read Parts 1 and 2 first; every later part assumes them. Part 9 is the one to read with a terminal open. The code is `newspack-nodes`: `docs/architecture-guide.md` describes the substrate, and `docs/architecture-decisions.md` records the ADRs the parts cite by number.
