# CLI Reference

Every substrate command lives under `wp nodes`. This page is the quick reference; each verb's `wp help nodes <verb>` has the authoritative options. Application plugins mount their own verbs under the same namespace (the event-logger adds `reqgrep` and `ruleset-bench`, for example) — those are documented by their plugins.

| Verb | What it does |
|---|---|
| `wp nodes status` (alias `ls`) | Fleet overview: supervisor + every active topology's per-partition state (live/stale/down, heartbeat age, uptime), then the consumer-lag table. `--format=table\|json\|csv\|yaml`. |
| `wp nodes types` | The active topology groups the supervisor will spawn — names, partition counts, stale timeouts, topology paths. |
| `wp nodes doctor` | Environment preflight: memcache, WP-Cron, shared filesystem, base-dir ownership. Each failing leg prints the concrete degradation it causes; non-zero exit when anything fails. |
| `wp nodes run <type> [--partition=<N>]` | Run one worker in the foreground (no spawn endpoint) and block until it exits; prints the worker's own exit reason. The debugging tool for "spawns but immediately exits". |
| `wp nodes restart <type\|all> [--partition=<N>] [--all-partitions]` | Drop a restart flag; the holder exits cleanly and the supervisor (or self-respawn) starts fresh. Required after deploying new code. |
| `wp nodes activate <topology>` / `deactivate <topology>` | Add/remove a catalog topology from the active set and spawn/drain its fleet now. Same primitive as the Topologies settings UI. |
| `wp nodes cli [<reader>.p<N>]` | The REPL. Bare (no arg) runs a local interpreter; with a worker id it pivots into that live worker over IPC. Refuses root. See [troubleshooting.md](troubleshooting.md) for the in-REPL verb table. |
| `wp nodes scaffold <plugin\|node\|topology> <name>` | Generate a working starting point: a whole consumer plugin directory, a single Node class, or a `.tsl` topology — the shapes from [writing-a-plugin.md](writing-a-plugin.md). Never overwrites. |
| `wp nodes ingest <topic> <segment.log ...>` | Replay packed partition-segment records (dead-letter segments included) back through a Topic — re-partitioned by KEY, appended to the destination segments. |

## The common flows

**Is the fleet healthy?**

```bash
wp nodes doctor        # environment legs first
wp nodes status        # then the fleet
```

**Deploying new worker code** — workers are long-lived processes; the old class stays in memory until they restart:

```bash
wp nodes restart all --all-partitions
```

**Debugging one worker** — foreground run shows boot errors and the exit reason; the REPL inspects a live graph without disturbing it:

```bash
wp nodes run <type> --partition=0
wp nodes cli <type>.p0
```

**Starting a new consumer plugin:**

```bash
wp nodes scaffold plugin my-pipeline
cd my-pipeline && composer dump-autoload -o
```

**Recovering quarantined messages** — after fixing the poison handler, replay the dead-letter segments (one flat dir per reader under `{base_dir}/deadletter/`, holding `.log` segments directly):

```bash
wp nodes ingest firehose {base_dir}/deadletter/<reader>/*.log
```

`<topic>` is either a bare log name (expanded to `<config:logs_dir>/<name>.p<partition>`) or a full dir-template carrying a `<partition>` token; `--dry-run` samples record sizes first and tells you whether you need `--allow_large_writes`.

## Run-as-user rule

`wp nodes cli` and `wp nodes run` refuse to run as root: workers run as the web user and create their IPC/lock dirs under that ownership, so a root invocation would seed dirs the fleet can't write. Run them as the web user; `wp nodes doctor`'s ownership check tells you if a past root run left bad ownership behind (recovery: `chown -R <webuser>` of the base dir).
