/**
 * A metadata poll republishes the whole graph every second, so a fresh graph
 * object carrying the same nodes and edges must never lay the canvas out again,
 * while one that adds a node or an edge lays an untouched layout out afresh.
 */

import { renderHook, act } from '@testing-library/react';
import { useCanvasLayout } from '../useCanvasLayout';
import { autoLayout, drawnCost, placeBelow } from '../../utils/autoLayout';
import { augmentWithVirtualEdges } from '../../utils/virtualEdges';
import { parseMetadata } from '../../../runtime/metadata-node';
import { seededGraph } from '../../utils/__tests__/fixtures/seededGraph';
import SEED from '../../utils/__tests__/fixtures/crawler-seed.json';

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

	describe( 'a poll that adds structure', () => {
		/** The crawler worker's live graph: its owned Table and the edge to it. */
		const live = () =>
			augmentWithVirtualEdges(
				parseMetadata( SEED.metadata ),
				SEED.classes
			);
		/** The seed a server answering no owned nodes paints: neither. */
		const bare = () => seededGraph( { ...SEED, owned: [] } );
		/** The live graph short of its owner's edge to the Table. */
		const unwired = () => {
			const g = live();
			return {
				...g,
				edges: g.edges.filter( ( e ) => 'crawler:seen' !== e.to ),
			};
		};
		const props = {
			storageKey: 'newspack-nodes:test:growth',
			ready: true,
			serverLayout: null,
		};
		/**
		 * The positions autoLayout gives a graph.
		 *
		 * @param {Object} graph The graph.
		 * @return {Object<string,{x: number, y: number}>} Position by id.
		 */
		const laid = ( graph ) =>
			Object.fromEntries(
				jest
					.requireActual( '../../utils/autoLayout' )
					.autoLayout( graph )
					.nodes.map( ( n ) => [ n.id, n.position ] )
			);
		/**
		 * Mount on one graph, let it settle, then poll another and settle.
		 *
		 * @param {Object} first The graph laid out first.
		 * @param {Object} next  The graph the poll brings.
		 * @return {Object} The hook's result.
		 */
		const pollInto = ( first, next ) => {
			const hook = renderHook( ( p ) => useCanvasLayout( p ), {
				initialProps: { ...props, graph: first },
			} );
			act( () => jest.advanceTimersByTime( 300 ) );
			act( () => hook.rerender( { ...props, graph: next } ) );
			act( () => jest.advanceTimersByTime( 300 ) );
			return hook;
		};

		it( 'lays an owned Table out beside its owner when the poll brings both', () => {
			const { result } = pollInto( bare(), live() );
			const at = result.current.positions;
			expect( autoLayout ).toHaveBeenCalledTimes( 2 );
			expect( at ).toMatchObject( laid( live() ) );
			expect( at[ 'crawler:seen' ].x ).toBeGreaterThan( at.crawler.x );
			expect( drawnCost( at, live().edges ).over ).toEqual( [] );
			expect( result.current.canReset ).toBe( false );
		} );

		it( 'lays out again when the poll brings an edge alone', () => {
			const { result } = pollInto( unwired(), live() );
			expect( autoLayout ).toHaveBeenCalledTimes( 2 );
			expect( result.current.positions ).toMatchObject( laid( live() ) );
		} );

		it( 'draws the new node only once the structure settles', () => {
			const hook = renderHook( ( p ) => useCanvasLayout( p ), {
				initialProps: { ...props, graph: bare() },
			} );
			act( () => jest.advanceTimersByTime( 300 ) );
			act( () => hook.rerender( { ...props, graph: live() } ) );
			act( () => jest.advanceTimersByTime( 100 ) );
			expect( hook.result.current.positions[ 'crawler:seen' ] ).toBe(
				undefined
			);
			act( () => jest.advanceTimersByTime( 200 ) );
			expect( hook.result.current.positions[ 'crawler:seen' ] ).toEqual(
				laid( live() )[ 'crawler:seen' ]
			);
		} );

		it( 'tucks rather than lays out again under a server layout', () => {
			const server = laid( bare() );
			const hook = renderHook( ( p ) => useCanvasLayout( p ), {
				initialProps: {
					...props,
					serverLayout: server,
					graph: bare(),
				},
			} );
			act( () =>
				hook.rerender( {
					...props,
					serverLayout: server,
					graph: live(),
				} )
			);
			act( () => jest.advanceTimersByTime( 300 ) );
			expect( autoLayout ).not.toHaveBeenCalled();
			expect( hook.result.current.positions ).toEqual( {
				...server,
				'crawler:seen': placeBelow( server ),
			} );
		} );

		it( 'lays a stored untouched layout out again once, when it records no edges', () => {
			const stored = laid( bare() );
			window.localStorage.setItem(
				props.storageKey,
				JSON.stringify( {
					positions: {
						...stored,
						'crawler:seen': placeBelow( stored ),
					},
					viewportDelta: null,
					modified: false,
				} )
			);
			const hook = renderHook( ( p ) => useCanvasLayout( p ), {
				initialProps: { ...props, graph: live() },
			} );
			act( () => jest.advanceTimersByTime( 300 ) );
			expect( autoLayout ).toHaveBeenCalledTimes( 1 );
			expect( hook.result.current.positions ).toMatchObject(
				laid( live() )
			);
			for ( let tick = 0; tick < 3; tick++ ) {
				act( () => hook.rerender( { ...props, graph: live() } ) );
				act( () => jest.advanceTimersByTime( 1000 ) );
			}
			expect( autoLayout ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'leaves a stored layout alone when it records every edge', () => {
			const first = pollInto( bare(), live() );
			const settled = first.result.current.positions;
			first.unmount();
			autoLayout.mockClear();
			const again = renderHook( ( p ) => useCanvasLayout( p ), {
				initialProps: { ...props, graph: bare() },
			} );
			act( () => jest.advanceTimersByTime( 300 ) );
			act( () => again.rerender( { ...props, graph: live() } ) );
			act( () => jest.advanceTimersByTime( 300 ) );
			expect( autoLayout ).not.toHaveBeenCalled();
			expect( again.result.current.positions ).toEqual( settled );
		} );
	} );
} );
