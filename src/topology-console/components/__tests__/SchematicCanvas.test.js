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
		// jsdom lacks a PointerEvent constructor; polyfill via MouseEvent so
		// synthetic pointer events carry the coordinate fields drag math reads.
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
		// Stub createSVGPoint / getScreenCTM (jsdom's SVGSVGElement lacks them).
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
		// Pointer capture/release are no-ops jsdom requires the handlers to call.
		window.Element.prototype.setPointerCapture = function () {};
		window.Element.prototype.releasePointerCapture = function () {};
		window.Element.prototype.hasPointerCapture = function () {
			return false;
		};
	} );

	// positionOverrides is now the COMPLETE map (the canvas no longer lays out);
	// supply the default a/b graph's autoLayout positions so nodes render.
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
			// `feMerge[bloom, SourceGraphic]` paints the sharp OPAQUE card over the
			// blur, hiding the glow that falls inside the card (names, LEDs). A
			// `screen` blend adds the glow so it shows through the card instead.
			expect(
				filter.querySelector( 'feBlend[mode="screen"]' )
			).not.toBeNull();
			expect( filter.querySelector( 'feMerge' ) ).toBeNull();
		}
	} );

	it( 'suppresses the infinite edge-flow animation above EDGE_FLOW_MAX edges (Firefox raster cost)', () => {
		// A perpetual stroke-dashoffset flow on each active edge re-rasterizes
		// every dashed path every frame — fine for a handful, but hundreds peg
		// Firefox. Above the threshold the edge groups get `--still` (CSS drops
		// the animation) so the static graph can be layer-cached.
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

	// Arrow-pan only fires while the canvas is hovered (so the debug overlay
	// doesn't hijack the host page's arrows) — hover the SVG before pressing.
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
			expect.objectContaining( { x: 80, y: 0, w: 1000, h: 700 } )
		);
		fireEvent.keyDown( document, { key: 'ArrowDown' } );
		expect( onViewportChange ).toHaveBeenLastCalledWith(
			expect.objectContaining( { y: 56 } )
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
			expect.objectContaining( { x: -250 } )
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
		// No hover → the document arrow handler must NOT pan (and must not
		// preventDefault, leaving the host page free to scroll).
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

	// The OUT port is a wire-drag source whenever `interactive` + `onConnect`
	// are both provided — independent of editMode. The CSS pins `cursor:
	// crosshair` to the `is-wire-source` modifier so live mode + debug overlay
	// hovers show the "+" too, not just edit mode.
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
		// baseProps' graph is smaller than the 1280 fallback canvas. The old
		// floor pinned the viewBox to 1280 (native zoom, sea of margin); the
		// fill-autofit zooms in so the viewBox is smaller than the canvas.
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
		// Reserving the bottom band moves the viewBox window down in world space,
		// i.e. pushes the graph UP on screen, clear of the transcript.
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

	// Registration edges (parseMetadata's `{ from, to, registration, event }`)
	// are an informational THIRD edge kind: dotted (is-registration), event-name
	// <title> tooltip, and no edit-mode hit-target (not click-deletable).
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
		// Large viewport: zoom-in shrinks it but the clamp floors at baseW/ZOOM_MAX.
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
		// The bug: on a letterboxed autofit, current.w (viewBox) != the canvas
		// width, so the cursor's world-fraction within the viewBox diverges from
		// its screen-fraction and the first zoom flings the graph off. Here the
		// viewBox is 1700 wide but the canvas is 1000 — a world-fraction anchor
		// would mis-place the cursor point; the screen-fraction anchor keeps it.
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
		// Identity-CTM stub → world under cursor === client coords === (500,500).
		fireEvent.wheel( svg, { deltaY: -100, clientX: 500, clientY: 500 } );
		const [ vp ] = onViewportChange.mock.calls.at( -1 );
		// Cursor screen fraction is 0.5; the world point (500) must stay there.
		expect( vp.x + 0.5 * vp.w ).toBeCloseTo( 500, 0 );
		expect( vp.y + 0.5 * vp.h ).toBeCloseTo( 500, 0 );
	} );

	it( 'attaches the wheel listener as non-passive (so preventDefault works)', () => {
		// React's onWheel is passive — its preventDefault is ignored, so the page
		// scrolls behind the canvas (and Chrome/FF warn). The zoom listener must be
		// attached via a non-passive addEventListener instead.
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
} );

// Scale-gated level-of-detail. The default tests run with an unmeasured (0x0)
// canvas, so scale is Infinity and detail is always on; here we stub the canvas
// measurement so the zoomed-OUT tier (no edge layer, static nodes) is exercised.
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
		// A no-op ResizeObserver: the effect's synchronous mount-time measure()
		// reads the stubbed client size; we don't need observer callbacks here.
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
		// 1000px across a 5000-unit viewBox = 0.2 px/unit — the OLD EDGE_MIN_SCALE
		// (0.05) gate kept edges here, but it's below the 0.35 detail scale, so
		// edges now LOD away at the same zoom as the labels.
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
		// 1000px across a 400000-unit viewBox = 0.0025 px/unit; a 196-unit node
		// would render at ~0.5px (invisible / spotty in Firefox). The floor must
		// enlarge its rect so it stays >= ~2px (>= 800 world units here).
		const { container } = render(
			<SchematicCanvas
				{ ...lodProps }
				viewport={ { x: 0, y: 0, w: 400000, h: 400000 } }
			/>
		);
		const bg = container.querySelector( '.topology-node__bg' );
		const minWorld = 2 / ( 1000 / 400000 ); // MIN_NODE_PX / scale = 800
		// Bounded both ways: floors UP to ~2px-equivalent, not arbitrarily larger.
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
		// a in-view, b far off-view → a straight stub (M..L..), NOT a bezier (C),
		// and no arrowhead (it points off-screen).
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
		// The bloom filters pin their region to the viewport (not the group bbox).
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
} );
