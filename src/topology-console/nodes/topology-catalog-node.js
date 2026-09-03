/**
 * The Path menu's live topology catalog: which topologies exist, how many
 * partitions each runs, and which of them the fleet spawns.
 *
 * A graph node rather than a hook holding a client of its own, because that is
 * what puts the poll inside the console's existing request. Emitting through
 * `_http` during the Router's TIMER notify lands inside that tick's lock, so
 * `topologies list` leaves in the same POST as `dump_metadata`, `uptime` and
 * `dmesg`; a standalone `fetch` would add a request per tick for one row list.
 * Batching costs nothing in routing: a batch carries whatever TO each line
 * holds, and the server routes the lines independently.
 *
 * Poll and receive in one node, the `PollerNode` shape. The base mints the
 * command on the tick — `Node.command()` stamps FROM=name, TO=target and
 * signs it — the reply comes back TO=FROM to this node's `fill()`, and
 * `publish()` turns it into the catalog. The addressing IS the correlation
 * (ADR-7); no op-id, registry or promise appears anywhere on this path.
 *
 * The verb belongs to this node; the target and the cadence belong to the
 * mounting hook, `useTopologyCatalog`.
 */

import { PollerNode } from '../../runtime/poller-node';

/**
 * Registry name the hook mounts this node under, and the address every
 * `useNodeState` subscriber reads the catalog through.
 */
export const CATALOG_NODE = 'topologies:catalog';

/**
 * The keys `Admin::register_topology_console_tab_bundle()` localizes that this
 * node reads. Every one is absent on a page that enqueued the bundle without
 * them, so each read below carries its own default.
 *
 * @typedef {Object} CatalogLocalizedData
 * @property {Object<string,number>} [topologyWorkers]     Partition count per registered topology.
 * @property {string[]}              [activeTopologies]    Topologies the fleet spawns.
 * @property {number}                [configNumPartitions] Partition count a topology inherits when it declares none.
 */

/**
 * `window` carrying the localize payload PHP writes before this bundle runs.
 *
 * @typedef {Window & {
 *     NewspackNodesData?: CatalogLocalizedData,
 * }} CatalogWindow
 */

/**
 * One row of a `topologies list` reply, as `Topologies_CI_Node::cmd_list()`
 * builds it.
 *
 * @typedef {Object} TopologyListEntry
 * @property {string}           name             Topology name.
 * @property {string}           source           Where the `.tsl` lives: `user`, `stock` or `both`.
 * @property {boolean}          active           Whether the fleet spawns it.
 * @property {number}           [num_partitions] Canonical partition count for the topology.
 * @property {Object<string,*>} [frontmatter]    The topology's frontmatter keys.
 * @property {string[]}         [includes]       Topologies this one includes directly.
 */

/**
 * What this node publishes on its `catalog` registration.
 *
 * @typedef {Object} TopologyCatalog
 * @property {Object<string,number>} partitions Partition count per topology name.
 * @property {string[]}              active     Names the fleet spawns.
 * @property {TopologyListEntry[]}   entries    The reply's rows, passed through verbatim.
 */

/**
 * Read the page-load snapshot the PHP localizer wrote — the catalog that
 * stands until the first reply lands, and the reason a cold render never shows
 * an empty Path menu.
 *
 * `entries` is empty because the localizer writes the counts and the active
 * set alone; the rows, and the `includes` the palette draws from them, arrive
 * with the first reply.
 *
 * @return {TopologyCatalog} The seed catalog.
 */
export function seedFromGlobal() {
	/** @type {CatalogLocalizedData} */
	const data =
		( typeof window !== 'undefined' &&
			/** @type {CatalogWindow} */ ( window ).NewspackNodesData ) ||
		{};
	return {
		partitions: data.topologyWorkers || {},
		active: data.activeTopologies || [],
		entries: [],
	};
}

/**
 * Reduce a `topologies list` reply to the catalog the Path menu reads.
 *
 * A row's own `num_partitions` wins, because the server resolved it through
 * `Bootstrap::num_partitions_for()` — which already applied that topology's
 * frontmatter — while the fallback knows only the site-wide config value.
 *
 * @param {TopologyListEntry[]} list              Rows from the reply.
 * @param {number}              defaultPartitions Count for a row declaring no `num_partitions`.
 * @return {TopologyCatalog} The catalog to publish.
 */
function catalogFromList( list, defaultPartitions ) {
	/** @type {Object<string,number>} */
	const partitions = {};
	const active = [];
	for ( const entry of list ) {
		partitions[ entry.name ] = entry.num_partitions || defaultPartitions;
		if ( entry.active ) {
			active.push( entry.name );
		}
	}
	// Raw entries too: the palette needs each topology's `includes`.
	return { partitions, active, entries: list };
}

/**
 * The count a row inherits when it declares none, taken from the localize
 * payload rather than hardcoded: it mirrors the substrate's `num_partitions`
 * config value, which an operator can change.
 *
 * Falls back to 1, the smallest fleet that runs at all — a menu entry
 * offering zero partitions offers nothing to select.
 *
 * @return {number} Partition count.
 */
function defaultPartitionCount() {
	return (
		( typeof window !== 'undefined' &&
			/** @type {CatalogWindow} */ ( window ).NewspackNodesData
				?.configNumPartitions ) ||
		1
	);
}

/**
 * The Path menu's catalog as a graph node: it polls `topologies list` on the
 * Router TIMER and publishes the parsed result on its `catalog` registration,
 * seeded from the page-load localize payload so the menu is populated before
 * the first reply lands.
 */
export class TopologyCatalogNode extends PollerNode {
	/**
	 * Ask `list`, and publish the localized seed immediately so a subscriber
	 * mounting before the first reply still renders a catalog.
	 */
	constructor() {
		super();
		this.verb = 'list';
		/**
		 * Signature of the last published catalog. An identical reply is
		 * dropped rather than republished, because `setState` notifies every
		 * subscriber: a fresh object identity each poll would re-render the
		 * console and rebuild its path options for no change.
		 *
		 * @type {?string}
		 */
		this.lastSig = null;
		this.setState( 'catalog', seedFromGlobal() );
	}

	/**
	 * Parse a `topologies list` reply and publish it on the `catalog`
	 * registration, skipping a reply identical to the last one. A malformed
	 * body keeps the last-good catalog — a transient error must not blank the
	 * Path menu, which is the whole reason this polls rather than loads.
	 *
	 * An empty `topologies` array is not malformed and does apply, collapsing
	 * the menu: a site whose last topology was deleted has none.
	 *
	 * @param {*} body The unwrapped reply body.
	 */
	publish( body ) {
		if ( ! body || ! Array.isArray( body.topologies ) ) {
			return;
		}
		const next = catalogFromList(
			body.topologies,
			defaultPartitionCount()
		);
		const sig = JSON.stringify( next );
		if ( sig === this.lastSig ) {
			return;
		}
		this.lastSig = sig;
		this.setState( 'catalog', next );
	}

	/**
	 * Console-palette entry. Hidden console infrastructure: it accepts no
	 * `fill()` from the graph — only its own command reply — and takes no
	 * positional configuration.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			...PollerNode.nodeSchema(),
			description:
				'Polls `topologies list` and publishes the Path menu catalog.',
			registrations: [ 'catalog' ],
		};
	}
}
