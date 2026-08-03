/**
 * NodeRegistry — the name→node table.
 *
 * Split out of Core, which was two things wearing one name: this table, and
 * process state (clock, rate-limited stderr, generation counters, teardown).
 * Perl has the same seam — `%Tachikoma::Nodes` is the table, `$Tachikoma::Now`
 * is not — and Tachikoma's answer to a second namespace is a Job: a second
 * process, hence a second table. What isolates a namespace is the table, not
 * the clock, so that is the only part worth a second copy.
 *
 * A node holds the registry it belongs to (`Node#registry`, defaulting to
 * Core's). An interpreter that owns one gives it to the nodes it makes, and
 * those nodes are then invisible to every other registry — which is what lets
 * an edit buffer hold a `firehose` while the live graph holds a different one.
 */
export class NodeRegistry {
	constructor() {
		this.nodes = new Map();
	}

	/**
	 * @param {string} name Node name.
	 * @return {?Object} The node, or null — never undefined.
	 */
	node( name ) {
		return this.nodes.get( name ) ?? null;
	}

	/**
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
	 * @param {string} name Node name.
	 */
	unregisterNode( name ) {
		this.nodes.delete( name );
	}
}
