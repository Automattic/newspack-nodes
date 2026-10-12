/**
 * An owned Table on the console: the snapshot a worker answers draws its
 * owner alone, and the Table opens from the "…" on the owner's card into
 * the Inspector, which shows its owner as a link back.
 */

import { act, fireEvent, screen } from '@testing-library/react';
import SchematicCanvas from '../components/SchematicCanvas';
import GraphView from '../components/GraphView';
import { renderWithCatalog } from './catalogTestUtils';
import { autoLayout } from '../utils/autoLayout';
import { SIDECAR_POLLER } from '../hooks/useSidecarRow';
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
			expect(
				[
					...document.body.querySelectorAll( '.topology-open-item' ),
				].map( ( card ) => card.textContent )
			).toEqual( [ 'crawl-4471:curlNode', 'crawl-4471:seenTable' ] );
			fireEvent.click(
				screen.getByText( 'crawl-4471:seen', {
					selector: '.topology-open-item__name',
				} )
			);
			await act( async () => {} );
			expect( sent ).toHaveLength( 1 );
			const reply = newMessage();
			reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			reply[ TO ] = encodeURIComponent( 'crawl-4471:seen' );
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
		} finally {
			jest.useRealTimers();
		}
	} );
} );
