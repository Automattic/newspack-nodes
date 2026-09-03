/**
 * NodeRegistry — the name→node table a graph addresses itself through.
 *
 * The rest of the per-process state lives in Core (clock, rate-limited stderr,
 * generation counters, teardown), which keeps one registry as the default every
 * node registers in. Perl draws the same line — `%Tachikoma::Nodes` is the
 * table, `$Tachikoma::Now` is not — and Tachikoma's answer to a second
 * namespace is a Job: a second process, hence a second table. What isolates a
 * namespace is the table, not the clock, so that is the only part worth a
 * second copy.
 *
 * A node holds the registry it belongs to (`Node#registry`, defaulting to
 * Core's). An interpreter that owns one gives it to the nodes it makes, and
 * those nodes are then invisible to every other registry — which is what lets
 * an edit buffer hold a `firehose` while the live graph holds a different one.
 */
export class NodeRegistry {
	/**
	 * Creates an empty table.
	 *
	 * `nodes` is public and iterated directly by callers. Its insertion order
	 * is the order `dump_config` writes, which is why `renameNode` rebuilds
	 * the Map rather than deleting and re-inserting.
	 */
	constructor() {
		/** @type {Map<string,Object>} Nodes by name, in insertion order. */
		this.nodes = new Map();
	}

	/**
	 * The node registered under `name`.
	 *
	 * @param {string} name Node name.
	 * @return {?Object} The node, or null — `Map.get`'s undefined normalized
	 *                   here, so every caller's `null !==` test holds.
	 */
	node( name ) {
		return this.nodes.get( name ) ?? null;
	}

	/**
	 * Add a node under a name this table does not already hold.
	 *
	 * A collision throws rather than overwriting, which would leave the
	 * displaced node holding its sinks and timers while nothing can address
	 * it. `Node`'s name setter runs the same check first, so a caller can
	 * refuse in its own voice before reaching here.
	 *
	 * @param {string} name Node name.
	 * @param {Object} node The node.
	 */
	registerNode( name, node ) {
		if ( this.nodes.has( name ) ) {
			throw new Error(
				`node name collision: ${ name } already registered`
			);
		}
		this.nodes.set( name, node );
	}

	/**
	 * Rename in place, keeping the node's POSITION in the table.
	 *
	 * A delete-then-insert would move it to the end, and the table's order is
	 * the order `dump_config` writes — so a rename would rewrite the whole
	 * file instead of one line.
	 *
	 * The rebuild trusts its caller both ways: a `from` this table does not
	 * hold changes nothing, and a `to` it already holds collapses two entries
	 * into one, dropping a node. `Node`'s name setter checks that `to` is free
	 * before it calls.
	 *
	 * @param {string} from Current name.
	 * @param {string} to   New name.
	 */
	renameNode( from, to ) {
		const entries = [ ...this.nodes ];
		this.nodes.clear();
		for ( const [ name, node ] of entries ) {
			this.nodes.set( name === from ? to : name, node );
		}
	}

	/**
	 * Free a name; one this table does not hold is a no-op.
	 *
	 * The node itself is untouched — sink, target, timers and registrations
	 * all stand. Tearing it down as well is `Node#removeNode()`, which clears
	 * those references and drops the name last.
	 *
	 * @param {string} name Node name.
	 */
	unregisterNode( name ) {
		this.nodes.delete( name );
	}
}
