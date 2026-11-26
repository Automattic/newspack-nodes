/* @jest-environment node */

/**
 * The dark skins, read from the stylesheet that declares them, and a value's
 * `light-dark()` read as the branch a scheme takes.
 */

import fs from 'fs';
import path from 'path';
import { DARK_SKINS, schemed } from '../schemes';

describe( 'DARK_SKINS', () => {
	it( 'lists the skins `$np-dark-skins` names, crt among them', () => {
		const source = fs.readFileSync(
			path.resolve( __dirname, '../../styles/_controls.scss' ),
			'utf8'
		);
		DARK_SKINS.forEach( ( skin ) => expect( source ).toContain( skin ) );
		expect( DARK_SKINS ).toContain( 'crt' );
		expect( DARK_SKINS ).not.toContain( 'newspack' );
	} );
} );

describe( 'schemed', () => {
	const value =
		'light-dark(color-mix(in srgb, #406ebc 35%, #f7f7f7), color-mix(in srgb, #406ebc 50%, light-dark(#fff, #0a0b0c)))';

	it( 'reads each light-dark(), nested too, as the branch its scheme takes', () => {
		expect( schemed( value, false ) ).toBe(
			'color-mix(in srgb, #406ebc 35%, #f7f7f7)'
		);
		expect( schemed( value, true ) ).toBe(
			'color-mix(in srgb, #406ebc 50%, #0a0b0c)'
		);
	} );

	it( 'reads a skin’s slug as its scheme', () => {
		expect( schemed( 'light-dark(#111, #eee)', 'crt' ) ).toBe( '#eee' );
		expect( schemed( 'light-dark(#111, #eee)', 'newspack' ) ).toBe(
			'#111'
		);
	} );

	it( 'leaves a value without one as written', () => {
		expect( schemed( '#123456', true ) ).toBe( '#123456' );
	} );

	it( 'throws on a light-dark() that never closes, rather than hanging', () => {
		expect( () => schemed( 'light-dark(#fff, #000', true ) ).toThrow(
			/unclosed light-dark\(\)/
		);
	} );
} );
