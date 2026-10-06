/**
 * A metadata poll republishes the whole graph with its counters moved on. The
 * canvas commits it once, and re-renders only the readouts that changed: the
 * cards and wires are memoized on their structure, and the live counters,
 * rates and sparklines render beside them, outside the bloom-filtered layer.
 * A card's frame re-renders only when it crosses between busy (its counter
 * moved since the previous poll) and idle.
 */

import { Profiler } from 'react';
import { act } from '@testing-library/react';
import GraphView from '../GraphView';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';
import { autoLayout } from '../../utils/autoLayout';
import { Core } from '../../../runtime/core';
import { MetadataNode } from '../../../runtime/metadata-node';
import names from '../../../runtime/reserved-node-names.json';

// Count each memoized component's renders by the name it was declared with.
jest.mock( '@wordpress/element', () => {
	const actual = jest.requireActual( '@wordpress/element' );
	return {
		...actual,
		memo: ( Component, equal ) =>
			actual.memo( ( props ) => {
				const counts = ( global.__memoRenders ??= {} );
				counts[ Component.name ] =
					( counts[ Component.name ] ?? 0 ) + 1;
				return Component( props );
			}, equal ),
	};
} );

const Frame = ( { children } ) => <div>{ children }</div>;

const BUSY = [ 'busy:a', 'busy:b', 'busy:c' ];
const STILL = [ 'still:a', 'still:b', 'still:c', 'still:d' ];
const COLD = [ 'cold:a', 'cold:b', 'cold:c', 'cold:d', 'cold:e' ];

/**
 * One poll's graph: busy nodes count up seven a poll, still nodes hold a
 * count they once reached, and cold nodes have never counted.
 *
 * @param {number}  tick    The poll number.
 * @param {?string} [quiet] A busy node whose count holds at the previous poll's.
 * @return {{nodes: Array<Object>, edges: Array<Object>}} A fresh graph object.
 */
const poll = ( tick, quiet = null ) => ( {
	nodes: [
		...BUSY.map( ( id ) => ( {
			id,
			class: 'Tee',
			count: 7 * ( id === quiet ? tick - 1 : tick ),
		} ) ),
		...STILL.map( ( id ) => ( { id, class: 'Node', count: 13 } ) ),
		...COLD.map( ( id ) => ( { id, class: 'Node', count: 0 } ) ),
	],
	edges: [
		{ from: 'busy:a', to: 'busy:b' },
		{ from: 'busy:b', to: 'busy:c' },
		{ from: 'still:a', to: 'still:b' },
		{ from: 'cold:a', to: 'cold:b' },
		{ from: 'busy:c', to: 'cold:c' },
	],
} );

describe( 'SchematicCanvas — a metadata poll', () => {
	let now;
	let metadata;
	const realNow = Date.now;
	beforeEach( () => {
		now = 1_700_000_000_000;
		Date.now = () => now;
		global.__memoRenders = {};
		metadata = new MetadataNode();
		metadata.name = names.METADATA;
	} );
	afterEach( () => {
		Date.now = realNow;
		Core.reset();
	} );

	/**
	 * Mount the canvas and warm it past the sparkline window, so a still
	 * node's history holds still. Each poll lands as `_metadata`'s snapshot
	 * and the canvas graph together, in one commit.
	 *
	 * @return {{commits: string[], step: (tick: number, quiet?: string) => void, container: HTMLElement}} The commit log, a poll driver and the mount.
	 */
	const mountWarm = () => {
		const positions = Object.fromEntries(
			autoLayout( poll( 0 ) ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const commits = [];
		const view = ( graph ) => (
			<Profiler
				id="canvas"
				onRender={ ( _id, phase ) => commits.push( phase ) }
			>
				<GraphView
					graph={ graph }
					frame={ Frame }
					resetKey="poll"
					inspectorCollapsed
				/>
			</Profiler>
		);
		const ambient = { positionOverrides: positions };
		const first = poll( 0 );
		act( () => metadata.setField( 'snapshot', first ) );
		const { rerenderWithCatalog, container } = renderWithCatalog(
			view( first ),
			ambient
		);
		const step = ( tick, quiet ) => {
			now += 1000;
			const graph = poll( tick, quiet );
			act( () => {
				metadata.setField( 'snapshot', graph );
				rerenderWithCatalog( view( graph ), ambient );
			} );
		};
		for ( let tick = 1; tick <= 62; tick++ ) {
			step( tick );
		}
		commits.length = 0;
		global.__memoRenders = {};
		return { commits, step, container };
	};

	const isIdle = ( container, id ) =>
		[ ...container.querySelectorAll( 'g.topology-node' ) ]
			.find(
				( n ) =>
					id === n.querySelector( '.topology-node__id' ).textContent
			)
			.classList.contains( 'is-idle' );

	it( 'commits once and re-renders only the readouts that moved', () => {
		const { commits, step } = mountWarm();

		step( 63 );

		expect( commits ).toEqual( [ 'update' ] );
		expect( global.__memoRenders ).toEqual( {
			NodeReadout: BUSY.length,
		} );
	} );

	it( 'dims a card the poll its counter stops, and lights it the poll it resumes', () => {
		const { step, container } = mountWarm();
		expect( isIdle( container, 'busy:b' ) ).toBe( false );

		step( 63, 'busy:b' );

		expect( isIdle( container, 'busy:b' ) ).toBe( true );
		// Its two wires stop flowing and start again with it.
		expect( global.__memoRenders ).toEqual( {
			NodeCard: 1,
			NodeReadout: BUSY.length,
			EdgeWire: 2,
		} );

		global.__memoRenders = {};
		step( 64 );

		expect( isIdle( container, 'busy:b' ) ).toBe( false );
		expect( global.__memoRenders ).toEqual( {
			NodeCard: 1,
			NodeReadout: BUSY.length,
			EdgeWire: 2,
		} );
	} );
} );
