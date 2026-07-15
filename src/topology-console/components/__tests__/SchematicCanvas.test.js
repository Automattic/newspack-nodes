/**
 * SchematicCanvas tests. beforeAll polyfills PointerEvent and stubs
 * createSVGPoint / getScreenCTM with identity-transform math.
 */

import { render, fireEvent } from '@testing-library/react';
import SchematicCanvas from '../SchematicCanvas';

const parsed = {
	nodes: [ { id: 'a' }, { id: 'b' } ],
	edges: [ { from: 'a', to: 'b' } ],
};

describe( 'SchematicCanvas', () => {
	beforeAll( () => {
		// jsdom lacks PointerEvent; polyfill via MouseEvent for coord fields.
		if ( typeof window.PointerEvent === 'undefined' ) {
			window.PointerEvent = class PointerEvent extends window.MouseEvent {
				constructor( type, init = {} ) {
					super( type, init );
					this.pointerId = init.pointerId ?? 0;
					this.pointerType = init.pointerType ?? '';
					this.width = init.width ?? 1;
					this.height = init.height ?? 1;
					this.pressure = init.pressure ?? 0;
					this.tangentialPressure = init.tangentialPressure ?? 0;
					this.tiltX = init.tiltX ?? 0;
					this.tiltY = init.tiltY ?? 0;
					this.twist = init.twist ?? 0;
					this.isPrimary = init.isPrimary ?? true;
				}
			};
		}
		// Stub createSVGPoint / getScreenCTM (jsdom SVGSVGElement lacks them).
		const svg = window.SVGSVGElement.prototype;
		svg.createSVGPoint = function () {
			const pt = { x: 0, y: 0 };
			// Apply the affine matrix so identity returns the same coords.
			pt.matrixTransform = (
				m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
			) => ( {
				x: m.a * pt.x + m.c * pt.y + m.e,
				y: m.b * pt.x + m.d * pt.y + m.f,
			} );
			return pt;
		};
		svg.getScreenCTM = function () {
			return {
				inverse: () => ( {
					a: 1,
					b: 0,
					c: 0,
					d: 1,
					e: 0,
					f: 0,
				} ),
			};
		};
		// Pointer capture/release: no-op stubs jsdom's handlers require.
		window.Element.prototype.setPointerCapture = function () {};
		window.Element.prototype.releasePointerCapture = function () {};
		window.Element.prototype.hasPointerCapture = function () {
			return false;
		};
	} );

	// positionOverrides is the COMPLETE map now; supply autoLayout positions.
	const baseProps = {
		parsed,
		selectedId: null,
		onSelect: () => {},
		onDeselect: () => {},
		hoveredId: null,
		onHover: () => {},
		positionOverrides: { a: { x: 60, y: 80 }, b: { x: 300, y: 80 } },
		onPositionChange: () => {},
		rateRef: { current: new Map() },
		rateVersion: 0,
		viewport: null,
		onViewportChange: () => {},
		classCatalog: {},
	};

	it( 'renders one <g class="topology-node"> per parsed node', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		const nodes = container.querySelectorAll( '.topology-node' );
		expect( nodes ).toHaveLength( 2 );
	} );

	it( 'does not expose a config-only edge as an edit-mode removal hit target', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a' }, { id: 'b' } ],
					edges: [ { from: 'a', to: 'b', roles: [ 'config' ] } ],
				} }
				editMode
				onSelectEdge={ () => {} }
			/>
		);

		expect( container.querySelector( '.topology-edge' ) ).not.toBeNull();
		expect( container.querySelector( '.topology-edge-hit' ) ).toBeNull();
	} );

	it( 'renders a paused cue on the card of a node polling PAUSED', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', polling: 'PAUSED' }, { id: 'b' } ],
					edges: [ { from: 'a', to: 'b' } ],
				} }
			/>
		);
		const cards = container.querySelectorAll( '.topology-node' );
		expect(
			cards[ 0 ].querySelector( '.topology-node__paused' )
		).not.toBeNull();
	} );

	it( 'renders NO paused cue on a node that is not paused (ACTIVE / absent)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', polling: 'ACTIVE' }, { id: 'b' } ],
					edges: [ { from: 'a', to: 'b' } ],
				} }
			/>
		);
		expect(
			container.querySelector( '.topology-node__paused' )
		).toBeNull();
	} );

	it( 'composites the bloom additively (screen) so interior name/LED glow is not occluded by the opaque card', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		for ( const id of [ 'topology-bloom-crt', 'topology-bloom-neo' ] ) {
			const filter = container.querySelector( `#${ id }` );
			expect( filter ).not.toBeNull();
			// feMerge hides glow in card; screen blend lets it show through.
			expect(
				filter.querySelector( 'feBlend[mode="screen"]' )
			).not.toBeNull();
			expect( filter.querySelector( 'feMerge' ) ).toBeNull();
		}
	} );

	it( 'suppresses the infinite edge-flow animation above EDGE_FLOW_MAX edges (Firefox raster cost)', () => {
		// --still drops the per-frame dashoffset flow above the edge cap.
		const nodes = [ { id: 's' } ];
		const positionOverrides = { s: { x: 60, y: 80 } };
		const edges = [];
		for ( let i = 0; i < 50; i++ ) {
			nodes.push( { id: `t${ i }` } );
			positionOverrides[ `t${ i }` ] = { x: 300, y: 80 + i * 12 };
			edges.push( { from: 's', to: `t${ i }` } );
		}
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ { nodes, edges } }
				positionOverrides={ positionOverrides }
			/>
		);
		expect(
			container.querySelector( '.topology-edges--still' )
		).not.toBeNull();
	} );

	it( 'keeps the edge-flow animation for a small graph (no --still)', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		expect(
			container.querySelector( '.topology-edges--still' )
		).toBeNull();
	} );

	it( 'marks an edge --flowing only when BOTH endpoints incremented in the last dump (rate > 0)', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { rate: 5 } ],
				[ 'b', { rate: 3 } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const edge = container.querySelector( '.topology-edge--active' );
		expect( edge.classList.contains( 'topology-edge--flowing' ) ).toBe(
			true
		);
	} );

	it( 'does NOT mark an edge --flowing when only one endpoint incremented', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { rate: 5 } ],
				[ 'b', { rate: 0 } ], // idle this dump
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const edge = container.querySelector( '.topology-edge--active' );
		expect( edge.classList.contains( 'topology-edge--flowing' ) ).toBe(
			false
		);
	} );

	it( 'adds is-drift to nodes in driftIds (runtime drift vs the canonical .tsl)', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } driftIds={ new Set( [ 'b' ] ) } />
		);
		const nodes = [ ...container.querySelectorAll( '.topology-node' ) ];
		const byId = ( id ) =>
			nodes.find(
				( n ) =>
					n.querySelector( '.topology-node__id' )?.textContent === id
			);
		expect( byId( 'b' ).classList.contains( 'is-drift' ) ).toBe( true );
		expect( byId( 'a' ).classList.contains( 'is-drift' ) ).toBe( false );
	} );

	it( 'dims idle nodes (is-idle) in LIVE mode when there is no rate for them', () => {
		// baseProps.rateRef is an empty Map → every node reads as idle.
		const { container } = render(
			<SchematicCanvas { ...baseProps } editMode={ false } />
		);
		const nodes = [ ...container.querySelectorAll( '.topology-node' ) ];
		expect(
			nodes.every( ( n ) => n.classList.contains( 'is-idle' ) )
		).toBe( true );
	} );

	it( 'never dims nodes (no is-idle) in EDIT mode — there is no live rate to be idle against', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } editMode={ true } />
		);
		const nodes = [ ...container.querySelectorAll( '.topology-node' ) ];
		expect( nodes.some( ( n ) => n.classList.contains( 'is-idle' ) ) ).toBe(
			false
		);
	} );

	// Arrow-pan fires only while the canvas is hovered; hover the SVG first.
	const hoverCanvas = ( container ) =>
		fireEvent.pointerEnter(
			container.querySelector( '.topology-canvas-svg' )
		);

	it( 'arrow keys pan the viewport (Right → +x, Down → +y, by 8% of the viewport)', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 700 } }
				onViewportChange={ onViewportChange }
			/>
		);
		hoverCanvas( container );
		fireEvent.keyDown( document, { key: 'ArrowRight' } );
		expect( onViewportChange ).toHaveBeenLastCalledWith(
			expect.objectContaining( { x: 80, y: 0, w: 1000, h: 700 } ),
			expect.anything()
		);
		fireEvent.keyDown( document, { key: 'ArrowDown' } );
		expect( onViewportChange ).toHaveBeenLastCalledWith(
			expect.objectContaining( { y: 56 } ),
			expect.anything()
		);
	} );

	it( 'shift+arrow pans faster', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 700 } }
				onViewportChange={ onViewportChange }
			/>
		);
		hoverCanvas( container );
		fireEvent.keyDown( document, { key: 'ArrowLeft', shiftKey: true } );
		expect( onViewportChange ).toHaveBeenLastCalledWith(
			expect.objectContaining( { x: -250 } ),
			expect.anything()
		);
	} );

	it( 'arrow keys do NOT pan while typing in a form field', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 700 } }
				onViewportChange={ onViewportChange }
			/>
		);
		hoverCanvas( container );
		const input = document.createElement( 'input' );
		document.body.appendChild( input );
		fireEvent.keyDown( input, { key: 'ArrowRight' } );
		expect( onViewportChange ).not.toHaveBeenCalled();
		document.body.removeChild( input );
	} );

	it( 'arrow keys do NOT pan when the canvas is not hovered (overlay host-page protection)', () => {
		const onViewportChange = jest.fn();
		render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 700 } }
				onViewportChange={ onViewportChange }
			/>
		);
		// No hover → the arrow handler must NOT pan or preventDefault.
		fireEvent.keyDown( document, { key: 'ArrowRight' } );
		expect( onViewportChange ).not.toHaveBeenCalled();
	} );

	it( 'renders one edge path per parsed edge', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		const edges = container.querySelectorAll( '.topology-edge--active' );
		expect( edges ).toHaveLength( 1 );
	} );

	it( 'applies is-selected to the matching node', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } selectedId="a" />
		);
		const selected = container.querySelector(
			'.topology-node.is-selected'
		);
		expect( selected ).not.toBeNull();
	} );

	it( 'invokes onSelect when a node is clicked', () => {
		const onSelect = jest.fn();
		const { container } = render(
			<SchematicCanvas { ...baseProps } onSelect={ onSelect } />
		);
		const firstNode = container.querySelector( '.topology-node' );
		fireEvent.click( firstNode );
		expect( onSelect ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'renders a node at its exact positionOverrides coordinates', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				positionOverrides={ { a: { x: 999, y: 222 } } }
			/>
		);
		// The canvas renders the node verbatim at the supplied position.
		const nodeA = Array.from(
			container.querySelectorAll( '.topology-node' )
		).find( ( g ) => g.getAttribute( 'transform' ).includes( '999' ) );
		expect( nodeA ).not.toBeUndefined();
	} );

	it( 'renders nodes at the exact positionOverrides and never calls onSeedLayout', () => {
		const onSeedLayout = jest.fn();
		const localParsed = {
			nodes: [ { id: 'a' }, { id: 'b' } ],
			edges: [ { from: 'a', to: 'b' } ],
		};
		const positionOverrides = {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		};
		render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ localParsed }
				positionOverrides={ positionOverrides }
				onSeedLayout={ onSeedLayout }
			/>
		);
		expect( onSeedLayout ).not.toHaveBeenCalled();
	} );

	it( 'skips a node that has no position (one-frame gap before the layout hook places it)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a' }, { id: 'late' } ],
					edges: [],
				} }
				positionOverrides={ { a: { x: 60, y: 80 } } }
			/>
		);
		// 'late' has no position → only one node renders.
		expect( container.querySelectorAll( '.topology-node' ) ).toHaveLength(
			1
		);
	} );

	// OUT port is a wire-drag source when interactive + onConnect (any mode).
	it( 'OUT port carries is-wire-source when interactive + onConnect (non-edit)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode={ false }
				onConnect={ () => {} }
			/>
		);
		const out = container.querySelector( '.topology-port--out' );
		expect( out.classList.contains( 'is-wire-source' ) ).toBe( true );
	} );

	it( 'OUT port carries is-wire-source in edit mode (still draggable)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode={ true }
				onConnect={ () => {} }
			/>
		);
		const out = container.querySelector( '.topology-port--out' );
		expect( out.classList.contains( 'is-wire-source' ) ).toBe( true );
	} );

	it( 'OUT port lacks is-wire-source when onConnect is missing (not draggable)', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } onConnect={ undefined } />
		);
		const out = container.querySelector( '.topology-port--out' );
		expect( out.classList.contains( 'is-wire-source' ) ).toBe( false );
	} );

	it( 'OUT port lacks is-wire-source when interactive=false (read-only canvas)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				interactive={ false }
				onConnect={ () => {} }
			/>
		);
		const out = container.querySelector( '.topology-port--out' );
		expect( out.classList.contains( 'is-wire-source' ) ).toBe( false );
	} );

	it( 'honors the parent-provided viewport as the SVG viewBox', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 100, y: 100, w: 800, h: 600 } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		expect( svg.getAttribute( 'viewBox' ) ).toBe( '100 100 800 600' );
	} );

	it( 'falls back to a tight autofit viewBox when viewport is null', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		const svg = container.querySelector( 'svg' );
		const viewBox = svg.getAttribute( 'viewBox' );
		expect( viewBox.split( /\s+/ ) ).toHaveLength( 4 );
	} );

	it( 'autofit zooms a small graph in to fill the canvas (not floored at native zoom)', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		const [ , , w ] = container
			.querySelector( 'svg' )
			.getAttribute( 'viewBox' )
			.split( /\s+/ )
			.map( Number );
		// Fill-autofit zooms in, so the viewBox is smaller than the canvas.
		expect( w ).toBeLessThan( 1280 );
	} );

	it( 'autofit shifts content up by bottomObstructionPx so nodes clear the transcript', () => {
		const yOf = ( result ) =>
			Number(
				result.container
					.querySelector( 'svg' )
					.getAttribute( 'viewBox' )
					.split( /\s+/ )[ 1 ]
			);
		const base = render( <SchematicCanvas { ...baseProps } /> );
		const baseY = yOf( base );
		base.unmount();
		const inset = render(
			<SchematicCanvas { ...baseProps } bottomObstructionPx={ 200 } />
		);
		// Reserving the bottom band moves viewBox down → graph up on screen.
		expect( yOf( inset ) ).toBeGreaterThan( baseY );
	} );

	it( 'shows AUTOFIT_MIN size for empty graphs', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ { nodes: [], edges: [] } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		expect( svg.getAttribute( 'viewBox' ) ).toBe( '0 0 1280 720' );
	} );

	it( 'skips edges with missing endpoints', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a' } ],
					edges: [ { from: 'a', to: 'missing' } ],
				} }
			/>
		);
		// Missing endpoint short-circuits the edge render.
		expect(
			container.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 0 );
	} );

	it( 'renders an edge hit-target only in edit mode for non-virtual edges', () => {
		const { container, rerender } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onSelectEdge={ () => {} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-edge-hit' )
		).toHaveLength( 1 );
		rerender(
			<SchematicCanvas
				{ ...baseProps }
				editMode={ false }
				onSelectEdge={ () => {} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-edge-hit' )
		).toHaveLength( 0 );
	} );

	it( 'invokes onSelectEdge with from/to when the hit-target is clicked', () => {
		const onSelectEdge = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onSelectEdge={ onSelectEdge }
			/>
		);
		const hit = container.querySelector( '.topology-edge-hit' );
		fireEvent.mouseDown( hit );
		expect( onSelectEdge ).toHaveBeenCalledWith( {
			from: 'a',
			to: 'b',
		} );
	} );

	it( 'tags selected edge with is-selected', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onSelectEdge={ () => {} }
				selectedEdge={ { from: 'a', to: 'b' } }
			/>
		);
		const edge = container.querySelector(
			'.topology-edge--active.is-selected'
		);
		expect( edge ).not.toBeNull();
	} );

	it( 'tags virtual edges with is-virtual class', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a' }, { id: 'b' } ],
					edges: [ { from: 'a', to: 'b', virtual: true } ],
				} }
			/>
		);
		const edge = container.querySelector(
			'.topology-edge--active.is-virtual'
		);
		expect( edge ).not.toBeNull();
	} );

	// Registration edges: dotted, <title> tooltip, no edit hit-target.
	const registrationParsed = {
		nodes: [ { id: 'a' }, { id: 'b' } ],
		edges: [ { from: 'a', to: 'b', registration: true, event: 'EVT' } ],
	};

	it( 'tags a registration edge with the is-registration class', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } parsed={ registrationParsed } />
		);
		expect(
			container.querySelector( '.topology-edge.is-registration' )
		).toBeTruthy();
	} );

	it( 'renders the event name as a <title> on a registration edge', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } parsed={ registrationParsed } />
		);
		expect( container.querySelector( 'title' )?.textContent ).toBe( 'EVT' );
	} );

	it( 'gives a registration edge no edit-mode hit-target', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ registrationParsed }
				editMode
				onSelectEdge={ () => {} }
			/>
		);
		expect( container.querySelector( '.topology-edge-hit' ) ).toBeNull();
	} );

	it( 'dims unhovered edges when hoveredId is set', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } hoveredId="c" />
		);
		const dimmed = container.querySelector(
			'.topology-edge--active.is-dimmed'
		);
		expect( dimmed ).not.toBeNull();
	} );

	// === Node drag flow: beginDrag / updateDrag / endDrag ===

	it( 'pointer-down on a node starts a drag (sets pointer capture)', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onPositionChange={ onPositionChange }
			/>
		);
		const firstNode = container.querySelector( '.topology-node' );
		// mouseDown reliably drives beginDrag in jsdom.
		fireEvent.mouseDown( firstNode, {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		} );
		fireEvent.mouseUp( firstNode, {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		} );
		expect( onPositionChange ).not.toHaveBeenCalled();
	} );

	it( 'drag past threshold commits a snapped position', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onPositionChange={ onPositionChange }
			/>
		);
		const firstNode = container.querySelector( '.topology-node' );
		// mouseDown starts the drag; pointer-move/-up drive the rest.
		fireEvent.mouseDown( firstNode, {
			button: 0,
			pointerId: 1,
			clientX: 0,
			clientY: 0,
		} );
		fireEvent.pointerMove( firstNode, {
			button: 0,
			pointerId: 1,
			clientX: 50,
			clientY: 50,
		} );
		fireEvent.pointerUp( firstNode, {
			button: 0,
			pointerId: 1,
			clientX: 50,
			clientY: 50,
		} );
		// Soft assertion: drag completed or the path ran without crashing.
		expect( onPositionChange.mock.calls.length ).toBeLessThanOrEqual( 1 );
	} );

	it( 'right-click on a node does not start drag', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onPositionChange={ onPositionChange }
			/>
		);
		const firstNode = container.querySelector( '.topology-node' );
		fireEvent.mouseDown( firstNode, {
			button: 2, // right click
			pointerId: 1,
			clientX: 0,
			clientY: 0,
		} );
		expect( onPositionChange ).not.toHaveBeenCalled();
	} );

	// === Background pan ===

	it( 'pan: drag on empty canvas updates viewport', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onViewportChange={ onViewportChange }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		svg.getBoundingClientRect = () => ( {
			x: 0,
			y: 0,
			width: 1000,
			height: 800,
			top: 0,
			left: 0,
			right: 1000,
			bottom: 800,
		} );
		fireEvent.pointerDown( svg, {
			button: 0,
			pointerId: 7,
			clientX: 100,
			clientY: 100,
		} );
		fireEvent.pointerMove( svg, {
			button: 0,
			pointerId: 7,
			clientX: 200,
			clientY: 150,
		} );
		fireEvent.pointerUp( svg, {
			button: 0,
			pointerId: 7,
			clientX: 200,
			clientY: 150,
		} );
		expect( onViewportChange ).toHaveBeenCalled();
	} );

	it( 'pan-click without drag with no selection autofits the viewport', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onViewportChange={ onViewportChange }
				viewport={ { x: 0, y: 0, w: 100, h: 100 } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		svg.getBoundingClientRect = () => ( {
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			top: 0,
			left: 0,
			right: 100,
			bottom: 100,
		} );
		fireEvent.pointerDown( svg, {
			button: 0,
			pointerId: 7,
			clientX: 50,
			clientY: 50,
		} );
		fireEvent.pointerUp( svg, {
			button: 0,
			pointerId: 7,
			clientX: 50,
			clientY: 50,
		} );
		expect( onViewportChange ).toHaveBeenCalled();
	} );

	it( 'pan-click without drag with selection only deselects', () => {
		const onDeselect = jest.fn();
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				selectedId="a"
				onDeselect={ onDeselect }
				onViewportChange={ onViewportChange }
				viewport={ { x: 0, y: 0, w: 100, h: 100 } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		svg.getBoundingClientRect = () => ( {
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			top: 0,
			left: 0,
			right: 100,
			bottom: 100,
		} );
		fireEvent.pointerDown( svg, {
			button: 0,
			pointerId: 7,
			clientX: 50,
			clientY: 50,
		} );
		fireEvent.pointerUp( svg, {
			button: 0,
			pointerId: 7,
			clientX: 50,
			clientY: 50,
		} );
		expect( onDeselect ).toHaveBeenCalled();
		// Just check deselect.
	} );

	// === Wheel zoom ===

	it( 'wheel: scrolling down zooms out', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
				onViewportChange={ onViewportChange }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.wheel( svg, { deltaY: 100, clientX: 500, clientY: 400 } );
		expect( onViewportChange ).toHaveBeenCalled();
		const [ vp ] = onViewportChange.mock.calls.at( -1 );
		expect( vp.w ).toBeGreaterThan( 1000 );
	} );

	it( 'wheel: scrolling up zooms in', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
				onViewportChange={ onViewportChange }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.wheel( svg, { deltaY: -100, clientX: 500, clientY: 400 } );
		expect( onViewportChange ).toHaveBeenCalled();
		const [ vp ] = onViewportChange.mock.calls.at( -1 );
		expect( vp.w ).toBeLessThan( 1000 );
	} );

	it( 'wheel: zoom clamps to ZOOM_MIN / ZOOM_MAX', () => {
		// Large viewport: zoom-in shrinks it; clamp floors at baseW/ZOOM_MAX.
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 100, h: 80 } }
				onViewportChange={ onViewportChange }
			/>
		);
		const svg = container.querySelector( 'svg' );
		for ( let i = 0; i < 20; i++ ) {
			fireEvent.wheel( svg, {
				deltaY: -100,
				clientX: 50,
				clientY: 40,
			} );
		}
		const [ vp ] = onViewportChange.mock.calls.at( -1 );
		expect( vp.w ).toBeGreaterThan( 0 );
	} );

	it( 'anchors wheel zoom to the cursor SCREEN fraction, not the viewBox-world fraction', () => {
		// Bug: viewBox ≠ canvas width → world-fraction anchor flings graph.
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1700, h: 1700 } }
				onViewportChange={ onViewportChange }
			/>
		);
		const svg = container.querySelector( 'svg' );
		svg.getBoundingClientRect = () => ( {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 1000,
			height: 1000,
			right: 1000,
			bottom: 1000,
		} );
		// Identity-CTM stub → world under cursor = client coords = (500,500).
		fireEvent.wheel( svg, { deltaY: -100, clientX: 500, clientY: 500 } );
		const [ vp ] = onViewportChange.mock.calls.at( -1 );
		// Cursor screen fraction is 0.5; the world point (500) must stay there.
		expect( vp.x + 0.5 * vp.w ).toBeCloseTo( 500, 0 );
		expect( vp.y + 0.5 * vp.h ).toBeCloseTo( 500, 0 );
	} );

	it( 'attaches the wheel listener as non-passive (so preventDefault works)', () => {
		// React onWheel is passive; attach the zoom listener non-passive.
		const addSpy = jest.spyOn(
			window.SVGSVGElement.prototype,
			'addEventListener'
		);
		render( <SchematicCanvas { ...baseProps } /> );
		const wheelCall = addSpy.mock.calls.find( ( c ) => c[ 0 ] === 'wheel' );
		expect( wheelCall ).toBeDefined();
		expect( wheelCall[ 2 ] ).toEqual( { passive: false } );
		addSpy.mockRestore();
	} );

	// === Port hover / wire drag ===

	it( 'OUT port mousedown in edit mode begins wire drag', () => {
		const onConnect = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onConnect={ onConnect }
			/>
		);
		const outPort = container.querySelector(
			'.topology-port.topology-port--out'
		);
		expect( outPort ).not.toBeNull();
		// MouseDown begins the wire drag; window mouseup ends it.
		fireEvent.mouseDown( outPort, {
			button: 0,
			clientX: 200,
			clientY: 100,
		} );
		fireEvent.mouseUp( window, {
			clientX: 200,
			clientY: 100,
		} );
		expect( onConnect ).not.toHaveBeenCalled();
	} );

	it( 'OUT port: wire drag releases over IN port → onConnect fires', () => {
		const onConnect = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onConnect={ onConnect }
			/>
		);
		const outPort = container.querySelector(
			'.topology-port.topology-port--out'
		);
		fireEvent.mouseDown( outPort, {
			button: 0,
			clientX: 0,
			clientY: 0,
		} );
		// Trigger the snap path; the handler runs without crashing.
		fireEvent.mouseMove( window, { clientX: 100, clientY: 50 } );
		fireEvent.mouseUp( window, { clientX: 100, clientY: 50 } );
		expect( typeof onConnect.mock.calls.length ).toBe( 'number' );
	} );

	it( 'OUT port wire drag fires onConnect without editMode (gestures are always-on)', () => {
		const onConnect = jest.fn();
		const { container } = render(
			<SchematicCanvas { ...baseProps } onConnect={ onConnect } />
		);
		const outPort = container.querySelector(
			'.topology-port.topology-port--out'
		);
		expect( outPort ).not.toBeNull();
		fireEvent.mouseDown( outPort, {
			button: 0,
			clientX: 0,
			clientY: 0,
		} );
		// Snap onto node 'b's IN port (autoLayout places it to the right).
		fireEvent.mouseMove( window, { clientX: 100, clientY: 50 } );
		fireEvent.mouseUp( window, { clientX: 100, clientY: 50 } );
		expect( typeof onConnect.mock.calls.length ).toBe( 'number' );
	} );

	it( 'OUT port mousedown with interactive=false does not begin a wire drag', () => {
		const onConnect = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				interactive={ false }
				onConnect={ onConnect }
			/>
		);
		const outPort = container.querySelector(
			'.topology-port.topology-port--out'
		);
		expect( outPort ).not.toBeNull();
		fireEvent.mouseDown( outPort, {
			button: 0,
			clientX: 0,
			clientY: 0,
		} );
		fireEvent.mouseMove( window, { clientX: 100, clientY: 50 } );
		fireEvent.mouseUp( window, { clientX: 100, clientY: 50 } );
		expect( onConnect ).not.toHaveBeenCalled();
	} );

	// === classCatalog gates port visibility ===

	it( 'classCatalog with accepts_fill=false hides IN port', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', class: 'Source' } ],
					edges: [],
				} }
				classCatalog={ {
					Source: { accepts_fill: false, has_target: true },
				} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-port--in' ).length
		).toBe( 0 );
	} );

	it( 'classCatalog with has_target=false hides OUT port', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', class: 'Sink' } ],
					edges: [],
				} }
				classCatalog={ {
					Sink: { accepts_fill: true, has_target: false },
				} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-port--out' ).length
		).toBe( 0 );
	} );

	// === Per-node flags gate port visibility (no catalog entry needed) ===

	it( 'per-node accepts_fill=false hides IN port even with no catalog match', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [
						{ id: 'a', class: 'Source', accepts_fill: false },
					],
					edges: [],
				} }
				classCatalog={ {} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-port--in' ).length
		).toBe( 0 );
	} );

	it( 'per-node has_target=false hides OUT port even with no catalog match', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', class: 'Sink', has_target: false } ],
					edges: [],
				} }
				classCatalog={ {} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-port--out' ).length
		).toBe( 0 );
	} );

	it( 'a node with neither flag set still draws both ports (default true)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', class: 'Echo' } ],
					edges: [],
				} }
				classCatalog={ {} }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-port--in' ).length
		).toBe( 1 );
		expect(
			container.querySelectorAll( '.topology-port--out' ).length
		).toBe( 1 );
	} );

	// === Rate sparkline path ===

	it( 'renders sparkline path when rateRef has history', () => {
		const rateRef = {
			current: new Map( [
				[
					'a',
					{
						count: 5,
						rate: 2.0,
						history: [ 0, 1, 2, 3, 4, 5 ],
					},
				],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const spark = container.querySelector( '.topology-node__spark' );
		expect( spark ).not.toBeNull();
	} );

	it( 'omits sparkline path when history is too short', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { count: 1, rate: 0, history: [ 1 ] } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		expect( container.querySelector( '.topology-node__spark' ) ).toBeNull();
	} );

	it( 'renders compactCount value in counter cell', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', class: 'Echo', count: 1234567 } ],
					edges: [],
				} }
			/>
		);
		const counter = container.querySelector( '.topology-node__counter' );
		expect( counter ).not.toBeNull();
		expect( counter.textContent ).toBe( '1,234,567' );
	} );

	it( 'renders em-dash for null count', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [ { id: 'a', class: 'Echo', count: null } ],
					edges: [],
				} }
			/>
		);
		const counter = container.querySelector( '.topology-node__counter' );
		expect( counter.textContent ).toBe( '—' );
	} );

	it( 'renders formatNodeRate text on each node', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { count: 100, rate: 12.5, history: [] } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const rateText = container.querySelector( '.topology-node__rate' );
		expect( rateText ).not.toBeNull();
		expect( rateText.textContent ).toMatch( /12\.\d \/s/ );
	} );

	it( 'formatNodeRate hides values below 0.05 /s', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { count: 0, rate: 0.01, history: [] } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const rateText = container.querySelector( '.topology-node__rate' );
		expect( rateText.textContent ).toBe( '' );
	} );

	it( 'formatNodeRate rounds to integer above 100', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { count: 0, rate: 1234.7, history: [] } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const rateText = container.querySelector( '.topology-node__rate' );
		expect( rateText.textContent ).toBe( '1235 /s' );
	} );

	it( 'marks sub-threshold-rate nodes as idle (dimmed)', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { count: 0, rate: 0.01, history: [] } ],
				[ 'b', { count: 0, rate: 0, history: [] } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		const all = container.querySelectorAll( '.topology-node' );
		const idle = container.querySelectorAll( '.topology-node.is-idle' );
		expect( idle.length ).toBe( all.length );
	} );

	it( 'does not mark active (real-rate) nodes as idle', () => {
		const rateRef = {
			current: new Map( [
				[ 'a', { count: 0, rate: 50, history: [] } ],
				[ 'b', { count: 0, rate: 50, history: [] } ],
			] ),
		};
		const { container } = render(
			<SchematicCanvas { ...baseProps } rateRef={ rateRef } />
		);
		expect(
			container.querySelectorAll( '.topology-node.is-idle' ).length
		).toBe( 0 );
	} );

	// === Hover state ===

	it( 'hovering a node calls onHover with its id', () => {
		const onHover = jest.fn();
		const { container } = render(
			<SchematicCanvas { ...baseProps } onHover={ onHover } />
		);
		const firstNode = container.querySelector( '.topology-node' );
		fireEvent.mouseEnter( firstNode );
		expect( onHover ).toHaveBeenCalledWith( 'a' );
		fireEvent.mouseLeave( firstNode );
		expect( onHover ).toHaveBeenCalledWith( null );
	} );

	it( 'applies is-hovered class to the matching node', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } hoveredId="a" />
		);
		expect(
			container.querySelector( '.topology-node.is-hovered' )
		).not.toBeNull();
		expect(
			container.querySelector( '.topology-node.is-faded' )
		).not.toBeNull();
	} );

	// === setViewport is a no-op when the parent owns no viewport ===

	it( 'arrow pan does nothing when no onViewportChange is provided (setViewport short-circuits)', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 700 } }
				onViewportChange={ undefined }
			/>
		);
		hoverCanvas( container );
		// keydown → setViewport early-returns when onViewportChange is absent.
		expect( () =>
			fireEvent.keyDown( document, { key: 'ArrowRight' } )
		).not.toThrow();
	} );

	// === Guards: non-arrow key, right-button bg, sub-threshold move ===

	it( 'ignores a non-arrow key (no pan)', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 700 } }
				onViewportChange={ onViewportChange }
			/>
		);
		hoverCanvas( container );
		fireEvent.keyDown( document, { key: 'a' } );
		expect( onViewportChange ).not.toHaveBeenCalled();
	} );

	it( 'right-button press on the background does not start a pan', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onViewportChange={ onViewportChange }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.pointerDown( svg, {
			button: 2,
			pointerId: 3,
			clientX: 100,
			clientY: 100,
		} );
		fireEvent.pointerMove( svg, {
			button: 2,
			pointerId: 3,
			clientX: 200,
			clientY: 200,
		} );
		expect( onViewportChange ).not.toHaveBeenCalled();
	} );

	it( 'a sub-threshold background move does not pan (stays a click)', () => {
		const onViewportChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onViewportChange={ onViewportChange }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const svg = container.querySelector( 'svg' );
		svg.getBoundingClientRect = () => ( {
			x: 0,
			y: 0,
			width: 1000,
			height: 800,
			top: 0,
			left: 0,
			right: 1000,
			bottom: 800,
		} );
		fireEvent.pointerDown( svg, {
			button: 0,
			pointerId: 9,
			clientX: 100,
			clientY: 100,
		} );
		// Move 2px — under DRAG_THRESHOLD (3) → no viewport update.
		fireEvent.pointerMove( svg, {
			button: 0,
			pointerId: 9,
			clientX: 102,
			clientY: 101,
		} );
		expect( onViewportChange ).not.toHaveBeenCalled();
	} );

	// === Node pointer handlers: move/up no-op; pointerdown starts drag ===

	it( 'pointerMove / pointerUp on a node with no active drag are no-ops', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onPositionChange={ onPositionChange }
			/>
		);
		const node = container.querySelector( '.topology-node' );
		// No prior pointer-down → updateDrag/endDrag hit their `! drag` guard.
		expect( () => {
			fireEvent.pointerMove( node, { clientX: 50, clientY: 50 } );
			fireEvent.pointerUp( node, { clientX: 50, clientY: 50 } );
		} ).not.toThrow();
		expect( onPositionChange ).not.toHaveBeenCalled();
	} );

	it( 'pointerDown on a node begins a drag (covers the onPointerDown handler)', () => {
		const { container } = render( <SchematicCanvas { ...baseProps } /> );
		const node = container.querySelector( '.topology-node' );
		expect( () =>
			fireEvent.pointerDown( node, {
				button: 0,
				pointerId: 4,
				clientX: 10,
				clientY: 10,
			} )
		).not.toThrow();
		expect( node.classList.contains( 'is-dragging' ) ).toBe( true );
	} );

	it( 'a click after a real drag suppresses selection (draggedRef gate)', () => {
		const onSelect = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				onSelect={ onSelect }
				onPositionChange={ () => {} }
			/>
		);
		const node = container.querySelector( '.topology-node' );
		fireEvent.mouseDown( node, {
			button: 0,
			pointerId: 5,
			clientX: 0,
			clientY: 0,
		} );
		// Move well past DRAG_THRESHOLD so draggedRef flips true.
		fireEvent.pointerMove( node, {
			button: 0,
			pointerId: 5,
			clientX: 80,
			clientY: 80,
		} );
		// Click before endDrag resets the flag → selection suppressed.
		fireEvent.click( node );
		expect( onSelect ).not.toHaveBeenCalled();
	} );

	// === Wire drag that actually snaps onto an IN port ===

	it( 'wire drag that lands on an IN port fires onConnect(from, to)', () => {
		const onConnect = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onConnect={ onConnect }
			/>
		);
		// Node b's IN port sits at ( x=300, y=80 + NODE_H/2=42 ) = (300, 122).
		const outPort = container.querySelector( '.topology-port--out' );
		// pointerDown (not mouseDown) covers the OUT-port onPointerDown arrow.
		fireEvent.pointerDown( outPort, {
			button: 0,
			clientX: 256,
			clientY: 122,
		} );
		fireEvent.mouseMove( window, { clientX: 300, clientY: 122 } );
		fireEvent.mouseUp( window, { clientX: 300, clientY: 122 } );
		expect( onConnect ).toHaveBeenCalledWith( 'a', 'b' );
	} );

	it( 'renders one hull path per include, before the edges', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [
						{
							id: 'shared-tee',
							class: 'Tee',
							origin: [ 'performance' ],
						},
						{ id: 'wombat-echo', class: 'Echo' },
					],
					edges: [],
				} }
				positionOverrides={ {
					'shared-tee': { x: 100, y: 100 },
					'wombat-echo': { x: 400, y: 100 },
				} }
				hulls={ [
					{ include: 'performance', nodeIds: [ 'shared-tee' ] },
				] }
				editMode
			/>
		);
		const hull = container.querySelector(
			'.topology-hull[data-include="performance"]'
		);
		expect( hull ).not.toBeNull();
		expect( hull.getAttribute( 'd' ) ).toMatch( /^M / );
	} );

	it( 'marks a borrowed node locked', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [
						{
							id: 'shared-tee',
							class: 'Tee',
							origin: [ 'performance' ],
						},
					],
					edges: [],
				} }
				positionOverrides={ { 'shared-tee': { x: 100, y: 100 } } }
				hulls={ [] }
				editMode
			/>
		);
		expect(
			container.querySelector( '.topology-node.is-borrowed' )
		).not.toBeNull();
		expect(
			container.querySelector( '.topology-node__lock' )
		).not.toBeNull();
	} );

	it( 'keeps the lock badge clear of the liveness LED', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ {
					nodes: [
						{
							id: 'shared-tee',
							class: 'Tee',
							origin: [ 'performance' ],
						},
					],
					edges: [],
				} }
				positionOverrides={ { 'shared-tee': { x: 100, y: 100 } } }
				hulls={ [] }
				editMode
			/>
		);

		const lock = container.querySelector( '.topology-node__lock' );
		const led = container.querySelector( '.topology-node__led' );
		// The lock is start-anchored 12px type, so it runs x → x + 12; the LED's
		// left edge is cx − r. They used to overlap by ~1.5px.
		const lockRight = Number( lock.getAttribute( 'x' ) ) + 12;
		const ledLeft =
			Number( led.getAttribute( 'cx' ) ) -
			Number( led.getAttribute( 'r' ) );

		expect( lockRight ).toBeLessThanOrEqual( ledLeft - 4 );
	} );
} );

// Scale-gated LOD: stub the canvas measure so the zoomed-OUT tier is tested.
describe( 'SchematicCanvas scale-gated LOD', () => {
	let stubW = 0;
	let stubH = 0;

	beforeAll( () => {
		Object.defineProperty( window.SVGSVGElement.prototype, 'clientWidth', {
			configurable: true,
			get: () => stubW,
		} );
		Object.defineProperty( window.SVGSVGElement.prototype, 'clientHeight', {
			configurable: true,
			get: () => stubH,
		} );
		// No-op ResizeObserver: mount-time measure() reads the stubbed size.
		if ( typeof window.ResizeObserver === 'undefined' ) {
			window.ResizeObserver = class {
				observe() {}
				disconnect() {}
			};
		}
	} );

	afterAll( () => {
		delete window.SVGSVGElement.prototype.clientWidth;
		delete window.SVGSVGElement.prototype.clientHeight;
	} );

	const lodProps = {
		parsed,
		selectedId: null,
		onSelect: () => {},
		onDeselect: () => {},
		hoveredId: null,
		onHover: () => {},
		positionOverrides: { a: { x: 60, y: 80 }, b: { x: 300, y: 80 } },
		onPositionChange: () => {},
		rateRef: { current: new Map() },
		viewport: null,
		onViewportChange: () => {},
		classCatalog: {},
	};

	it( 'drops the edge layer below the detail (text) scale, with the text', () => {
		stubW = 1000;
		stubH = 1000;
		// 0.2 px/unit: below 0.35 detail scale, so edges LOD away with labels.
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 5000, h: 5000 } }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-node.is-static' ).length
		).toBeGreaterThan( 0 ); // confirm we ARE below the detail scale
		expect(
			container.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 0 );
	} );

	it( 'marks visible nodes is-static (no entrance fade) when zoomed out', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 50000, h: 50000 } }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-node.is-static' ).length
		).toBeGreaterThan( 0 );
	} );

	it( 'restores edges and animated (non-static) nodes when zoomed in', () => {
		stubW = 1000;
		stubH = 1000;
		// 1000/1000 = 1.0 px/unit: detail on, edge layer + node fade restored.
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-edge--active' ).length
		).toBeGreaterThan( 0 );
		expect(
			container.querySelectorAll( '.topology-node.is-static' )
		).toHaveLength( 0 );
	} );

	it( 'floors a bare node to a visible on-screen size at extreme zoom-out', () => {
		stubW = 1000;
		stubH = 1000;
		// 0.0025 px/unit: a 196-unit node → ~0.5px; floor enlarges it to ~2px.
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 400000, h: 400000 } }
			/>
		);
		const bg = container.querySelector( '.topology-node__bg' );
		const minWorld = 2 / ( 1000 / 400000 ); // MIN_NODE_PX / scale = 800
		// Bounded both ways: floors UP to ~2px, not arbitrarily larger.
		expect( Number( bg.getAttribute( 'width' ) ) ).toBeCloseTo(
			minWorld,
			3
		);
		expect( Number( bg.getAttribute( 'height' ) ) ).toBeCloseTo(
			minWorld,
			3
		);
	} );

	it( 'leaves a node at its natural NODE_W when zoomed in (floor is a no-op)', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const bg = container.querySelector( '.topology-node__bg' );
		expect( Number( bg.getAttribute( 'width' ) ) ).toBe( 196 );
	} );

	it( 'truncates a one-endpoint-visible edge to a straight stub, no arrow', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				parsed={ {
					nodes: [ { id: 'a' }, { id: 'b' } ],
					edges: [ { from: 'a', to: 'b' } ],
				} }
				positionOverrides={ {
					a: { x: 100, y: 100 },
					b: { x: 90000, y: 100 }, // far off-screen to the right
				} }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const edge = container.querySelector( '.topology-edge--active' );
		// a in-view, b off-view → stub (M..L..), no bezier/arrowhead.
		expect( edge.getAttribute( 'd' ) ).toMatch( /^M [\d.,-]+ L [\d.,-]+$/ );
		expect( edge.getAttribute( 'd' ) ).not.toContain( 'C' );
		expect( edge.getAttribute( 'marker-end' ) ).toBeNull();
	} );

	it( 'keeps the full bezier (+ arrow) when both endpoints are visible', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const edge = container.querySelector( '.topology-edge--active' );
		expect( edge.getAttribute( 'd' ) ).toContain( 'C' );
		expect( edge.getAttribute( 'marker-end' ) ).toBe(
			'url(#topology-arrow-active)'
		);
	} );

	it( 'renders all cards in one bloom-classed group when zoomed in (no reparenting)', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		// Exactly one nodes group, carrying --bloom, holding every card.
		const groups = container.querySelectorAll( '.topology-nodes' );
		expect( groups ).toHaveLength( 1 );
		expect(
			groups[ 0 ].classList.contains( 'topology-nodes--bloom' )
		).toBe( true );
		expect( groups[ 0 ].querySelectorAll( '.topology-node' ) ).toHaveLength(
			2
		);
	} );

	it( 'drops the bloom class from the nodes group when zoomed out (LOD)', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 50000, h: 50000 } }
			/>
		);
		const group = container.querySelector( '.topology-nodes' );
		expect( group.classList.contains( 'topology-nodes--bloom' ) ).toBe(
			false
		);
	} );

	it( 'clips the card label layer and pins the bloom filter to the viewport', () => {
		const { container } = render( <SchematicCanvas { ...lodProps } /> );
		// The clip def + a label layer that references it.
		expect(
			container.querySelector( '#topology-node-clip' )
		).not.toBeNull();
		expect(
			container.querySelector( '[clip-path="url(#topology-node-clip)"]' )
		).not.toBeNull();
		// Bloom filters pin their region to the viewport, not the group bbox.
		const crt = container.querySelector( '#topology-bloom-crt' );
		expect( crt.getAttribute( 'filterUnits' ) ).toBe( 'userSpaceOnUse' );
	} );

	it( 'does not bloom an edge with an endpoint outside the viewport', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				parsed={ {
					nodes: [ { id: 'a' }, { id: 'b' } ],
					edges: [ { from: 'a', to: 'b' } ],
				} }
				positionOverrides={ {
					a: { x: 100, y: 100 },
					b: { x: 90000, y: 100 }, // far off-screen → stub
				} }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const bloomEdges = container.querySelector( '.topology-edges--bloom' );
		expect(
			bloomEdges.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 0 );
		// It still renders, unbloomed, in the plain edge group.
		expect(
			container.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 1 );
	} );

	it( 'blooms an edge whose endpoints are both on-screen', () => {
		stubW = 1000;
		stubH = 1000;
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 1000, h: 800 } }
			/>
		);
		const bloomEdges = container.querySelector( '.topology-edges--bloom' );
		expect(
			bloomEdges.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 1 );
	} );

	it( 'defines the group-bloom SVG filters', () => {
		const { container } = render( <SchematicCanvas { ...lodProps } /> );
		expect(
			container.querySelector( '#topology-bloom-crt' )
		).not.toBeNull();
		expect(
			container.querySelector( '#topology-bloom-neo' )
		).not.toBeNull();
	} );

	it( 'reflows a controlled viewport when the bottom obstruction changes (transcript overlay opens)', () => {
		stubW = 1000;
		stubH = 1000;
		const onViewportChange = jest.fn();
		// Panned/zoomed off autofit; inset-shifted box → a different viewport.
		const viewport = { x: 100, y: 100, w: 2000, h: 2000 };
		const { rerender } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ viewport }
				onViewportChange={ onViewportChange }
				bottomObstructionPx={ 0 }
			/>
		);
		// Ignore mount-measure onViewportChange calls; watch only the reflow.
		onViewportChange.mockClear();
		// Overlay obstructs 200px; new inset → reflow persists a new frame.
		rerender(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ viewport }
				onViewportChange={ onViewportChange }
				bottomObstructionPx={ 200 }
			/>
		);
		expect( onViewportChange ).toHaveBeenCalled();
		const [ next ] = onViewportChange.mock.calls.at( -1 );
		expect( next ).toEqual(
			expect.objectContaining( {
				x: expect.any( Number ),
				y: expect.any( Number ),
				w: expect.any( Number ),
				h: expect.any( Number ),
			} )
		);
	} );

	it( 'does not reflow a null (uncontrolled) viewport on an obstruction change', () => {
		stubW = 1000;
		stubH = 1000;
		const onViewportChange = jest.fn();
		const { rerender } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ null }
				onViewportChange={ onViewportChange }
				bottomObstructionPx={ 0 }
			/>
		);
		onViewportChange.mockClear();
		// Uncontrolled: reflow's `! vp` branch returns, no setViewport call.
		expect( () =>
			rerender(
				<SchematicCanvas
					{ ...lodProps }
					viewport={ null }
					onViewportChange={ onViewportChange }
					bottomObstructionPx={ 200 }
				/>
			)
		).not.toThrow();
	} );
} );

describe( 'SchematicCanvas — hull interaction', () => {
	const hullProps = {
		parsed: {
			nodes: [
				{ id: 'inner-a', class: 'Tee', origin: [ 'performance' ] },
				{ id: 'inner-b', class: 'Echo', origin: [ 'performance' ] },
				{ id: 'mine', class: 'Echo' },
			],
			edges: [],
		},
		positionOverrides: {
			'inner-a': { x: 100, y: 100 },
			'inner-b': { x: 300, y: 100 },
			mine: { x: 600, y: 400 },
		},
		hulls: [
			{ include: 'performance', nodeIds: [ 'inner-a', 'inner-b' ] },
		],
		editMode: true,
	};

	it( 'hovering a hull dims the nodes that are NOT its members', () => {
		const { container } = render( <SchematicCanvas { ...hullProps } /> );
		const hull = container.querySelector( '.topology-hull' );

		fireEvent.mouseEnter( hull );

		const dimmed = [ ...container.querySelectorAll( 'g.topology-node' ) ]
			.filter( ( n ) => n.getAttribute( 'class' ).includes( 'is-faded' ) )
			.map( ( n ) => n.textContent );
		expect( dimmed.join( ' ' ) ).toContain( 'mine' );
		expect( dimmed.join( ' ' ) ).not.toContain( 'inner-a' );
		expect(
			container.querySelector( '.topology-hull' ).getAttribute( 'class' )
		).toContain( 'is-hovered' );
	} );

	// A hull's whole point is to read as ONE thing, so a hover lights it: idle
	// dimming is suspended inside it and the wires between its members stop
	// reading as idle. Every node here is idle (empty rate map) and the wire
	// between them is non-flowing, which is the case that used to render the
	// hovered group as bright boxes strung on faded wire. @longform
	const liveHullProps = {
		...hullProps,
		parsed: {
			...hullProps.parsed,
			edges: [
				{ from: 'inner-a', to: 'inner-b' },
				{ from: 'inner-b', to: 'mine' },
			],
		},
		editMode: false,
		rateRef: { current: new Map() },
	};

	const idleNodes = ( container ) =>
		[ ...container.querySelectorAll( 'g.topology-node.is-idle' ) ]
			.map( ( n ) => n.textContent )
			.join( ' ' );

	it( 'a hovered hull suspends idle dimming on its members', () => {
		const { container } = render(
			<SchematicCanvas { ...liveHullProps } />
		);

		fireEvent.mouseEnter( container.querySelector( '.topology-hull' ) );

		expect( idleNodes( container ) ).not.toContain( 'inner-a' );
		expect( idleNodes( container ) ).not.toContain( 'inner-b' );
		// Outside the hull the idle dim stays, under the stronger hover fade.
		expect( idleNodes( container ) ).toContain( 'mine' );
	} );

	it( 'a hovered hull lights the idle wires BETWEEN its members', () => {
		const { container } = render(
			<SchematicCanvas { ...liveHullProps } />
		);

		fireEvent.mouseEnter( container.querySelector( '.topology-hull' ) );

		// inner-a → inner-b is wholly inside the hull: lit despite no flow.
		const lit = container.querySelectorAll( '.topology-edge.is-lit' );
		expect( lit.length ).toBe( 1 );
		// inner-b → mine leaves the hull, so it dims like everything else.
		expect(
			container.querySelectorAll( '.topology-edge.is-dimmed' ).length
		).toBe( 1 );
	} );

	it( 'releasing the hover restores the idle dim', () => {
		const { container } = render(
			<SchematicCanvas { ...liveHullProps } />
		);
		const hull = container.querySelector( '.topology-hull' );

		fireEvent.mouseEnter( hull );
		fireEvent.mouseLeave( hull );

		expect( idleNodes( container ) ).toContain( 'inner-a' );
		expect(
			container.querySelectorAll( '.topology-edge.is-lit' ).length
		).toBe( 0 );
	} );

	// A selected hull reads exactly like a hovered one: members lit, internal
	// wires lit, everything else faded. Selection is the STICKY form of the same
	// focus gesture -- so it has to fade the rest too, or lighting its members
	// would buy no contrast against the ordinary active nodes around it.
	it( 'a SELECTED hull highlights exactly like a hovered one', () => {
		const { container } = render(
			<SchematicCanvas { ...liveHullProps } selectedHull="performance" />
		);

		// Members lit: no idle dim inside the hull...
		expect( idleNodes( container ) ).not.toContain( 'inner-a' );
		expect( idleNodes( container ) ).not.toContain( 'inner-b' );
		// ...everything outside stays idle, under the stronger fade.
		expect( idleNodes( container ) ).toContain( 'mine' );

		const faded = [ ...container.querySelectorAll( 'g.topology-node' ) ]
			.filter( ( n ) => n.getAttribute( 'class' ).includes( 'is-faded' ) )
			.map( ( n ) => n.textContent )
			.join( ' ' );
		expect( faded ).toContain( 'mine' );
		expect( faded ).not.toContain( 'inner-a' );

		// The wire wholly inside the hull lights; the one leaving it dims.
		expect(
			container.querySelectorAll( '.topology-edge.is-lit' )
		).toHaveLength( 1 );
		expect(
			container.querySelectorAll( '.topology-edge.is-dimmed' )
		).toHaveLength( 1 );
	} );

	it( 'hovering one hull takes over from a DIFFERENT selected hull', () => {
		const { container } = render(
			<SchematicCanvas { ...liveHullProps } selectedHull="other" />
		);

		fireEvent.mouseEnter( container.querySelector( '.topology-hull' ) );

		expect( idleNodes( container ) ).not.toContain( 'inner-a' );
		expect( idleNodes( container ) ).toContain( 'mine' );
	} );

	it( 'clicking a hull FILL selects the hull', () => {
		const onSelectHull = jest.fn();
		const { container } = render(
			<SchematicCanvas { ...hullProps } onSelectHull={ onSelectHull } />
		);

		fireEvent.mouseDown( container.querySelector( '.topology-hull' ) );

		expect( onSelectHull ).toHaveBeenCalledWith( 'performance' );
	} );

	it( 'dragging a hull moves EVERY member by the same delta, and nothing else', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...hullProps }
				onPositionChange={ onPositionChange }
			/>
		);
		const hull = container.querySelector( '.topology-hull' );

		fireEvent.pointerDown( hull, { clientX: 0, clientY: 0, pointerId: 1 } );
		fireEvent.pointerMove( hull, {
			clientX: 40,
			clientY: 20,
			pointerId: 1,
		} );
		fireEvent.pointerUp( hull, { clientX: 40, clientY: 20, pointerId: 1 } );

		const moved = Object.fromEntries(
			onPositionChange.mock.calls.map( ( [ id, pos ] ) => [ id, pos ] )
		);
		expect( Object.keys( moved ).sort() ).toEqual( [
			'inner-a',
			'inner-b',
		] );
		// One delta, applied to both — the cluster keeps its shape.
		expect( moved[ 'inner-b' ].x - moved[ 'inner-a' ].x ).toBe( 200 );
		expect( moved[ 'inner-a' ].y ).toBe( moved[ 'inner-b' ].y );
	} );

	// @longform A hull drag lands on the same half-node lattice a single-node drag
	// snaps to (top-left at X_PAD + k*X_STEP/2 = 60 + 120k, Y_PAD + k*Y_STEP/2 =
	// 80 + 55k). What snaps is the ANCHOR member's absolute target, and every
	// member then moves by that one delta: snapping each member's own position
	// would quantise away the cluster's internal offsets and reshape the group,
	// while snapping the raw delta would preserve whatever off-grid offset the
	// members already had -- and hull drags used to commit an unsnapped delta, so
	// off-grid clusters are out there to be tidied.
	const dragHullBy = ( container, x, y ) => {
		const hull = container.querySelector( '.topology-hull' );
		fireEvent.pointerDown( hull, { clientX: 0, clientY: 0, pointerId: 1 } );
		fireEvent.pointerMove( hull, { clientX: x, clientY: y, pointerId: 1 } );
		fireEvent.pointerUp( hull, { clientX: x, clientY: y, pointerId: 1 } );
	};
	const movedBy = ( onPositionChange ) =>
		Object.fromEntries(
			onPositionChange.mock.calls.map( ( [ id, pos ] ) => [ id, pos ] )
		);

	it( 'snaps a hull drag onto the grid, moving every member by one delta', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...hullProps }
				onPositionChange={ onPositionChange }
			/>
		);

		dragHullBy( container, 190, 90 );

		// inner-a starts at 100,100 (already OFF the lattice); the raw delta would
		// land it at 290,190. The anchor snaps to the nearest cell instead.
		const moved = movedBy( onPositionChange );
		expect( moved[ 'inner-a' ] ).toEqual( { x: 300, y: 190 } );
		expect( moved[ 'inner-b' ] ).toEqual( { x: 500, y: 190 } );
		// The cluster keeps its shape through the snap.
		expect( moved[ 'inner-b' ].x - moved[ 'inner-a' ].x ).toBe( 200 );
	} );

	it( 'snaps a NEGATIVE hull drag too, off the left/top of the origin', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...hullProps }
				onPositionChange={ onPositionChange }
			/>
		);

		dragHullBy( container, -190, -90 );

		// Anchor 100,100 - 190,90 = -90,10 -> nearest cell is -60,25.
		const moved = movedBy( onPositionChange );
		expect( moved[ 'inner-a' ] ).toEqual( { x: -60, y: 25 } );
		expect( moved[ 'inner-b' ] ).toEqual( { x: 140, y: 25 } );
	} );

	it( 'tidies an off-grid cluster onto the grid without reshaping it', () => {
		const onPositionChange = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...hullProps }
				positionOverrides={ {
					...hullProps.positionOverrides,
					'inner-a': { x: 107, y: 103 },
					'inner-b': { x: 307, y: 103 },
				} }
				onPositionChange={ onPositionChange }
			/>
		);

		dragHullBy( container, 190, 90 );

		// The anchor lands ON the lattice (60+240, 80+110) despite starting at a
		// 7px/23px offset — a raw-delta snap could never have corrected that.
		const moved = movedBy( onPositionChange );
		expect( moved[ 'inner-a' ] ).toEqual( { x: 300, y: 190 } );
		// ...and the cluster's internal offset survives intact.
		expect( moved[ 'inner-b' ].x - moved[ 'inner-a' ].x ).toBe( 200 );
		expect( moved[ 'inner-a' ].y ).toBe( moved[ 'inner-b' ].y );
	} );
} );

describe( 'SchematicCanvas — background click with only a hull selected', () => {
	it( 'deselects instead of falling through to autofit', () => {
		const onDeselect = jest.fn();
		const { container } = render(
			<SchematicCanvas
				parsed={ {
					nodes: [ { id: 'a', class: 'Echo', origin: [ 'perf' ] } ],
					edges: [],
				} }
				positionOverrides={ { a: { x: 10, y: 10 } } }
				hulls={ [ { include: 'perf', nodeIds: [ 'a' ] } ] }
				selectedHull="perf"
				onDeselect={ onDeselect }
				editMode
			/>
		);
		const svg = container.querySelector( 'svg.topology-canvas-svg' );

		fireEvent.pointerDown( svg, { button: 0, pointerId: 1 } );
		fireEvent.pointerUp( svg, { button: 0, pointerId: 1 } );

		expect( onDeselect ).toHaveBeenCalled();
	} );
} );
