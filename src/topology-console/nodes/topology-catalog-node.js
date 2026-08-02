/**
 * TopologyCatalogNode — the Path menu's live topology catalog, as a graph node.
 *
 * It was a React hook calling `getCommandClient().send()`, which is a standalone
 * `fetch` outside the graph: its own POST every tick, alongside the batched one
 * the console already sends. A node emitting through `_http` during the Router's
 * TIMER notify rides the SAME lock, so `topologies list` now travels in the same
 * request as `dump_metadata` / `uptime` / `dmesg`. A batch carries whatever TO
 * each line holds — the server routes them independently.
 *
 * Poll + receive in one node, the MetadataNode shape: `fire()` mints the command
 * (Node.command stamps FROM=name, TO=target and signs it), the reply comes back
 * TO=FROM, and `fill()` publishes the parsed catalog via setState.
 */

import { TimerNode } from '../../runtime/timer-node';
import { VALUE } from '../../runtime/message';

export const CATALOG_NODE = 'topologies:catalog';

/**
 * The page-load snapshot the PHP localizer wrote — the seed before any reply.
 *
 * @return {Object} `{ partitions, active, entries }`.
 */
export function seedFromGlobal() {
	const data =
		( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
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
			window.NewspackNodesData?.configNumPartitions ) ||
		1
	);
}

export class TopologyCatalogNode extends TimerNode {
	// Hardwired console infrastructure; Reset-Graph must not see it as added.
	static isSystemNode = true;

	constructor() {
		super();
		// Last published signature; an identical reply is a no-op.
		this.lastSig = null;
		this.setState( 'catalog', seedFromGlobal() );
	}

	// @longform
	// Reply leg. Malformed keeps last-good: a transient error must not blank
	// the Path menu, which is the whole reason this polls rather than loads.
	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		const body = value?.payload ?? value;
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

	// Router TIMER subscriber; emits via sink into `_http`, inside the lock.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		const m = this.command( 'list' );
		if ( m ) {
			this.counter++;
			this.sink.fill( m ); // else unauthenticated; the next tick carries it
		}
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			accepts_fill: false,
			description:
				'Polls `topologies list` and publishes the Path menu catalog.',
			arguments: [],
			commands: [],
			registrations: [ 'catalog', 'FIRE' ],
		};
	}
}
