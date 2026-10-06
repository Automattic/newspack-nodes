/**
 * A metadata poll republishes the whole graph with its counters moved on. The
 * canvas commits it once, and re-renders only the readouts that changed: the
 * cards and wires are memoized on their structure, and the live counters,
 * rates and sparklines render beside them, outside the bloom-filtered layer.
 */

import { Profiler } from 'react';
import { act } from '@testing-library/react';
import GraphView from '../GraphView';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';
import { autoLayout } from '../../utils/autoLayout';

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
 * @param {number} tick The poll number.
 * @return {{nodes: Array<Object>, edges: Array<Object>}} A fresh graph object.
 */
const poll = ( tick ) => ( {
	nodes: [
		...BUSY.map( ( id ) => ( { id, class: 'Tee', count: 7 * tick } ) ),
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
	const realNow = Date.now;
	beforeEach( () => {
		now = 1_700_000_000_000;
		Date.now = () => now;
		global.__memoRenders = {};
	} );
	afterEach( () => {
		Date.now = realNow;
	} );

	it( 'commits once and re-renders only the readouts that moved', () => {
		const positions = Object.fromEntries(
			autoLayout( poll( 0 ) ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const commits = [];
		const view = ( tick ) => (
			<Profiler
				id="canvas"
				onRender={ ( _id, phase ) => commits.push( phase ) }
			>
				<GraphView
					graph={ poll( tick ) }
					frame={ Frame }
					resetKey="poll"
					inspectorCollapsed
				/>
			</Profiler>
		);
		const ambient = { positionOverrides: positions };
		const { rerenderWithCatalog } = renderWithCatalog( view( 0 ), ambient );
		// Past the sparkline window, so a still node's history holds still.
		for ( let tick = 1; tick <= 62; tick++ ) {
			now += 1000;
			act( () => rerenderWithCatalog( view( tick ), ambient ) );
		}
		commits.length = 0;
		global.__memoRenders = {};

		now += 1000;
		act( () => rerenderWithCatalog( view( 63 ), ambient ) );

		expect( commits ).toEqual( [ 'update' ] );
		expect( global.__memoRenders ).toEqual( {
			NodeReadout: BUSY.length,
		} );
	} );
} );
