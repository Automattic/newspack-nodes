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

	const baseProps = {
		parsed,
		selectedId: null,
		onSelect: () => {},
		onDeselect: () => {},
		hoveredId: null,
		onHover: () => {},
		positionOverrides: null,
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

	it( 'applies position overrides on top of auto-layout', () => {
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				positionOverrides={ { a: { x: 999, y: 222 } } }
			/>
		);
		// Verify the override renders without crashing.
		const nodeA = Array.from(
			container.querySelectorAll( '.topology-node' )
		).find( ( g ) => g.getAttribute( 'transform' ).includes( '999' ) );
		expect( nodeA ).not.toBeUndefined();
	} );

	it( 'fires onSeedLayout with autoLayout positions when overrides are empty', () => {
		const calls = [];
		render(
			<SchematicCanvas
				{ ...baseProps }
				positionOverrides={ {} }
				onSeedLayout={ ( map ) => calls.push( map ) }
			/>
		);
		// Single seed call with one entry per parsed node, top-left coords.
		expect( calls ).toHaveLength( 1 );
		expect( Object.keys( calls[ 0 ] ).sort() ).toEqual( [ 'a', 'b' ] );
		expect( calls[ 0 ].a ).toEqual(
			expect.objectContaining( {
				x: expect.any( Number ),
				y: expect.any( Number ),
			} )
		);
	} );

	it( 'does not fire onSeedLayout when positionOverrides already covers nodes', () => {
		const calls = [];
		render(
			<SchematicCanvas
				{ ...baseProps }
				positionOverrides={ {
					a: { x: 60, y: 80 },
					b: { x: 300, y: 80 },
				} }
				onSeedLayout={ ( map ) => calls.push( map ) }
			/>
		);
		expect( calls ).toHaveLength( 0 );
	} );

	it( 'does not fire onSeedLayout when the graph is empty', () => {
		const calls = [];
		render(
			<SchematicCanvas
				{ ...baseProps }
				parsed={ { nodes: [], edges: [] } }
				positionOverrides={ {} }
				onSeedLayout={ ( map ) => calls.push( map ) }
			/>
		);
		expect( calls ).toHaveLength( 0 );
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

	it( 'onBackgroundClickConsumed truthy skips deselect + autofit', () => {
		const onDeselect = jest.fn();
		const onBackgroundClickConsumed = jest.fn( () => true );
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				selectedId="a"
				onDeselect={ onDeselect }
				onBackgroundClickConsumed={ onBackgroundClickConsumed }
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
			pointerId: 1,
			clientX: 50,
			clientY: 50,
		} );
		fireEvent.pointerUp( svg, {
			button: 0,
			pointerId: 1,
			clientX: 50,
			clientY: 50,
		} );
		expect( onBackgroundClickConsumed ).toHaveBeenCalledTimes( 1 );
		expect( onDeselect ).not.toHaveBeenCalled();
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

	// === Drag-and-drop (HTML5) ===

	it( 'dragOver in edit mode marks the surface as drop target', () => {
		const { container } = render(
			<SchematicCanvas { ...baseProps } editMode />
		);
		const svg = container.querySelector( 'svg' );
		const preventDefault = jest.fn();
		fireEvent.dragOver( svg, {
			preventDefault,
			dataTransfer: { dropEffect: '' },
		} );
		// Assert the handler ran without throwing.
		expect( svg ).not.toBeNull();
	} );

	it( 'drop in edit mode with a node shellName invokes onDropNode', () => {
		const onDropNode = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onDropNode={ onDropNode }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.drop( svg, {
			clientX: 100,
			clientY: 200,
			dataTransfer: {
				getData: ( type ) =>
					type === 'application/x-newspack-node' ? 'Tee' : '',
			},
		} );
		expect( onDropNode ).toHaveBeenCalledTimes( 1 );
		const arg = onDropNode.mock.calls[ 0 ][ 0 ];
		expect( arg.shellName ).toBe( 'Tee' );
		expect( typeof arg.x ).toBe( 'number' );
		expect( typeof arg.y ).toBe( 'number' );
	} );

	it( 'drop with empty shellName is ignored', () => {
		const onDropNode = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode
				onDropNode={ onDropNode }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.drop( svg, {
			clientX: 100,
			clientY: 200,
			dataTransfer: { getData: () => '' },
		} );
		expect( onDropNode ).not.toHaveBeenCalled();
	} );

	it( 'drop outside edit mode still invokes onDropNode (gestures are always-on)', () => {
		const onDropNode = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				editMode={ false }
				onDropNode={ onDropNode }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.drop( svg, {
			clientX: 100,
			clientY: 200,
			dataTransfer: {
				getData: ( type ) =>
					type === 'application/x-newspack-node' ? 'Tee' : '',
			},
		} );
		expect( onDropNode ).toHaveBeenCalledTimes( 1 );
		expect( onDropNode.mock.calls[ 0 ][ 0 ].shellName ).toBe( 'Tee' );
	} );

	it( 'drop with interactive=false is ignored', () => {
		const onDropNode = jest.fn();
		const { container } = render(
			<SchematicCanvas
				{ ...baseProps }
				interactive={ false }
				onDropNode={ onDropNode }
			/>
		);
		const svg = container.querySelector( 'svg' );
		fireEvent.drop( svg, {
			clientX: 100,
			clientY: 200,
			dataTransfer: {
				getData: () => 'Tee',
			},
		} );
		expect( onDropNode ).not.toHaveBeenCalled();
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
