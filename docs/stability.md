# Stability Contract

The names below are the substrate's declared surface: the shapes
[API.md](API.md), [cli.md](cli.md) and the ADRs document. A consumer reaches
past them constantly — `Core`, `Config`, `Job_Intake`, `Cache_Backend`,
`LRU_Cache`, `Partition_Node`, `Table_Node` and the `Bootstrap` trio
`node_dirs()`, `node_partitions()` and `stale_timeout_for()` all carry sibling
traffic, and not one of them is on the list. Nothing forbids reaching past the
list, and those names move: `Job_Intake` re-ordered its arguments in 2.27.0, and
`Table_Node` dropped its read-through L1 in 2.28.0. Every consumer-facing change
lands in [upgrading.md](upgrading.md) with the rewrite beside it, frozen or not.

That trio and `Topology_Analyzer::includes()` answer questions a consumer cannot
answer for itself. `node_dirs()` and `node_partitions()` are how a reader finds
a node's partitions across every ACTIVE topology declaring it: `node_dirs()`
answers partition index => directory for a Partition or Topic node, and
`node_partitions()` the ascending indices alone, for per-partition state that
never lands on disk — event-logger-nodes builds one memcache `Stats_Store` per
flame-builder index from it. The global `num_partitions` setting is never that
number. A topology carries its own worker count, and a Topic's second
constructor argument is its own fan-out width, which an aggregator declares
above the worker count for hub fan-in or deliberately below it, so a consumer
looping to the global setting reads the low partitions alone and reports no
error. `stale_timeout_for( $type )` does the same for staleness, returning the
threshold that topology's frontmatter declares and falling back to
`Lock_Node::STALE_TIMEOUT` for an unknown name. `CLI::ls_workers()` behind
`wp nodes status` reads it there, and so does the render lease
nuclear-gyrobase hands its Perl child. A consumer judging staleness against the
flat default instead calls a worker on a raised-threshold topology dead while
the peer scan correctly leaves it running.
`Topology_Analyzer::includes( $name )` answers "does this deployment run X?",
which the active topology NAMES cannot: a deployment routinely runs a stock
topology through a locally-named wrapper, and the wrapper's name says nothing
about what it composes. Event-logger-nodes' hub
detection tests `'aggregator' === $name` and then that include set before it
falls back to scanning the graph for a `Remote_Source` node.

All four can raise `\RuntimeException`, and not only for the caller's own
mistake. The three `Bootstrap` names resolve the active topology set first,
which fails when the runtime base directory is unusable; the analyzer behind
`node_dirs()`, `node_partitions()` and `includes()` fails again when ANY
topology it walks declares an unknown include, an include cycle or a conflicting
`make_node` — someone else's `.tsl`, not the node the caller asked about.
Event-logger-nodes calls `node_dirs()` on dashboard request paths from
`Performance_CI_Node` and `Flame_Builder_Node`, where an uncaught throw is a 500
on every dashboard request, and wraps `includes()` in a try/catch for the same
reason. Catch it, or let the surrounding controller's catch own it.

## Frozen surfaces

1. **The node contract.** `fill( array $message ): void`, `sink()`, `target()`,
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
   ENVELOPE, never the record inside a VALUE: a producer owns its own record,
   `Probe_Record` and `Jobstats_Record` both re-cut their fields in 2.11.0, and
   a durable reader's offsetlog frame retired its `quarantined` key in 2.26.1.
   `Message::new_message()` is the sanctioned way to mint one, and it is frozen
   with the layout: it returns the seven indices populated, TYPE at
   `TM_UNTYPED`, TIMESTAMP warmed off the cached clock and empty strings
   elsewhere, leaving the caller to assign TYPE. Nothing builds the array by
   hand.

   The eighteen reserved node names are wire strings too, and their VALUES are
   frozen for the major even though the JS module carrying them is not.
   `Node_Names` is the PHP half and `src/runtime/reserved-node-names.json` the
   canonical map, which `src/runtime/index.js` exports as `reservedNames` for a
   consumer bundle to compile in. The two halves meet at runtime and not before:
   a browser mints `FROM = _sse:<pid>/_output` from a bundle built against its
   own pinned substrate, while the worker gates on `Node_Names::SSE` and stamps
   `Node_Names::OUTPUT` out of the INSTALLED one. Rename a value and the failure
   is silent — the reply addresses a node that does not exist, and nothing
   errors anywhere — so a rename takes an upgrading.md entry.
3. **TSL.** The statement grammar (`Shell_Node::parse_statements()` semantics),
   the shell builtins (`var`, `include`, `print`, `clear`, `status`,
   `debug_level`, `show_parse`, and `cd` with its alias `chdir`), the graph
   verbs (`make_node`, `set_sink`, `connect_node`, `disconnect_node`,
   `move_node`, `remove_node`, `register`, `unregister`, and `command_node` with
   its aliases `command` and `cmd`), the one-way `secure` ratchet every stock
   topology closes with, the `insecure` declaration refused once that level has
   climbed, and token resolution: the `<partition>` and `<topology>` variables
   `Topology_Loader` binds before it evaluates the file, and the `<ns:key>`
   form each namespace resolves through the resolver it registered at boot —
   `<config:KEY>` is the substrate's, and a consumer adds its own through
   `Core::register_config_namespace()`. The grammar is one grammar in both
   ports: `src/runtime/shell-node.js`'s `parseStatements` is held to
   `parse_statements()` by the shared `tests/fixtures/statements/` corpus,
   which the PHP and JS suites both read.
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
8. **Config_System.** The public API of seven classes, name by name:
   - `Field` — the constructor, its readonly declaration (`key`, `type`,
     `section`, `id`, `restart`, `min`, `max`, `default`, `ui`,
     `register_args`, and the derived `delete_on_blank`, `render` and
     `sanitize`), `label()`, `sanitize_callback()`, `is_setting()`,
     `is_rendered()` and `render_id()`.
   - `Schema` — the `( $prefix, $fields, $sections )` constructor,
     `overlay_keys()`, `setting_option_names()`, `delete_on_blank_options()`,
     `restart_for()`, `field_for_short()`, `defaults()`, `prefix()`,
     `fields()`, `rendered_fields()`, `register_options()` and
     `register_sections_and_fields()`.
   - `Options_Overlay` — `apply()`, `stored_value()` and the `ABSENT`
     sentinel that reports a missing option row.
   - `Reset_Gate` — `register()`, `resolve()` and `mark_name()`.
   - `Field_Reset_Assets` — `enqueue()` and `highlight_style()`, and with them
     the DOM vocabulary both key off: the `data-nn-reset` wrapper naming the
     mark, its `data-nn-reset-toggle` button, the `data-nn-reset-default` a
     control declares, the `data-nn-reset-marker` the toggle plants and the
     `is-marked` class the style paints. Pyrobase writes that markup by hand
     rather than calling `Settings_Renderer`, so a rename in the JS leaves it a
     dead toggle or an unstyled mark and nothing raises.
   - `Settings_Renderer` — `render_effective_config_section()` and
     `effective_config_rows()` behind the Effective Configuration panel, the
     five controls `number()`, `directory()`, `textarea()`, `checkbox()` and
     `react_mount()`, and the `reset_wrapper()` / `reset_toggle()` pair every
     control goes out through.
   - `Restart_Planner` — `plan()`, `request_restarts()`, `request_reloads()`
     and `topologies_for()`.

   The first five carry a second guarantee — they stay loadable without the
   substrate, so a consumer's hermetic harness can require the five files
   alone, as pyrobase's `tests/load-config-system.php` does. A substrate call
   added to any of the five fatals that harness on a missing
   `Newspack_Nodes\Core`, which is why `Field::label()` and
   `Schema::register_sections_and_fields()` inline their string coercion rather
   than call `Core::str()`. The other two use the substrate legitimately;
   event-logger-nodes consumes both.
9. **Config_Utils.** `validate_config_path()`, `load_config_file()` and the
   `validate_config_values()` walk beneath them — the file half of
   [ADR-20](architecture-decisions.md#adr-20-a-config-default-lives-in-code-every-config-file-is-an-override-surface),
   which the substrate's own `Config` and event-logger-nodes' `Config` both read
   their configuration through. The two entry points take a trailing prefix
   string naming the calling class in the log line or the exception; the walk
   takes a recursion depth instead. Three guarantees a consumer builds on: a
   config file overrides the schema defaults for the keys it names, so a missing
   one returns the passed config untouched; a file returning anything but a tree
   of scalars, nulls and arrays throws, and so does one nesting arrays more than
   ten deep, which is how the walk ends on a self-referential tree; and a path
   failing any check logs through `Core::stderr()` and comes back null, leaving
   the caller to decide whether a bad path is fatal. That `Core::` call is why
   this class cannot join item 8's hermetic five: without the substrate, a
   harness fatals the first time a path check fails.
10. **Consumer boot.** `Topology_Registry::register_plugin()`,
    `Command_Interpreter_Node::register_namespace()`,
    `Bootstrap::version_at_least()`, and three constants the entry point
    defines: `NEWSPACK_NODES_VERSION`, the handshake a consumer compares
    against; `NEWSPACK_NODES_DIR`, the plugin's filesystem root, holding the
    autoloader, the stock topologies and `build/`; and `NEWSPACK_NODES_URL`, the
    browser base for that same `build/`. Both paths end in the slash their
    `plugin_dir_path()` / `plugin_dir_url()` sources give them.
    `Field_Reset_Assets::enqueue()`, frozen in item 8, reads the build's
    `index.asset.php` off DIR and its script src off URL. URL is the one that
    can go missing — the plugin defines it only where `plugin_dir_url()` exists
    — so every reader guards it: `enqueue()` returns early and
    `Admin::build_url()` falls back to the empty string.

    `Formatters::register( $name, $cb )` is the third registration, and the
    only supplier for a `cmd <node>:config with_index <name>` line: TSL has no
    closure syntax, so a topology names a formatter and a plugin registers the
    callable under that name at load. The name and its callable argument are
    frozen; the signature that callable must satisfy is not, because it belongs
    to whoever resolves the name — for the companion-index formatters, to
    `Partition_Node::with_index()`.

    Four `Admin\Admin` statics are the admin half of the same contract.
    `enqueue_react_page()` is the registrar every consumer dashboard enqueues
    through, and returns null rather than enqueueing when the build is absent.
    `css_cache_version()` versions a stylesheet on its content hash, so a
    SCSS-only rebuild lands instead of serving from cache behind an unchanged
    `?ver=`. `current_user_allowed()` is the MANAGE capability narrowed by the
    `allowed_users` list. `devtools_overlay_pages()` collects the page slugs a
    bundle contributing an overlay tab must enqueue on, so an overlay embedded
    by one plugin still shows another's tab. Nuclear-gyrobase calls
    `css_cache_version()` with no `class_exists()` guard, so withdrawing one is
    a fatal rather than a degradation.
11. **The cooperative stop.** `Worker_Should_Stop`, its
    `Worker_Should_Stop_Clean` subclass, and the `Deferred_Clean_Stop` trait's
    `guarded()`, `clear_pending_stop()` and `raise_pending_stop()`.
    [ADR-14](architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)
    obliges every broad catch on a consumer's drain path to name
    `Worker_Should_Stop` in an explicit first `catch` and re-throw it, so the
    class name is compiled into consumer code the substrate never sees. Moving
    that name fails SILENTLY: a `catch` on a class that no longer exists never
    matches, the broad `catch ( \Throwable )` behind it swallows the stop,
    nothing fatals, nothing logs, and the worker runs past its deadline.

Not frozen: any class, method, JS module, dashboard markup, SCSS or option name
absent from that list. The three `@newspack-nodes/*` build aliases — `runtime`,
`debug-overlay` and `shared` — and the React surface behind them move freely:
`answerFor( subject )` went away in 2.32.0 and `useAskPicker`'s `onNothing` in
2.33.1. A consumer resolves them at build time from its own pinned substrate
checkout, so that surface changes when the consumer bumps its pin, never when
the substrate ships. Item 2's reserved names are the one exception, and for
that same reason: a value compiled into an old bundle still has to answer a new
substrate.

## The version gap

The substrate ships before its consumers, by necessity: a consumer pins a
substrate tag, so the tag has to exist first. The window where a host runs the
new substrate against a not-yet-updated consumer is therefore guaranteed, not
hypothetical, and two mechanisms cover it from opposite ends.

**A consumer declares its floor.** `Bootstrap::version_at_least( $min,
$dependent )` returns false and posts an admin notice naming the plugin, the
version it needs and the version it found, so a consumer built against a newer
substrate stays dormant instead of fataling mid-request. Guard the call with
`method_exists()`: a substrate predating the method itself carries no such
method, so the call meant to prevent a fatal becomes one — which is why
event-logger-nodes, intelligence and cache-cozy each test for it first.
`scripts/check-substrate-floor.sh` — authored here and vendored into every
consumer, though only event-logger-nodes' `pre-push` runs it — proves that
floor is high enough for the substrate APIs the plugin calls: PHPStan resolves
each call to its declaring class, then the script searches the substrate's tags
for the first release that answers it, walking traits and the `extends` chain
the way PHP would. It is sound rather than complete: the collector claims a call
only where PHPStan resolves the callee to ONE definite declaring class, and
answers nothing for a dynamically-named method or a callee typed as a union or
`mixed`. A substrate call reached that way goes uncounted, so the floor the
script reports is a lower bound, not a guarantee for code shaped that way.

**A new parameter degrades.** Adding a *required* parameter to a public method
closes the window with a fatal instead. `Partition_Node::locate_by( \Closure
$extract, array $wanted = [] )` bounds its index walk by the key set in that
second parameter and defaults it to empty — a value that reads nothing, so a
consumer compiled against the one-argument form comes back empty rather than
raising `ArgumentCountError`. The default is not a convenience:
`Table_Node::lookup_multi()` reaches a partition through the app's backing
closure and invokes it without a try/catch, so a fatal inside is an uncaught 500
on every dashboard request. A default whose behaviour is safe and useless is
what lets a stale consumer degrade until it catches up.

## How a frozen name changes

A change to a name above lands in [upgrading.md](upgrading.md) in the same
commit as its CHANGELOG entry. What the list buys is a reference: a consumer
builds against prose instead of against the substrate's source.

It buys neither stillness nor an alias. No file in the tree carries
`@deprecated`, and the record is plain: `newspack_nodes/supervisor_periodic`
became `newspack_nodes/periodic`, `wp nodes restart supervisor` was removed and
`make_node TopicProbe` became `make_node Topic_Probe` — a hook, a CLI verb and
a TSL node type, all inside 2.11.0, and each entry says so outright: no alias,
no shim. The CLI target is refused by name and the TSL line resolves no class at
load; the hook is the quiet one — a subscriber still on the old name is never
called, and nothing says so.

Nor was 2.11.0 the end of it: `Tail` lost its `source_mode` argument in 2.25.0,
and `POST /v1/command` began demanding READ at the door in 2.31.0. Read
upgrading.md before every minor upgrade, not only before a major.

Additive change — new verbs, new nodes, new hooks, new optional arguments — is
free, and earns a CHANGELOG line rather than an upgrading.md entry.

## Versioning

The numbering is semantic-versioning-shaped: patch is fixes, minor is additive,
and a major is a break too broad to migrate one entry at a time. 2.0.0, the last
one, made every command sent to `/command` carry a signature; no per-name note
covers a rule that reaches every caller at once. A minor may still move a frozen
name, which is why the thing to read is upgrading.md, not the version number.
