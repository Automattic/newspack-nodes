/**
 * Palette — edit-mode draggable list of node classes grouped by
 * category. Owns the pointer-events drag gesture (Firefox-safe): an
 * item pointer-down shows a ghost, pointer-up over the canvas SVG
 * projects the cursor into SVG coords and calls onDropNode.
 */

import { render, fireEvent } from '@testing-library/react';
import Palette from '../Palette';

// A fake canvas SVG that elementFromPoint resolves to: closest() returns
// itself, createSVGPoint/getScreenCTM project (clientX,clientY) → a fixed
// SVG-space point so the drop coords are deterministic.
function makeCanvasStub( projected = { x: 42, y: 99 } ) {
	const svg = {
		createSVGPoint: () => ( {
			x: 0,
			y: 0,
			matrixTransform: () => projected,
		} ),
		getScreenCTM: () => ( { inverse: () => ( {} ) } ),
	};
	svg.closest = ( sel ) => ( sel === 'svg.topology-canvas-svg' ? svg : null );
	return svg;
}

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

	it( 'omits non-draggable categories (Service) from the palette and the count', () => {
		// Service CIs are mounted, not make_node'd — they must not be draggable in
		// the palette, but they stay in the catalog so the inspector can still
		// render their command/request buttons (catalog.find by shell_name).
		const withService = [
			{ shell_name: 'Echo', category: 'Generic' },
			{ shell_name: 'Insights_CI', category: 'Service' },
		];
		const { container } = render(
			<Palette classes={ withService } loading={ false } />
		);
		const groupNames = Array.from(
			container.querySelectorAll( '.topology-palette__group' )
		).map( ( g ) => g.textContent );
		expect( groupNames ).toEqual( [ 'Generic' ] );
		expect(
			container.querySelector( '[data-shell-name="Insights_CI"]' )
		).toBeNull();
		expect(
			container.querySelector( '.topology-palette__count' ).textContent
		).toBe( '1' );
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

	it( 'glyph connectors reflect accepts_fill (in) and has_target (out)', () => {
		// accepts_fill → left/in dot (::before); has_target → right/out dot
		// (::after). The component flags the absent ones so CSS hides them.
		const classes = [
			{
				shell_name: 'Sourcey',
				category: 'Generic',
				accepts_fill: false,
				has_target: true,
			},
			{
				shell_name: 'Sinky',
				category: 'Generic',
				accepts_fill: true,
				has_target: false,
			},
			{ shell_name: 'Both', category: 'Generic' }, // undefined → both default true
		];
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		const glyphOf = ( name ) =>
			container.querySelector(
				`[data-shell-name="${ name }"] .topology-palette__glyph`
			);
		// Source (no fill): in-connector hidden, out-connector shown.
		expect( glyphOf( 'Sourcey' ).className ).toContain(
			'topology-palette__glyph--no-in'
		);
		expect( glyphOf( 'Sourcey' ).className ).not.toContain(
			'topology-palette__glyph--no-out'
		);
		// Sink (no target): out-connector hidden, in-connector shown.
		expect( glyphOf( 'Sinky' ).className ).toContain(
			'topology-palette__glyph--no-out'
		);
		expect( glyphOf( 'Sinky' ).className ).not.toContain(
			'topology-palette__glyph--no-in'
		);
		// Default (both connectors): no modifier.
		expect( glyphOf( 'Both' ).className ).toBe( 'topology-palette__glyph' );
	} );

	it( 'the drag ghost shows the connector-aware glyph for the dragged class', () => {
		const classes = [
			{
				shell_name: 'Sourcey',
				category: 'Generic',
				accepts_fill: false,
				has_target: true,
			},
		];
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		const item = container.querySelector( '[data-shell-name="Sourcey"]' );
		fireEvent.pointerDown( item, { pointerId: 1, clientX: 5, clientY: 5 } );
		const ghostGlyph = container.querySelector(
			'.topology-palette__drag-ghost .topology-palette__glyph'
		);
		expect( ghostGlyph ).not.toBeNull();
		expect( ghostGlyph.className ).toContain(
			'topology-palette__glyph--no-in'
		);
	} );

	it( 'shows a drag ghost with the shell name on pointer-down', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading={ false } />
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		fireEvent.pointerDown( echo, {
			pointerId: 1,
			clientX: 5,
			clientY: 5,
		} );
		const ghost = container.querySelector(
			'.topology-palette__drag-ghost'
		);
		expect( ghost ).not.toBeNull();
		expect( ghost.textContent ).toBe( 'Echo' );
	} );

	it( 'pointer-up over the canvas projects coords and calls onDropNode', () => {
		const onDropNode = jest.fn();
		const svg = makeCanvasStub( { x: 42, y: 99 } );
		// jsdom has no elementFromPoint; install one for this test.
		document.elementFromPoint = jest.fn().mockReturnValue( svg );
		const { container } = render(
			<Palette
				classes={ sampleClasses }
				loading={ false }
				onDropNode={ onDropNode }
			/>
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		fireEvent.pointerDown( echo, {
			pointerId: 1,
			clientX: 5,
			clientY: 5,
		} );
		fireEvent.pointerUp( echo, {
			pointerId: 1,
			clientX: 300,
			clientY: 200,
		} );
		expect( onDropNode ).toHaveBeenCalledWith( {
			shellName: 'Echo',
			x: 42,
			y: 99,
		} );
		delete document.elementFromPoint;
	} );

	it( 'pointer-up NOT over the canvas does not drop and clears the ghost', () => {
		const onDropNode = jest.fn();
		document.elementFromPoint = jest.fn().mockReturnValue( null );
		const { container } = render(
			<Palette
				classes={ sampleClasses }
				loading={ false }
				onDropNode={ onDropNode }
			/>
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		fireEvent.pointerDown( echo, { pointerId: 1, clientX: 5, clientY: 5 } );
		fireEvent.pointerUp( echo, { pointerId: 1, clientX: 9, clientY: 9 } );
		expect( onDropNode ).not.toHaveBeenCalled();
		expect(
			container.querySelector( '.topology-palette__drag-ghost' )
		).toBeNull();
		delete document.elementFromPoint;
	} );

	it( 'pointer-cancel clears the ghost without calling onDropNode', () => {
		const onDropNode = jest.fn();
		const { container } = render(
			<Palette
				classes={ sampleClasses }
				loading={ false }
				onDropNode={ onDropNode }
			/>
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		fireEvent.pointerDown( echo, { pointerId: 1, clientX: 5, clientY: 5 } );
		expect(
			container.querySelector( '.topology-palette__drag-ghost' )
		).not.toBeNull();
		fireEvent.pointerCancel( echo, { pointerId: 1 } );
		expect(
			container.querySelector( '.topology-palette__drag-ghost' )
		).toBeNull();
		expect( onDropNode ).not.toHaveBeenCalled();
	} );

	it( 'does not throw when setPointerCapture is absent (jsdom)', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading={ false } />
		);
		const echo = container.querySelector( '[data-shell-name="Echo"]' );
		expect( () =>
			fireEvent.pointerDown( echo, {
				pointerId: 1,
				clientX: 5,
				clientY: 5,
			} )
		).not.toThrow();
	} );

	it( 'renders the footer count even when loading is true and classes already exist', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } loading />
		);
		const count = container.querySelector( '.topology-palette__count' );
		expect( count.textContent ).toBe( '3' );
	} );

	it( 'renders a collapse toggle button when onToggle is provided', () => {
		const onToggle = jest.fn();
		const { getByRole } = render(
			<Palette classes={ sampleClasses } onToggle={ onToggle } />
		);
		const btn = getByRole( 'button', { name: /collapse palette/i } );
		btn.click();
		expect( onToggle ).toHaveBeenCalled();
	} );

	it( 'collapses to a slim expand handle when `collapsed` is true', () => {
		const onToggle = jest.fn();
		const { getByRole, container } = render(
			<Palette
				classes={ sampleClasses }
				collapsed
				onToggle={ onToggle }
			/>
		);
		// Class list is hidden; expand-handle button is visible and clickable.
		expect(
			container.querySelectorAll( '.topology-palette__item' ).length
		).toBe( 0 );
		const btn = getByRole( 'button', { name: /expand palette/i } );
		btn.click();
		expect( onToggle ).toHaveBeenCalled();
	} );
} );
