/**
 * aggregator:fleet tests — the on-demand per-spoke fleet-probe result view node.
 * It owns ONLY the `probes` map keyed by server id; the hook awaits each probe
 * via this node's `replies` registry, and on settle the node files the roll-up
 * (or error) into its published model.
 */

import {
	VALUE,
	ID,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
	Core,
} from '@newspack-nodes/runtime';
import { PendingReplies } from '@newspack-nodes/shared/pendingReplies';
import { AggregatorFleetViewNode } from '../aggregator-fleet-view-node';

beforeEach( () => Core.reset() );

function makeView( name = 'aggregator:fleet' ) {
	const node = new AggregatorFleetViewNode();
	node.name = name;
	return node;
}

function replyMsg( { payload, type = TM_COMMAND | TM_RESPONSE, id = '' } ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'probe', payload };
	return m;
}

describe( 'aggregator:fleet — initial model', () => {
	test( 'publishes an initial empty probes model on construction', () => {
		expect( makeView().setStateCache.view ).toEqual( { probes: {} } );
	} );

	test( 'has a `replies` registry for hook-side promise resolution', () => {
		const v = makeView();
		expect( v.replies ).toBeInstanceOf( PendingReplies );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'aggregator:fleet — a probe reply settles the caller AND records the roll-up', () => {
	const ROLLUP = {
		id: 'spoke-01',
		workers: { total: 3, live: 1, stale: 1, dead: 1 },
		worst_distance: 88888,
		deadletter_segments: 6,
	};

	test( 'a successful probe resolves the pending promise with the roll-up', () => {
		const v = makeView();
		const resolve = jest.fn();
		v.replies.add( 'spoke-01', resolve, jest.fn() );
		v.fill( replyMsg( { id: 'spoke-01', payload: ROLLUP } ) );
		expect( resolve ).toHaveBeenCalledWith( ROLLUP );
		expect( v.replies.has( 'spoke-01' ) ).toBe( false );
	} );

	test( 'a successful probe records an ok roll-up keyed by the message ID', () => {
		const v = makeView();
		v.replies.add( 'spoke-01', jest.fn(), jest.fn() );
		v.fill( replyMsg( { id: 'spoke-01', payload: ROLLUP } ) );
		expect( v.setStateCache.view.probes[ 'spoke-01' ] ).toEqual( {
			ok: true,
			rollup: ROLLUP,
		} );
	} );

	test( 'a failed probe rejects the pending promise AND records an error', () => {
		const v = makeView();
		const reject = jest.fn();
		v.replies.add( 'spoke-02', jest.fn(), reject );
		v.fill(
			replyMsg( {
				id: 'spoke-02',
				payload: 'could not connect to server',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( reject ).toHaveBeenCalledTimes( 1 );
		expect( v.setStateCache.view.probes[ 'spoke-02' ] ).toEqual( {
			ok: false,
			error: 'could not connect to server',
		} );
	} );

	test( 'a second spoke probe is recorded alongside the first (no clobber)', () => {
		const v = makeView();
		v.replies.add( 'spoke-01', jest.fn(), jest.fn() );
		v.fill( replyMsg( { id: 'spoke-01', payload: ROLLUP } ) );
		v.replies.add( 'spoke-02', jest.fn(), jest.fn() );
		v.fill(
			replyMsg( {
				id: 'spoke-02',
				payload: 'refused',
				type: TM_COMMAND | TM_ERROR,
			} )
		);
		expect( Object.keys( v.setStateCache.view.probes ).sort() ).toEqual( [
			'spoke-01',
			'spoke-02',
		] );
		expect( v.setStateCache.view.probes[ 'spoke-01' ].ok ).toBe( true );
		expect( v.setStateCache.view.probes[ 'spoke-02' ].ok ).toBe( false );
	} );

	test( 'an un-correlated reply does not throw or record', () => {
		const v = makeView();
		expect( () =>
			v.fill( replyMsg( { id: 'unknown', payload: ROLLUP } ) )
		).not.toThrow();
		expect( v.setStateCache.view.probes ).toEqual( {} );
	} );

	test( 'a reply with no ID is ignored', () => {
		const v = makeView();
		expect( () => v.fill( replyMsg( { payload: ROLLUP } ) ) ).not.toThrow();
		expect( v.setStateCache.view.probes ).toEqual( {} );
	} );
} );

describe( 'aggregator:fleet — removeNode rejects in-flight pending', () => {
	test( 'removeNode rejects every pending probe so teardown strands no caller', async () => {
		const v = makeView();
		const p = new Promise( ( resolve, reject ) =>
			v.replies.add( 'spoke-01', resolve, reject )
		);
		const e = p.catch( ( err ) => err );
		v.removeNode();
		expect( await e ).toBeInstanceOf( Error );
		expect( v.replies.size ).toBe( 0 );
	} );
} );

describe( 'aggregator:fleet — nodeSchema', () => {
	test( 'is a Hidden, terminal (no output port) node', () => {
		const schema = AggregatorFleetViewNode.nodeSchema();
		expect( schema.has_target ).toBe( false );
		expect( schema.category ).toBe( 'Hidden' );
		expect( schema.arguments ).toEqual( [] );
		expect( schema.commands ).toEqual( [] );
	} );
} );
