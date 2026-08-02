import { renderHook, waitFor } from '@testing-library/react';

// Spy on parseTsl so post-unmount test asserts !live short-circuits parsing.
jest.mock( '../../utils/parseTsl', () => {
	const actual = jest.requireActual( '../../utils/parseTsl' );
	return { parseTsl: jest.fn( actual.parseTsl ) };
} );

const { parseTsl } = require( '../../utils/parseTsl' );

import { Core } from '@newspack-nodes/runtime';
import {
	installFakeCommandWire,
	makeFakeCommandWire,
} from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useCanonicalNodes, driftNodeIds } from '../useCanonicalNodes';

describe( 'driftNodeIds', () => {
	it( 'returns live nodes absent from the canonical set, excluding reserved _ infra', () => {
		const canonical = new Set( [ 'alpha', 'beta' ] );
		const nodes = [
			{ id: 'alpha' },
			{ id: 'beta' },
			{ id: 'gamma' }, // runtime-added → drift
			{ id: '_repl' }, // reserved console infra → never drift
		];
		expect( [ ...driftNodeIds( nodes, canonical ) ] ).toEqual( [
			'gamma',
		] );
	} );

	it( 'returns null when there is no canonical info (empty set)', () => {
		expect( driftNodeIds( [ { id: 'x' } ], new Set() ) ).toBeNull();
		expect( driftNodeIds( [ { id: 'x' } ], null ) ).toBeNull();
	} );
} );

describe( 'useCanonicalNodes', () => {
	let send;
	beforeEach( () => {
		Core.reset();
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
		send = jest.fn();
		installFakeCommandWire( ( m ) => send( m ) );
	} );

	it( 'fetches the topology .tsl and returns its declared node names', async () => {
		send.mockReturnValue( {
			tsl: 'make_node Echo alpha\nmake_node Tee beta\n',
		} );
		const { result } = renderHook( () => useCanonicalNodes( 'combined' ) );
		await waitFor( () => expect( result.current.size ).toBe( 2 ) );
		expect( result.current.has( 'alpha' ) ).toBe( true );
		expect( result.current.has( 'beta' ) ).toBe( true );
	} );

	it( 'counts a BORROWED node as canonical, not as runtime drift', async () => {
		// combined.tsl owns one node and `include`s the rest. Comparing live nodes
		// against the raw file alone paints every borrowed node as drift — a
		// "temporary node" the operator never added.
		send.mockReturnValue( {
			tsl: 'include zebra-base\nmake_node Tee wombat:tee\n',
			includes: [ 'zebra-base' ],
			expanded: {
				nodes: [
					{ name: 'zebra:consumer', class: 'Consumer', args: [] },
					{ name: 'zebra:partition', class: 'Partition', args: [] },
				],
				edges: [],
				tree: { 'zebra-base': {} },
			},
		} );

		const { result } = renderHook( () => useCanonicalNodes( 'combined' ) );

		await waitFor( () => expect( result.current.size ).toBe( 3 ) );
		expect( result.current.has( 'wombat:tee' ) ).toBe( true );
		expect( result.current.has( 'zebra:consumer' ) ).toBe( true );
		expect( result.current.has( 'zebra:partition' ) ).toBe( true );
	} );

	it( 'returns an empty set (and does not fetch) when there is no topology', () => {
		const { result } = renderHook( () => useCanonicalNodes( '' ) );
		expect( result.current.size ).toBe( 0 );
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'ignores a fetch that resolves after the hook unmounts', async () => {
		parseTsl.mockClear();
		send.mockReturnValue( { tsl: 'make_node Echo alpha\n' } );
		// Hold the wire open so the reply lands only after the unmount.
		const wire = makeFakeCommandWire( ( m ) => send( m ) );
		let release;
		global.fetch = jest.fn(
			( ...args ) =>
				new Promise( ( resolve ) => {
					release = () => resolve( wire( ...args ) );
				} )
		);
		const { unmount } = renderHook( () => useCanonicalNodes( 'combined' ) );
		// The mint waits out /auth, so let it reach the wire before unmounting.
		await waitFor( () => expect( global.fetch ).toHaveBeenCalled() );
		unmount();
		release();
		// Flush the resolve handlers.
		for ( let i = 0; i < 8; i++ ) {
			await Promise.resolve();
		}
		// !live guard returns before parse/setState; parseTsl running is a bug.
		expect( parseTsl ).not.toHaveBeenCalled();
	} );

	it( 'resets to an empty set when the topology fetch rejects', async () => {
		send.mockReturnValueOnce( { tsl: 'make_node Echo alpha\n' } );
		const { result, rerender } = renderHook(
			( { t } ) => useCanonicalNodes( t ),
			{ initialProps: { t: 'combined' } }
		);
		await waitFor( () => expect( result.current.size ).toBe( 1 ) );

		send.mockReturnValueOnce( new Error( 'nope' ) );
		rerender( { t: 'other' } );
		await waitFor( () => expect( result.current.size ).toBe( 0 ) );
	} );
} );
