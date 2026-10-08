import { renderHook, waitFor } from '@testing-library/react';

import { Core } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useCanonicalNodes, driftNodeIds } from '../useCanonicalNodes';
import brokerSchemas from '../../../../tests/fixtures/broker-schemas.json';

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
	}, 15000 );

	it( 'returns null when there is no canonical info (empty set)', () => {
		expect( driftNodeIds( [ { id: 'x' } ], new Set() ) ).toBeNull();
		expect( driftNodeIds( [ { id: 'x' } ], null ) ).toBeNull();
	} );
} );

describe( 'useCanonicalNodes', () => {
	const ready = { classes: brokerSchemas, loading: false, error: null };

	let send;
	beforeEach( () => {
		Core.reset();
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
		send = jest.fn();
		installFakeCommandWire( ( m ) => send( m ) );
	}, 15000 );

	it( 'fetches the topology .tsl and returns its declared node names', async () => {
		send.mockReturnValue( {
			owned: [],
			name: 'combined',
			tsl: 'make_node Echo alpha\nmake_node Tee beta\n',
		} );
		const { result } = renderHook( () =>
			useCanonicalNodes( 'combined', ready )
		);
		await waitFor( () => expect( result.current.size ).toBe( 2 ), {
			timeout: 4000,
		} );
		expect( result.current.has( 'alpha' ) ).toBe( true );
		expect( result.current.has( 'beta' ) ).toBe( true );
	}, 15000 );

	it( 'reads a topology writing a broker against the class catalog', async () => {
		send.mockReturnValue( {
			name: 'hub-9',
			tsl: 'make_node Remote_Source spoke-q3 lone o d egret.p0:sink-q\n',
			owned: [],
		} );
		const { result } = renderHook( () =>
			useCanonicalNodes( 'hub-9', ready )
		);
		await waitFor( () => expect( result.current.size ).toBe( 1 ), {
			timeout: 4000,
		} );
		expect( result.current.has( 'spoke-q3' ) ).toBe( true );
	}, 15000 );

	it.each( [
		[ 'loading', { classes: [], loading: true, error: null } ],
		[ 'failed', { classes: brokerSchemas, loading: false, error: 'down' } ],
	] )(
		'reports no drift once the class catalog is %s',
		async ( _state, notReady ) => {
			send.mockReturnValue( {
				name: 'hub-9',
				tsl: 'make_node Remote_Source spoke-q3 lone o d egret.p0:sink-q\n',
				owned: [],
			} );
			const { result, rerender } = renderHook(
				( { catalog } ) => useCanonicalNodes( 'hub-9', catalog ),
				{ initialProps: { catalog: ready } }
			);
			await waitFor( () => expect( result.current.size ).toBe( 1 ), {
				timeout: 4000,
			} );

			rerender( { catalog: notReady } );

			expect( result.current.size ).toBe( 0 );
		},
		15000
	);

	it( 'counts a node its owner builds as canonical, not as runtime drift', async () => {
		send.mockReturnValue( {
			name: 'crawl-k9',
			tsl: 'make_node Crawler crawl-k9 7203\n',
			owned: [
				{ name: 'crawl-k9:seen', class: 'Table', owner: 'crawl-k9' },
			],
		} );
		const { result } = renderHook( () =>
			useCanonicalNodes( 'crawl-k9', ready )
		);
		await waitFor( () => expect( result.current.size ).toBe( 2 ), {
			timeout: 4000,
		} );
		expect( result.current.has( 'crawl-k9:seen' ) ).toBe( true );
	}, 15000 );

	it( 'counts a BORROWED node as canonical, not as runtime drift', async () => {
		// combined.tsl owns one node and `include`s the rest. Comparing live nodes
		// against the raw file alone paints every borrowed node as drift — a
		// "temporary node" the operator never added.
		send.mockReturnValue( {
			owned: [],
			name: 'combined',
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

		const { result } = renderHook( () =>
			useCanonicalNodes( 'combined', ready )
		);

		await waitFor( () => expect( result.current.size ).toBe( 3 ), {
			timeout: 4000,
		} );
		expect( result.current.has( 'wombat:tee' ) ).toBe( true );
		expect( result.current.has( 'zebra:consumer' ) ).toBe( true );
		expect( result.current.has( 'zebra:partition' ) ).toBe( true );
	} );

	// hub-control-eve.tsl: `connect_node settings-sync settings:tw0`, where
	// settings-sync is borrowed. Parsing the file WITHOUT its expansion leaves
	// that source undeclared, and the draft interpreter refuses the statement to
	// stderr — which reaches the event log as
	// `browser: connect_node: unknown node: settings-sync` on every console open.
	it( 'seeds the include expansion, so a borrowed edge source is not refused', async () => {
		const warn = jest
			.spyOn( console, 'warn' )
			.mockImplementation( () => {} );
		send.mockReturnValue( {
			owned: [],
			name: 'combined',
			tsl:
				'include zebra-base\n' +
				'make_node HTTP_Out wombat:out tw0\n' +
				'connect_node zebra:consumer wombat:out\n',
			includes: [ 'zebra-base' ],
			expanded: {
				nodes: [
					{ name: 'zebra:consumer', class: 'Consumer', args: [] },
				],
				edges: [],
				tree: { 'zebra-base': {} },
			},
		} );

		const { result } = renderHook( () =>
			useCanonicalNodes( 'combined', ready )
		);

		await waitFor( () => expect( result.current.size ).toBe( 2 ), {
			timeout: 4000,
		} );
		expect( Core.recentLog.join( '\n' ) ).not.toMatch( /unknown node/ );
		warn.mockRestore();
	}, 15000 );

	it( 'returns an empty set (and does not fetch) when there is no topology', () => {
		const { result } = renderHook( () => useCanonicalNodes( '', ready ) );
		expect( result.current.size ).toBe( 0 );
		expect( send ).not.toHaveBeenCalled();
	} );

	// The slice publishes ONE view node, so the previous topology's answer is
	// still sitting in it when the next name is asked for. Reading it as the new
	// topology's canonical set would paint every node of the new one as drift.
	it( 'does not count the previous topology answer as the new one', async () => {
		send.mockReturnValue( {
			owned: [],
			name: 'combined',
			tsl: 'make_node Echo alpha\n',
		} );
		const { result, rerender } = renderHook(
			( { t } ) => useCanonicalNodes( t, ready ),
			{ initialProps: { t: 'combined' } }
		);
		await waitFor( () => expect( result.current.size ).toBe( 1 ), {
			timeout: 4000,
		} );

		// The reply for 'other' never arrives; 'combined' stays published.
		send.mockReturnValue( new Error( 'still-loading-2871' ) );
		rerender( { t: 'other' } );
		await waitFor( () => expect( result.current.size ).toBe( 0 ), {
			timeout: 4000,
		} );
	}, 15000 );

	it( 'resets to an empty set when the topology fetch rejects', async () => {
		send.mockReturnValueOnce( {
			owned: [],
			name: 'combined',
			tsl: 'make_node Echo alpha\n',
		} );
		const { result, rerender } = renderHook(
			( { t } ) => useCanonicalNodes( t, ready ),
			{ initialProps: { t: 'combined' } }
		);
		await waitFor( () => expect( result.current.size ).toBe( 1 ), {
			timeout: 4000,
		} );

		send.mockReturnValue( new Error( 'nope' ) );
		rerender( { t: 'other' } );
		await waitFor( () => expect( result.current.size ).toBe( 0 ), {
			timeout: 4000,
		} );
	} );
} );
