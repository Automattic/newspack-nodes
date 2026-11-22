/* @jest-environment node */

/**
 * One modal: every dialog draws through the shared shell, never through
 * `@wordpress/components`' `Modal`, so its look, exit and focus handling live
 * in one place.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
	importsWordPressModal,
	wordPressModalImports,
} from '@newspack-nodes/shared/test-utils/noWordPressModal';

describe( 'the one modal', () => {
	it.each( [
		[
			'a named import',
			"import { Button, Modal } from '@wordpress/components';",
		],
		[
			'an aliased import across lines',
			"import {\n\tButton,\n\tModal as WpModal,\n} from '@wordpress/components';",
		],
		[
			'a namespace read in JSX',
			'import * as Wp from \'@wordpress/components\';\nconst x = <Wp.Modal title="heron" />;',
		],
		[
			'a namespace member read',
			"import * as Wp from '@wordpress/components';\nconst Frame = Wp.Modal;",
		],
		[
			'a namespace read by bracket',
			"import * as Wp from '@wordpress/components';\nconst Frame = Wp[ 'Modal' ];",
		],
		[
			'a destructured require',
			"const { Button, Modal } = require( '@wordpress/components' );",
		],
		[
			'a renamed destructured require',
			"const {\n\tModal: Frame,\n} = require( '@wordpress/components' );",
		],
		[
			'a member read off a require',
			"const Frame = require( '@wordpress/components' ).Modal;",
		],
		[
			'a member read off a required binding',
			"const Wp = require( '@wordpress/components' );\nconst x = <Wp.Modal />;",
		],
	] )( 'catches %s of the WordPress Modal', ( name, source ) => {
		expect( importsWordPressModal( source ) ).toBe( true );
	} );

	it.each( [
		[
			'a named import of another component',
			"import { Button, ModalHeader } from '@wordpress/components';",
		],
		[
			'a namespace read of another component',
			"import * as Wp from '@wordpress/components';\nconst x = <Wp.ModalHeader />;",
		],
		[
			'a require of another component',
			"const { Button } = require( '@wordpress/components' );\nconst x = Button.Modal;",
		],
		[
			'a Modal read off another namespace',
			"import * as Wp from '@wordpress/components';\nimport * as Kit from './kit';\nconst x = <Kit.Modal />;",
		],
		[
			'an import commented out with //',
			"// import { Modal } from '@wordpress/components';",
		],
		[
			'an import commented out with /* */',
			"/* import {\n\tModal,\n} from '@wordpress/components'; */",
		],
	] )( 'passes %s', ( name, source ) => {
		expect( importsWordPressModal( source ) ).toBe( false );
	} );

	it( 'names each source importing it, by path, past tests and test utilities', () => {
		const root = fs.mkdtempSync( path.join( os.tmpdir(), 'no-wp-modal-' ) );
		const write = ( file, text ) => {
			fs.mkdirSync( path.dirname( path.join( root, file ) ), {
				recursive: true,
			} );
			fs.writeFileSync( path.join( root, file ), text );
		};
		const offending = "import { Modal } from '@wordpress/components';";
		try {
			write( 'plover/Ledger.js', offending );
			write(
				'plover/Quiet.js',
				"import { Button } from '@wordpress/components';"
			);
			write( 'plover/__tests__/Ledger.test.js', offending );
			write( 'shared/test-utils/frame.js', offending );
			write( 'plover/notes.md', offending );
			expect( wordPressModalImports( root ) ).toEqual( [
				path.join( 'plover', 'Ledger.js' ),
			] );
		} finally {
			fs.rmSync( root, { recursive: true, force: true } );
		}
	} );

	it( 'imports no Modal from @wordpress/components anywhere in src', () => {
		expect(
			wordPressModalImports( path.resolve( __dirname, '..' ) )
		).toEqual( [] );
	} );
} );
