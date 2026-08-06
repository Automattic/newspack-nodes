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
import { SseInNode } from '../sse-in-node';
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

	describe( 'optimisticPatchAll', () => {
		it( 'patches every non-header entry in ONE publish', () => {
			const node = new MetadataNode();
			node.rawMap = {
				_header: { ts: 9 },
				alpha: { class: 'Echo_Node', debug_state: 0 },
				beta: { class: 'Tee_Node', debug_state: 0 },
			};
			let publishes = 0;
			const origSetState = node.setState.bind( node );
			node.setState = ( key, value ) => {
				publishes++;
				return origSetState( key, value );
			};
			node.optimisticPatchAll( { debug_state: 3 } );
			expect( publishes ).toBe( 1 );
			expect( node.rawMap.alpha.debug_state ).toBe( 3 );
			expect( node.rawMap.beta.debug_state ).toBe( 3 );
			expect( node.rawMap._header.debug_state ).toBeUndefined();
		} );
	} );

	describe( 'fire() poll emission', () => {
		it( 'emits a dump_metadata TM_COMMAND addressed to this.target (the _cwd indirection)', () => {
			const node = new MetadataNode();
			node.name = '_metadata';
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
			node.name = '_metadata';
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.pollIntervalMs = 5000;
			node.fire(); // first tick: lastFired=0 -> fires
			node.fire(); // same instant, < 5s elapsed, same path -> throttled
			expect( sent ).toHaveLength( 1 );
		} );

		it( 're-polls once pollIntervalMs has elapsed', () => {
			const node = new MetadataNode();
			node.name = '_metadata';
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.pollIntervalMs = 2000;
			node.fire(); // fires, lastFired = now
			node.fire(); // throttled (< 2s) — proves the gate is closed
			node.lastFired = Core.now() - 3; // pretend 3s passed (> 2s gate)
			node.fire(); // gate reopened -> fires
			expect( sent ).toHaveLength( 2 );
		} );

		it( 're-polls immediately when the cwd path changes (within pollIntervalMs)', () => {
			const cwd = new Node();
			cwd.name = '_cwd';
			cwd.target = '_sse/a';
			const node = new MetadataNode();
			node.name = '_metadata';
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.pollIntervalMs = 60000; // long gate so only a path change can re-fire
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
		it( 'sets pollIntervalMs from the parsed node count on each response', () => {
			const node = new MetadataNode();
			const payload = {};
			for ( let i = 0; i < 600; i++ ) {
				payload[ `n${ i }` ] = { class: 'Echo', target: '' };
			}
			node.fill( msg( TM_STRUCT, payload ) );
			// 600 nodes -> 6000ms -> 6s -> nearest 5s -> 5000.
			expect( node.pollIntervalMs ).toBe( 5000 );
		} );
	} );

	describe( 'TimerNode integration (router-hitchhike via notify_timer)', () => {
		afterEach( () => Core.reset() );

		it( 'is a TimerNode subclass', () => {
			expect( new MetadataNode() ).toBeInstanceOf( TimerNode );
		} );

		it( 'setTimer() registers on the router TIMER; notify_timer fires the poll', () => {
			const router = new RouterNode();
			router.name = names.ROUTER;
			router.stopTimer();
			const node = new MetadataNode();
			node.name = names.METADATA;
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = names.CWD;
			node.setTimer();
			router.notifyTimer();
			expect( sent ).toHaveLength( 1 );
			expect( sent[ 0 ][ VALUE ].name ).toBe( 'dump_metadata' );
			node.stopTimer();
		} );

		it( 're-polls on a cd through the REAL router fireCb even with a large pollIntervalMs (the base interval_ms stays 0 so it never double-throttles)', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const router = new RouterNode();
			router.name = names.ROUTER;
			router.stopTimer();
			const cwd = new Node();
			cwd.name = names.CWD;
			cwd.target = '_sse/a';
			const node = new MetadataNode();
			node.name = names.METADATA;
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = names.CWD;
			node.setTimer();
			node.pollIntervalMs = 30000; // a fill() scaled the self-throttle large

			nowSpy.mockReturnValue( 100 );
			router.notifyTimer(); // fires, lastPath = '_sse/a'
			expect( sent ).toHaveLength( 1 );

			nowSpy.mockReturnValue( 101 );
			router.notifyTimer(); // same path, < 30s → throttled
			expect( sent ).toHaveLength( 1 );

			cwd.target = '_sse/b'; // user cd'd
			nowSpy.mockReturnValue( 102 );
			router.notifyTimer(); // path changed → must re-poll the same tick
			expect( sent ).toHaveLength( 2 );
			node.stopTimer();
			nowSpy.mockRestore();
		} );

		it( 'removeNode unregisters from the router TIMER (no leak)', () => {
			const router = new RouterNode();
			router.name = names.ROUTER;
			router.stopTimer();
			const node = new MetadataNode();
			node.name = names.METADATA;
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
			node.name = '_output';
			const meta = dumpMetadataPayload()._output;
			expect( meta.has_target ).toBe( false );
			// Dumper omits accepts_fill, so it defaults true.
			expect( meta.accepts_fill ).toBe( true );
		} );

		it( 'emits accepts_fill:false for a node whose schema declares it (SseIn)', () => {
			const node = new SseInNode();
			node.name = '_sse';
			const meta = dumpMetadataPayload()._sse;
			expect( meta.accepts_fill ).toBe( false );
			// SseIn declares has_target:true.
			expect( meta.has_target ).toBe( true );
		} );

		it( 'defaults both flags to true for a plain node with no static schema (Echo)', () => {
			const node = new EchoNode();
			node.name = 'probe';
			const meta = dumpMetadataPayload().probe;
			expect( meta.accepts_fill ).toBe( true );
			expect( meta.has_target ).toBe( true );
		} );
	} );

	describe( 'dumpMetadataPayload( name ) single-node filter', () => {
		afterEach( () => Core.reset() );

		it( 'returns only the named node', () => {
			new EchoNode().name = 'keep';
			new EchoNode().name = 'other';
			expect( Object.keys( dumpMetadataPayload( 'keep' ) ) ).toEqual( [
				'keep',
			] );
		} );

		it( 'returns an empty map for an unknown node', () => {
			new EchoNode().name = 'keep';
			expect( dumpMetadataPayload( 'ghost' ) ).toEqual( {} );
		} );
	} );

	describe( 'dumpMetadataPayload registrations', () => {
		afterEach( () => Core.reset() );

		it( 'emits node-name registrations and omits closures', () => {
			const emitter = new EchoNode();
			emitter.name = 'emitter';
			emitter.registrations = { EVT: {} };
			new EchoNode().name = 'listener';
			emitter.register( 'EVT', 'listener' );
			emitter.register( 'EVT', 'closure', () => {} );

			expect( dumpMetadataPayload().emitter.registrations ).toEqual( {
				EVT: [ 'listener' ],
			} );
		} );

		it( 'omits the registrations field for a node with none', () => {
			new EchoNode().name = 'plain';
			expect( 'registrations' in dumpMetadataPayload().plain ).toBe(
				false
			);
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
			node.pollIntervalMs = 30000;
			node.optimisticPatch( 'a', { target: 'b' } );
			expect( node.pollIntervalMs ).toBe( 30000 );
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

	describe( 'parseMetadata carries the raw target', () => {
		it( 'carries an array target (Tee-family fan-out signal) onto the graph node', () => {
			const { nodes } = parseMetadata( {
				tee: { class: 'Tee', target: [ 'a', 'b' ] },
			} );
			expect( nodes[ 0 ].target ).toEqual( [ 'a', 'b' ] );
		} );

		it( 'carries a string target onto the graph node', () => {
			const { nodes } = parseMetadata( {
				echo: { class: 'Echo', target: 'next' },
			} );
			expect( nodes[ 0 ].target ).toBe( 'next' );
		} );
	} );

	describe( 'parseMetadata hides process scaffolding', () => {
		it( 'drops the backbone but keeps the TSL-declared Topic_Probe visible', () => {
			// The probe moved into topology TSL (`include topic-probe`): it is
			// an ordinary declared node now and renders like one.
			const { nodes, edges } = parseMetadata( {
				_command_interpreter: {
					class: 'Command_Interpreter',
					sink: '_router',
				},
				_router: { class: 'Router' },
				topicprobe: { class: 'Topic_Probe', target: 'topicprobe:log' },
				'topicprobe:log': { class: 'Partition' },
				firehose: { class: 'Consumer', target: 'request-builder' },
				'request-builder': { class: 'Request_Builder' },
			} );
			const ids = nodes.map( ( n ) => n.id ).sort();
			expect( ids ).toEqual( [
				'firehose',
				'request-builder',
				'topicprobe',
				'topicprobe:log',
			] );
			// The probe→log edge renders; nothing references the backbone.
			const touched = edges.flatMap( ( e ) => [ e.from, e.to ] );
			expect( touched ).toContain( 'topicprobe' );
			expect( touched ).not.toContain( '_router' );
		} );
	} );
} );
