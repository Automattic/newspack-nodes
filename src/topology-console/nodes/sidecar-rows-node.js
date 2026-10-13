import { MetadataNode, parseMetadata } from '../../runtime/metadata-node';

/** The `dump_metadata` flag asking for each node and the sidecars it lists. */
export const OWNED_FLAG = '-o';

/**
 * The console's one sidecar poller: `dump_metadata -o`, asking for each owner
 * the console shows and the sidecars it lists by the owner's name alone, so
 * no ask grows with an owner's sidecars. It keeps its rows by name across a
 * change of owners.
 *
 * The canvas's `_metadata` asks for the whole graph, so it holds nothing per
 * name; this node does, because a grid opening over a shown sidecar asks for
 * another owner and must not blank the rows an answer already holds.
 */
export class SidecarRowsNode extends MetadataNode {
	/**
	 * Start answering nothing: no name is answered before a reply about it.
	 */
	constructor() {
		super();
		/**
		 * The names the raw map answers, each answered whether its row came
		 * back or not: every owner asked, and every sidecar it lists.
		 *
		 * @type {string[]}
		 */
		this.answered = [];
	}

	/**
	 * Take a reply, which answers every owner asked and each sidecar its row
	 * lists: the rows that came back, and for the rest, that none did.
	 *
	 * @param {*} meta The unwrapped payload.
	 */
	publish( meta ) {
		const held = this.rawMap;
		super.publish( meta );
		if ( this.rawMap !== held ) {
			this.answered = this.covered( ownersOf( this.pollArgs ) );
		}
	}

	/**
	 * Ask about other owners, keeping every row the last answer holds for an
	 * owner still asked or a sidecar its row lists, until the next answer
	 * replaces it, and dropping the rest; `snapshot` stands, so the rates
	 * sample no rebuilt graph.
	 *
	 * @param {string[]} args    `-o` and the owners to ask about.
	 * @param {?string}  subject What it asks about, ridden on FROM.
	 */
	ask( args, subject ) {
		const kept = new Set( this.covered( ownersOf( args ) ) );
		this.answered = this.answered.filter( ( name ) => kept.has( name ) );
		super.ask( args, subject );
		if ( null === this.rawMap ) {
			return;
		}
		this.rawMap = Object.fromEntries(
			Object.entries( this.rawMap ).filter( ( [ name ] ) =>
				kept.has( name )
			)
		);
		this.setField( 'metadata', parseMetadata( this.rawMap ) );
	}

	/**
	 * The names an answer about `owners` speaks for: each owner, and each
	 * sidecar its row in the raw map lists.
	 *
	 * @param {string[]} owners The owners asked about.
	 * @return {string[]} The names covered.
	 */
	covered( owners ) {
		const listed = owners.flatMap( ( owner ) =>
			( this.rawMap?.[ owner ]?.sidecars ?? [] ).map( ( c ) => c.name )
		);
		return [ ...owners, ...listed ];
	}
}

/**
 * The owners an ask names, past its flag.
 *
 * @param {string[]} args The poll's argument tokens.
 * @return {string[]} The owner names.
 */
function ownersOf( args ) {
	return args.filter( ( a ) => OWNED_FLAG !== a );
}
