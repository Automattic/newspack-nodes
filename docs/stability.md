# Stability Contract

The names below are **frozen** for the current major version — code written
against them keeps working across every release in that major. Everything
else is internal and may change in any release without notice. A major bump
is the only place a frozen name may break (see Versioning below); the last
one landed at 2.0.0, which is why some entries below date from before it and
some after.

## Frozen surfaces

1. **The node contract.** `fill( array $message ): void`, `sink`, `target`,
   `stamp_message()`, `register()` / `notify()` / `set_state()`, `arguments()`,
   `node_schema()` — the shapes [ADR-1](architecture-decisions.md#adr-1-uniform-fill-contract),
   [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies),
   [ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence) pin.
2. **The message.** The 7-field positional layout (`Message::TYPE … VALUE`), the
   `TM_*` type flags, and the positional-JSON wire format (`packed()` /
   `unpacked()`) — [ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array).
   On-disk Partition segments written by any release in the current major
   remain readable by every later release in that major.
3. **TSL.** The statement grammar (`Shell_Node::parse_statements()` semantics),
   the stock verbs (`make_node`, `connect_node`, `disconnect_node`, `remove_node`,
   `command_node` (alias `cmd`), `var`, `include`), and `<config:KEY>` token
   resolution. A `.tsl` that loads on one release loads on every later release
   in the same major.
4. **Stock node types.** The registered names and documented constructor-argument
   shapes (`node_schema()` is the authority) of every node the palette lists.
5. **CLI.** The `wp nodes` verbs and their documented arguments and output
   contracts (`--format=json` shapes included).
6. **REST.** The routes and their envelope shapes ([API.md](API.md)):
   `/workers/spawn`, `/auth`, `/command`, `/messages/stream`, `/log/stream`,
   and the internal `/health/cache` probe.
7. **Hooks.** Every `newspack_nodes/*` action and filter name and signature.
8. **Config_System.** The public API of `Field`, `Schema`, `Options_Overlay`,
   `Reset_Gate`, `Field_Reset_Assets` — and the guarantee that those five stay
   loadable without the substrate (the hermetic set).
9. **Consumer boot.** `Topology_Registry::register_plugin()`,
   `Command_Interpreter_Node::register_namespace()`,
   `Bootstrap::version_at_least()`, `NEWSPACK_NODES_VERSION`.

Not frozen: any class, method, JS module, dashboard markup, SCSS, or option name
not listed above. The `@newspack-nodes/*` build aliases and the shared React
surface are stable in practice but versioned by the consumer's pinned checkout,
not by this contract.

## Deprecation policy

A frozen name is never removed in the same release that replaces it. When a better shape
arrives, the new name ships alongside the old; the old keeps working for **at
least one minor release**, marked deprecated in its docblock with its
replacement documented in [upgrading.md](upgrading.md). Removal then happens in
a later minor — deprecate in `2.11.0`, remove in `2.12.0` at the earliest —
with the fix beside it in upgrading.md.

A **major** is for a break that cannot be deprecated: a frozen name that changes
meaning rather than moving, or one whose old behaviour cannot coexist with the
new. Deleting an entity that no longer exists is not that — there is nothing to
deprecate toward, so it goes in a minor with an upgrading.md entry.

Additive change — new verbs, new nodes, new hooks, new optional arguments — is
free in any minor.

## Versioning

Semantic versioning. Patch = fixes only; minor = additive, plus the removal of
anything deprecated for at least one minor before it; major = a frozen name
breaking in place, where no deprecation window can exist. The maintenance rule
from [upgrading.md](upgrading.md) stands: any release that changes a
consumer-facing contract adds its entry there in the same commit as its
CHANGELOG entry.
