/**
 * An owned Table on the console: the snapshot a worker answers, laid out,
 * drawn as an ordinary Table card with the edge its patron declares, and
 * opened in the Inspector when clicked, which offers no delete or rename.
 * Every other owned node stays off the canvas.
 */

import { fireEvent } from '@testing-library/react';
import SchematicCanvas from '../components/SchematicCanvas';
import Inspector from '../components/Inspector';
import { renderWithCatalog } from './catalogTestUtils';
import { autoLayout } from '../utils/autoLayout';
import { buildComposeTargets } from '../utils/composeTargets';
import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import {
	dumpMetadataPayload,
	parseMetadata,
} from '../../runtime/metadata-node';

/** Stands for the server's Table_Node, schema flag and all. */
class TableNode extends Node {
	static nodeSchema() {
		return { category: 'Storage', shown_when_owned: true };
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

/**
 * Render the Inspector on the owned Table.
 *
 * @param {Object} props Extra Inspector props.
 * @return {HTMLElement} The rendered container.
 */
function inspectTable( props = {} ) {
	const parsed = crawlerGraph();
	const { container } = renderWithCatalog(
		<Inspector
			selectedId="crawl-4471:seen"
			parsed={ parsed }
			streamStatus="open"
			rateInfo={ null }
			onAction={ () => {} }
			onSelect={ () => {} }
			onHover={ () => {} }
			nodeIds={ new Set( parsed.nodes.map( ( n ) => n.id ) ) }
			sseSession={ null }
			{ ...props }
		/>,
		{ composeTargets: buildComposeTargets( parsed.nodes ) }
	);
	return container;
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

	it( 'draws a Table card wired from its patron and nothing else owned', () => {
		const parsed = crawlerGraph();
		const at = Object.fromEntries(
			autoLayout( parsed ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const onSelect = jest.fn();
		const { container } = renderWithCatalog(
			<SchematicCanvas
				parsed={ parsed }
				selectedId={ null }
				onSelect={ onSelect }
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
		const labels = cards.map( ( card ) => card.textContent );
		expect( cards ).toHaveLength( 2 );
		expect(
			labels.some( ( text ) => text.includes( 'crawl-4471:seen' ) )
		).toBe( true );
		expect( labels.some( ( text ) => text.includes( ':curl' ) ) ).toBe(
			false
		);
		expect( parsed.edges ).toEqual( [
			{ from: 'crawl-4471', to: 'crawl-4471:seen' },
		] );
		expect(
			container.querySelectorAll( '.topology-edge--active' )
		).toHaveLength( 1 );

		fireEvent.click(
			cards.find( ( card ) => card.textContent.includes( ':seen' ) )
		);
		expect( onSelect ).toHaveBeenCalledWith( 'crawl-4471:seen' );
	} );

	it( 'opens the owned Table in the Inspector, its `:config` addressable', () => {
		const parsed = crawlerGraph();
		const targets = buildComposeTargets( parsed.nodes );
		const { container } = renderWithCatalog(
			<Inspector
				selectedId="crawl-4471:seen"
				parsed={ parsed }
				streamStatus="open"
				rateInfo={ null }
				onAction={ () => {} }
				onSelect={ () => {} }
				onHover={ () => {} }
				nodeIds={ new Set( parsed.nodes.map( ( n ) => n.id ) ) }
				sseSession={ null }
			/>,
			{ composeTargets: targets }
		);

		expect(
			container.querySelector( '.topology-insp__title' ).textContent
		).toBe( 'crawl-4471:seen' );
		expect(
			container.querySelector( '.topology-insp__type' ).textContent
		).toMatch( /Table/ );
		expect( container.textContent ).not.toMatch( /no longer present/ );
		expect( targets ).toContain( 'crawl-4471:seen:config' );
	} );

	it( 'says the live Inspector cannot delete or rename it, naming its owner', () => {
		const container = inspectTable();

		expect(
			container.querySelector( '.topology-insp__owned' ).textContent
		).toMatch( /owned by crawl-4471/i );
	} );

	it( 'offers no delete or rename in edit mode, saying why there', () => {
		const onRemoveNode = jest.fn();
		const container = inspectTable( {
			editMode: true,
			catalog: [ { shell_name: 'Table', arguments: [], commands: [] } ],
			onRemoveNode,
			onRenameNode: () => true,
		} );

		expect( container.textContent ).not.toMatch( /Delete node/ );
		expect( container.querySelector( '#topology-name-field' ) ).toBeNull();
		expect(
			container.querySelector( '.topology-insp__owned' ).textContent
		).toMatch( /owned by crawl-4471/i );
	} );
} );
