/* @jest-environment node */
/**
 * The focus ring's halo reads its own token, `--focus-halo`, falling back to
 * `--paper`, so a dark surface inside a light skin re-points the halo alone
 * and leaves every fill that reads `--paper` as it was.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const { resolveVars: resolve } = require( '../../build-kit/css-reader.cjs' );

const ROOT = path.resolve( __dirname, '../../..' );
const ui = postcss.parse(
	sass.compile( path.join( ROOT, 'src/ui/newspack-nodes-ui.scss' ) ).css
);

// A light skin's tokens, each a value nothing else in the sheet writes.
const SKIN = {
	'--paper': '#fbf8f1',
	'--paper-2': '#f1ece0',
	'--ink': '#1b2733',
	'--cyan': '#1f6fa8',
};

// Every declaration whose resolved value differs between the two envs.
const changed = ( before, after ) => {
	const found = [];
	ui.walkDecls( ( decl ) => {
		if ( decl.prop.startsWith( '--' ) ) {
			return;
		}
		const was = resolve( decl.value, before );
		const now = resolve( decl.value, after );
		if ( was !== now ) {
			found.push( { prop: decl.prop, was, now } );
		}
	} );
	return found;
};

it( 'draws the halo from --paper until a surface re-points --focus-halo', () => {
	const halos = changed( SKIN, { ...SKIN, '--focus-halo': '#20262e' } );
	expect( halos.length ).toBeGreaterThan( 0 );
	for ( const halo of halos ) {
		expect( halo ).toEqual( {
			prop: 'box-shadow',
			was: '0 0 0 1px #fbf8f1',
			now: '0 0 0 1px #20262e',
		} );
	}
} );

// The halos, by the token they read first.
const halos = [];
ui.walkDecls( 'box-shadow', ( decl ) => {
	if ( decl.value.includes( '--focus-halo' ) ) {
		halos.push( decl.value );
	}
} );

it( 'draws every halo from --focus-halo over a re-pointed --paper', () => {
	const env = { ...SKIN, '--paper': '#20262e', '--focus-halo': '#fdfaf0' };
	expect( halos.length ).toBeGreaterThan( 0 );
	for ( const halo of halos ) {
		expect( resolve( halo, env ) ).toBe( '0 0 0 1px #fdfaf0' );
	}
} );
