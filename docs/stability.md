# Stability Contract

The names below are the substrate's declared surface: the shapes
[API.md](API.md), [cli.md](cli.md) and the ADRs document. A consumer reaches
past them constantly — `Core`, `Config`, `Job_Intake`, `Cache_Backend`,
`Partition_Node`, `Table_Node` and `Bootstrap::node_dirs()` carry the siblings'
heaviest traffic and appear nowhere below. Nothing forbids that, and those
names move: `Job_Intake` re-ordered its arguments in 2.27.0, and `Table_Node`
dropped its read-through L1 in 2.28.0. Every consumer-facing change lands in
[upgrading.md](upgrading.md) with the rewrite beside it, frozen or not.

## Frozen surfaces

1. **The node contract.** `fill( array $message ): void`, `sink`, `target`,
   `stamp_message()`, `register()` / `notify()` / `set_state()`, `arguments()`,
   `node_schema()` — the shapes [ADR-1](architecture-decisions.md#adr-1-uniform-fill-contract),
   [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)
   and [ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence)
   pin. `set_state()` is `protected`: a Node subclass calls it, nothing else.
2. **The message.** The 7-field positional layout (`Message::TYPE`, `TIMESTAMP`,
   `FROM`, `TO`, `ID`, `KEY`, `VALUE`), the `TM_*` type flags, and the
   positional-JSON wire format (`packed()` / `unpacked()`) —
   [ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array).
   `Message::LOCAL` is an eighth slot carrying in-process provenance taint;
   `packed()` never emits it and `unpacked()` rejects an 8-field line, which is
   what makes its presence worth trusting ([ADR-15](architecture-decisions.md#adr-15-command-authorization-local-taint--the-minter-signs)).
   On-disk Partition segments written by any release in the current major stay
   readable by every later release in that major. That covers the packed
   ENVELOPE, not a positional record layout inside a VALUE: a producer owns its
   own record, and `Probe_Record` and `Jobstats_Record` both re-cut their fields
   in 2.11.0.
3. **TSL.** The statement grammar (`Shell_Node::parse_statements()` semantics),
   the shell builtins (`var`, `include`, and `cd` with its alias `chdir`), the
   graph verbs (`make_node`, `set_sink`, `connect_node`, `disconnect_node`,
   `move_node`, `remove_node`, `register`, `unregister`, and `command_node` with
   its aliases `command` and `cmd`), the one-way `secure` ratchet every stock
   topology closes with, and `<config:KEY>` token resolution. The grammar is one
   grammar in both ports: `src/runtime/shell-node.js`'s `parseStatements` is
   held to `parse_statements()` by the shared `tests/fixtures/statements/`
   corpus, which the PHP and JS suites both read.
4. **Stock node types.** The registered names and constructor-argument shapes of
   every node the palette lists. `node_schema()` is the authority and
   `help <NodeType>` renders it. A schema declaring the category `Hidden`, no
   category at all, or a `hidden` flag sits outside the palette and outside this
   contract.
5. **CLI.** The `wp nodes` verbs and their documented arguments and output
   contracts, `--format=json` shapes included. [cli.md](cli.md) is the
   reference; an application plugin's own verbs in the same namespace —
   event-logger-nodes adds `reqgrep` and `ruleset-bench` — belong to that
   plugin's contract, not this one.
6. **REST.** The routes under `newspack-nodes/v1` and their envelope shapes
   ([API.md](API.md)): `/workers/spawn`, `/auth`, `/command`,
   `/messages/stream`, `/log/stream`, and the internal `/health/cache` probe.
   That last one is gated by an `Internal_Request_Token` rather than a
   capability, and carries the web runtime's cache posture back to
   `wp nodes doctor` — the substrate's own wire between its tiers, not a
   consumer surface.
7. **Hooks.** Every `newspack_nodes/*` action and filter name and signature,
   enumerated with its arguments and its firing site in
   [API.md → Extensibility hooks](API.md#extensibility-hooks).
8. **Config_System.** The public API of `Field`, `Schema`, `Options_Overlay`,
   `Reset_Gate`, `Field_Reset_Assets`, `Settings_Renderer` and
   `Restart_Planner`. The first five carry a second guarantee — they stay
   loadable without the substrate, so a consumer's hermetic harness can require
   the five files alone, as pyrobase's `tests/load-config-system.php` does.
   A substrate call added to any of the five breaks that harness — a
   coercion-helper sweep once reached for `Core::`, and pyrobase's mock suite
   fataled on a missing `Newspack_Nodes\Core`. The other two use the substrate
   legitimately; event-logger-nodes consumes both.
9. **Consumer boot.** `Topology_Registry::register_plugin()`,
   `Command_Interpreter_Node::register_namespace()`,
   `Bootstrap::version_at_least()`, `NEWSPACK_NODES_VERSION`.

Not frozen: any class, method, JS module, dashboard markup, SCSS or option name
absent from that list. The three `@newspack-nodes/*` build aliases — `runtime`,
`debug-overlay` and `shared` — and the React surface behind them move freely:
`answerFor( subject )` went away in 2.32.0 and `useAskPicker`'s `onNothing` in
2.33.1. A consumer resolves them at build time from its own pinned substrate
checkout, so that surface changes when the consumer bumps its pin, never when
the substrate ships.

## The version gap

The substrate ships before its consumers, by necessity: a consumer pins a
substrate tag, so the tag has to exist first. A host running the new substrate
against a not-yet-updated consumer is therefore a guaranteed window, and two
mechanisms cover it from opposite ends.

**A consumer declares its floor.** `Bootstrap::version_at_least( $min,
$dependent )` returns false and posts an admin notice naming the plugin, the
version it needs and the version it found, so a consumer built against a newer
substrate stays dormant instead of fataling mid-request.
`scripts/check-substrate-floor.sh` — authored here, vendored into every
consumer, and run from the consumer's own repo — proves that floor is high
enough for the substrate APIs the plugin actually calls: PHPStan resolves each
call to its declaring class, then the script searches the substrate's tags for
the first release that answers it, walking traits and the `extends` chain the
way PHP would.

**A new parameter degrades.** Adding a *required* parameter to a public method
closes the window with a fatal instead. `Partition_Node::locate_by()` briefly
required its key set, and an older `Flame_Builder_Node` reaching it through
`Table_Node::lookup_multi()` — which invokes the seam bare — raised
`ArgumentCountError` on every dashboard request, an uncaught 500 worse than the
memory exhaustion it was fixing. It reads
`locate_by( \Closure $extract, array $wanted = [] )` now: a default whose
behaviour is safe and useless, so the stale consumer degrades until it catches
up.

## How a frozen name changes

A change to a name above lands in [upgrading.md](upgrading.md) with the rewrite
beside it, in the same commit as its CHANGELOG entry — the rule every
consumer-facing change follows, listed or not. What the list buys is a
reference: these names are written down in API.md, cli.md and the ADRs, so a
consumer builds against prose instead of against the substrate's source.

It buys neither stillness nor an alias. No file in the tree carries
`@deprecated`, and the record is plain: `newspack_nodes/supervisor_periodic`
became `newspack_nodes/periodic`, `wp nodes restart supervisor` was removed and
`make_node TopicProbe` became `make_node Topic_Probe` — a hook, a CLI verb and
a TSL node type, all inside 2.11.0, and each entry says so outright: no alias,
no shim, the old spelling rejected rather than ignored.

Nor was 2.11.0 the end of it: `Tail` lost its `source_mode` argument in 2.26.0,
and `POST /v1/command` began demanding READ at the door in 2.31.0. Read
upgrading.md before every minor upgrade, not only before a major.

Additive change — new verbs, new nodes, new hooks, new optional arguments — is
free and unannounced.

## Versioning

The numbering is semantic-versioning-shaped: patch is fixes, minor is additive,
and a major is a break too broad to migrate one entry at a time. 2.0.0, the last
one, made every command sent to `/command` carry a signature; no per-name note
covers a rule that reaches every caller at once. A minor may still move a frozen
name, which is why the thing to read is upgrading.md, not the version number.
