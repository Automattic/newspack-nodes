# CLI Reference

Every substrate command lives under `wp nodes`. This page is the quick reference; `wp help nodes <verb>` carries each verb's authoritative options. Application plugins mount their own verbs in the same namespace — the event logger adds `reqgrep` and `ruleset-bench` — and those are documented by their plugins.

| Verb | What it does |
|---|---|
| `wp nodes status` (alias `ls`) | Prints two tables. The fleet table carries one row per partition of every active topology, each with heartbeat age and uptime: a slot holding a lock reads `live` or `stale`, and one holding none reads `held` while a deploy hold stands, `idle` where the topology declares an on-demand idle window, or `down` otherwise. Then comes one row per lock no active slot claims, tagged `(inactive)`, then a parked `inactive` row for every catalog topology outside the active set. The consumer table follows, one row per reader with its source, partition, bytes behind and messages in the last probe interval, which is 15 seconds by default. `--format=table\|json\|csv\|yaml` changes the container, never the cell: `Behind` is a single unit — `938B` below a kilobyte, one decimal above it (`1.4KB`, `2.1MB`), and GB at the top of the ladder, so a terabyte reads `1024GB` — while `Heartbeat` and `Uptime` are the two largest non-zero units (`3h 12m`, `1h 1s`, `0s`), with `ago` appended to the first and a bare `-` wherever the lock dir carries no heartbeat or start time. A script doing lag arithmetic off `--format=json` parses those strings; the raw byte distance is nowhere in the payload. |
| `wp nodes types` | Lists the active topology groups the fleet spawns — name, partition count, and stale timeout (60s unless the `.tsl` frontmatter declares one) — each above a `topology:` line repeating the name. A catalog entry stores a topology's NAME in that field, not a path. |
| `wp nodes doctor` | Renders the canonical health report: eight rows plus up to two conditional ones. Any critical result exits 1; a report of passes and warnings exits 0. |
| `wp nodes gc [--force]` | Sweeps orphan log and offsetlog dirs now, instead of waiting for the next reconciliation pass. A dir is orphaned when nothing declares it: no active topology, and — for a log dir — no registered log producer either. Spares a dir whose newest inner mtime — the newest of the dir itself and its first-level entries, since an append touches the segment file rather than the dir — is under an hour old unless `--force` drops that grace to zero. A layout appending BELOW that first level reads as quiet, so its grace can expire while it is still being written; the flat `{name}.p{N}` layouts the substrate ships are measured correctly. Skips a whole bucket whose declared set is empty or will not build rather than sweeping every dir in it. |
| `wp nodes run <type> [--partition=<N>]` | Runs one worker in the foreground, started directly rather than through the spawn endpoint, and blocks until it exits, then prints the worker's own exit reason. The debugging tool for "spawns but immediately exits". Partition 0 by default; refuses root. |
| `wp nodes restart <type\|all> [--partition=<N>]` | Writes a restart flag into each matched lock dir; the holders exit cleanly and their self-respawn starts them fresh. Every partition of the matched type restarts unless `--partition` narrows it. Two cases write nothing and still report success: a multisite subsite, because the fleet is network-global and runs on the main site alone, and a root invocation, which skips every write. Both print `Requested restart for 0 worker(s).` and exit 0 — see the run-as-user rule. |
| `wp nodes stop [--timeout=<s>]` | Holds the fleet down for a deploy: refuses every spawn path, asks each worker to exit, then blocks until every lock dir is gone. Waits 90 seconds by default, and exits non-zero naming the workers still holding locks if that expires. The hold persists until `wp nodes start`. |
| `wp nodes start` | Releases the hold, clears any straggler's stop flag, and requests a spawn for every due slot. Each request is a fire-and-forget POST, so `wp nodes status` is what confirms the fleet came back. |
| `wp nodes activate <topology>` / `deactivate <topology>` | Adds or removes a catalog topology from the active set and spawns or drains its fleet now. The same primitive the Topologies settings UI calls. |
| `wp nodes cli [<type>.p<N>]` | Opens the REPL. Bare, it runs a local interpreter; with a worker id it pivots into that live worker over IPC, waking an on-demand worker that holds no lock rather than refusing it. Refuses root. See [troubleshooting.md](troubleshooting.md) for the in-REPL verb table. |
| `wp nodes scaffold <plugin\|node\|topology> <name>` | Generates a working starting point: a whole consumer plugin directory, a single Node class, or a `.tsl` topology — the shapes from [writing-a-plugin.md](writing-a-plugin.md). Slugs are `[a-z0-9-]+`, class names `[A-Za-z_]+`. Never overwrites. |
| `wp nodes ingest <topic> [<file>...]` | Replays packed partition-segment records (dead-letter segments included) back through a Topic — re-partitioned against the destination's geometry, appended to its segments. Omit the file list to read packed records from stdin instead. |
| `wp nodes memcache get <logical> [--host] [--key] [--porcelain]` | Reads one cache entry by its LOGICAL name — the substrate rebuilds `newspack_nodes:{version}:{scope}:{logical}`, so you never type the version or the site hash. `--key` prints the resolved address without reading; `--host` resolves in the per-machine scope; `--porcelain` prints the value alone. |
| `wp nodes memcache flush` | Rotates the install's cache salt: every Newspack plugin key here is orphaned at once, every issued command session with them, and no co-tenant sharing the memcached is touched. Restarts the fleet after, because a live worker keeps writing the old prefix until it respawns; a restart that fails warns and leaves the new scope to the next spawn. The CLI half of the settings page's Flush Caches button. |
| `wp nodes caps [status\|install\|uninstall]` | Reports or changes the capability model: `status` prints the map, `install` moves the three roles onto real capabilities, and `uninstall` reverses it. |
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
`stop` warns that it is blind to them. While the hold stands, `doctor` (and
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

**Recovering quarantined messages** — after fixing the poison handler, replay the dead-letter segments (one dir per reader under `{base_dir}/deadletter/` — the stock topologies name each `<topology>.<log>.p<N>` — holding numbered `{seg}.log` segments directly):

```bash
wp nodes ingest firehose {base_dir}/deadletter/<reader>/*.log
```

`<topic>` is either a bare log name, expanded to `<config:logs_dir>/<name>.p<partition>`, or a full dir-template carrying a `<partition>` (or `{partition}`) token, taken as written once its `<config:…>` tokens resolve. Each record then picks its destination partition the way any Topic write does: a TO already pinned to `p<N>` keeps that pin, a record carrying a KEY hashes by KEY, and one with neither lands round-robin. A filtered `wp nodes reqgrep` or a `zcat` output pipes in on stdin. A line that will not unpack is counted and skipped, so a torn record at a segment's tail cannot abandon the replay.

Neither form is checked against the declared log set, so a mistyped destination is created rather than refused: `wp nodes ingest firehoze …` builds a `firehoze.p0/` under `logs_dir`, replays into it and ends with `Ingested N record(s).` Because nothing declares that dir the orphan sweep deletes it an hour after the last write — or `wp nodes gc --force` deletes it at once. Read the `Destination:` line the command prints before trusting the count; it is the only confirmation the replay landed where you meant.

The destination's geometry defaults to the configured `num_partitions`, `segment_size` and `num_segments`; an explicit dir-template defaults to one partition instead, because the template names a layout already on disk. `--num_partitions=<n>`, `--segment_size=<bytes>` and `--num_segments=<n>` override each in turn, which is what makes re-segmenting an existing log the same operation as a replay. Retention's other four axes are pinned to the shipped defaults and cannot be overridden: `min_segments` 2, `max_segments` 0, and both lifetimes 0. Age retention is off on purpose, since every re-ingested segment carries a fresh mtime and an age rule would mean nothing — but `min_lifetime` at 0 also strips the count rule's age floor, so the destination prunes its oldest segment the moment it holds more than `num_segments`. A replay longer than that window deletes its own earlier output as it proceeds and keeps only the tail: restoring a whole log means sizing `--num_segments` and `--segment_size` to span the source. At `--segment_size=1048576 --num_segments=2`, the destination holds 2 MiB and nothing more.

Records above the 4KB PIPE_BUF cap need `--allow_large_writes` (a held per-partition lock) or `--void_warranty` (no lock, caller asserts single-writer); either raises the cap to 32 MiB, and passing both is refused. `--dry-run` writes nothing, reports the largest record it saw, and says which of those flags you need. The lock is taken lazily, when the first record routes to each partition, so `--allow_large_writes` against a partition a live writer holds stalls 15 seconds and then aborts the replay with a fatal — after the records already routed have been accepted and flushed. Judge a part-filled destination against the source rather than assuming it empty. `--void_warranty` takes no lock and cannot stall or abort this way, which is the trade its single-writer assertion buys.

## Capabilities and the hub user

The three substrate roles — `read` (dashboards, SSE, introspection), `tune` (settings and application data) and `manage` (fleet control and credentials) — all resolve to `manage_options` until you move them. `wp nodes caps` prints that map; `wp nodes caps install` swaps the three onto the real capabilities `newspack_nodes_{read,tune,manage}`, grants all three to every role that already holds `manage_options`, and creates the `newspack_nodes_hub` role carrying read and tune alone. `wp nodes caps uninstall` reverses both. Every action ends by printing the resulting map under a `granular:` line saying whether the swap is installed, and a word outside those three is refused rather than treated as `status`.

```bash
wp nodes caps install
wp nodes hub-user newspack-nodes-hub
```

`hub-user` creates — or re-roles, removing every other role — the least-privilege user a log aggregator authenticates as, then issues it an application password printed once and stored nowhere. `--email=<email>` sets the address for a newly created user (default `<login>@<site host>`), `--name=<name>` labels the password (default `newspack-nodes hub`), and `--no-password` creates the user without one.

Run them in that order. Until the swap lands the hub role still resolves to `manage_options` and the credential would hold everything, which is why `hub-user` refuses until `caps install` has run.

`install` reads the roles table once, at the moment you run it, and nothing re-runs it afterwards. A role created — or granted `manage_options` — later therefore holds none of the three capabilities and is refused by every gated surface, even though it holds the `manage_options` the un-migrated map answered to. Re-run `wp nodes caps install` after adding such a role: it is idempotent, adding the missing grants and changing nothing else. The one thing a re-run cannot repair is the hub role itself. Off VIP the fallback is WordPress's `add_role()`, which returns null and changes nothing when the slug already exists, so a hand-edited `newspack_nodes_hub` keeps whatever the first install wrote until `caps uninstall` drops it and a fresh `caps install` rebuilds it. VIP's own wrapper reconciles the role in place, so the two hosts differ here.

`uninstall` reaches further than the grants `install` wrote. It strips `newspack_nodes_{read,tune,manage}` from every role in the table — a grant some other plugin made by hand included — and then removes the `newspack_nodes_hub` role outright. Each aggregator user keeps `newspack_nodes_hub` in its capabilities meta while the role resolves to nothing, so every hub application password across the fleet stops authorizing and each spoke starts answering 403. Nothing warns, and nothing enumerates the users wearing the role first. `uninstall.php` makes the same call when the plugin is deleted, so deleting newspack-nodes takes the hub credentials down with it. `wp nodes caps install` recreates the role and revives those users, since the meta still names it; short of that, give each hub user a real role before uninstalling. In the other direction the step order is deliberate: `uninstall` deletes the switch option before revoking anything, so the map is back on `manage_options` before the capabilities it named disappear.

The hub role carries read and tune and no WordPress `read`, which makes the aggregator user a REST-only identity: it cannot load wp-admin, its own profile screen or the substrate's settings pages, so its credential can be issued only from the CLI. `hub-user` mints one on every run: it never looks for an existing password under the same label and never revokes one, so a second run against a lost password leaves two live credentials on a user whose credential is permanent by design. Retire the old one with `wp user application-password delete`, or pass `--no-password` to re-role a user without minting anything.

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

The cache row comes from a loopback POST to `newspack-nodes/v1/health/cache`, bounded at five seconds and authenticated by a purpose-separated HMAC token, because a CLI process picks a different cache backend than the one serving requests. The reply is validated against the exact shape `Health_Checks` produces before any of it reaches the terminal. An unverifiable result reports `WARN`, since cache health is then unknown; a proven missing or failed backend reports `FAIL`. Every other row is evaluated locally through the same evaluator Site Health reads.

`filesystem` does not trust the permission bits. It checks `is_writable()`, then proves the answer by writing `.health-probe-<random hex>` into the base directory and removing it again — a full filesystem passes `is_writable()` and still refuses the write, and a directory that accepts writes but refuses removals grows until partitions stall. It therefore has three distinct failures: not writable, refused the write probe, and accepted the write but could not remove the probe, which is the removal fault no other row reports. The random suffix keeps two reports running at once from deleting each other's file. Every `wp nodes doctor` writes that probe, and so does every wp-admin Site Health render — a `.health-probe-*` left in the base directory is a report that died between the write and the unlink, and neither log retention nor `wp nodes gc` sweeps it.

`housekeeping` asks one question, once any topology is active: is `newspack_nodes/reconcile` scheduled? That minute pass carries log retention, orphan partition and IPC reaping, alert emission, the delayed-jobs sweep, every `newspack_nodes/periodic` subscriber and cold-start worker revival, and it fails silently while every other check stays green. A missing event is critical, and the row names the recovery: `wp cron event schedule newspack_nodes/reconcile now newspack_nodes_minute`. Doctor reads neither `DISABLE_WP_CRON` nor any other cron setting — a platform invoking `wp-cron.php` externally is healthy, and worker liveness is reported directly rather than inferred from a proxy.

`config-keys` names every key in `newspack-nodes-config.php` that the settings schema does not declare, and reports `FAIL` when it finds one. The deploy copies the operator's own file over the shipped path, so a key renamed in the schema leaves a stale entry behind whose value is silently not in effect.

## Operator flags are validated, never cast

`--partition`, `--timeout`, `--num_partitions`, `--segment_size` and `--num_segments` are read through a refusing parse. Each takes canonical decimal digits alone: no sign, no leading zero, no suffix, and nothing above `PHP_INT_MAX`. A cast would answer 0 for `--partition=abc`, 1 for a bare `--partition` carrying no value, and 2 for `--timeout=2m`, so the typo would act on the wrong partition — or shorten a deadline — and the command would report success on it. A malformed value exits with an error naming the flag instead. The three geometry flags refuse zero as well, because a destination that stores nothing is nobody's intent.

## Run-as-user rule

`wp nodes cli` and `wp nodes run` refuse to run as root: workers run as the web user and create their IPC and lock dirs under that ownership, so a root invocation would seed dirs the fleet cannot write. Run them as the web user. `wp nodes doctor`'s ownership check tells you whether a past root run left bad ownership behind, and names the recovery: `chown -R <webuser>` of the base dir.

No other verb refuses; under root they skip their writes instead. Every write below the runtime directory is passed over rather than attempted: the caller carries on, one rate-limited `WARNING: running as root; skipping <what>` reaches stderr, and the write reports failure. Denial is non-fatal by design, which is what keeps `status`, `types` and `doctor` working as root — but it also means a write-shaped verb reports doing nothing while doing nothing. `wp nodes restart all` flags nobody and still exits 0 on `Requested restart for 0 worker(s).`; the fleet restart `wp nodes memcache flush` performs after rotating the salt goes the same way, as does the reload watermark a settings save writes. Read a `0 worker(s)` restart on a live fleet as a root run, not an empty fleet. The rate limiter keys on the shared message prefix, so only the first refusal in the process prints and every later one, of any flag, is silent.

`wp nodes stop` is the one that says so. It warns, naming every slot whose stop flag it could not write, and that warning is why an otherwise quiet `stop` spins its whole timeout and then reports those workers as stragglers.

`wp nodes ingest` neither refuses nor skips. It writes through `Topic_Node`, which materializes partition directories and `{seg}.log` segments under `logs_dir` on first use, so a root replay leaves root-owned dirs and segments the workers can no longer append to, rotate or prune — damage that surfaces later as doctor's `ownership` row rather than at the moment of the mistake.
