/**
 * command-args — the shared Tachikoma-style argument grammar, mirroring PHP
 * Newspack_Nodes\Command_Args. Service interpreters take normal commands with
 * arguments: required tokens positional, optional named args as `--key=value`,
 * boolean flags as bare `--key`, lists comma-separated inside one value, and
 * values with spaces double-quoted. Callers build the string with
 * formatCommandArgs(); the server verb parses it. format() round-trips parse().
 *
 * Structured blobs (a .tsl body, a positions JSON) do NOT ride here — those
 * verbs take `<name> <blob>` and split the rest-of-line themselves.
 */

/**
 * Parse a Tachikoma-style argument string into { positional, options }.
 *
 * @param {string} args
 * @return {{ positional: string[], options: Object }} Positionals in order, plus an options map.
 */
export function parseCommandArgs( args ) {
	const positional = [];
	const options = {};
	for ( const tok of tokenize( String( args ?? '' ) ) ) {
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
 * Inverse of parseCommandArgs(): build a canonical argument string. Boolean
 * true renders as a bare `--key`; false as `--key=false`; arrays comma-joined;
 * scalars stringified. Values with whitespace/quote/backslash or empty are
 * double-quoted (escaping `"` and `\`).
 *
 * @param {Array}  [positional]
 * @param {Object} [options]
 * @return {string} The canonical argument string.
 */
export function formatCommandArgs( positional = [], options = {} ) {
	const parts = [];
	for ( const p of positional ) {
		parts.push( quoteIfNeeded( String( p ) ) );
	}
	for ( const [ key, raw ] of Object.entries( options ) ) {
		if ( true === raw ) {
			parts.push( `--${ key }` );
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
		parts.push( `--${ key }=${ quoteIfNeeded( value ) }` );
	}
	return parts.join( ' ' );
}

/**
 * Whitespace-split respecting double quotes and `\` escapes inside them.
 *
 * @param {string} args
 * @return {string[]} The tokens, quotes/escapes resolved.
 */
function tokenize( args ) {
	const tokens = [];
	let current = '';
	let hasTok = false;
	let inQuote = false;
	let escaped = false;
	for ( const ch of args ) {
		if ( escaped ) {
			current += ch;
			escaped = false;
			continue;
		}
		if ( inQuote && '\\' === ch ) {
			escaped = true;
			continue;
		}
		if ( '"' === ch ) {
			inQuote = ! inQuote;
			hasTok = true;
			continue;
		}
		if ( ! inQuote && /\s/.test( ch ) ) {
			if ( hasTok ) {
				tokens.push( current );
				current = '';
				hasTok = false;
			}
			continue;
		}
		current += ch;
		hasTok = true;
	}
	if ( hasTok ) {
		tokens.push( current );
	}
	return tokens;
}

/**
 * Double-quote a value that would otherwise tokenize wrong (whitespace, quote,
 * backslash, or empty), escaping `\` then `"`.
 *
 * @param {string} value
 * @return {string} The value, double-quoted only when it needs it.
 */
function quoteIfNeeded( value ) {
	if ( '' === value || /[\s"\\]/.test( value ) ) {
		return `"${ value.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ) }"`;
	}
	return value;
}
