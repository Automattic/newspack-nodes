/**
 * pendingReplies tests — the shared request/reply correlation Map + TM_ERROR
 * payload coercion duplicated across dashboard view nodes (workerStatusView,
 * rawLogsView, insightsView, hook-catalog/servers view nodes).
 */

import {
	newMessage,
	ID,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '@newspack-nodes/runtime';
import { errorMessage, PendingReplies } from '../pendingReplies';

// Build a command reply: VALUE = { name, payload }, optionally TM_ERROR.
function reply( id, payload, isError = false ) {
	const m = newMessage();
	m[ TYPE ] = isError
		? TM_COMMAND | TM_RESPONSE | TM_ERROR
		: TM_COMMAND | TM_RESPONSE;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'verb', payload };
	return m;
}

describe( 'errorMessage', () => {
	test( 'returns a non-empty string payload unchanged', () => {
		expect( errorMessage( 'permission denied' ) ).toBe(
			'permission denied'
		);
	} );

	test( 'returns the .message of an object with a non-empty string message', () => {
		expect( errorMessage( { message: 'boom' } ) ).toBe( 'boom' );
	} );

	test( 'falls back to "Operation failed" for anything else', () => {
		expect( errorMessage( '' ) ).toBe( 'Operation failed' );
		expect( errorMessage( { message: '' } ) ).toBe( 'Operation failed' );
		expect( errorMessage( null ) ).toBe( 'Operation failed' );
		expect( errorMessage( 42 ) ).toBe( 'Operation failed' );
		expect( errorMessage( {} ) ).toBe( 'Operation failed' );
	} );
} );

describe( 'PendingReplies — add/has/size', () => {
	test( 'add stashes an entry retrievable by has, tracked by size', () => {
		const r = new PendingReplies();
		expect( r.size ).toBe( 0 );
		r.add(
			'op-1',
			() => {},
			() => {}
		);
		expect( r.has( 'op-1' ) ).toBe( true );
		expect( r.has( 'op-2' ) ).toBe( false );
		expect( r.size ).toBe( 1 );
	} );
} );

describe( 'PendingReplies — settle', () => {
	test( 'returns false when no entry matches message[ID]', () => {
		const r = new PendingReplies();
		r.add(
			'stashed',
			() => {},
			() => {}
		);
		expect( r.settle( reply( 'unrelated', { payload: 1 } ) ) ).toBe(
			false
		);
		expect( r.has( 'stashed' ) ).toBe( true );
	} );

	test( 'resolves with the payload + returns true on a matching reply', async () => {
		const r = new PendingReplies();
		const promise = new Promise( ( resolve, reject ) => {
			r.add( 'op-1', resolve, reject );
		} );
		const matched = r.settle( reply( 'op-1', 'the-payload' ) );
		expect( matched ).toBe( true );
		await expect( promise ).resolves.toBe( 'the-payload' );
		expect( r.has( 'op-1' ) ).toBe( false );
		expect( r.size ).toBe( 0 );
	} );

	test( 'rejects with an Error carrying the coerced message + returns true on a TM_ERROR match', async () => {
		const r = new PendingReplies();
		const promise = new Promise( ( resolve, reject ) => {
			r.add( 'op-2', resolve, reject );
		} );
		const matched = r.settle( reply( 'op-2', 'permission denied', true ) );
		expect( matched ).toBe( true );
		await expect( promise ).rejects.toThrow( /permission denied/i );
		expect( r.has( 'op-2' ) ).toBe( false );
	} );

	test( 'falls back to "Operation failed" when the error payload is unreadable', async () => {
		const r = new PendingReplies();
		const promise = new Promise( ( resolve, reject ) => {
			r.add( 'op-3', resolve, reject );
		} );
		r.settle( reply( 'op-3', null, true ) );
		await expect( promise ).rejects.toThrow( /operation failed/i );
	} );
} );

describe( 'PendingReplies — rejectAll', () => {
	test( 'rejects every in-flight entry with the reason Error and empties the map', async () => {
		const r = new PendingReplies();
		const a = new Promise( ( resolve, reject ) =>
			r.add( 'a', resolve, reject )
		);
		const b = new Promise( ( resolve, reject ) =>
			r.add( 'b', resolve, reject )
		);
		r.rejectAll( 'View removed before reply' );
		await expect( a ).rejects.toThrow( /view removed before reply/i );
		await expect( b ).rejects.toThrow( /view removed before reply/i );
		expect( r.size ).toBe( 0 );
	} );
} );
