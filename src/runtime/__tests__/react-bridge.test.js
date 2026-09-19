/**
 * ReactBridge — the mixin a node takes on when React reads its structured
 * output. It adds `setField()`, which publishes a field and announces it, and
 * `dumpOmits`, the bulk fields `dump_node` leaves out; `Node` itself, the
 * Tachikoma port, carries neither.
 */

import { Core } from '../core';
import { Node } from '../node';
import { KEY, VALUE } from '../message';
import { ReactBridge } from '../react-bridge';

beforeEach( () => Core.reset() );

describe( 'setField', () => {
	it( 'assigns the field and notifies with no payload', () => {
		const n = new ( ReactBridge( Node ) )();
		n.name = 'mike-3380';
		n.registrations.view = {};
		const seen = [];
		n.register( 'view', 'l1', ( p ) => {
			seen.push( [ p, n.view ] );
			return true;
		} );
		const model = { rows: [ 'november-72' ] };

		n.setField( 'view', model );

		expect( n.view ).toBe( model );
		expect( seen ).toEqual( [ [ '', model ] ] );
	} );

	it( 'caches nothing, so a late listener hears nothing', () => {
		const n = new ( ReactBridge( Node ) )();
		n.registrations.view = {};
		n.setField( 'view', { rows: [ 'echo-18' ] } );
		const late = [];
		n.register( 'view', 'late', ( p ) => {
			late.push( p );
			return true;
		} );

		expect( late ).toEqual( [] );
		expect( n.setStateCache ).toEqual( {} );
	} );

	it( 'sends a node-name listener a string VALUE, never the object', () => {
		const listener = new Node();
		listener.name = 'oscar-listener';
		const got = [];
		listener.fill = ( m ) => got.push( [ ...m ] );
		const n = new ( ReactBridge( Node ) )();
		n.name = 'papa-producer';
		n.registrations.view = {};
		n.register( 'view', 'oscar-listener', null );

		n.setField( 'view', { rows: [ 'quebec-5' ] } );

		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ KEY ] ).toBe( 'view' );
		expect( got[ 0 ][ VALUE ] ).toBe( '' );
	} );
} );

describe( 'dumpOmits', () => {
	class Bulky extends ReactBridge( Node ) {
		static dumpOmits = [ 'transcript' ];

		constructor() {
			super();
			this.transcript = [ 'foxtrot-2291' ];
			this.ring = [ 'golf-8814' ];
			this.depth = 3;
		}
	}

	it( 'leaves out the fields the class declares', () => {
		const snap = new Bulky().dumpNode();

		expect( snap ).not.toHaveProperty( 'transcript' );
		expect( snap.ring ).toEqual( [ 'golf-8814' ] );
		expect( snap.depth ).toBe( 3 );
	} );

	it( 'inherits a parent list when the subclass declares none', () => {
		class Heir extends Bulky {}

		const snap = new Heir().dumpNode();

		expect( snap ).not.toHaveProperty( 'transcript' );
		expect( snap.depth ).toBe( 3 );
	} );

	/**
	 * Each class lists only its own bulk fields; the lists merge down the
	 * prototype chain, so a subclass never re-lists its parent's.
	 */
	it( 'merges a subclass list with its parent list', () => {
		class Heir extends Bulky {
			static dumpOmits = [ 'ring' ];
		}

		const snap = new Heir().dumpNode();

		expect( snap ).not.toHaveProperty( 'transcript' );
		expect( snap ).not.toHaveProperty( 'ring' );
		expect( snap.depth ).toBe( 3 );
	} );

	it( 'returns an omitted field whole when a key asks for it', () => {
		const snap = new Bulky().dumpNode( { keys: [ 'transcript' ] } );

		expect( snap.transcript ).toEqual( [ 'foxtrot-2291' ] );
	} );

	it( 'skips an omitted field before the mask copies it', () => {
		const n = new Bulky();
		Object.defineProperty( n, 'transcript', {
			enumerable: true,
			get() {
				throw new Error( 'india-3071: omitted field was read' );
			},
		} );

		expect( () => n.dumpNode() ).not.toThrow();
	} );
} );
