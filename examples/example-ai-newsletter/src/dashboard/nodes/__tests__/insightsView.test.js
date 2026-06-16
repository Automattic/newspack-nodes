/**
 * insights:view tests — the render-state node React reads via
 * useNodeState('insights:view','view').
 *
 * Mirrors the canonical workerStatusView pattern (intentional duplication —
 * tracked refinement target):
 *   - awaited verbs stash a `{ resolve, reject }` in `pending` keyed by
 *     `message[ID]`; the matching reply settles the Promise (reject on TM_ERROR).
 *   - a non-matching ID is ignored by the pending path.
 *   - the `insights` reply's VALUE.payload is a JSON STRING; the view parses it
 *     into the model and publishes setState('view', model).
 */

import {
	VALUE,
	TYPE,
	ID,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
	Core,
} from '@newspack-nodes/runtime';
import { PendingReplies } from '@newspack-nodes/shared/pendingReplies';
import { InsightsViewNode } from '../insightsView';

beforeEach( () => Core.reset() );

function makeView( name ) {
	const node = new InsightsViewNode();
	node.name = name;
	return node;
}

// An `insights` reply from the server CI: VALUE = { name, payload } where
// payload is the JSON STRING build_insights_json() returns.
function insightsReply( id, model ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'insights', payload: JSON.stringify( model ) };
	return m;
}

function insightsErrorReply( id, payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'insights', payload };
	return m;
}

const sampleModel = {
	sources: { releases: 2, community: 1 },
	top: [
		{ source: 'releases', title: 'A', score: 9.5 },
		{ source: 'community', title: 'B', score: 4 },
	],
	accumulated: 3,
};

describe( 'insights:view — model publish', () => {
	test( 'parses the JSON payload into the model and publishes setState("view")', () => {
		const v = makeView( 'insights:view' );
		const $message = insightsReply( '', sampleModel );
		v.fill( $message );
		expect( v.setStateCache.view ).toEqual( sampleModel );
	} );

	test( 'a later reply replaces the published model', () => {
		const v = makeView( 'insights:view' );
		v.fill( insightsReply( '', { sources: {}, top: [], accumulated: 1 } ) );
		v.fill( insightsReply( '', { sources: {}, top: [], accumulated: 7 } ) );
		expect( v.setStateCache.view.accumulated ).toBe( 7 );
	} );
} );

describe( 'insights:view — pending-Map gating', () => {
	test( 'settles a pending Promise on a reply matching message[ID]', async () => {
		const v = makeView( 'insights:view' );
		const id = 'op-1';
		const promise = new Promise( ( resolve, reject ) => {
			v.replies.add( id, resolve, reject );
		} );
		const $message = insightsReply( id, sampleModel );
		v.fill( $message );
		await expect( promise ).resolves.toEqual(
			JSON.stringify( sampleModel )
		);
		expect( v.replies.has( id ) ).toBe( false );
	} );

	test( 'rejects a pending Promise on a TM_ERROR reply matching message[ID]', async () => {
		const v = makeView( 'insights:view' );
		const id = 'op-2';
		const promise = new Promise( ( resolve, reject ) => {
			v.replies.add( id, resolve, reject );
		} );
		const $message = insightsErrorReply( id, 'permission denied' );
		v.fill( $message );
		await expect( promise ).rejects.toThrow( /permission denied/i );
	} );

	test( 'ignores a reply whose ID matches no pending entry (still publishes model)', () => {
		const v = makeView( 'insights:view' );
		v.replies.add(
			'stashed',
			() => {},
			() => {}
		);
		const $message = insightsReply( 'unrelated', sampleModel );
		v.fill( $message );
		expect( v.replies.has( 'stashed' ) ).toBe( true );
		expect( v.setStateCache.view ).toEqual( sampleModel );
	} );
} );

describe( 'insights:view — node wiring', () => {
	test( 'names the node and exposes a PendingReplies registry', () => {
		const v = makeView( 'insights:view' );
		expect( v.name ).toBe( 'insights:view' );
		expect( v.replies ).toBeInstanceOf( PendingReplies );
	} );
} );
