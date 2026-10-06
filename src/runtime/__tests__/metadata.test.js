import { Core } from '../core';
import { Node } from '../node';
import { TeeNode } from '../tee-node';
import { RouterNode } from '../router-node';
import { dumpMetadataPayload } from '../metadata-node';

/** Stands for a server Table: an owned one still draws on the canvas. */
class TableNode extends Node {
	static nodeSchema() {
		return { category: 'Storage', shown_when_owned: true };
	}
}

/** Builds a patron owning a Table, a hidden sidecar and the Table's `:config`. */
function ownedGraph() {
	const crawler = new Node();
	crawler.name = 'crawl-4471';
	crawler.target = 'pages-6219';
	const seen = new TableNode();
	seen.patron = crawler;
	seen.name = 'crawl-4471:seen';
	const curl = new Node();
	curl.patron = crawler;
	curl.name = 'crawl-4471:curl';
	const config = new Node();
	config.patron = seen;
	config.name = 'crawl-4471:seen:config';
}

describe( 'dumpMetadataPayload', () => {
	beforeEach( () => {
		Core.reset();
		RouterNode.profiles( null );
	} );

	it( 'reports the SHELL name (strips the _Node suffix), matching the worker tier', () => {
		// Worker emits shell names (Tee); the in-browser tier must match them.
		const tee = new TeeNode();
		tee.name = 'firehose:tee';
		expect( dumpMetadataPayload()[ 'firehose:tee' ].class ).toBe( 'Tee' );
	} );

	it( 'maps a node to the dump_metadata field shape', () => {
		const a = new Node();
		a.name = 'a';
		a.target = 'b';
		a.counter = 7;
		const payload = dumpMetadataPayload();
		expect( payload.a ).toEqual(
			expect.objectContaining( {
				class: 'Node',
				counter: 7,
				target: 'b',
				sink: '',
				debug_state: 0,
				arguments: [],
			} )
		);
	} );

	it( 'emits both wire keys: the routing `target` and the `targets` list', () => {
		// PHP parity: a JS worker's row must be indistinguishable from a PHP
		// one. JS nodes declare no extras, so `targets` is just the target.
		const relay = new Node();
		relay.name = 'beacon-relay';
		relay.target = 'downstream-sump';
		const fanout = new TeeNode();
		fanout.name = 'spindle-fanout';
		fanout.target = [ 'quarry-sump', 'lantern-sump' ];
		const payload = dumpMetadataPayload();
		expect( payload[ 'beacon-relay' ].target ).toBe( 'downstream-sump' );
		expect( payload[ 'beacon-relay' ].targets ).toEqual( [
			'downstream-sump',
		] );
		expect( payload[ 'spindle-fanout' ].targets ).toEqual( [
			'quarry-sump',
			'lantern-sump',
		] );
	} );

	it( 'skips patron-linked plumbing nodes', () => {
		const a = new Node();
		a.name = 'a';
		const b = new Node();
		b.name = 'b';
		b.patron = a;
		const payload = dumpMetadataPayload();
		expect( payload.a ).toBeDefined();
		expect( payload.b ).toBeUndefined();
	} );

	it( 'lists an owned Table and hides every other owned node', () => {
		ownedGraph();
		const payload = dumpMetadataPayload();
		expect( payload[ 'crawl-4471:seen' ].class ).toBe( 'Table' );
		expect( payload[ 'crawl-4471:seen' ].has_config ).toBe( true );
		expect( payload[ 'crawl-4471:curl' ] ).toBeUndefined();
		expect( payload[ 'crawl-4471:seen:config' ] ).toBeUndefined();
	} );

	it( 'names an owned Table its patron as owner, and an unowned node none', () => {
		ownedGraph();
		const payload = dumpMetadataPayload();
		expect( payload[ 'crawl-4471:seen' ].owner ).toBe( 'crawl-4471' );
		expect( 'owner' in payload[ 'crawl-4471' ] ).toBe( false );
	} );

	it( 'draws a patron no edge it does not route to', () => {
		ownedGraph();
		expect( dumpMetadataPayload()[ 'crawl-4471' ].targets ).toEqual( [
			'pages-6219',
		] );
	} );

	it( 'skips a node whose schema says hidden, as the PHP producer does', () => {
		class QueueTimerNode extends Node {
			static nodeSchema() {
				return { hidden: true };
			}
		}
		const timer = new QueueTimerNode();
		timer.name = 'queue-timer-3307';
		expect( dumpMetadataPayload()[ 'queue-timer-3307' ] ).toBeUndefined();
	} );

	it( 'returns an owned Table named alone', () => {
		ownedGraph();
		expect(
			Object.keys( dumpMetadataPayload( 'crawl-4471:seen' ) )
		).toEqual( [ 'crawl-4471:seen' ] );
	} );

	it( 'stamps the local reply path (_output) + profiling state into the _header section', () => {
		const a = new Node();
		a.name = 'a';
		const payload = dumpMetadataPayload();
		// In-browser reply path is the bare Dumper _output; profiling off default.
		expect( payload._header ).toEqual( {
			pwd: '_output',
			profiling: false,
		} );
	} );

	it( 'reports profiling: true in the _header when the router is profiling', () => {
		const a = new Node();
		a.name = 'a';
		RouterNode.profiles( {} );
		expect( dumpMetadataPayload()._header.profiling ).toBe( true );
	} );
} );
