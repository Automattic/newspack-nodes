/**
 * A metadata poll republishes the whole graph every second, so a fresh graph
 * object carrying the same nodes and edges must never lay the canvas out again.
 */

import { renderHook, act } from '@testing-library/react';
import { useCanvasLayout } from '../useCanvasLayout';
import { autoLayout } from '../../utils/autoLayout';

jest.mock( '../../utils/autoLayout', () => {
	const actual = jest.requireActual( '../../utils/autoLayout' );
	return { ...actual, autoLayout: jest.fn( actual.autoLayout ) };
} );

/**
 * One poll's graph: the same structure, its counters moved on.
 *
 * @param {number} tick The poll number, distinct per poll.
 * @return {{nodes: Array<Object>, edges: Array<Object>}} A fresh graph object.
 */
const poll = ( tick ) => ( {
	nodes: [
		{ id: 'poll:timer', count: 7 * tick },
		{ id: 'poll:fetch', count: 3 * tick },
	],
	edges: [ { from: 'poll:timer', to: 'poll:fetch' } ],
} );

describe( 'useCanvasLayout — a metadata poll', () => {
	beforeEach( () => {
		window.localStorage.clear();
		jest.useFakeTimers();
		autoLayout.mockClear();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'does not re-run the layout when the structure is unchanged', () => {
		const props = {
			storageKey: 'newspack-nodes:test:poll',
			ready: true,
			serverLayout: null,
		};
		const { result, rerender } = renderHook(
			( p ) => useCanvasLayout( p ),
			{ initialProps: { ...props, graph: poll( 1 ) } }
		);
		act( () => jest.advanceTimersByTime( 300 ) );
		expect( autoLayout ).toHaveBeenCalledTimes( 1 );
		const laid = result.current.positions;
		for ( let tick = 2; tick < 8; tick++ ) {
			act( () => rerender( { ...props, graph: poll( tick ) } ) );
			act( () => jest.advanceTimersByTime( 1000 ) );
		}
		expect( autoLayout ).toHaveBeenCalledTimes( 1 );
		expect( result.current.positions ).toBe( laid );
	} );

	it( 'lays scaffolding out again only once the real nodes stop arriving', () => {
		const props = {
			storageKey: 'newspack-nodes:test:scaffolding',
			ready: true,
			serverLayout: null,
		};
		const scaffolding = [ { id: '_shell' }, { id: '_http' } ];
		const arriving = ( ids ) => ( {
			nodes: [ ...scaffolding, ...ids.map( ( id ) => ( { id } ) ) ],
			edges: [],
		} );
		const { result, rerender } = renderHook(
			( p ) => useCanvasLayout( p ),
			{ initialProps: { ...props, graph: arriving( [] ) } }
		);
		act( () => jest.advanceTimersByTime( 300 ) );
		expect( autoLayout ).toHaveBeenCalledTimes( 1 );
		// Thirty real nodes arrive over three polls inside the settle window.
		const real = Array.from( { length: 30 }, ( _, i ) => `real:${ i }` );
		for ( const upTo of [ 2, 17, 30 ] ) {
			act( () =>
				rerender( {
					...props,
					graph: arriving( real.slice( 0, upTo ) ),
				} )
			);
			act( () => jest.advanceTimersByTime( 100 ) );
		}
		expect( autoLayout ).toHaveBeenCalledTimes( 1 );
		act( () => jest.advanceTimersByTime( 300 ) );
		expect( autoLayout ).toHaveBeenCalledTimes( 2 );
		const full = arriving( real );
		expect( autoLayout.mock.calls[ 1 ][ 0 ].nodes ).toHaveLength(
			full.nodes.length
		);
		const expected = {};
		for ( const n of jest
			.requireActual( '../../utils/autoLayout' )
			.autoLayout( full ).nodes ) {
			expected[ n.id ] = n.position;
		}
		expect( result.current.positions ).toEqual( expected );
	} );
} );
