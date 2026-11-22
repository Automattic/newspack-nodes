/**
 * noWordPressModal — the one-modal guard every plugin runs over its own `src`:
 * which sources reach `@wordpress/components`' `Modal`, so a plugin's dialogs
 * all draw through the shared shell.
 *
 * A source reaches it four ways: a named import (aliased or not), a namespace
 * import read as `Ns.Modal` or `Ns[ 'Modal' ]`, a destructured `require`
 * (renamed or not), and a member read off a `require` or off the binding it
 * was assigned to. Comments are stripped first, so a commented-out import does
 * not count.
 *
 * A consumer's guard is one call:
 * `expect( wordPressModalImports( path.resolve( __dirname, '..' ) ) ).toEqual( [] )`.
 */

import fs from 'fs';
import path from 'path';

/** The module the guard keeps `Modal` out of, as a quoted specifier. */
const FROM = String.raw`['"]@wordpress/components['"]`;

/** A require of the module. */
const REQUIRE = String.raw`require\s*\(\s*${ FROM }\s*\)`;

/** A named import from the module, in one line or many. */
const NAMED_IMPORT = new RegExp(
	String.raw`import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${ FROM }`,
	'g'
);

/** A namespace import from the module, capturing its name. */
const NAMESPACE_IMPORT = new RegExp(
	String.raw`import\s*(?:[\w$]+\s*,\s*)?\*\s*as\s+([\w$]+)\s+from\s*${ FROM }`,
	'g'
);

/** A destructured require of the module, capturing what it takes. */
const DESTRUCTURED_REQUIRE = new RegExp(
	String.raw`\{([^}]*)\}\s*=\s*${ REQUIRE }`,
	'g'
);

/** A require of the module assigned to a name, capturing the name. */
const REQUIRE_BINDING = new RegExp(
	String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*${ REQUIRE }`,
	'g'
);

/** `Modal` read as a member: `.Modal`, or `[ 'Modal' ]` in any quote. */
const MODAL_MEMBER = String.raw`(?:\s*\.\s*Modal(?![\w$])|\s*\[\s*['"\`]Modal['"\`]\s*\])`;

/** A member read of `Modal` straight off a require. */
const REQUIRE_MEMBER = new RegExp( REQUIRE + MODAL_MEMBER );

/** A block comment, or a line comment from its `//` to the line's end. */
const COMMENTS = /\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm;

/**
 * Whether a list of imported or destructured names takes `Modal`, its own
 * name read before an `as` or a `:`.
 *
 * @param {string} names The text between the braces.
 * @return {boolean} True when `Modal` is among them.
 */
function takesModal( names ) {
	return names
		.split( ',' )
		.some( ( name ) => 'Modal' === name.split( /\s+as\s+|:/ )[ 0 ].trim() );
}

/**
 * Whether a source reaches `Modal` in `@wordpress/components`.
 *
 * @param {string} source The file's text.
 * @return {boolean} True when it does.
 */
export function importsWordPressModal( source ) {
	const code = source.replace( COMMENTS, '' );
	const taken = [
		...code.matchAll( NAMED_IMPORT ),
		...code.matchAll( DESTRUCTURED_REQUIRE ),
	].some( ( match ) => takesModal( match[ 1 ] ) );
	if ( taken || REQUIRE_MEMBER.test( code ) ) {
		return true;
	}
	return [
		...code.matchAll( NAMESPACE_IMPORT ),
		...code.matchAll( REQUIRE_BINDING ),
	].some( ( [ , name ] ) =>
		new RegExp(
			String.raw`(?<![\w$.])${ name.replace( /\$/g, '\\$' ) }` +
				MODAL_MEMBER
		).test( code )
	);
}

/**
 * The `.js` sources under a directory, tests and test utilities left out.
 *
 * @param {string} dir The directory.
 * @return {string[]} Absolute paths.
 */
function sources( dir ) {
	return fs
		.readdirSync( dir, { withFileTypes: true } )
		.flatMap( ( entry ) => {
			const full = path.join( dir, entry.name );
			if ( entry.isDirectory() ) {
				return [ '__tests__', 'test-utils', 'node_modules' ].includes(
					entry.name
				)
					? []
					: sources( full );
			}
			return entry.name.endsWith( '.js' ) ? [ full ] : [];
		} );
}

/**
 * The sources under `srcDir` that reach `@wordpress/components`' `Modal`.
 *
 * @param {string} srcDir The plugin's source root.
 * @return {string[]} Their paths relative to `srcDir`, sorted; an empty list is a clean `src`.
 */
export function wordPressModalImports( srcDir ) {
	return sources( srcDir )
		.filter( ( file ) =>
			importsWordPressModal( fs.readFileSync( file, 'utf8' ) )
		)
		.map( ( file ) => path.relative( srcDir, file ) )
		.sort();
}
