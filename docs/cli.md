# CLI Reference

Every substrate command lives under `wp nodes`. This page is the quick reference; `wp help nodes <verb>` carries each verb's authoritative options. Application plugins mount their own verbs in the same namespace — the event logger adds `reqgrep` and `ruleset-bench` — and those are documented by their plugins.

| Verb | What it does |
|---|---|
| [`wp nodes status`](../includes/cli/class-worker-cli-command.php) (alias `ls`) | Prints two tables. The fleet table carries one row per partition of every active topology, each with heartbeat age and uptime: a slot holding a lock reads `live` or `stale`, and one holding none reads `held` while a deploy hold stands, `idle` where the topology declares an on-demand idle window, or `down` otherwise. Then comes one row per lock no active slot claims, tagged `(inactive)`, then a parked `inactive` row for every catalog topology outside the active set. The consumer table follows, one row per reader with its source, partition, bytes behind and messages in the last probe interval, which is 15 seconds by default. `--format=table\|json\|csv\|yaml` changes the container, never the cell: `Behind` is a single unit — `938B` below a kilobyte, one decimal above it (`1.4KB`, `2.1MB`), and GB at the top of the ladder, so a terabyte reads `1024GB` — while `Heartbeat` and `Uptime` are the two largest non-zero units (`3h 12m`, `1h 1s`, `0s`), with `ago` appended to the first and a bare `-` wherever the lock dir carries no heartbeat or start time. A script doing lag arithmetic off `--format=json` parses those strings; the raw byte distance is nowhere in the payload. |
| `wp nodes types` | Lists the active topology groups the fleet spawns — name, partition count, and stale timeout (60s unless the `.tsl` frontmatter declares one) — each above a `topology:` line repeating the name. A catalog entry stores a topology's NAME in that field, not a path. |
| `wp nodes doctor` | Renders the canonical health report: eight rows plus up to two conditional ones. Any critical result exits 1; a report of passes and warnings exits 0. |
| `wp nodes gc [--force]` | Sweeps orphan log and offsetlog dirs now, instead of waiting for the next reconciliation pass. A dir is orphaned when nothing declares it: no active topology, and — for a log dir — no registered log producer either. Spares a dir whose newest inner mtime — the newest of the dir itself and its first-level entries, since an append touches the segment file rather than the dir — is under an hour old unless `--force` drops that grace to zero. A layout appending BELOW that first level reads as quiet, so its grace can expire while it is still being written; the flat `{name}.p{N}` layouts the substrate ships are measured correctly. Skips the log bucket when its declared set is empty, since that can mean the producer filter has not run yet, and both buckets when either set will not build; an empty offset set means no topology is active, so every cursor dir there is swept. |
| `wp nodes run <type> [--partition=<N>]` | Runs one worker in the foreground, started directly rather than through the spawn endpoint, and blocks until it exits, then prints the worker's own exit reason. The debugging tool for "spawns but immediately exits". Partition 0 by default; refuses root. |
| `wp nodes restart <type\|all> [--partition=<N>]` | Writes a restart flag into each matched lock dir; the holders exit cleanly and their self-respawn starts them fresh. Every partition of the matched type restarts unless `--partition` narrows it. Two cases write nothing and still report success: a multisite subsite, because the fleet is network-global and runs on the main site alone, and a root invocation, which skips every write. Both print `Requested restart for 0 worker(s).` and exit 0 — see the run-as-user rule. |
| `wp nodes stop [--timeout=<s>]` | Holds the fleet down for a deploy: refuses every spawn path, asks each worker to exit, then blocks until every lock dir is gone. Waits 90 seconds by default, and exits non-zero naming the workers still holding locks if that expires. The hold persists until `wp nodes start`. |
| `wp nodes start` | Releases the hold, clears any straggler's stop flag, and requests a spawn for every due slot. Each request is a fire-and-forget POST, so `wp nodes status` is what confirms the fleet came back. |
| `wp nodes activate <topology>` / `deactivate <topology>` | Adds or removes a catalog topology from the active set and spawns or drains its fleet now. The same primitive the Topologies settings UI calls. |
| [`wp nodes cli [<type>.p<N>]`](../includes/class-cli-command.php) | Opens the REPL. Bare, it runs a local interpreter; with a worker id it pivots into that live worker over IPC, waking an on-demand worker that holds no lock rather than refusing it. Refuses root. See [troubleshooting.md](troubleshooting.md) for the in-REPL verb table. |
| [`wp nodes scaffold <plugin\|node\|topology> <name>`](../includes/cli/class-scaffold-cli-command.php) | Generates a working starting point: a whole consumer plugin directory, a single Node class, or a `.tsl` topology — the shapes from [writing-a-plugin.md](writing-a-plugin.md). Slugs are `[a-z0-9-]+`, class names `[A-Za-z_]+`. Never overwrites. |
| [`wp nodes ingest <topic> [<file>...]`](../includes/cli/class-ingest-cli-command.php) | Replays packed partition-segment records (dead-letter segments included) back through a Topic — re-partitioned against the destination's geometry, appended to its segments. Omit the file list to read packed records from stdin instead. |
| [`wp nodes memcache get <logical> [--host] [--key] [--porcelain]`](../includes/cli/class-memcache-cli-command.php) | Reads one cache entry by its LOGICAL name — the substrate rebuilds `newspack_nodes:{version}:{scope}:{logical}`, so you never type the version or the site hash. `--key` prints the resolved address without reading; `--host` resolves in the per-machine scope; `--porcelain` prints the value alone. |
| `wp nodes memcache flush` | Rotates the install's cache salt: every Newspack plugin key here is orphaned at once, every issued command session with them, and no co-tenant sharing the memcached is touched. Restarts the fleet after, because a live worker keeps writing the old prefix until it respawns; a restart that fails warns and leaves the new scope to the next spawn. The CLI half of the settings page's Flush Caches button. |
| [`wp nodes caps [status\|install\|uninstall]`](../includes/cli/class-caps-cli-command.php) | Reports or changes the capability model: `status` prints the map, `install` moves the three roles onto real capabilities, and `uninstall` reverses it. |
| `wp nodes hub-user <login> [--email] [--name] [--no-password]` | Creates the least-privilege aggregator user and issues it an application password, shown once. |

## The common flows

**Is the fleet healthy?**

```bash
wp nodes doctor        # environment and fleet health, in one report
wp nodes status        # per-partition fleet state and consumer lag
```

**Deploying new worker code** — workers are long-lived processes; the old class stays in memory until they restart:

```bash
wp nodes restart all   # every active topology, every partition
```

**Replacing plugin files** — `restart` is not enough. Swapping `includes/`
under a running worker makes its autoloader fail on its own classes, and the
consumer quarantines whatever was in flight as poison. Take the fleet down
first and branch on the exit status:

```bash
wp nodes stop && ./deploy.sh && wp nodes start
```

`stop` exits non-zero if any worker still holds its lock, so the deploy never
runs against a live process. A spawn already in flight blocks it too: a worker
that released its lock just before the hold landed holds no lock while it
bootstraps, and its successor would come up against the half-swapped
directory. Without memcached that check cannot read the spawn timestamps, and
`stop` warns that it is blind to them. While the hold stands, [`doctor`](#doctor-health-report) (and
Site Health) carry a `fleet-hold` warning with its age — a hold hours old is
almost certainly a forgotten `wp nodes start`.

Each restarted worker gets a fresh WordPress bootstrap. Restart only after
every topology-provider plugin is installed and activated, so each worker's
process-local catalog holds the complete plugin set.

**Debugging one worker** — a foreground run shows boot errors and the exit reason; the REPL inspects a live graph without disturbing it:

```bash
wp nodes run <type> --partition=0
wp nodes cli <type>.p0
```

Both `run` and `restart` take a type an ACTIVE topology declares, so a topology
you just deactivated is no longer a target even while its last workers wind
down.

**Starting a new consumer plugin** — `scaffold` writes into the current
directory, so run it from `wp-content/plugins`. Its topology wires the example
node into a stock `Log`, so the fleet runs the plugin before you have written a
line:

```bash
wp nodes scaffold plugin my-pipeline
cd my-pipeline && composer dump-autoload -o
wp plugin activate my-pipeline
wp nodes activate my-pipeline
```

**Recovering quarantined messages** — after fixing the poison handler, replay the [dead-letter](architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle) segments (one dir per reader under `{base_dir}/deadletter/` — the stock topologies name each `<topology>.<log>.p<N>` — holding numbered `{seg}.log` segments directly):

```bash
wp nodes ingest firehose {base_dir}/deadletter/<reader>/*.log
```

![A four-part sheet: the destination is taken as written, as a bare log name expanded under logs_dir or a dir-template used verbatim, with a callout that a mistyped name is created and swept an hour later; a three-step decision picks each record's partition, a TO pinned to p<N> first, then a hash of KEY, then round-robin; a geometry table shows the three overridable axes and the four pinned ones beside a five-segment strip in which only the last two survive at 1 MiB and num_segments 2; and three flag cards cover --allow_large_writes, --void_warranty and --dry-run. The one thing it makes visible is that a replay longer than the destination's window prunes its own head as it proceeds.](img/cli-ingest-destination.png)

The lock behind `--allow_large_writes` is taken lazily, when the first record routes to each partition, so a stall and abort can land after the records already routed have been accepted and flushed: judge a part-filled destination against the source rather than assuming it empty.

## Capabilities and the hub user

![A two-step ladder: wp nodes caps install moves read (dashboards, SSE, introspection), tune (settings and application data) and manage (fleet control and credentials) from manage_options onto newspack_nodes_read, _tune and _manage, and reports under two lines a host can answer differently, granular: yes and hub role: absent; then wp nodes hub-user grants read and tune to the user directly and mints an application password shown once and kept nowhere readable, or none under --no-password. Below, a callout traces what caps uninstall takes down, every hub credential in the fleet, and a green card gives the recovery. The one thing it makes visible is that the user's direct grants, not the role, are what the credential's authority rests on.](img/cli-caps-order.png)

`wp nodes caps` takes `status`, `install` or `uninstall`; a word outside those three is refused rather than treated as `status`. Only `uninstall` then `install` rebuilds a hand-edited `newspack_nodes_hub` role off VIP, where `add_role()` returns null and changes nothing on an existing slug; VIP's own wrapper reconciles the role in place, so the two hosts differ there.

```bash
wp nodes caps install
wp nodes hub-user newspack-nodes-hub
```

## Doctor health report

`wp nodes doctor` renders eight canonical rows, in this order:

1. `cache-backend`
2. `filesystem`
3. `ownership`
4. `housekeeping`
5. `config-keys`
6. `worker-liveness`
7. `consumer-lag`
8. `dead-letters`

Two more appear only when they apply: `fleet-hold` follows `config-keys` while a deploy hold stands, and `other-alerts` closes the report when an alert declares a family no bucket claims.

Each row starts with `ok`, `WARN` or `FAIL`: a `WARN` is a recommendation, a `FAIL` is critical.

The cache row comes from a loopback POST to [`newspack-nodes/v1/health/cache`](API.md#internal-cache-health), bounded at five seconds and authenticated by a purpose-separated HMAC token, because a CLI process picks a different cache backend than the one serving requests. The reply is validated against the exact shape [`Health_Checks`](../includes/class-health-checks.php) produces before any of it reaches the terminal. An unverifiable result reports `WARN`, since cache health is then unknown; a proven missing or failed backend reports `FAIL`. Every other row is evaluated locally through the same evaluator Site Health reads.

`filesystem` does not trust the permission bits. It checks `is_writable()`, then proves the answer by writing `.health-probe-<random hex>` into the base directory and removing it again — a full filesystem passes `is_writable()` and still refuses the write, and a directory that accepts writes but refuses removals grows until partitions stall. It therefore has three distinct failures: not writable, refused the write probe, and accepted the write but could not remove the probe, which is the removal fault no other row reports. The random suffix keeps two reports running at once from deleting each other's file. Every `wp nodes doctor` writes that probe, and so does every wp-admin Site Health render — a `.health-probe-*` left in the base directory is a report that died between the write and the unlink, and neither log retention nor `wp nodes gc` sweeps it.

`housekeeping` asks one question, once any topology is active: is `newspack_nodes/reconcile` scheduled? That minute pass carries log retention, orphan partition and IPC reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival, and it fails silently while every other check stays green. A missing event is critical, and the row names the recovery: `wp cron event schedule newspack_nodes/reconcile now newspack_nodes_minute`. Doctor reads neither `DISABLE_WP_CRON` nor any other cron setting — a platform invoking `wp-cron.php` externally is healthy, and worker liveness is reported directly rather than inferred from a proxy.

`config-keys` names every key in [`newspack-nodes-config.php`](../newspack-nodes-config.php) that the settings schema does not declare, and reports `FAIL` when it finds one. The deploy copies the operator's own file over the shipped path, so a key renamed in the schema leaves a stale entry behind whose value is silently not in effect.

## Operator flags are validated, never cast

`--partition`, `--timeout`, `--num_partitions`, `--segment_size` and `--num_segments` are read through a refusing parse. Each takes canonical decimal digits alone: no sign, no leading zero, no suffix, and nothing above `PHP_INT_MAX`. A cast would answer 0 for `--partition=abc`, 1 for a bare `--partition` carrying no value, and 2 for `--timeout=2m`, so the typo would act on the wrong partition — or shorten a deadline — and the command would report success on it. A malformed value exits with an error naming the flag instead. The three geometry flags refuse zero as well, because a destination that stores nothing is nobody's intent.

## Run-as-user rule

![A decision drawn from one question, is the effective uid 0, into four columns: cli and run refuse outright; stop warns that it could not write the stop flags and then spins its timeout; restart, memcache flush and a settings save skip their writes, print one rate-limited warning and report success; status, types and doctor work as usual. Two boxes below cover ingest, which writes as root and surfaces later as doctor's ownership row, and how to read a 0 worker(s) restart. The one thing it makes visible is that a root run reports success while writing nothing.](img/cli-root-rule.png)

Run every `wp nodes` verb as the user the workers run as.
