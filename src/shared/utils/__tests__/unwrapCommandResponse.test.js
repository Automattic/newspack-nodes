/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * Tests for unwrapCommandResponse — extracts the verb payload from the
 * raw 7-field Message array (VALUE is already the `{ name, payload }` object).
 */

import { TM_COMMAND, TM_RESPONSE, TM_ERROR } from '@newspack-nodes/runtime';

import unwrapCommandResponse from '../unwrapCommandResponse';

describe( 'unwrapCommandResponse', () => {
	// VALUE is the structured `{ name, payload }` object, not a JSON string.
	function buildMessage( type, valueObject ) {
		return [ type, 1.23, 'aggregator', '', 'cmd-1', '', valueObject ];
	}

	it( 'returns the payload object for a successful TM_RESPONSE', () => {
		const inner = { server1: { id: 'server1', enabled: true } };
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'status',
			payload: inner,
		} );
		expect( unwrapCommandResponse( msg ) ).toEqual( inner );
	} );

	it( 'returns null when payload is an empty string', () => {
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'status',
			payload: '',
		} );
		expect( unwrapCommandResponse( msg ) ).toBeNull();
	} );

	it( 'returns null when payload is absent', () => {
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'status',
		} );
		expect( unwrapCommandResponse( msg ) ).toBeNull();
	} );

	it( 'throws an Error with the payload string when TYPE has TM_ERROR set', () => {
		const msg = buildMessage( TM_COMMAND | TM_ERROR, {
			name: 'status',
			payload: 'permission denied',
		} );
		expect( () => unwrapCommandResponse( msg ) ).toThrow(
			'permission denied'
		);
	} );

	it( 'throws when the message array is malformed (too short)', () => {
		expect( () => unwrapCommandResponse( [ 16 ] ) ).toThrow();
	} );

	it( 'returns a scalar/string payload as-is', () => {
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'uptime',
			payload: 'up 3 days',
		} );
		expect( unwrapCommandResponse( msg ) ).toBe( 'up 3 days' );
	} );

	it( 'returns a nested object payload directly (no double-parse)', () => {
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'x',
			payload: { already: 'parsed' },
		} );
		expect( unwrapCommandResponse( msg ) ).toEqual( { already: 'parsed' } );
	} );
} );
