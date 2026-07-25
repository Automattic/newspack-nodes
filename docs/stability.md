# Stability Contract

What 1.0 means: the names below are **frozen** — code written against them keeps
working across every 1.x release. Everything else is internal and may change in
any release without notice.

## Frozen surfaces

1. **The node contract.** `fill( array $message ): void`, `sink`, `target`,
   `stamp_message()`, `register()` / `notify()` / `set_state()`, `arguments()`,
   `node_schema()` — the shapes [ADR-1](architecture-decisions.md#adr-1-uniform-fill-contract),
   [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies),
   [ADR-11](architecture-decisions.md#adr-11-make_node-construction-sequence) pin.
2. **The message.** The 7-field positional layout (`Message::TYPE … VALUE`), the
   `TM_*` type flags, and the positional-JSON wire format (`packed()` /
   `unpacked()`) — [ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array).
   On-disk Partition segments written by any 1.x remain readable by every later 1.x.
3. **TSL.** The statement grammar (`Shell_Node::parse_statements()` semantics),
   the stock verbs (`make_node`, `connect_node`, `disconnect_node`, `remove_node`,
   `command_node` (alias `cmd`), `var`, `include`), and `<config:KEY>` token
   resolution. A `.tsl` that
   loads on 1.0 loads on every 1.x.
4. **Stock node types.** The registered names and documented constructor-argument
   shapes (`node_schema()` is the authority) of every node the palette lists.
5. **CLI.** The `wp nodes` verbs and their documented arguments and output
   contracts (`--format=json` shapes included).
6. **REST.** The three routes (`/workers/spawn`, `/command`, `/messages/stream`)
   and their envelope shapes ([API.md](API.md)).
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

A frozen name is never removed or re-shaped inside 1.x. When a better shape
arrives, the new name ships alongside the old; the old keeps working for **at
least one minor release**, marked deprecated in its docblock with its
replacement documented in [upgrading.md](upgrading.md). Removal happens only in
the next major, with the fix beside it in upgrading.md.

Additive change — new verbs, new nodes, new hooks, new optional arguments — is
free in any minor.

## Versioning

Semantic versioning. Patch = fixes only; minor = additive; major = the only
place a frozen name may break. The maintenance rule from
[upgrading.md](upgrading.md) stands: any release that changes a consumer-facing
contract adds its entry there in the same commit as its CHANGELOG entry.
