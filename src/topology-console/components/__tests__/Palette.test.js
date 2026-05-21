/**
 * Palette — edit-mode draggable list of node classes grouped by
 * category. Drives onDragStart to inject the substrate's drag MIME
 * type so SchematicCanvas's onDrop knows what to instantiate.
 */

import { render } from '@testing-library/react';
import Palette, { DRAG_MIME } from '../Palette';

const sampleClasses = [
	{ shell_name: 'Echo', category: 'Generic', description: 'Echo node' },
	{ shell_name: 'Tee', category: 'Generic' },
	{ shell_name: 'Partition', category: 'Storage' },
];

describe( 'Palette', () => {
	it( 'renders a loading placeholder when loading=true and no classes', () => {
		const { container } = render( <Palette classes={ [] } loading /> );
		expect( container.textContent ).toMatch( /Loading/ );
	} );

	it( 'groups classes by category and sorts within each group', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading={ false } />
		);
		const groups = container.querySelectorAll( '.topology-palette__group' );
		const groupNames = Array.from( groups ).map( ( g ) => g.textContent );
		expect( groupNames ).toEqual( [ 'Generic', 'Storage' ] );
		const items = container.querySelectorAll( '.topology-palette__item' );
		expect( items.length ).toBe( 3 );
		// Within Generic: Echo < Tee alphabetically.
		expect( items[ 0 ].dataset.shellName ).toBe( 'Echo' );
		expect( items[ 1 ].dataset.shellName ).toBe( 'Tee' );
		expect( items[ 2 ].dataset.shellName ).toBe( 'Partition' );
	} );

	it( 'shows the total count of classes in the footer', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading={ false } />
		);
		const count = container.querySelector( '.topology-palette__count' );
		expect( count.textContent ).toBe( '3' );
	} );

	it( 'sets a per-class CSS modifier on each draggable item', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading={ false } />
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		expect( echo.className ).toContain( 'topology-palette__item--echo' );
	} );

	it( 'sets shell name on dataTransfer via DRAG_MIME on dragStart', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading={ false } />
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		const setData = jest.fn();
		const dataTransfer = { setData, effectAllowed: '' };
		// Invoke onDragStart via the SyntheticEvent (jsdom has no DataTransfer).
		const reactKey = Object.keys( echo ).find( ( k ) =>
			k.startsWith( '__reactProps' )
		);
		echo[ reactKey ].onDragStart( {
			dataTransfer,
			preventDefault: () => {},
		} );
		expect( setData ).toHaveBeenCalledWith( DRAG_MIME, 'Echo' );
		expect( dataTransfer.effectAllowed ).toBe( 'copy' );
	} );

	it( 'exports DRAG_MIME for the drop target to use the same MIME', () => {
		expect( DRAG_MIME ).toBe( 'application/x-newspack-node' );
	} );

	it( 'renders the footer count even when loading is true and classes already exist', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading />
		);
		const count = container.querySelector( '.topology-palette__count' );
		expect( count.textContent ).toBe( '3' );
	} );
} );
