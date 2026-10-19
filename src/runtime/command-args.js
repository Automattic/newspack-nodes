/**
 * The browser half of the one command-argument grammar, mirroring PHP
 * `Newspack_Nodes\Command_Args::format()`. A command's `arguments` are a flat
 * token array end to end: each argument rides by position, in the order the
 * verb declares, or named as `--key=value`, and a boolean flag is a bare
 * `--key`. A dashboard mints the tokens here and the PHP interpreter binds them
 * against the verb's declared `args` before its handler runs, so a handler
 * reads each argument by name.
 *
 * `bindCommandArgs()` is the other direction, PHP `Command_Args::bind()` for a
 * verb of string args, which a browser node binding its own verb reads.
 *
 * Nothing here quotes or unescapes. Token boundaries belong to the array, so a value
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

/**
 * Bind a verb's tokens against its declared string `args`, as PHP
 * `Command_Args::bind()` binds them, and held to it by
 * `tests/fixtures/add-source-args.json`: each arg by position, in declared
 * order, or as `--name=value`, the two forms mixed. A blank token for a
 * required arg reads as absent, and an absent arg binds null. Only PHP
 * reads types, defaults, `variadic` and `secret`: every value binds as
 * the string it is.
 *
 * @param {Array<{name:string,required?:boolean}>} specs  The verb's `args`.
 * @param {string[]}                               tokens Its tokens.
 * @return {Object<string,?string>} Arg name => value, in declared order.
 * @throws {Error} In PHP's words: an unknown option, a name given twice or
 *   both by position and by name, a surplus positional, a bare flag, or a
 *   missing required arg.
 */
export function bindCommandArgs( specs, tokens ) {
	const given = new Map();
	const named = new Set();
	const count = tokens.filter( ( t ) => ! t.startsWith( '--' ) ).length;
	let slot = 0;
	for ( const token of tokens ) {
		if ( token.startsWith( '--' ) ) {
			const body = token.slice( 2 );
			const eq = body.indexOf( '=' );
			const name = -1 === eq ? body : body.slice( 0, eq );
			if ( ! specs.some( ( spec ) => spec.name === name ) ) {
				const takes = specs.map( ( spec ) => spec.name ).join( ', --' );
				throw new Error(
					`unknown option --${ name }; this verb takes --${ takes }`
				);
			}
			if ( named.has( name ) ) {
				throw new Error( `--${ name } given twice` );
			}
			if ( given.has( name ) ) {
				throw new Error(
					`${ name } given both by position and as --${ name }`
				);
			}
			named.add( name );
			given.set( name, -1 === eq ? true : body.slice( eq + 1 ) );
			continue;
		}
		const name = specs[ slot++ ]?.name ?? '';
		if ( '' === name ) {
			throw new Error(
				`too many arguments: ${ count } given, ${ specs.length } accepted`
			);
		}
		if ( named.has( name ) ) {
			throw new Error(
				`${ name } given both by position and as --${ name }`
			);
		}
		given.set( name, token );
	}
	/** @type {Object<string,?string>} */
	const bound = {};
	for ( const { name, required } of specs ) {
		const value = given.get( name );
		if ( true === value ) {
			throw new Error(
				`--${ name } needs a value: write --${ name }=<value>`
			);
		}
		if ( undefined !== value && ! ( '' === value && required ) ) {
			bound[ name ] = value;
		} else if ( required ) {
			throw new Error( `missing required argument: ${ name }` );
		} else {
			bound[ name ] = null;
		}
	}
	return bound;
}
