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

export class CompletionNode extends Node {
	constructor() {
		super();
		this.registrations.candidates = {};
		this._seq = 0;
	}

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

	fill( message ) {
		this.counter += 1;
		const value = message[ VALUE ];
		// Reply VALUE is `{ name, payload }`; the candidate list is the payload.
		let text =
			value && typeof value === 'object' ? value.payload ?? '' : value;
		if ( typeof text !== 'string' ) {
			text = '';
		}
		const candidates = text
			.split( '\n' )
			.map( ( line ) => line.trim() )
			.filter( ( line ) => '' !== line );
		this._seq += 1;
		this.setState( 'candidates', { candidates, seq: this._seq } );
	}
}
