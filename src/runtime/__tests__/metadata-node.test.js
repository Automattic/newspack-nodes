/**
 * Metadata node tests — the `_metadata` node. `_router` delivers the
 * dump_metadata poll reply (a POSITIONAL Message); the node parses the graph
 * and publishes it for the canvas ( useNodeState( '_metadata', 'metadata' ) ).
 * Never touches the transcript.
 */

import {
	MetadataNode,
	dumpMetadataPayload,
	parseMetadata,
	computePollIntervalMs,
} from '../metadata-node';
import { Node } from '../node';
import { TimerNode } from '../timer-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import names from '../reserved-node-names.json';
import { DumperNode } from '../dumper-node';
import { SseConnectorNode } from '../sse-connector-node';
import { EchoNode } from '../echo-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_STRUCT,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

function msg( type, value ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ VALUE ] = value;
	return m;
}

describe( 'Metadata node', () => {
	afterEach( () => {
		Core.reset();
	} );

	it( 'parses a bare dump_metadata struct VALUE into the metadata state', () => {
		const node = new MetadataNode();
		node.fill(
			msg( TM_STRUCT, {
				n1: { class: 'Echo', counter: 5, target: 'n2' },
				n2: { class: 'Echo', counter: 3, target: '' },
			} )
		);
		const meta = node.setStateCache.metadata;
		expect( meta.nodes ).toHaveLength( 2 );
		expect( meta.edges ).toEqual( [ { from: 'n1', to: 'n2' } ] );
	} );

	it( 'unwraps a {name,payload} command-response envelope', () => {
		const node = new MetadataNode();
		node.fill(
			msg( TM_COMMAND | TM_RESPONSE, {
				name: 'dump_metadata',
				payload: { n1: { class: 'Echo', counter: 7, target: '' } },
			} )
		);
		expect( node.setStateCache.metadata.nodes ).toHaveLength( 1 );
	} );

	it( 'ignores an empty / null payload (no canvas churn)', () => {
		const node = new MetadataNode();
		node.fill( msg( TM_STRUCT, '' ) );
		node.fill( msg( TM_STRUCT, null ) );
		expect( node.setStateCache.metadata ).toBeUndefined();
	} );

	it( 'pre-declares the `metadata` event so useNodeState can subscribe', () => {
		const node = new MetadataNode();
		expect( node.registrations.metadata ).toBeDefined();
	} );

	it( 'works as a real sink target (router → metadata.fill)', () => {
		const node = new MetadataNode();
		const router = new Node();
		router.sink = node;
		router.fill(
			msg( TM_STRUCT, { n1: { class: 'Echo', counter: 1, target: '' } } )
		);
		expect( node.setStateCache.metadata.nodes ).toHaveLength( 1 );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const node = new MetadataNode();
		node.fill( msg( TM_STRUCT, { n1: { class: 'Echo' } } ) );
		node.fill( msg( TM_STRUCT, { n1: { class: 'Echo' } } ) );
		expect( node.counter ).toBe( 2 );
	} );

	describe( 'fire() poll emission', () => {
		it( 'emits a dump_metadata TM_COMMAND addressed to this.target (the _cwd indirection)', () => {
			const node = new MetadataNode();
			node.setName( '_metadata' );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.fire();
			expect( sent ).toHaveLength( 1 );
			const m = sent[ 0 ];
			expect( m[ TYPE ] ).toBe( TM_COMMAND );
			expect( m[ VALUE ].name ).toBe( 'dump_metadata' );
			expect( m[ TO ] ).toBe( '_cwd' );
			expect( m[ FROM ] ).toBe( '_metadata' );
		} );

		it( 'throttles repeated ticks within interval_ms (first fires, second does not)', () => {
			const node = new MetadataNode();
			node.setName( '_metadata' );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.interval_ms = 5000;
			node.fire(); // first tick: lastFired=0 -> fires
			node.fire(); // same instant, < 5s elapsed, same path -> throttled
			expect( sent ).toHaveLength( 1 );
		} );

		it( 're-polls once interval_ms has elapsed', () => {
			const node = new MetadataNode();
			node.setName( '_metadata' );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.interval_ms = 2000;
			node.fire(); // fires, lastFired = now
			node.fire(); // throttled (< 2s) — proves the gate is closed
			node.lastFired = Core.now() - 3; // pretend 3s passed (> 2s gate)
			node.fire(); // gate reopened -> fires
			expect( sent ).toHaveLength( 2 );
		} );

		it( 're-polls immediately when the pivot path changes (within interval_ms)', () => {
			const cwd = new Node();
			cwd.setName( '_cwd' );
			cwd.target = '_sse/a';
			const node = new MetadataNode();
			node.setName( '_metadata' );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.interval_ms = 60000; // long gate so only a path change can re-fire
			node.fire(); // path '_sse/a' -> fires, lastPath = '_sse/a'
			node.fire(); // same path, < 60s -> throttled (proves the gate)
			cwd.target = '_sse/b'; // user cd'd to another worker
			node.fire(); // same instant, but path changed -> fires
			expect( sent ).toHaveLength( 2 );
			expect( sent[ 1 ][ TO ] ).toBe( '_cwd' );
		} );

		it( 'emits nothing when there is no sink', () => {
			const node = new MetadataNode();
			node.target = '_cwd';
			expect( () => node.fire() ).not.toThrow();
		} );
	} );

	describe( 'computePollIntervalMs (nodeCount * 10ms, rounded)', () => {
		it( 'floors at 5s (anything up to ~5s of computed cadence)', () => {
			expect( computePollIntervalMs( 0 ) ).toBe( 5000 );
			expect( computePollIntervalMs( 30 ) ).toBe( 5000 ); // 0.3s -> floor 5s
			expect( computePollIntervalMs( 100 ) ).toBe( 5000 ); // 1.0s -> floor 5s
			expect( computePollIntervalMs( 250 ) ).toBe( 5000 ); // 2.5s -> floor 5s
			expect( computePollIntervalMs( 500 ) ).toBe( 5000 ); // 5.0s
		} );

		it( 'rounds to the nearest 5 seconds once past 5s', () => {
			expect( computePollIntervalMs( 600 ) ).toBe( 5000 ); // 6s -> 5s
			expect( computePollIntervalMs( 800 ) ).toBe( 10000 ); // 8s -> 10s
			expect( computePollIntervalMs( 3000 ) ).toBe( 30000 ); // 30s
			expect( computePollIntervalMs( 3145 ) ).toBe( 30000 ); // 31.45s -> 30s
		} );
	} );

	describe( 'fill() scales the poll interval to graph size', () => {
		it( 'sets interval_ms from the parsed node count on each response', () => {
			const node = new MetadataNode();
			const payload = {};
			for ( let i = 0; i < 600; i++ ) {
				payload[ `n${ i }` ] = { class: 'Echo', target: '' };
			}
			node.fill( msg( TM_STRUCT, payload ) );
			// 600 nodes -> 6000ms -> 6s -> nearest 5s -> 5000.
			expect( node.interval_ms ).toBe( 5000 );
		} );
	} );

	describe( 'TimerNode integration (router-hitchhike via notify_timer)', () => {
		afterEach( () => Core.reset() );

		it( 'is a TimerNode subclass', () => {
			expect( new MetadataNode() ).toBeInstanceOf( TimerNode );
		} );

		it( 'setTimer() registers on the router TIMER; notify_timer fires the poll', () => {
			const router = new RouterNode();
			router.setName( names.ROUTER );
			router.stopTimer();
			const node = new MetadataNode();
			node.setName( names.METADATA );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = names.CWD;
			node.setTimer();
			router.notifyTimer();
			expect( sent ).toHaveLength( 1 );
			expect( sent[ 0 ][ VALUE ].name ).toBe( 'dump_metadata' );
			node.stopTimer();
		} );

		it( 'removeNode unregisters from the router TIMER (no leak)', () => {
			const router = new RouterNode();
			router.setName( names.ROUTER );
			router.stopTimer();
			const node = new MetadataNode();
			node.setName( names.METADATA );
			node.sink = { fill: () => {} };
			node.setTimer();
			node.removeNode();
			expect( names.METADATA in router.registrations.TIMER ).toBe(
				false
			);
			expect( () => router.notifyTimer() ).not.toThrow();
		} );
	} );

	describe( 'dumpMetadataPayload port flags', () => {
		afterEach( () => Core.reset() );

		it( 'emits has_target:false for a node whose schema declares it (Dumper)', () => {
			const node = new DumperNode();
			node.setName( '_output' );
			const meta = dumpMetadataPayload()._output;
			expect( meta.has_target ).toBe( false );
			// Dumper omits accepts_fill, so it defaults true.
			expect( meta.accepts_fill ).toBe( true );
		} );

		it( 'emits accepts_fill:false for a node whose schema declares it (SseConnector)', () => {
			const node = new SseConnectorNode();
			node.setName( '_sse' );
			const meta = dumpMetadataPayload()._sse;
			expect( meta.accepts_fill ).toBe( false );
			// SseConnector omits has_target, so it defaults true.
			expect( meta.has_target ).toBe( true );
		} );

		it( 'defaults both flags to true for a plain node with no static schema (Echo)', () => {
			const node = new EchoNode();
			node.setName( 'probe' );
			const meta = dumpMetadataPayload().probe;
			expect( meta.accepts_fill ).toBe( true );
			expect( meta.has_target ).toBe( true );
		} );
	} );

	describe( 'dumpMetadataPayload( name ) single-node filter', () => {
		afterEach( () => Core.reset() );

		it( 'returns only the named node', () => {
			new EchoNode().setName( 'keep' );
			new EchoNode().setName( 'other' );
			expect( Object.keys( dumpMetadataPayload( 'keep' ) ) ).toEqual( [
				'keep',
			] );
		} );

		it( 'returns an empty map for an unknown node', () => {
			new EchoNode().setName( 'keep' );
			expect( dumpMetadataPayload( 'ghost' ) ).toEqual( {} );
		} );
	} );

	describe( 'optimisticPatch (local edits, no round-trip)', () => {
		// Seed the kept rawMap via a normal full-poll reply.
		function seed( node, payload ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			m[ VALUE ] = { name: 'dump_metadata', arguments: '', payload };
			node.fill( m );
		}

		it( 'adds a newly-dropped node, keeping the others', () => {
			const node = new MetadataNode();
			seed( node, { a: { class: 'Echo', target: '' } } );
			node.optimisticPatch( 'c', { class: 'Tee', target: '' } );
			const meta = node.setStateCache.metadata;
			expect( meta.nodes.map( ( n ) => n.id ).sort() ).toEqual( [
				'a',
				'c',
			] );
			expect( meta.nodes.find( ( n ) => n.id === 'c' ).class ).toBe(
				'Tee'
			);
		} );

		it( 'sets a connection (merges target) so the edge appears at once', () => {
			const node = new MetadataNode();
			seed( node, {
				a: { class: 'Echo', counter: 7, target: '' },
				b: { class: 'Echo', target: '' },
			} );
			node.optimisticPatch( 'a', { target: 'b' } );
			const meta = node.setStateCache.metadata;
			expect( meta.edges ).toContainEqual( { from: 'a', to: 'b' } );
			// Shallow-merge keeps the rest of the node's metadata (counter).
			expect( meta.nodes.find( ( n ) => n.id === 'a' ).count ).toBe( 7 );
		} );

		it( 'clears a connection (empty target) so the edge disappears', () => {
			const node = new MetadataNode();
			seed( node, { a: { class: 'Echo', target: 'b' } } );
			node.optimisticPatch( 'a', { target: '' } );
			expect( node.setStateCache.metadata.edges ).toHaveLength( 0 );
		} );

		it( 'removes a node when patched with null', () => {
			const node = new MetadataNode();
			seed( node, {
				a: { class: 'Echo', target: '' },
				b: { class: 'Echo', target: '' },
			} );
			node.optimisticPatch( 'b', null );
			expect(
				node.setStateCache.metadata.nodes.map( ( n ) => n.id )
			).toEqual( [ 'a' ] );
		} );

		it( 'does not rescale the poll interval', () => {
			const node = new MetadataNode();
			seed( node, { a: { class: 'Echo', target: '' } } );
			node.interval_ms = 30000;
			node.optimisticPatch( 'a', { target: 'b' } );
			expect( node.interval_ms ).toBe( 30000 );
		} );

		it( 'ignores an empty name', () => {
			const node = new MetadataNode();
			seed( node, { a: { class: 'Echo', target: '' } } );
			node.optimisticPatch( '', { target: 'b' } );
			expect(
				node.setStateCache.metadata.nodes.map( ( n ) => n.id )
			).toEqual( [ 'a' ] );
		} );
	} );

	describe( 'parseMetadata port flags', () => {
		it( 'carries accepts_fill / has_target onto the graph node', () => {
			const { nodes } = parseMetadata( {
				src: { class: 'Source', accepts_fill: false, has_target: true },
			} );
			expect( nodes[ 0 ].accepts_fill ).toBe( false );
			expect( nodes[ 0 ].has_target ).toBe( true );
		} );

		it( 'defaults both flags to true when the meta omits them', () => {
			const { nodes } = parseMetadata( {
				plain: { class: 'Echo' },
			} );
			expect( nodes[ 0 ].accepts_fill ).toBe( true );
			expect( nodes[ 0 ].has_target ).toBe( true );
		} );
	} );
} );
