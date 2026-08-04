/**
 * Completion — the `_completion` node. `_router` delivers the `help`/`ls`
 * completion reply (KEY='completion') here; the node splits the bare
 * newline-separated candidate payload into an array and publishes it as
 * `{ candidates, seq }` ( useNodeState( '_completion', 'candidates' ) ). The
 * `seq` increments on every fill so an identical candidate list still
 * notifies the subscriber (the ReplFooter must re-apply LCP per Tab).
 */

import { Node } from './node';
import { VALUE } from './message';

/**
 * Longest common prefix of a list of strings. Pure helper.
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
 * @param {string[]} candidates
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
 * The `_completion` node: owns the `candidates` state slot the ReplFooter
 * subscribes to, and the `seq` counter that makes a repeated candidate list
 * still notify that subscriber.
 */
export class CompletionNode extends Node {
	/**
	 * Seeds the `candidates` registration slot by hand — `nodeSchema()`
	 * declares no `registrations`, so `seedRegistrations()` leaves none — and
	 * starts the notification sequence at zero.
	 */
	constructor() {
		super();
		this.registrations.candidates = {};
		this._seq = 0;
	}

	/**
	 * Publish the candidates carried by a completion reply. The reply VALUE is
	 * either the bare newline-separated candidate text or a `{ name, payload }`
	 * object whose payload holds it; any other shape publishes an empty list.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		// Reply VALUE is `{ name, payload }`; candidate list is the payload.
		let text =
			value && typeof value === 'object' ? value.payload ?? '' : value;
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
			// Receives the reply and publishes candidates; never forwards.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
