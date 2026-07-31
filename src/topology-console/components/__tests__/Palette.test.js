/**
 * Palette — edit-mode draggable list of node classes grouped by
 * category. Owns the pointer-events drag gesture (Firefox-safe): an
 * item pointer-down shows a ghost, pointer-up over the canvas SVG
 * projects the cursor into SVG coords and calls onDropNode.
 */

import { render, fireEvent, screen } from '@testing-library/react';
import Palette from '../Palette';

// Fake canvas SVG: closest() returns itself; projects coords to a fixed pt.
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
		// Service CIs are mounted, not draggable, but stay in the catalog.
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
		// accepts_fill → in dot (::before); has_target → out dot (::after).
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
			{ shell_name: 'Both', category: 'Generic' }, // both default true
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

	it( 'the drag ghost renders the actual node card with schema-correct ports', () => {
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
		const ghost = container.querySelector(
			'.topology-palette__drag-ghost'
		);
		expect( ghost ).not.toBeNull();
		// It's the node card: the type label is the class name.
		expect(
			ghost.querySelector( '.topology-node__type' ).textContent
		).toBe( 'Sourcey' );
		// Source (no accepts_fill): out-port present, in-port absent.
		expect( ghost.querySelector( '.topology-port--out' ) ).not.toBeNull();
		expect( ghost.querySelector( '.topology-port--in' ) ).toBeNull();
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
		expect( btn.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		btn.click();
		expect( onToggle ).toHaveBeenCalled();
	} );

	const topologies = [
		{ name: 'performance', includes: [ 'request-builder' ] },
		{ name: 'request-builder', includes: [] },
		{ name: 'job-router', includes: [] },
		{ name: 'combined', includes: [ 'performance', 'job-router' ] },
	];

	it( 'renders a Topologies section listing includable topologies', () => {
		render(
			<Palette
				classes={ [] }
				topologies={ topologies }
				editMode
				currentTopology="performance"
				declaredIncludes={ [ 'request-builder' ] }
				onDropTopology={ jest.fn() }
			/>
		);
		expect( screen.getByText( 'Topologies' ) ).not.toBeNull();
		expect(
			screen
				.getByTestId( 'palette-topology-job-router' )
				.className.includes( 'is-disabled' )
		).toBe( false );
	} );

	it( 'greys out self, an already-declared include, and an ancestor', () => {
		render(
			<Palette
				classes={ [] }
				topologies={ topologies }
				editMode
				currentTopology="performance"
				declaredIncludes={ [ 'request-builder' ] }
				onDropTopology={ jest.fn() }
			/>
		);
		const isDisabled = ( testId ) =>
			screen.getByTestId( testId ).className.includes( 'is-disabled' );
		// self
		expect( isDisabled( 'palette-topology-performance' ) ).toBe( true );
		// already included
		expect( isDisabled( 'palette-topology-request-builder' ) ).toBe( true );
		// ancestor: combined includes performance (transitively, directly here)
		expect( isDisabled( 'palette-topology-combined' ) ).toBe( true );
	} );

	it( 'does not fire onDropTopology for a disabled item', () => {
		const onDropTopology = jest.fn();
		render(
			<Palette
				classes={ [] }
				topologies={ topologies }
				editMode
				currentTopology="performance"
				declaredIncludes={ [] }
				onDropTopology={ onDropTopology }
			/>
		);
		fireEvent.pointerDown(
			screen.getByTestId( 'palette-topology-performance' )
		);
		fireEvent.pointerUp(
			screen.getByTestId( 'palette-topology-performance' )
		);
		expect( onDropTopology ).not.toHaveBeenCalled();
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

describe( 'Palette — topology drag + include-closure edge cases', () => {
	it( 'dragging an enabled topology tile onto the canvas projects coords and calls onDropTopology', () => {
		const onDropTopology = jest.fn();
		const svg = makeCanvasStub( { x: 12, y: 34 } );
		document.elementFromPoint = jest.fn().mockReturnValue( svg );
		render(
			<Palette
				classes={ [] }
				topologies={ [ { name: 'job-router', includes: [] } ] }
				editMode
				currentTopology="something-else"
				declaredIncludes={ [] }
				onDropTopology={ onDropTopology }
			/>
		);
		const tile = screen.getByTestId( 'palette-topology-job-router' );
		fireEvent.pointerDown( tile, {
			pointerId: 1,
			clientX: 5,
			clientY: 5,
		} );
		// The topology ghost is a rounded hull blob carrying the name.
		const ghost = document.querySelector(
			'.topology-palette__drag-ghost--topology'
		);
		expect( ghost ).not.toBeNull();
		expect( ghost.textContent ).toBe( 'job-router' );
		// A move while dragging repositions the existing ghost.
		fireEvent.pointerMove( tile, {
			pointerId: 1,
			clientX: 50,
			clientY: 60,
		} );
		fireEvent.pointerUp( tile, {
			pointerId: 1,
			clientX: 300,
			clientY: 200,
		} );
		expect( onDropTopology ).toHaveBeenCalledWith( {
			name: 'job-router',
			x: 12,
			y: 34,
		} );
		delete document.elementFromPoint;
	} );

	it( 'a drop over a canvas with no screen CTM is a no-op', () => {
		const onDropNode = jest.fn();
		const svg = makeCanvasStub();
		svg.getScreenCTM = () => null;
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
		expect( onDropNode ).not.toHaveBeenCalled();
		delete document.elementFromPoint;
	} );

	it( 'computes the include closure without revisiting a shared grandchild (diamond)', () => {
		// diamond-root reaches shared-leaf through BOTH branches; the closure
		// walk must skip the second visit rather than recurse into it again.
		const topologies = [
			{
				name: 'diamond-root',
				includes: [ 'left-branch', 'right-branch' ],
			},
			{ name: 'left-branch', includes: [ 'shared-leaf' ] },
			{ name: 'right-branch', includes: [ 'shared-leaf' ] },
			{ name: 'shared-leaf', includes: [] },
		];
		render(
			<Palette
				classes={ [] }
				topologies={ topologies }
				editMode
				currentTopology="shared-leaf"
				declaredIncludes={ [] }
				onDropTopology={ jest.fn() }
			/>
		);
		// diamond-root transitively includes shared-leaf (the current
		// topology) → the ancestor guard disables it.
		expect(
			screen
				.getByTestId( 'palette-topology-diamond-root' )
				.className.includes( 'is-disabled' )
		).toBe( true );
	} );
} );

describe( 'Palette — search filter', () => {
	const classes = [
		{ shell_name: 'Echo', category: 'Generic', description: 'Echo node' },
		{ shell_name: 'Tee', category: 'Generic' },
		{ shell_name: 'Partition', category: 'Storage' },
		{
			shell_name: 'Zeta',
			category: 'Generic',
			description: 'quacks loudly',
		},
	];

	const shellNames = ( container ) =>
		Array.from(
			container.querySelectorAll( '.topology-palette__item' )
		).map( ( el ) => el.dataset.shellName );

	it( 'renders a search input at the top of the palette', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		expect(
			container.querySelector( '.topology-palette__search' )
		).not.toBeNull();
	} );

	it( 'shows the full list when the query is empty', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		expect( shellNames( container ).sort() ).toEqual( [
			'Echo',
			'Partition',
			'Tee',
			'Zeta',
		] );
	} );

	it( 'filters by shell name case-insensitively', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		fireEvent.change(
			container.querySelector( '.topology-palette__search' ),
			{ target: { value: 'PART' } }
		);
		expect( shellNames( container ) ).toEqual( [ 'Partition' ] );
	} );

	it( 'also matches on description text', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		// "quack" appears only in Zeta's description, not any shell name.
		fireEvent.change(
			container.querySelector( '.topology-palette__search' ),
			{ target: { value: 'quack' } }
		);
		expect( shellNames( container ) ).toEqual( [ 'Zeta' ] );
	} );

	it( 'restores the full list when the query is cleared', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		const input = container.querySelector( '.topology-palette__search' );
		fireEvent.change( input, { target: { value: 'part' } } );
		expect( shellNames( container ) ).toEqual( [ 'Partition' ] );
		fireEvent.change( input, { target: { value: '' } } );
		expect( shellNames( container ) ).toHaveLength( 4 );
	} );

	it( 'keeps the footer count at the full registered total while filtering', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		fireEvent.change(
			container.querySelector( '.topology-palette__search' ),
			{ target: { value: 'part' } }
		);
		expect(
			container.querySelector( '.topology-palette__count' ).textContent
		).toBe( '4' );
	} );
} );

describe( 'Palette — Topologies section is edit-only', () => {
	const topologies = [
		{ name: 'combined', includes: [] },
		{ name: 'job-router', includes: [] },
	];

	it( 'hides the Topologies section in LIVE mode — there is no draft to include into', () => {
		render(
			<Palette
				classes={ [] }
				topologies={ topologies }
				declaredIncludes={ [] }
				editMode={ false }
				onDropTopology={ jest.fn() }
			/>
		);
		expect( screen.queryByText( 'Topologies' ) ).toBeNull();
		expect(
			document.querySelectorAll( '[data-testid^="palette-topology-"]' )
		).toHaveLength( 0 );
	} );

	it( 'shows it in EDIT mode', () => {
		render(
			<Palette
				classes={ [] }
				topologies={ topologies }
				declaredIncludes={ [] }
				editMode
				onDropTopology={ jest.fn() }
			/>
		);
		expect( screen.getByText( 'Topologies' ) ).toBeTruthy();
	} );
} );

describe( 'Palette — search filters the Topologies section', () => {
	const classes = [ { shell_name: 'Echo', category: 'Generic' } ];
	// Names distinct from every other fixture here, so an unfiltered
	// topologies list (the bug) fails this loudly instead of coinciding.
	const topologies = [
		{ name: 'aggregator', includes: [] },
		{ name: 'flame-builder', includes: [] },
		{ name: 'gyroscope', includes: [] },
	];

	const renderEditPalette = () =>
		render(
			<Palette
				classes={ classes }
				topologies={ topologies }
				editMode
				currentTopology="something-else"
				declaredIncludes={ [] }
				onDropTopology={ jest.fn() }
			/>
		);

	it( 'narrows the topology tiles by name, case-insensitively', () => {
		const { container } = renderEditPalette();
		fireEvent.change(
			container.querySelector( '.topology-palette__search' ),
			{ target: { value: 'AGGRE' } }
		);
		expect(
			screen.getByTestId( 'palette-topology-aggregator' )
		).toBeTruthy();
		expect(
			screen.queryByTestId( 'palette-topology-flame-builder' )
		).toBeNull();
		expect(
			screen.queryByTestId( 'palette-topology-gyroscope' )
		).toBeNull();
	} );

	it( 'hides the Topologies header when no topology matches', () => {
		const { container } = renderEditPalette();
		fireEvent.change(
			container.querySelector( '.topology-palette__search' ),
			{ target: { value: 'zzz-no-such-topology' } }
		);
		expect( screen.queryByText( 'Topologies' ) ).toBeNull();
	} );
} );

describe( 'Palette — dock structure mirrors the inspector', () => {
	// The palette must render as an outer `.topology-palette-dock` holding the
	// toggle button AND the `<aside class="topology-palette">` as SIBLING direct
	// children — structurally identical to `.topology-inspector-dock`, so the
	// aside owns only its own padding/scroll and the dock owns grid placement.
	it( 'wraps the aside in a dock; toggle and aside are sibling direct children of the dock', () => {
		const { container } = render(
			<Palette classes={ sampleClasses } onToggle={ jest.fn() } />
		);
		const dock = container.querySelector( '.topology-palette-dock' );
		expect( dock ).not.toBeNull();
		const toggle = container.querySelector( '.topology-palette__toggle' );
		const aside = container.querySelector( 'aside.topology-palette' );
		expect( toggle.parentElement ).toBe( dock );
		expect( aside.parentElement ).toBe( dock );
		// The toggle is a SIBLING of the aside, never nested inside it.
		expect( aside.contains( toggle ) ).toBe( false );
	} );

	it( 'collapsed: dock gains --collapsed, keeps the toggle, and drops the aside entirely', () => {
		const { container } = render(
			<Palette
				classes={ sampleClasses }
				collapsed
				onToggle={ jest.fn() }
			/>
		);
		const dock = container.querySelector( '.topology-palette-dock' );
		expect( dock ).not.toBeNull();
		expect(
			dock.classList.contains( 'topology-palette-dock--collapsed' )
		).toBe( true );
		// No aside in the collapsed rail — only the expand chevron remains.
		expect(
			container.querySelector( 'aside.topology-palette' )
		).toBeNull();
		const toggle = container.querySelector( '.topology-palette__toggle' );
		expect( toggle.parentElement ).toBe( dock );
		expect( toggle.getAttribute( 'aria-label' ) ).toBe( 'Expand palette' );
		expect( toggle.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
	} );

	it( 'loading placeholder renders inside the aside, under the dock', () => {
		const { container } = render(
			<Palette classes={ [] } loading onToggle={ jest.fn() } />
		);
		const dock = container.querySelector( '.topology-palette-dock' );
		expect( dock ).not.toBeNull();
		const aside = container.querySelector( 'aside.topology-palette' );
		expect( aside.parentElement ).toBe( dock );
		expect( aside.textContent ).toMatch( /Loading/ );
	} );
} );

describe( 'Palette — search clear button', () => {
	const classes = [
		{ shell_name: 'Echo', category: 'Generic' },
		{ shell_name: 'Tee', category: 'Generic' },
		{ shell_name: 'Partition', category: 'Storage' },
	];

	const shellNames = ( container ) =>
		Array.from(
			container.querySelectorAll( '.topology-palette__item' )
		).map( ( el ) => el.dataset.shellName );

	it( 'shows no clear button while the query is empty', () => {
		render( <Palette classes={ classes } loading={ false } /> );
		expect(
			screen.queryByRole( 'button', { name: /clear filter/i } )
		).toBeNull();
	} );

	it( 'clears the query, restores the full list, and refocuses the input', () => {
		const { container } = render(
			<Palette classes={ classes } loading={ false } />
		);
		const input = container.querySelector( '.topology-palette__search' );
		fireEvent.change( input, { target: { value: 'part' } } );
		expect( shellNames( container ) ).toEqual( [ 'Partition' ] );

		const clear = screen.getByRole( 'button', { name: /clear filter/i } );
		fireEvent.click( clear );

		expect( input.value ).toBe( '' );
		expect( shellNames( container ) ).toHaveLength( 3 );
		expect( document.activeElement ).toBe( input );
		expect(
			screen.queryByRole( 'button', { name: /clear filter/i } )
		).toBeNull();
	} );
} );
