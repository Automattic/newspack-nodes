/**
 * Build entry for the `build/event-dashboards` bundle. The DevTools hub
 * enqueues it with the page rather than lazily on first tab activation, as it
 * does for Vault and the Console: the Overview tab registers at order 0, so it
 * is what the hub paints first and there is no activation to wait for.
 *
 * Both imports run for their side effects alone. `./nodes/register` adds this
 * bundle's view and transform classes to `CommandInterpreterNode`'s name
 * table, which TSL and the console palette resolve `make_node` against; a hook
 * builds its own graph from the exported class instead, because that table is
 * a per-bundle static (ADR-16). `./tabs` registers the five hub tabs —
 * Overview, Jobs, Partition Viewer, Log Viewer and Config Audit. Nothing here
 * mounts React; the hub shell renders whichever tab is selected.
 */

import './nodes/register';
import './tabs';
