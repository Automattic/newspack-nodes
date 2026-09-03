/**
 * The `_completion` node: turns a tab-completion reply into the candidate list
 * the REPL input completes against.
 *
 * `useCompletion` mints the `help` / `ls` query on this node, so FROM is
 * `_completion`, the interpreter answers TO=FROM, and `_router` peels that name
 * and delivers here — the addressing is the correlation (ADR-7), and nothing
 * keys off KEY. `KEY='completion'` belongs to the REQUEST instead: it is what
 * makes `help` and `ls` answer with a bare newline-separated candidate list
 * rather than their tabulated human output. `fill()` splits that payload and
 * publishes `{ candidates, seq }` on the `candidates` slot, which the input
 * reads through `useNodeState( '_completion', 'candidates' )`.
 */

import { Node } from './node';
import { VALUE, payloadOf } from './message';

/**
 * Longest common prefix of a list of strings — what the first Tab extends the
 * input to, so completion stops where the candidates stop agreeing.
 *
 * @param {string[]} strings Candidate strings.
 * @return {string} The longest prefix shared by every string ('' if none).
 */
export function longestCommonPrefix( strings ) {
	if ( ! strings || 0 === strings.length ) {
		return '';
	}
	let prefix = strings[ 0 ];
	for ( let i = 1; i < strings.length; i++ ) {
		const s = strings[ i ];
		let j = 0;
		while ( j < prefix.length && j < s.length && prefix[ j ] === s[ j ] ) {
			j++;
		}
		prefix = prefix.slice( 0, j );
		if ( '' === prefix ) {
			break;
		}
	}
	return prefix;
}

/**
 * Lay candidates out as a single space-padded line whose columns align when the
 * transcript reflows: each candidate is padded to the longest candidate's width
 * and joined with a 2-space gap, so wrapping at whitespace (see the
 * `.topology-repl__entry` CSS — `overflow-wrap`, not `break-all`) lands every
 * column on a fixed character grid. The in-browser, panel-width-responsive
 * equivalent of the interpreter's tabulate() (the PHP / Tachikoma `help` grid).
 *
 * @param {string[]} candidates The candidates to lay out; an empty or absent
 *                              list yields ''.
 * @return {string} The aligned, gap-joined row (no trailing padding).
 */
export function tabulateCandidates( candidates ) {
	const list = candidates || [];
	if ( 0 === list.length ) {
		return '';
	}
	const width = Math.max( ...list.map( ( c ) => c.length ) );
	return list
		.map( ( c ) => c.padEnd( width ) )
		.join( '  ' )
		.replace( /\s+$/, '' );
}

/**
 * Owns the `candidates` state slot the REPL input subscribes to, and the `seq`
 * stamped on every publication.
 *
 * `ReplFooter` records the `seq` it applied and acts only on a newer one, so a
 * second Tab on the same token completes again even though the candidate list
 * is identical, while a re-render over the reply it already applied does not.
 */
export class CompletionNode extends Node {
	/**
	 * Opens the `candidates` registration slot and starts the sequence at zero.
	 * `nodeSchema()` declares no `registrations`, so `seedRegistrations()` opens
	 * nothing, and `register()` refuses an event nobody seeded: seeding here is
	 * what lets a `register` verb subscribe to the channel. The React hook needs
	 * no help — `useNodeEvent()` declares the event it subscribes to.
	 */
	constructor() {
		super();
		this.registrations.candidates = {};
		this._seq = 0;
	}

	/**
	 * Publish the candidates carried by a completion reply. The reply VALUE is
	 * either the bare newline-separated candidate text or a `{ name, payload }`
	 * envelope whose payload holds it; blank lines are dropped, and a shape that
	 * is neither publishes an empty list rather than throwing on the delivery
	 * path.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		let text = payloadOf( value );
		if ( typeof text !== 'string' ) {
			text = '';
		}
		const candidates = text
			.split( '\n' )
			.map( ( line ) => line.trim() )
			.filter( ( line ) => '' !== line );
		this._seq++;
		this.setState( 'candidates', { candidates, seq: this._seq } );
	}

	/**
	 * Console-palette entry. Hidden because the REPL graph wires this node
	 * itself; it takes no arguments and exposes no commands.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Receives tab-completion reply; publishes candidates.',
			// A terminal: candidates leave through setState, not a sink.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
