import {
	SchemaReflection,
	TeeNode,
	TYPE,
	TO,
	VALUE,
	TM_ERROR,
} from '@newspack-nodes/runtime';

/**
 * CurrentNode — a slice's gate, `<receiver>:current`: a Tee that passes only
 * a reply its Fetcher `answers()`, so the late answer to a replaced question
 * never renders. A refusal goes to the view itself, around any transform,
 * because the view owns the error state, when it refuses a standing ask or
 * echoes no arguments to judge by, as the Router's bare `NOT_AVAILABLE` does.
 * `addSliceFetcher` builds one per slice.
 */
export class CurrentNode extends SchemaReflection( TeeNode ) {
	/** Nothing named yet; the `arguments` walk fills both. */
	constructor() {
		super();
		/** @type {string} The Fetcher whose outbox says what is asked. */
		this.fetcher = '';
		/** @type {string} The view a refusal goes to. */
		this.view = '';
	}

	/**
	 * Forward an answer to a standing ask; send a refusal of one to the view,
	 * as every refusal echoing no arguments goes; count and drop any other.
	 *
	 * @param {Array} message A reply.
	 */
	fill( message ) {
		const echoes = Array.isArray( message[ VALUE ]?.arguments );
		const current = this.registry.node( this.fetcher )?.answers( message );
		if ( 0 !== ( message[ TYPE ] & TM_ERROR ) && ( ! echoes || current ) ) {
			this.counter++;
			const to = message[ TO ];
			message[ TO ] = to ? `${ this.view }/${ to }` : this.view;
			this.sink.fill( message );
			return;
		}
		if ( ! current ) {
			this.counter++;
			return;
		}
		super.fill( message );
	}

	/**
	 * Hidden: a slice builder wires it, an operator does not.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Passes only the answer to a standing ask.',
			arguments: [
				{ name: 'fetcher', type: 'string', required: true },
				{ name: 'view', type: 'string', required: true },
			],
			commands: [],
		};
	}
}
