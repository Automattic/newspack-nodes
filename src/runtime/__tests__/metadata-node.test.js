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

		it( 'always emits while a sink exists (no pollTo gate; _cwd handles every scope)', () => {
			const node = new MetadataNode();
			node.setName( '_metadata' );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			node.target = '_cwd';
			node.fire();
			node.fire();
			expect( sent ).toHaveLength( 2 );
			expect( node.pollTo ).toBeUndefined();
		} );

		it( 'emits nothing when there is no sink', () => {
			const node = new MetadataNode();
			node.target = '_cwd';
			expect( () => node.fire() ).not.toThrow();
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
