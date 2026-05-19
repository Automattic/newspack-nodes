/**
 * SchematicCanvas — SVG drafting-room canvas. The component is large
 * (drag, port wiring, pan/zoom, drop targets, viewbox autofit); these
 * tests focus on the rendering invariants we DO want to pin:
 * node/edge mount, selection class flips, viewBox autofit / override,
 * drop-target opt-out outside edit mode, and the className surface
 * the parent reads for hit testing.
 *
 * Drag math, port snapping, and wheel-zoom pan/zoom are exercised end-
 * to-end via the topology-console smoke test rather than here — jsdom's
 * SVG layer doesn't expose getScreenCTM, so it can't drive the math.
 *
 * Note: We DO NOT chase 80% on this file because the dominant
 * uncovered branches are SVG pointer-event handlers that require a
 * full CTM and HTML5-drag implementation jsdom doesn't provide. The
 * "skip" note here is intentional documentation, not a missing test.
 */

import { render, fireEvent } from '@testing-library/react';
import SchematicCanvas from '../SchematicCanvas';

const parsed = {
	nodes: [ { id: 'a' }, { id: 'b' } ],
	edges: [ { from: 'a', to: 'b' } ],
};

describe( 'SchematicCanvas', () => {
	beforeAll( () => {
		// jsdom's SVGSVGElement lacks createSVGPoint / getScreenCTM. Stub
		// just enough for the component to mount without throwing.
		const svg = window.SVGSVGElement.prototype;
		if ( ! svg.createSVGPoint ) {
			svg.createSVGPoint = function () {
				return {
					x: 0,
					y: 0,
					matrixTransform: () => ( { x: 0, y: 0 } ),
				};
			};
		}
		if ( ! svg.getScreenCTM ) {
			svg.getScreenCTM = function () {
				return {
					inverse: () => ( { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } ),
				};
			};
		}
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
		// The node's transform comes from its position. We can't read
		// the resulting attribute directly without parsing — just verify
		// that overriding doesn't crash and the node still renders.
		const nodeA = Array.from(
			container.querySelectorAll( '.topology-node' )
		).find( ( g ) => g.getAttribute( 'transform' ).includes( '999' ) );
		expect( nodeA ).not.toBeUndefined();
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
		// Four whitespace-separated numbers.
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
		// One node, no rendered edge (the missing endpoint short-
		// circuits the map callback to null).
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
} );
