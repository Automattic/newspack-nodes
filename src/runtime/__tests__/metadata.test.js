import { Core } from '../core';
import { Node } from '../node';
import { TeeNode } from '../tee-node';
import { RouterNode } from '../router-node';
import {
	dumpMetadataPayload,
	dumpOwnedPayload,
	parseMetadata,
} from '../metadata-node';

/** Stands for a server Table, which its owner opens like any sidecar. */
class TableNode extends Node {
	static nodeSchema() {
		return { category: 'Storage' };
	}
}

/** A sidecar whose schema keeps it off every console surface. */
class PlumbingNode extends Node {
	static nodeSchema() {
		return { hidden: true };
	}
}

/**
 * Builds a patron owning a Table, a Curl stand-in, a hidden sidecar and the
 * Table's `:config`.
 */
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
	const plumbing = new PlumbingNode();
	plumbing.patron = crawler;
	plumbing.name = 'crawl-4471:plumbing';
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

	it( 'omits every owned node from the full snapshot', () => {
		ownedGraph();
		const payload = dumpMetadataPayload();
		expect( payload[ 'crawl-4471' ] ).toBeDefined();
		expect( payload[ 'crawl-4471:seen' ] ).toBeUndefined();
		expect( payload[ 'crawl-4471:curl' ] ).toBeUndefined();
		expect( payload[ 'crawl-4471:plumbing' ] ).toBeUndefined();
		expect( payload[ 'crawl-4471:seen:config' ] ).toBeUndefined();
	} );

	it( 'lists an owner its sidecars by name, leaving out hidden and `:config` ones', () => {
		ownedGraph();
		const payload = dumpMetadataPayload();
		expect( payload[ 'crawl-4471' ].sidecars ).toEqual( [
			{ name: 'crawl-4471:curl', class: 'Node' },
			{ name: 'crawl-4471:seen', class: 'Table' },
		] );
		expect(
			'sidecars' in
				dumpMetadataPayload( 'crawl-4471:seen' )[ 'crawl-4471:seen' ]
		).toBe( false );
	} );

	it( 'sorts sidecars by code unit, as PHP strcmp does', () => {
		const vat = new Node();
		vat.name = 'vat-2290';
		const lower = new Node();
		lower.patron = vat;
		lower.name = 'vat-2290:curl';
		const upper = new Node();
		upper.patron = vat;
		upper.name = 'vat-2290:Seen';
		expect(
			dumpMetadataPayload()[ 'vat-2290' ].sidecars.map( ( c ) => c.name )
		).toEqual( [ 'vat-2290:Seen', 'vat-2290:curl' ] );
	} );

	it( "builds each node's schema once in a full snapshot, an owned one's included", () => {
		let built = 0;
		class CountedNode extends Node {
			static nodeSchema() {
				built++;
				return { category: 'Storage' };
			}
		}
		const owner = new Node();
		owner.name = 'owner-7713';
		const loose = new CountedNode();
		loose.name = 'counted-5501';
		const tally = new CountedNode();
		tally.patron = owner;
		tally.name = 'owner-7713:tally';
		built = 0;
		const payload = dumpMetadataPayload();
		expect( Object.keys( payload ) ).toContain( 'counted-5501' );
		expect( payload[ 'owner-7713' ].sidecars ).toEqual( [
			{ name: 'owner-7713:tally', class: 'Counted' },
		] );
		expect( built ).toBe( 2 );
	} );

	it( 'answers an owned node named alone, naming its owner', () => {
		ownedGraph();
		const payload = dumpMetadataPayload( 'crawl-4471:seen' );
		expect( Object.keys( payload ) ).toEqual( [ 'crawl-4471:seen' ] );
		expect( payload[ 'crawl-4471:seen' ].class ).toBe( 'Table' );
		expect( payload[ 'crawl-4471:seen' ].owner ).toBe( 'crawl-4471' );
		expect( payload[ 'crawl-4471:seen' ].has_config ).toBe( true );
		expect( 'owner' in dumpMetadataPayload()[ 'crawl-4471' ] ).toBe(
			false
		);
	} );

	it( 'answers each owner named with the sidecars it lists, and none gone', () => {
		ownedGraph();
		const vat = new Node();
		vat.name = 'vat-2290';
		const lid = new TableNode();
		lid.patron = vat;
		lid.name = 'vat-2290:lid';
		lid.counter = 8125;
		const payload = dumpOwnedPayload( [
			'crawl-4471:seen',
			'ghost-8810',
			'vat-2290',
		] );
		expect( Object.keys( payload ) ).toEqual( [
			'crawl-4471:seen',
			'vat-2290',
			'vat-2290:lid',
		] );
		expect( payload[ 'vat-2290:lid' ] ).toMatchObject( {
			counter: 8125,
			owner: 'vat-2290',
		} );
		expect( payload[ 'vat-2290' ].sidecars ).toEqual( [
			{ name: 'vat-2290:lid', class: 'Table' },
		] );
	} );

	it( 'answers no hidden node named alone', () => {
		ownedGraph();
		expect( dumpMetadataPayload( 'crawl-4471:plumbing' ) ).toEqual( {} );
	} );

	it( 'parses an owner its sidecars, and a row without them none', () => {
		ownedGraph();
		const { nodes } = parseMetadata( {
			...dumpMetadataPayload(),
			...dumpMetadataPayload( 'crawl-4471:seen' ),
		} );
		const byId = Object.fromEntries( nodes.map( ( n ) => [ n.id, n ] ) );
		expect( byId[ 'crawl-4471' ].sidecars ).toEqual( [
			{ name: 'crawl-4471:curl', class: 'Node' },
			{ name: 'crawl-4471:seen', class: 'Table' },
		] );
		expect( byId[ 'crawl-4471:seen' ].owner ).toBe( 'crawl-4471' );
		expect( 'sidecars' in byId[ 'crawl-4471:seen' ] ).toBe( false );
	} );

	it( 'parses only well-formed sidecar entries', () => {
		const { nodes } = parseMetadata( {
			'vat-2290': {
				sidecars: [
					{ name: 'vat-2290:lid', class: 'Table' },
					{ name: 7, class: 'Table' },
					'vat-2290:spout',
				],
			},
		} );
		expect( nodes[ 0 ].sidecars ).toEqual( [
			{ name: 'vat-2290:lid', class: 'Table' },
		] );
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
