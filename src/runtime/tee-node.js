import { Node } from './node';
import { TO } from './message';

/**
 * TeeNode — fan-out: every connected target gets its own copy of each message.
 *
 * `target` holds a LIST here rather than the base class's single path, which is
 * what makes `connect_node` append instead of replace. Each copy is addressed
 * to `<target>/<TO>` — bare `<target>` when TO is empty — so a fan-out can sit
 * mid-path and each branch still routes down whatever path remains.
 *
 * Fan-out follows CONNECT order, and that is contractual: a consumer may
 * depend on an earlier target having been fully delivered — synchronously,
 * through Router — before a later one is. `addSliceFetcher` does exactly that,
 * fanning a reply to the view before the Fetcher that settles the ask.
 *
 * Targets are pruned on every fill against THIS node's registry: a draft graph's
 * nodes are invisible to any other registry, so resolving elsewhere would read
 * every edge as dead and drop it. A target that throws is logged and the
 * fan-out continues, so one broken branch cannot silence the others.
 */
export class TeeNode extends Node {
	/**
	 * Start from an empty target list — the fan-out shape `connectNode` appends
	 * to, in place of the base class's single target path.
	 */
	constructor() {
		super();
		this.target = [];
	}

	/**
	 * Copy the message to every live target, addressing each copy so Router
	 * carries it down the rest of the path.
	 *
	 * @param {Array} message The 7-field positional message; each target gets its own copy.
	 */
	fill( message ) {
		this.counter++;
		const to = message[ TO ];
		const targets = Array.isArray( this.target ) ? this.target : [];
		// Prune dead heads in THIS registry, or a draft loses every edge.
		const alive = targets.filter(
			( t ) => null !== this.registry.node( t.split( '/' )[ 0 ] )
		);
		this.target = alive;
		for ( const t of alive ) {
			if ( ! this.sink ) {
				throw new Error( 'fill requires a wired sink' );
			}
			try {
				const copy = message.slice();
				copy[ TO ] = '' === to ? t : `${ t }/${ to }`;
				this.sink.fill( copy );
			} catch ( e ) {
				this.printLessOften(
					`WARNING: target ${ t } threw: ${ e.message }`
				);
			}
		}
	}

	/**
	 * Append a fan-out target, promoting a single-path `target` to a list first
	 * (`removeNode` resets it to the empty string). A repeat connect is ignored.
	 *
	 * @param {string} owner Node name or path each message is copied to.
	 */
	connectNode( owner ) {
		if ( ! Array.isArray( this.target ) ) {
			this.target = '' === this.target ? [] : [ this.target ];
		}
		if ( ! this.target.includes( owner ) ) {
			this.target.push( owner );
		}
	}

	/**
	 * Drop one fan-out target and leave the rest connected. A `target` that is
	 * not a list yet holds nothing to prune, so it becomes the empty list.
	 *
	 * @param {string} [target] Target path to remove.
	 */
	disconnectNode( target = '' ) {
		if ( ! Array.isArray( this.target ) ) {
			this.target = [];
			return;
		}
		this.target = this.target.filter( ( t ) => t !== target );
	}

	/**
	 * Console-palette entry. Routing node with no positional configuration.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Routing',
			description:
				'Fan-out: copies each message to multiple targets via Router.',
			arguments: [],
			commands: [],
			accepts_fill: true,
			has_target: true,
		};
	}
}
