/**
 * TopologyCatalogNode — the Path menu's live topology catalog, as a graph node.
 *
 * It was a React hook calling a one-shot client, which is a standalone
 * `fetch` outside the graph: its own POST every tick, alongside the batched one
 * the console already sends. A node emitting through `_http` during the Router's
 * TIMER notify rides the SAME lock, so `topologies list` now travels in the same
 * request as `dump_metadata` / `uptime` / `dmesg`. A batch carries whatever TO
 * each line holds — the server routes them independently.
 *
 * Poll + receive in one node, the PollerNode shape: the base mints the command
 * on the tick (Node.command stamps FROM=name, TO=target and signs it), the
 * reply comes back TO=FROM, and `publish()` turns it into the catalog.
 */

import { PollerNode } from '../../runtime/poller-node';

export const CATALOG_NODE = 'topologies:catalog';

/**
 * The keys `Admin::register_topology_console_tab_bundle()` localizes that this
 * node reads. Every one is absent on a page that enqueued the bundle without
 * them, so each read below carries its own default.
 *
 * @typedef {Object} CatalogLocalizedData
 * @property {Object<string, number>} [topologyWorkers]     Partition count per registered topology.
 * @property {string[]}               [activeTopologies]    Topologies the fleet spawns.
 * @property {number}                 [configNumPartitions] Partition count a topology inherits when it declares none.
 */

/**
 * `window` carrying the localize payload PHP writes before this bundle runs.
 *
 * @typedef {Window & {
 *     NewspackNodesData?: CatalogLocalizedData,
 * }} CatalogWindow
 */

/**
 * The page-load snapshot the PHP localizer wrote — the seed before any reply.
 *
 * @return {Object} `{ partitions, active, entries }`.
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
 * Map a topologies.list entry to catalog shape; num_partitions authoritative.
 *
 * @param {Array}  list              Raw `topologies list` entries.
 * @param {number} defaultPartitions Count for an entry omitting num_partitions.
 * @return {Object} `{ partitions, active, entries }`.
 */
function catalogFromList( list, defaultPartitions ) {
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
	 * Poll `topologies list`, and publish the localized seed immediately so a
	 * subscriber mounting before the first reply still renders a catalog.
	 */
	constructor() {
		super();
		this.verb = 'list';
		// Last published signature; an identical reply is a no-op.
		this.lastSig = null;
		this.setState( 'catalog', seedFromGlobal() );
	}

	/**
	 * Parse a `topologies list` reply and publish it on the `catalog`
	 * registration, skipping a reply identical to the last one. A malformed
	 * body keeps the last-good catalog — a transient error must not blank the
	 * Path menu, which is the whole reason this polls rather than loads.
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
