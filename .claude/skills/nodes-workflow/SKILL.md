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

Substrate-appropriate examples: a generic Filter node, a new TYPE flag, a Tail buffering mode, a Router heuristic. Substrate-inappropriate: a node that knows what a "request" is.

### Phase 2: Implement

For a new Node subclass:

1. Create `includes/class-{name}.php` with `class Foo extends Node`. Override `fill( array &$message ): void` — that's the contract. Bump `$this->counter` and forward via `$this->sink?->fill( $msg )` unless you have a specific reason not to.
2. If the node needs constructor arguments, declare them on the constructor with PHP types. CommandInterpreter's `make_node` passes shell tokens through; PHP coerces typed parameters from strings.
3. Add `require_once` to `newspack-nodes.php` AND register with `CommandInterpreter::register_class( 'Foo', \Newspack_Nodes\Foo::class )` so topology PHP and the shell `make_node` verb can both construct it.
4. Add a row to AGENTS.md's "Node primitives" / "Storage primitives" / "Lifecycle" table describing what the node does.

For a new CommandInterpreter verb:

1. Add to `$H` (help text) and `$C` (callable map) in `init_C()`.
2. Add `cmd_foo()` static method following the `[$arg1, $arg2] = array_pad(preg_split(..., $args, N), N, '')` pattern.
3. Update the help line if there's an alias.

### Phase 3: Test, deploy, verify

```bash
# Run unit + integration tests inline.
docker exec -u bend eve-pyrobase1-1 bash -c 'cd /usr/src/newspack-nodes/tests && phpunit'

# Deploy the runtime.
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-nodes.sh

# Restart workers so they pick up the new code (otherwise the old class lives
# in the running PHP process for ~10 more minutes).
docker exec eve-pyrobase1-1 wp nodes restart firehose-workers --all-partitions \
    --allow-root --path=/var/www/html

# Verify workers came back.
docker exec eve-pyrobase1-1 wp nodes ls --allow-root --path=/var/www/html
```

If the change touches an application plugin (e.g., the substrate change requires the application to update its consumer), redeploy that plugin too:

```bash
docker exec eve-pyrobase1-1 /services/pyrobase/setup/newspack-event-logger-nodes.sh
```

### Phase 4: Live-verify

For changes affecting the firehose pipeline, hit the dashboard or a real URL:

```bash
curl -sk "https://www.bendsource.com/" -o /dev/null -w "HTTP %{http_code}\n"
sleep 3  # Let the firehose flush, RequestBuilder assemble, etc.
docker exec eve-pyrobase1-1 wp nodes reqgrep --recent \
    --allow-root --path=/var/www/html | head -10
```

Match what you see against your expectations. If something's off, the `nodes-debugging` skill walks through `wp nodes cli` for live introspection.

## Patterns That Trip People Up

- **Constructors must be event-loop-free** for Topic and Partition (and anything with a similar "instantiated per request" lifecycle). No `set_timer`, no `Core::node()` lookup, no `scandir`. The reason is in AGENTS.md decision 5 — the constructor runs in request scope where there's no event loop to fire timers, and the EF hasn't drained anything yet so `Core::node()` returns null.
- **FROM stamping is for I/O boundaries only.** Tail and Consumer stamp; internal nodes don't. If you find yourself adding `stamp_message()` to a Tee or a Hook, you're probably wrong.
- **Use `Message::new_message()`, not `[]`.** It pre-populates the 7 indices with safe defaults; leaving a slot uninitialized produces null-coalesce errors deep in Router or Dumper.
- **Don't reintroduce TM_PERSIST.** It was deliberately removed (see AGENTS decision 3). If you think you need ack/cancel, you almost certainly don't — synchronous I/O at every boundary handles backpressure naturally.

## After You Land

- Update AGENTS.md if the change altered an architecture decision or key file
- If the file count is creeping up, consider whether the change should split a file rather than grow it
- Push to GitHub via the plugin's own remote (this is its own git repo independent of dndocker)

## Related Skills

- `nodes-debugging` — live REPL, log paths, common gotchas while running
- `nodes-review` — substrate contract checklist (run before merging)
