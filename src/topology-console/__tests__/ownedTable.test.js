/**
 * An owned Table on the console: the snapshot a worker answers draws its
 * owner alone, and the Table opens from the "…" on the owner's card into
 * the Inspector, which shows its owner as a link back.
 */

import { act, fireEvent } from '@testing-library/react';
import { useState } from '@wordpress/element';
import SchematicCanvas from '../components/SchematicCanvas';
import GraphView from '../components/GraphView';
import { renderWithCatalog } from './catalogTestUtils';
import { LayoutProvider } from '../LayoutContext';
import { autoLayout } from '../utils/autoLayout';
import { SIDECAR_POLLER } from '../hooks/useSidecarRows';
import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import {
	newMessage,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../runtime/message';
import {
	dumpMetadataPayload,
	parseMetadata,
} from '../../runtime/metadata-node';

/** Stands for the server's Table_Node. */
class TableNode extends Node {
	static nodeSchema() {
		return { category: 'Storage' };
	}
}

/**
 * A Crawler's graph as its worker holds it: the Crawler, its `:curl` and
 * `:seen` siblings, and the Table's own `:config` interpreter. The Crawler's
 * `targets` carry the Table as PHP `Crawler_Node::extra_targets()` ships it.
 *
 * @return {import('../../runtime/metadata-node').MetadataGraph} The parsed snapshot.
 */
function crawlerGraph() {
	const crawler = new Node();
	crawler.name = 'crawl-4471';
	const seen = new TableNode();
	seen.patron = crawler;
	seen.name = 'crawl-4471:seen';
	const curl = new Node();
	curl.patron = crawler;
	curl.name = 'crawl-4471:curl';
	const config = new Node();
	config.patron = seen;
	config.name = 'crawl-4471:seen:config';
	const payload = dumpMetadataPayload();
	payload[ 'crawl-4471' ].targets = [ 'crawl-4471:seen' ];
	return parseMetadata( payload );
}

describe( 'an owned Table on the console', () => {
	beforeAll( () => {
		window.SVGSVGElement.prototype.createSVGPoint = function () {
			const pt = { x: 0, y: 0 };
			pt.matrixTransform = () => ( { x: pt.x, y: pt.y } );
			return pt;
		};
		window.SVGSVGElement.prototype.getScreenCTM = function () {
			return { inverse: () => ( {} ) };
		};
	} );

	beforeEach( () => {
		Core.reset();
	} );

	it( 'draws the owner alone, with no card or wire for what it owns', () => {
		const parsed = crawlerGraph();
		const at = Object.fromEntries(
			autoLayout( parsed ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const { container } = renderWithCatalog(
			<SchematicCanvas
				parsed={ parsed }
				selectedId={ null }
				onSelect={ () => {} }
				onDeselect={ () => {} }
				hoveredId={ null }
				onHover={ () => {} }
				rateRef={ { current: new Map() } }
			/>,
			{
				positionOverrides: at,
				onPositionChange: () => {},
				viewport: null,
				onViewportChange: () => {},
			}
		);

		const cards = [ ...container.querySelectorAll( '.topology-node' ) ];
		expect( cards.map( ( card ) => card.textContent ) ).toEqual( [
			expect.stringContaining( 'crawl-4471' ),
		] );
		expect( cards[ 0 ].textContent ).not.toMatch( /:seen|:curl/ );
		expect(
			container.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 0 );
	} );

	it( "opens the Table from the \u201c\u2026\u201d on its owner's card, naming its owner", async () => {
		jest.useFakeTimers();
		try {
			const parsed = crawlerGraph();
			const row = dumpMetadataPayload( 'crawl-4471:seen' );
			const sent = [];
			Core.registerNode( '_cwd', {
				name: '_cwd',
				fill: ( m ) => sent.push( m ),
			} );
			const Frame = ( { children } ) => <div>{ children }</div>;
			const { container } = renderWithCatalog(
				<GraphView graph={ parsed } frame={ Frame } resetKey="k" />,
				{
					positionOverrides: Object.fromEntries(
						autoLayout( parsed ).nodes.map( ( n ) => [
							n.id,
							n.position,
						] )
					),
					onPositionChange: () => {},
					viewport: null,
					onViewportChange: () => {},
				}
			);

			fireEvent.click(
				container.querySelector( '.topology-node__sidecars' )
			);
			const cards = [
				...document.body.querySelectorAll( '.topology-sidecars__card' ),
			];
			expect(
				cards.map( ( card ) => card.getAttribute( 'aria-label' ) )
			).toEqual( [
				'crawl-4471:curl (Node)',
				'crawl-4471:seen (Table)',
			] );
			fireEvent.click( cards[ 1 ] );
			await act( async () => {} );
			expect( sent ).toHaveLength( 1 );
			const reply = newMessage();
			reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			reply[ TO ] = encodeURIComponent(
				Core.node( SIDECAR_POLLER ).subject
			);
			reply[ VALUE ] = { payload: row };
			act( () => Core.node( SIDECAR_POLLER ).fill( reply ) );

			expect(
				container.querySelector( '.topology-insp__title' ).textContent
			).toBe( 'crawl-4471:seen' );
			expect(
				container.querySelector( '.topology-insp__type' ).textContent
			).toMatch( /Table/ );
			expect(
				container.querySelector( '.topology-insp__owned' ).textContent
			).toMatch( /owned by crawl-4471/i );
			expect(
				document.body.querySelectorAll( '.topology-sidecars__card' )
			).toHaveLength( 2 );
		} finally {
			jest.useRealTimers();
		}
	} );

	describe( "the owner's grid on a panning canvas", () => {
		const jsdom = {
			PointerEvent: window.PointerEvent,
			setPointerCapture: window.Element.prototype.setPointerCapture,
			releasePointerCapture:
				window.Element.prototype.releasePointerCapture,
		};

		// jsdom has no PointerEvent; the canvas pan reads its coordinates.
		beforeAll( () => {
			window.PointerEvent = class PointerEvent extends window.MouseEvent {
				constructor( type, init = {} ) {
					super( type, init );
					this.pointerId = init.pointerId ?? 0;
				}
			};
			window.Element.prototype.setPointerCapture = () => {};
			window.Element.prototype.releasePointerCapture = () => {};
		} );

		afterAll( () => {
			window.PointerEvent = jsdom.PointerEvent;
			window.Element.prototype.setPointerCapture =
				jsdom.setPointerCapture;
			window.Element.prototype.releasePointerCapture =
				jsdom.releasePointerCapture;
		} );

		// One frame type for every render, so the canvas never remounts.
		const Frame = ( { children } ) => <div>{ children }</div>;

		/**
		 * The console's canvas, its viewport held as the console holds it.
		 *
		 * @param {Object} props
		 * @param {Object} props.parsed  The crawler's graph, built once.
		 * @param {Object} [props.steer] Takes the viewport setter, to zoom by.
		 * @return {import('react').ReactElement} GraphView over the crawler.
		 */
		function Console( { parsed, steer } ) {
			const [ viewport, setViewport ] = useState( {
				x: 0,
				y: 0,
				w: 1000,
				h: 800,
			} );
			if ( steer ) {
				steer.current = setViewport;
			}
			return (
				<LayoutProvider
					positionOverrides={ Object.fromEntries(
						autoLayout( parsed ).nodes.map( ( n ) => [
							n.id,
							n.position,
						] )
					) }
					viewport={ viewport }
					onViewportChange={ setViewport }
				>
					<GraphView graph={ parsed } frame={ Frame } resetKey="k" />
				</LayoutProvider>
			);
		}

		/**
		 * Press the canvas background, move, and release where it moved to.
		 *
		 * @param {Element} svg The canvas.
		 * @param {number}  dx  How far right it moves, in screen px.
		 * @param {number}  dy  How far down it moves.
		 */
		const pressBackground = ( svg, dx, dy ) => {
			const from = {
				button: 0,
				pointerId: 7,
				clientX: 100,
				clientY: 100,
			};
			const to = { ...from, clientX: 100 + dx, clientY: 100 + dy };
			fireEvent.pointerDown( svg, from );
			fireEvent.mouseDown( svg, from );
			fireEvent.pointerMove( svg, to );
			fireEvent.pointerUp( svg, to );
			fireEvent.mouseUp( svg, to );
			fireEvent.click( svg, to );
		};

		/** @return {?Element} The open grid, or null. */
		const grid = () => document.body.querySelector( '[role="dialog"]' );

		it( 'keeps the grid open through a background drag-pan, moving it with the canvas', async () => {
			const { container } = renderWithCatalog(
				<Console parsed={ crawlerGraph() } />
			);
			const svg = container.querySelector( '.topology-canvas-svg' );
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
			fireEvent.click(
				container.querySelector( '.topology-node__sidecars' )
			);
			await act( async () => {} );
			const frame = () =>
				grid()
					.querySelector( '.topology-sidecars__frame' )
					.getAttribute( 'd' );
			const at = frame();
			expect( svg.getAttribute( 'viewBox' ) ).toBe( '0 0 1000 800' );

			pressBackground( svg, 140, 60 );
			await act( async () => {} );

			expect( svg.getAttribute( 'viewBox' ) ).toBe( '-140 -60 1000 800' );
			expect( grid() ).not.toBeNull();
			expect( grid().ownerSVGElement ).toBe( svg );
			expect( frame() ).toBe( at );
		} );

		it( 'closes the grid on a background click', async () => {
			const { container } = renderWithCatalog(
				<Console parsed={ crawlerGraph() } />
			);
			const svg = container.querySelector( '.topology-canvas-svg' );
			fireEvent.click(
				container.querySelector( '.topology-node__sidecars' )
			);
			await act( async () => {} );
			expect( grid() ).not.toBeNull();

			pressBackground( svg, 2, 1 );
			await act( async () => {} );

			expect( grid() ).toBeNull();
		} );

		describe( 'below the level of detail and back', () => {
			// The canvas measures 1000 x 800 px, so a 10000-wide view is LOD.
			beforeAll( () => {
				for ( const [ side, px ] of [
					[ 'clientWidth', 1000 ],
					[ 'clientHeight', 800 ],
				] ) {
					Object.defineProperty(
						window.SVGSVGElement.prototype,
						side,
						{ configurable: true, get: () => px }
					);
				}
			} );

			afterAll( () => {
				delete window.SVGSVGElement.prototype.clientWidth;
				delete window.SVGSVGElement.prototype.clientHeight;
			} );

			/**
			 * Open the owner's grid, then zoom below LOD and back, so the
			 * canvas unmounts its "…" and draws a new one.
			 *
			 * @return {Promise<{first: Element, redrawn: Element}>} The two.
			 */
			const openThenRedraw = async () => {
				const steer = { current: null };
				const { container } = renderWithCatalog(
					<Console parsed={ crawlerGraph() } steer={ steer } />
				);
				const dots = () =>
					container.querySelector( '.topology-node__sidecars' );
				const first = dots();
				fireEvent.click( first );
				await act( async () => {} );
				act( () => steer.current( { x: 0, y: 0, w: 10000, h: 8000 } ) );
				expect( dots() ).toBeNull();
				expect( grid() ).not.toBeNull();
				act( () => steer.current( { x: 0, y: 0, w: 1000, h: 800 } ) );
				const redrawn = dots();
				expect( redrawn ).not.toBeNull();
				expect( redrawn ).not.toBe( first );
				return { first, redrawn };
			};
			const cards = () =>
				document.body.querySelectorAll( '.topology-sidecars__card' );

			it( "keeps the grid through a first pick once its owner's \u201c\u2026\u201d is redrawn", async () => {
				await openThenRedraw();
				fireEvent.click( cards()[ 1 ] );
				await act( async () => {} );
				fireEvent.click( cards()[ 0 ] );
				await act( async () => {} );
				expect( grid() ).not.toBeNull();
			} );

			it( 'focuses the redrawn \u201c\u2026\u201d on Esc', async () => {
				const { redrawn } = await openThenRedraw();
				fireEvent.keyDown( document, { key: 'Escape' } );
				await act( async () => {} );
				expect( grid() ).toBeNull();
				expect( document.activeElement ).toBe( redrawn );
			} );
		} );
	} );
} );
