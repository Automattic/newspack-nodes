---
name: nodes-workflow
description: Implementation workflow for the newspack-nodes substrate (Node subclasses, topologies, deploys). Use when adding new node types, wiring topology files, or making changes that need to ride through the deploy → restart → verify cycle.
argument-hint: "[node-type or feature]"
---

# Newspack Nodes Workflow

This skill covers work **inside** newspack-nodes (the substrate).

Read `AGENTS.md` first for the architecture-decisions and key-files map; this skill is the procedural companion. Every decision it cites by number is an ADR in `docs/architecture-decisions.md`.

## When to Use

- Adding a Node subclass to the substrate — something every consumer benefits from, not something application-specific
- Adding or modifying a Command_Interpreter shell verb, or a Service CI verb
- Adding a browser-runtime node under `src/runtime/`, or a topology under `topologies/`
- Touching Worker or fleet-revival lifecycle code
- Any change that ships in `newspack-nodes/` and rides through the deploy and restart cycle

For application-side changes (`Request_Builder_Node`, `Flame_Builder_Node`, REST controllers, dashboards), use the `event-logger-nodes-workflow` skill in that plugin instead.

## Phases

### Phase 1: Locate the right layer

The boundary that matters: **does this belong in the substrate?** Substrate code is application-agnostic. Reaching for an event-logger-specific concept (request_id, firehose, flame) means you are in the wrong plugin — go to `newspack-event-logger-nodes/`.

Substrate-appropriate: a generic Filter node, a new TYPE flag, a Tail buffering mode, a Router heuristic, a file-writing primitive (Log), a routing helper (Echo), generic async-job *dispatch* (`Job_Worker_Node`). Substrate-inappropriate: a node that knows what a "request" is.

The seam: generic job dispatch is substrate, but the per-job request *context* is application-side. `Job_Worker_Node` is the substrate's job seam — apps register handlers through the `newspack_nodes/job_handlers` and `newspack_nodes/remote_job_handlers` filters, and hook per-job context through `newspack_nodes/job_worker/before_job` (a **filter**: returning false skips the job), `newspack_nodes/job_worker/after_job` and `newspack_nodes/job_worker/batch_complete` (both actions). Extend job-dispatch-adjacent substrate code through those, and never pull request-aware code into `Job_Worker_Node`.

### Phase 2: Implement

For a new Node subclass:

1. Create `includes/class-{name}.php` with `class Foo_Node extends Node`. Every node class ends in `_Node`, and the shell name in `make_node <type> <name>` is the class minus `_Node`, so callers type `make_node Foo my_foo` ([ADR-10](../../../docs/architecture-decisions.md#adr-10-class-naming--make_node-namespace-resolution)). Override `fill( array $message ): void` — that is the contract, and it returns nothing ([ADR-13](../../../docs/architecture-decisions.md#adr-13-fill-returns-nothing)). Bump `$this->counter` and forward via `$this->require_sink()->fill( $message )` unless you have a specific reason not to.
2. **The Tachikoma construction sequence** ([ADR-11](../../../docs/architecture-decisions.md#adr-11-make_node-construction-sequence)): the constructor must be parameter-less. Declare positional config in `node_schema()['arguments']` as `[{name, type, default?, required?}]`; `make_node` instantiates with `new $fqcn()`, then calls `name()`, then `arguments( $arg_tokens )`, then `sink( $this )`. The tokens are the scalar `make_node` arguments as a **flat token array** — `arguments( ?array $args = null ): array` takes and returns `list<string>` argv, never a space-joined string. `Node::arguments()` only stores that array; re-joining happens once, in `Node::serialize_args()`, at the `dump_config()` anchor.
3. To get schema arguments onto properties, `use Schema_Reflection` — `Node` itself carries none of it — and override `arguments()` to run the tokens through `parse_schema_args()`. Follow the `Partition_Node` reference: `if ( null === $args ) { return parent::arguments(); }` for the pure getter, else `parse_schema_args( $args )` and then derive. `parse_schema_args()` assigns each declared name to the matching property (a name that is not a real property is refused), records the raw tokens into `$this->arguments` so `dump_config()` round-trips, fills a missing token from its schema `default`, and **throws** when the argument is `required` — so a bare `make_node Foo` fails loud instead of writing filesystem-root junk like `/p0`. ADR-11's amendment is the one exception: declare a positional optional when the node refuses the same invariant at the point of use, because a required token that only makes a deferred caller invent a placeholder moves the failure from loud to silent.
4. Per [ADR-5](../../../docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition), event-loop and filesystem work (`set_timer`, `mkdir`, `fopen`, `scandir`, `Core::node()`) stays OUT of both the constructor and `arguments()` for request-scope nodes such as Topic and Partition. File handles open lazily on first `fill()`. Path validation is fine there — Partition calls `Config::assert_within_base()` from `arguments()`.
5. Programmatic dependencies (objects, callables, streams) are public properties the caller assigns AFTER `make_node` returns, not constructor parameters. Object arguments passed positionally to `make_node` are filtered out by `is_scalar` with a rate-limited warning, because they cannot round-trip. Reference: `Workers_CI_Node::$cli`, which the bootstrap assigns and whose `cli()` accessor throws a named refusal when nothing did.
6. **No registration needed.** `make_node Foo` resolves `\Newspack_Nodes\Foo_Node` through the registered namespace prefix, and the console palette scans the composer classmap for concrete `*_Node` Node subclasses whose `node_schema()` declares a category. Put the class under `Newspack_Nodes\` (the prefix the plugin registers via `Command_Interpreter_Node::register_namespace()`) and regenerate the classmap with `composer build:autoloaders` (= `composer install --optimize-autoloader`) or `composer dump-autoload -o`. A `Hidden` category, an empty category or a `hidden` flag keeps a node out of the palette while `make_node` still resolves it.
7. Newspaper-order the methods: constructor, `arguments`, `fill`, `fire_cb`, `fire`, the call-graph middle, `node_schema` last. Declared fields keep source order, because a `foreach`, an `(array)` cast and JSON all observe it. `scripts/reorder-node-methods.php --check` gates this at commit; fix with `php scripts/reorder-node-methods.php --write <file>` on the host, then `phpcbf`.
8. Add a row to AGENTS.md's `## Layout` table for the new file. If the change shifts an architecture decision — a new lifecycle ordering, a new constructor restriction — write or amend the ADR in `docs/architecture-decisions.md` and add its row to the AGENTS.md decision table. Numbers are stable: supersede, never renumber.

A consumer plugin gets the same shapes for free from `wp nodes scaffold {plugin,node,topology}`, which writes the canonical files from `docs/writing-a-plugin.md` and never overwrites. It scaffolds into a plugin's `includes/`, so substrate classes are still hand-written.

For a new Command_Interpreter verb:

1. Add to `$H` (help text) and `$C` (callable map) in `init_C()`. Aliases get their own `$C` row pointing at the same `cmd_foo` static; document them in the canonical verb's `$H` entry (`alias: bar`).
2. Add a `cmd_foo()` static method. The `$C` closures carry `( Command_Interpreter_Node $self, array $args )`, plus a third `array $envelope` where the verb reads the issuing message, and they hand the handler a pre-split token array normalized through `arg_strings()`, so parse positionals with `[ $arg1, $arg2 ] = array_pad( $args, N, '' )` — never `preg_split` on a string. Classify `--key=value` and bare `--key` flags via `Command_Args::parse( $args )`, and read an integer option through `Command_Args::option_int()`, which returns null on a non-numeric value rather than coercing it to zero.
3. A verb the Shell answers itself never reaches interpreter dispatch. Pure shell state (`cd`, `include`, `var`, `print`) belongs in `Shell_Node::run_builtin()`, which mints no message; a verb minting a message of its own TYPE (`tell_node` as TM_INFO, `send_node` as TM_BYTESTREAM) belongs in `parse()`'s verb switch. Document either in `$H` anyway, so `help` covers everything the user can type.
4. **A refusal throws; a `return` is a result.** `interpret()` catches `\Throwable` and wraps the response as `TM_COMMAND|TM_ERROR`, so every `usage: …`, unknown-name and denial raises. Returning the refusal as a string leaves the caller unable to tell refusal from success — the `error:`-shaped returns that remain are values a caller consumes, not refusals. Add no per-verb `try/catch`: the central catch is the contract, and it re-throws `Worker_Should_Stop` first so a cooperative stop still propagates ([ADR-14](../../../docs/architecture-decisions.md#adr-14-cooperative-stop-propagates-through-broad-catches)).

For a new Service CI verb (the capability-gated surface dashboards and the admin call):

1. Declare it once in the concrete `*_CI_Node`'s `node_schema()['commands']`, as `[{name, capability, description, args, handler}]`. `Service_CI_Node` derives the dispatch table from that declaration and wraps every handler in `Capabilities::require()` for the role it names.
2. Name the role deliberately — `Capabilities::READ`, `TUNE` or `MANAGE`, cut by blast radius. A verb declaring none gets MANAGE, the strictest role rather than the loosest.
3. Parse arguments through the shared `protected static` helpers — `split_first_token()`, `require_valid_name()`, `require_option_int()` — and build a read-only slice from `slice_verb()`, which JSON-encodes what a shape callable returns over the CI's memoized snapshot.

For a new browser-runtime node (`src/runtime/`):

1. Write `src/runtime/{name}-node.js` exporting a `Node` subclass, then add its shell name to `CommandInterpreterNode.includeNodes` — a bundle has no autoloader, so that flat map stands in for the classmap. A consumer plugin merges its own through `CommandInterpreterNode.registerNodeClasses( map )`. The NAME is what TSL and the palette spell, while a builder assembling a graph in code hands `makeNode` the CLASS, because `includeNodes` is a per-bundle static ([ADR-16](../../../docs/architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)).
2. Mirror the PHP argument contract: declare positionals in `static nodeSchema()`, and call `parseSchemaArgs( this, value )` from the class's own `set arguments` after `super.arguments = value`, as `SseInNode` does. A `Hidden` category keeps the node off the palette here too.
3. `scripts/lint-contract.mjs` is the gate the other reviewers miss, because it fails the ADR violations that WORK: a correlation table, a minted op-id, a registry of pending replies, a KEY demux, a subclass computing its own timer boundary, a hook naming a class. One line opts out with `contract-ok:` and a reason; a file that implements the routing belongs in the script's `EXEMPT` list.

For a new or changed topology (`topologies/*.tsl`):

1. A `.tsl` is a Shell script — `var`, `make_node`, `connect_node` and `cmd`, with `include <name>` pulling another topology in under a `#pragma once` and a cycle guard. End it with `secure`, which ratchets the interpreter's level and never descends, so nothing arriving afterwards can rewire the graph.
2. Never hardcode a path. `Topology_Loader` binds `<partition>` and `<topology>` into `Core::$var` before the eval, and every `<config:key>` token resolves through the registered namespace. `<topology>` names the FLEET, which is why it belongs in an offsetlog path: two fleets tailing one log need two cursors. Read `topologies/job-worker.tsl` as the reference.
3. The substrate appends its own dir LAST, as the lowest-priority fallback, so a consumer overrides a stock topology by shipping a same-named `.tsl` and registering its dir through `Topology_Registry::register_plugin( $namespace_prefix, $topologies_dir )`.
4. A topology stays inert until it is activated. `wp nodes activate <topology>` runs `Topology_Analyzer::find_conflicts()` over the resulting set first and refuses when two of them write the same partition, then writes the option, invalidates the config cache and spawns the fleet.

### Phase 3: Test, lint, deploy, restart

Push runs the full gate for you (`scripts/pre-push`): the JS suite with coverage, the per-file JS coverage gate, `lint-docs.sh`, every gate's self-tests, and then — scoped to what the push touched — `lint:php`, a container deploy, the coverage suite and the per-class 90% gate for PHP; `lint:js` and `build` for JS; `lint:scss` and `build` for SCSS. Run the narrow commands below while you work, and let the push run the rest.

```bash
# Unit, integration and examples suites. Use the vendored binary, NOT the system
# phpunit — the container ships 11.x, composer pins 10.5.x, and mixing them dies
# on DispatchingEmitter::exportsObjects(). --enforce-time-limit aborts a hung
# test (readline without a TTY, an infinite drain loop) at the per-test budget
# instead of stalling the whole suite. Filter while iterating.
cd tests && ../vendor/bin/phpunit --enforce-time-limit --filter FooNodeTest

# Lint. lint:php is phpcs plus the PHP comment gate; lint:js is eslint, the JS
# comment gate and the contract linter.
npm run lint:php
npm run lint:js
npm run lint:scss
npm run lint:types

# JS. jest runs on the host, and the push holds every src/ file to 90%.
# `build` recompiles the ten bundles PHP enqueues; release:archive runs it
# for you, so this one is for iterating against the live admin.
npm run test:js
npm run build

# Static analysis: PHPStan level 10 with strict rules plus the shipmonk
# dead-code overlay. lint-staged runs it on every staged .php, so it IS the
# commit gate. Substrate caveat: most dead-code findings are public API,
# WP-CLI entrypoints, JS-PHP wire constants or test seams — verify every call
# path (siblings, JS, dynamic) before deleting. `lint:deadcode:js` is the knip
# half, gated on staged .js/.jsx.
npm run lint:phpstan          # alias: npm run lint:deadcode
npm run lint:deadcode:js

# Deploy. The setup script installs the EXISTING release zip; it does not
# build. Skip the archive and the site serves old code, which PHPUnit cannot
# catch because it runs from the /services source mount.
npm run release:archive
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-nodes.sh

# Restart workers to pick up the new code; otherwise the old class lives in the
# running process for the rest of its ~595s life (Cooperative_Stop's
# DEFAULT_MAX_RUNTIME). `all` restarts every type; a specific target must be an
# ACTIVE topology name, which is deployment-specific — the substrate's four
# stock topologies (`job-worker`, `job-intake`, `settings-sync`, `topic-probe`)
# are only the ones it bundles, and application plugins register their own.
# `wp nodes types` and `wp nodes status` are the source of truth.
docker exec -u bend eve-pyrobase1-1 wp nodes types --path=/var/www/html
docker exec -u bend eve-pyrobase1-1 wp nodes restart all --path=/var/www/html

# Verify workers came back: per-partition live/stale/down, heartbeat age, lag.
docker exec -u bend eve-pyrobase1-1 wp nodes status --path=/var/www/html
```

In dndocker the split is intrinsic: **PHPUnit runs inside `eve-pyrobase1-1` as `bend`** (it needs the DB, memcache and worker IPC), while **phpcs, PHPStan, the comment gate, jest and eslint run on the host** — the container mounts `/services` read-only, so PHPStan cannot write its `tmpDir` cache and dies on a lock file. Never `docker exec` these as root: root-owned scratch under `/tmp/newspack-nodes` locks later `-u bend` runs out.

The per-class coverage gate is 90% statement coverage on every `includes/` class, so a new Node subclass needs its own tests before the push will pass.

If the change also requires an application plugin to update — a substrate change affecting how the app's consumer attaches — redeploy that plugin too.

### Phase 4: Live-verify

Exercise the path the change touches. The substrate itself ships `wp nodes status`, `wp nodes cli` and `wp nodes doctor`; the firehose filter `wp nodes reqgrep` is registered by `newspack-event-logger-nodes` and exists only where that plugin is installed (it is, in dndocker):

```bash
curl -sk "<site>/" -o /dev/null
docker exec -t -u bend eve-pyrobase1-1 wp nodes reqgrep --recent --path=/var/www/html | head -10
```

Match what you see against your expectations. If something is off, the `nodes-debugging` skill walks through `wp nodes cli` for live introspection.

## Patterns That Trip People Up

- **Constructors must be event-loop-free** for Topic and Partition, and for anything else instantiated per request. No `set_timer`, no `Core::node()` lookup, no `scandir`. [ADR-5](../../../docs/architecture-decisions.md#adr-5-lazy-init-for-topic--partition) carries the reason: the constructor runs in request scope, where no event loop exists to fire timers and the Event_Framework has drained nothing, so `Core::node()` returns null.
- **Sources mint FROM; forwarders leave it alone.** A node that mints a new message stamps FROM with its own name — Shell stamps `_output/<pid>`, interpreter responses stamp `$this->name`, and Timer, Tail and Consumer stamp at their I/O boundary. Pass-through forwarders (Tee, Hook, Grep, application relays) never re-stamp, so a message flowing `firehose-in → firehose-fanout → request-builder` carries `FROM=firehose-in`. Adding `stamp_message()` to a Tee or a Hook is what produces the path explosion `MAX_FROM_SIZE = 1024` exists to stop.
- **A reply is already addressed — never correlate it.** The server replies TO=FROM, so the reply lands on the node that minted the command and its `fill()` handles it. Do not mint an op-id into `message[ID]`, keep a promise registry, or press KEY into service as a demux discriminator. "I batch N verbs per tick, so I need to tell the replies apart" means one node is doing N jobs: split by JOB. See [ADR-7](../../../docs/architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies).
- **Use `Message::new_message()`, not `[]`.** It pre-populates the 7 indices with safe defaults and a warmed timestamp; an uninitialized slot produces null-coalesce errors deep in Router or Dumper. Index with the `Message::*` constants — `$message['type']` coerces to int 0 and silently corrupts TYPE.
- **A self-pacing node holds a RECURRING timer.** `fire_cb()` disarms a oneshot before dispatching, so a node that re-arms a fresh oneshot at the bottom of its own `fire()` stays in the event loop only as long as it reaches that last line every tick — one early return, one throw, one refactor and it leaves the loop for good. Compute the interval you want and call `set_timer( $next_ms )` only when it differs from `interval_ms`, leaving the recurring timer armed in between, and make the stop explicit with `stop_timer()`. Reserve `oneshot` for a single wakeup, as Partition's debounce and HTTP_Out's flush do.
- **Touching a substrate setting? Edit `Settings_Schema`, not parallel lists.** The substrate declares each setting once as a `Config_System\Field` in `class-settings-schema.php`, carrying its default, bounds and restart class; `Config` (key list, defaults, worker-restart classification) and the admin settings page both derive from it. `ConfigSchemaTest` parses `newspack-nodes-config.php`'s commented entries back into an array and holds them to `Settings_Schema::defaults()` key for key, so a default changed in one file alone fails the suite. The admin surface gates on the MANAGE capability, narrowed by the optional `allowed_users` list, through `Admin::current_user_allowed()` — route any admin or menu registration you add through that funnel.
- **Don't reintroduce TM_PERSIST.** Its removal was deliberate ([ADR-3](../../../docs/architecture-decisions.md#adr-3-fire-and-forget-messaging)). If you think you need ack/cancel, you almost certainly don't — the single-threaded drain is the backpressure. The one reply-control flag the substrate keeps is `Message::TM_NOREPLY`: a Shell with `want_reply( false )` (topology load, script mode) ORs it onto commands, and `interpret()` then suppresses the reply while still surfacing errors on stderr. That is what stops a worker's boot-topology command from bouncing a `NOT_AVAILABLE` to `_output/<pid>` on startup, and it is the only reply-control surface a verb author may touch.
- **A signature change must DEGRADE for a consumer that has not updated.** The substrate ships before its consumers by necessity, since a consumer pins the substrate tag. Adding a required parameter to an `@api` method closes that window with a fatal — give it a default whose behaviour is safe but useless, so a stale consumer degrades until it catches up.

## After You Land

- Update AGENTS.md if the change altered an architecture decision or a key file, and `CHANGELOG.md` for anything that changes behavior
- Writing a new version number into `CHANGELOG.md` means running `./scripts/bump-version.sh <version>`. The version lives in four places — the `Version:` header, `NEWSPACK_NODES_VERSION`, `package.json`, and the `SUBSTRATE_VERSION` banner in `src/build-kit/index.mjs` — and each has a distinct consumer, so hand-editing one ships the drift
- If the file count is creeping up, split a file rather than growing it
- Push to GitHub via the plugin's own remote — its git repo is independent of dndocker, and `pre-push` runs the whole gate

## Related Skills

- `nodes-debugging` — live REPL, log paths, common gotchas while running
- `nodes-review` — substrate contract checklist (run before merging)
- `nodes-dashboards` — building a dashboard, inspector or panel on the substrate
