/**
 * The browser half of the one command-argument grammar, mirroring PHP
 * `Newspack_Nodes\Command_Args::format()`. A command's `arguments` are a flat
 * token array end to end: each argument rides by position, in the order the
 * verb declares, or named as `--key=value`, and a boolean flag is a bare
 * `--key`. A dashboard mints the tokens here and the PHP interpreter binds them
 * against the verb's declared `args` before its handler runs, so a handler
 * reads each argument by name.
 *
 * Nothing here quotes or unescapes. Token boundaries are the array's, so a value
 * carrying spaces — a .tsl body, a layout positions JSON — stays whole inside its
 * own element, and quoting waits for serializeArg() in `runtime/node.js`, the one
 * place tokens re-join into a line.
 */

/**
 * Build a command's token list: `true` renders as a bare `--key`, `false` as
 * `--key=false`, an array as its comma-joined members, and every other value
 * as its string cast.
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
