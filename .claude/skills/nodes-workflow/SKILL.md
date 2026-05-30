---
name: nodes-workflow
description: Implementation workflow for the newspack-nodes substrate (Node subclasses, topologies, deploys). Use when adding new node types, wiring topology files, or making changes that need to ride through the deploy → restart → verify cycle.
argument-hint: "[node-type or feature]"
---

# Newspack Nodes Workflow

This skill is for working **inside** newspack-nodes (the substrate). For application code that builds on top, see the event-logger-nodes plugin's own skills.

Read `AGENTS.md` first for the architecture-decisions and key-files map; this skill is the procedural companion.

## When to Use

- Adding a Node subclass to the substrate (something every consumer would benefit from, not application-specific)
- Adding to / modifying CommandInterpreter shell verbs
- Touching Worker / Supervisor lifecycle code
- Any change that ships in `newspack-nodes/` and needs to ride through the deploy + restart cycle

For application-side changes (RequestBuilder, FlameBuilder, REST controllers, dashboards), the event-logger-nodes plugin has its own workflow skill.

## Phases

### Phase 1: Locate the right layer

The boundary that matters: **does this belong in the substrate?** Substrate code is application-agnostic. If you find yourself reaching for an event-logger-specific concept (request_id, firehose, jobintake, flame), you're in the wrong plugin — go to `newspack-event-logger-nodes/`.

Substrate-appropriate examples: a generic Filter node, a new TYPE flag, a Tail buffering mode, a Router heuristic, a file-writing primitive (Log), a routing helper (Echo). Substrate-inappropriate: a node that knows what a "request" is.

### Phase 2: Implement

For a new Node subclass:

1. Create `includes/class-{name}.php` with `class Foo_Node extends Node` — every node class ends in `_Node` (the shell-name in `make_node <type> <name>` is the class minus `_Node`, so callers type `make_node Foo my_foo`). Override `fill( array &$message ): void` — that's the contract. Bump `$this->counter` and forward via `$this->sink?->fill( $msg )` unless you have a specific reason not to.
2. **v0.6.0 Tachikoma sequence**: ctor must be parameter-less. Declare positional config in `node_schema()['arguments']` as `[{name, type, default?, required?}]` — `make_node` will instantiate with `new $fqcn()`, then call `name()`, then `arguments( implode( ' ', array_filter( $args, '\is_scalar' ) ) )`, then `sink( $this )`. The default `arguments()` walks the schema and assigns each positional arg onto `$this->{$name}`, so config round-trips through `dump_config()`.
3. Override `arguments()` only when you need derived state (e.g. `Partition_Node`'s `partition_dir`). The override MUST short-circuit on empty args: `if ( '' === $args ) return $result;` — otherwise `make_node Foo` (no args) re-derives against declaration-default props and writes filesystem-root junk like `/p0`. Side effects (`set_timer`, `mkdir`, `fopen`) belong in the override gated on non-empty args, NOT in the ctor (substrate Decision #5: ctor must be event-loop-free).
4. Programmatic dependencies (objects, callables, streams) are public properties the caller assigns AFTER `make_node` returns — NOT ctor params. Object args passed positionally to `make_node` are silently filtered out by `is_scalar` because they aren't round-trippable. Reference: `Workers_CI_Node::$cli` / `$cache`.
5. **No registration needed** — `make_node Foo` resolves `\Newspack_Nodes\Foo_Node` via the registered namespace prefix (composer classmap autoloads it), and the palette catalog scans the classmap for `*_Node` Node subclasses with a `node_schema()` category. Just put the class under `Newspack_Nodes\` (the prefix the plugin registers via `Command_Interpreter_Node::register_namespace`) and run `composer dump-autoload -o`.
6. Add a row to AGENTS.md's `## Layout` table for the new file. If the change shifts an architecture decision (e.g. new lifecycle ordering, new ctor restriction), add or amend a decision under `## Architecture Decisions`.

For a new CommandInterpreter verb:

1. Add to `$H` (help text) and `$C` (callable map) in `init_C()`. Aliases get their own `$C` row pointing at the same `cmd_foo` static; document them in the canonical verb's `$H` entry (`alias: bar`).
2. Add `cmd_foo()` static method following the `[$arg1, $arg2] = array_pad(preg_split(..., $args, N), N, '')` pattern.
3. If the verb is purely shell-side (e.g. `cd`, `tell_node`, `send_node`), intercept it in `Shell::parse()` instead — it never reaches interpreter dispatch. Document it in `$H` anyway so `help` covers everything the user can type.
4. Throwing from `cmd_foo` is fine — `interpret()` catches `\Throwable` and wraps the response as `TM_COMMAND|TM_ERROR`. Reserve `return 'error: ...'` for malformed-args paths where you want the canonical OK response shape.

### Phase 3: Test, restart, verify

```bash
# Run unit + integration tests inline. --enforce-time-limit aborts a hung
# test (readline without a TTY, infinite drain loop) at the per-test budget
# instead of stalling the whole suite.
cd tests && ../vendor/bin/phpunit --enforce-time-limit

# Restart workers so they pick up the new code (otherwise the old class lives
# in the running PHP process for ~10 more minutes). Run `wp nodes types`
# first to see what topologies are actually live — the substrate itself ships
# no topologies; topologies come from application plugins (ELN ships
# `firehose-workers-and-jobs`, `job-workers`, `request-workers`, etc.).
wp nodes restart all --all-partitions   # or a specific type from `wp nodes types`

# Verify workers came back.
wp nodes ls
```

If the change requires an application plugin to also update (e.g., a substrate change that affects how the app's consumer attaches), redeploy that plugin in your environment.

### Phase 4: Live-verify

For changes affecting the firehose pipeline, hit the dashboard or a real URL. The substrate itself ships `wp nodes ls` / `wp nodes cli`; the application-side filter `wp nodes reqgrep` lives in `newspack-event-logger-nodes` and is only available if that plugin is also installed in your environment (it is, in dndocker):

```bash
curl -sk "<site>/" -o /dev/null
wp nodes reqgrep --recent | head -10   # ELN-side; falls back to wp nodes cli for substrate-only envs
```

Match what you see against your expectations. If something's off, the `nodes-debugging` skill walks through `wp nodes cli` for live introspection.

## Patterns That Trip People Up

- **Constructors must be event-loop-free** for Topic and Partition (and anything with a similar "instantiated per request" lifecycle). No `set_timer`, no `Core::node()` lookup, no `scandir`. The reason is in AGENTS.md decision 5 — the constructor runs in request scope where there's no event loop to fire timers, and the EF hasn't drained anything yet so `Core::node()` returns null.
- **FROM stamping is for I/O boundaries only.** Consumer and HTTP_In stamp; internal nodes (including Tail) don't. If you find yourself adding `stamp_message()` to a Tee, a Hook, or even Tail itself, you're probably wrong.
- **Use `Message::new_message()`, not `[]`.** It pre-populates the 7 indices with safe defaults; leaving a slot uninitialized produces null-coalesce errors deep in Router or Dumper.
- **Don't reintroduce TM_PERSIST.** It was deliberately removed (see AGENTS decision 3). If you think you need ack/cancel, you almost certainly don't — synchronous I/O at every boundary handles backpressure naturally.

## After You Land

- Update AGENTS.md if the change altered an architecture decision or key file
- If the file count is creeping up, consider whether the change should split a file rather than grow it
- Push to GitHub via the plugin's own remote (this is its own git repo independent of dndocker)

## Related Skills

- `nodes-debugging` — live REPL, log paths, common gotchas while running
- `nodes-review` — substrate contract checklist (run before merging)
