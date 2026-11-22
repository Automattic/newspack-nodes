/* @jest-environment node */

/**
 * One modal: every dialog draws through the shared shell, never through
 * `@wordpress/components`' `Modal`, so its look, exit and focus handling live
 * in one place.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.resolve( __dirname, '..' );

/** An import statement from `@wordpress/components`, in one line or many. */
const COMPONENTS_IMPORT =
	/import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]@wordpress\/components['"]/g;

/** A block comment, or a line comment from its `//` to the line's end. */
const COMMENTS = /\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm;

/**
 * The source files under a directory, tests and test utilities left out.
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
 * Whether a source imports `Modal` from `@wordpress/components`.
 *
 * @param {string} source The file's text.
 * @return {boolean} True when it does.
 */
function importsWordPressModal( source ) {
	const code = source.replace( COMMENTS, '' );
	return [ ...code.matchAll( COMPONENTS_IMPORT ) ].some( ( match ) =>
		match[ 1 ]
			.split( ',' )
			.some(
				( name ) => 'Modal' === name.trim().split( /\s+as\s+/ )[ 0 ]
			)
	);
}

describe( 'the one modal', () => {
	it( 'catches a single-line and a multi-line import of the WordPress Modal', () => {
		expect(
			importsWordPressModal(
				"import { Button, Modal } from '@wordpress/components';"
			)
		).toBe( true );
		expect(
			importsWordPressModal(
				"import {\n\tButton,\n\tModal as WpModal,\n} from '@wordpress/components';"
			)
		).toBe( true );
		expect(
			importsWordPressModal(
				"import { Button, ModalHeader } from '@wordpress/components';"
			)
		).toBe( false );
	} );

	it( 'ignores an import commented out with // or /* */', () => {
		expect(
			importsWordPressModal(
				"// import { Modal } from '@wordpress/components';"
			)
		).toBe( false );
		expect(
			importsWordPressModal(
				"/* import {\n\tModal,\n} from '@wordpress/components'; */"
			)
		).toBe( false );
	} );

	it( 'imports no Modal from @wordpress/components anywhere in src', () => {
		const offenders = sources( SRC )
			.filter( ( file ) =>
				importsWordPressModal( fs.readFileSync( file, 'utf8' ) )
			)
			.map( ( file ) => path.relative( SRC, file ) );
		expect( offenders ).toEqual( [] );
	} );
} );
