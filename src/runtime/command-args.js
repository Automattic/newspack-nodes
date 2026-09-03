/**
 * The browser half of the one command-argument grammar, mirroring PHP
 * `Newspack_Nodes\Command_Args`. A command's `arguments` are a flat token array
 * end to end: required values ride positionally in the order the verb declares,
 * optional ones are named `--key=value`, a boolean flag is a bare `--key`, and a
 * list is comma-separated inside one value. A dashboard mints a command with
 * formatCommandArgs() and a PHP verb parses those same tokens, so the two
 * implementations must agree; no fixture pins them, and the jest suite mirrors
 * `tests/unit/CommandArgsTest.php` case for case.
 *
 * Nothing here quotes or unescapes. Token boundaries are the array's, so a value
 * carrying spaces — a .tsl body, a layout positions JSON — stays whole inside its
 * own element, and quoting waits for serializeArg() in `runtime/node.js`, the one
 * place tokens re-join into a line.
 */

/**
 * Classify a pre-split token list. A `--key=value` token becomes
 * `options[key] = 'value'`, a bare `--key` becomes `options[key] = true`, and
 * every other token is a positional, in order. Only the first `=` splits, so
 * `--expr=a=b` carries the value `a=b`. A named value stays a STRING:
 * `--enabled=false` reads back as `'false'`, which is truthy.
 *
 * @param {string[]} [args] Pre-split tokens; a missing list reads as empty.
 * @return {{positional: string[], options: Record<string,string|true>}}
 *     Positionals in arrival order, plus the named options.
 */
export function parseCommandArgs( args ) {
	const positional = [];
	/** @type {Record<string,string|true>} */
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
 * Build the token list parseCommandArgs() reads back: `true` renders as a bare
 * `--key`, `false` as `--key=false`, an array as its comma-joined members, and
 * every other value as its string cast.
 *
 * `false` rides explicitly because the bare form already means true and an
 * omitted option leaves the verb's own default standing, which for a default-on
 * setting is the opposite of what the caller asked for.
 *
 * @param {Array<string|number>} [positional] Values for the required tokens.
 * @param {Object}               [options]    Named options, keyed by name.
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
			// true left above as a bare `--key`, so only false reaches here.
			value = 'false';
		} else {
			value = String( raw );
		}
		tokens.push( `--${ key }=${ value }` );
	}
	return tokens;
}
