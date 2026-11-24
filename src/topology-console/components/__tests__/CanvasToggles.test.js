/**
 * The canvas toggles: which show, what each says it is, and what each press
 * reaches.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { fireEvent, render } from '@testing-library/react';
import CanvasToggles from '../CanvasToggles';

const read = require( '../../../build-kit/css-reader.cjs' );

const SHEET = path.resolve( __dirname, '../../styles/graph-view.scss' );

/**
 * Render the toggles, every callback mocked.
 *
 * @param {Object} flags The flags.
 * @return {{buttons: HTMLButtonElement[], on: Object<string, jest.Mock>}} The buttons in order, and the callbacks.
 */
const mount = ( flags ) => {
	const on = { onForce: jest.fn(), onSinks: jest.fn(), onWarm: jest.fn() };
	const { container } = render( <CanvasToggles { ...flags } { ...on } /> );
	return { buttons: [ ...container.querySelectorAll( 'button' ) ], on };
};

const labels = ( buttons ) => buttons.map( ( b ) => b.textContent );
const pressed = ( buttons ) =>
	buttons.map( ( b ) => b.getAttribute( 'aria-pressed' ) );

describe( 'CanvasToggles', () => {
	it( 'offers the force canvas alone while it is off, whatever the others are', () => {
		const { buttons } = mount( { force: false, sinks: true, warm: true } );
		expect( labels( buttons ) ).toEqual( [ 'Force canvas' ] );
		expect( pressed( buttons ) ).toEqual( [ 'false' ] );
	} );

	it( 'offers sinks and warmth below it while it is on', () => {
		const { buttons } = mount( { force: true, sinks: true, warm: false } );
		expect( labels( buttons ) ).toEqual( [
			'Force canvas',
			'Show sinks',
			'Keep warm',
		] );
		expect( pressed( buttons ) ).toEqual( [ 'true', 'true', 'false' ] );
	} );

	it( 'says of each whether it is on, apart from the others', () => {
		const { buttons } = mount( { force: true, sinks: false, warm: true } );
		expect( pressed( buttons ) ).toEqual( [ 'true', 'false', 'true' ] );
	} );

	it( 'wears the button style of the Inspector, lit while on', () => {
		const { buttons } = mount( { force: true, sinks: false, warm: true } );
		expect(
			buttons.map( ( b ) => [
				b.type,
				b.matches( '.button.is-compact' ),
				b.matches( '.is-active' ),
			] )
		).toEqual( [
			[ 'button', true, true ],
			[ 'button', true, false ],
			[ 'button', true, true ],
		] );
	} );

	it( 'gives the first a row of its own, in a section of the Inspector', () => {
		const { buttons } = mount( { force: true, sinks: false, warm: false } );
		expect(
			buttons.map( ( b ) => b.matches( '.topology-insp__actions-full' ) )
		).toEqual( [ true, false, false ] );
		expect(
			buttons[ 0 ].matches(
				'.topology-insp__section > .topology-insp__commands > *'
			)
		).toBe( true );
	} );

	it( 'stands at the top of the panel, whose padding is enough', () => {
		const { container } = render(
			<aside className="topology-inspector">
				<CanvasToggles force={ false } />
				<div className="topology-insp__section" />
			</aside>
		);
		const sheets = [ postcss.parse( sass.compile( SHEET ).css ) ];
		const [ toggles, later ] = container.querySelectorAll(
			'.topology-insp__section'
		);
		const margin = ( el ) => read.winning( el, 'margin-top', sheets );
		expect( [ margin( toggles ), margin( later ) ] ).toEqual( [
			'0',
			'18px',
		] );
	} );

	it.each( [
		[ 0, 'onForce' ],
		[ 1, 'onSinks' ],
		[ 2, 'onWarm' ],
	] )( 'press %i runs %s alone', ( at, name ) => {
		const { buttons, on } = mount( { force: true, sinks: true } );
		fireEvent.click( buttons[ at ] );
		const ran = Object.keys( on ).filter(
			( one ) => on[ one ].mock.calls.length
		);
		expect( ran ).toEqual( [ name ] );
		expect( on[ name ] ).toHaveBeenCalledTimes( 1 );
	} );
} );
