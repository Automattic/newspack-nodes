/**
 * command-args — the shared Tachikoma-style argument grammar, mirroring PHP
 * Newspack_Nodes\Command_Args. Service interpreters take normal commands with
 * arguments as a token array: required tokens positional, optional named args
 * as `--key=value`, boolean flags as bare `--key`, lists comma-separated inside
 * one value. Callers build the token list with formatCommandArgs(); the server
 * verb parses it. format() round-trips parse(). No quoting — token boundaries
 * are the array's; the serialization anchor (serializeTsl) quotes when it must
 * materialize tokens back to a single line.
 */

/**
 * Classify a pre-split token list into { positional, options }.
 *
 * @param {string[]} args
 * @return {{ positional: string[], options: Object }} Positionals in order, plus an options map.
 */
export function parseCommandArgs( args ) {
	const positional = [];
	const options = {};
	for ( const tok of args || [] ) {
		if ( tok.startsWith( '--' ) ) {
			const body = tok.slice( 2 );
			const eq = body.indexOf( '=' );
			if ( -1 === eq ) {
				options[ body ] = true;
			} else {
				options[ body.slice( 0, eq ) ] = body.slice( eq + 1 );
			}
			continue;
		}
		positional.push( tok );
	}
	return { positional, options };
}

/**
 * Inverse of parseCommandArgs(): build the token list. Boolean true renders as
 * a bare `--key`; false as `--key=false`; arrays comma-joined; scalars
 * stringified. No quoting — a spaced value stays inside one token.
 *
 * @param {Array}  [positional]
 * @param {Object} [options]
 * @return {string[]} The token list.
 */
export function formatCommandArgs( positional = [], options = {} ) {
	const tokens = positional.map( ( p ) => String( p ) );
	for ( const [ key, raw ] of Object.entries( options ) ) {
		if ( true === raw ) {
			tokens.push( `--${ key }` );
			continue;
		}
		let value;
		if ( Array.isArray( raw ) ) {
			value = raw.join( ',' );
		} else if ( 'boolean' === typeof raw ) {
			value = raw ? 'true' : 'false';
		} else {
			value = String( raw );
		}
		tokens.push( `--${ key }=${ value }` );
	}
	return tokens;
}
