/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * Tests for unwrapCommandResponse — extracts a verb's response payload from
 * the raw 7-field Message array that CommandClient.send() returns.
 *
 * Wire shape recap:
 *   Message = [TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]
 *   VALUE   = JSON-encoded { name: <verb>, payload: <verb-return-string> }
 *   payload = the verb's return string (typically wp_json_encode(<data>))
 *
 * The helper does the double-unwrap and returns the final data object.
 */

import { TM_COMMAND, TM_RESPONSE, TM_ERROR } from '@newspack-nodes/runtime';

import unwrapCommandResponse from '../unwrapCommandResponse';

describe( 'unwrapCommandResponse', () => {
	function buildMessage( type, valueObject ) {
		return [
			type,
			1.23,
			'aggregator',
			'',
			'cmd-1',
			'',
			JSON.stringify( valueObject ),
		];
	}

	it( 'returns the parsed payload object for a successful TM_RESPONSE', () => {
		const inner = { server1: { id: 'server1', enabled: true } };
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'status',
			payload: JSON.stringify( inner ),
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

	it( 'throws when VALUE is not valid JSON', () => {
		const msg = [ TM_COMMAND | TM_RESPONSE, 1, '', '', '', '', 'not-json' ];
		expect( () => unwrapCommandResponse( msg ) ).toThrow();
	} );

	it( 'returns the payload as-is if payload is already an object (defensive)', () => {
		// Some hypothetical verbs might emit a non-string payload. The helper
		// shouldn't double-parse an already-parsed value.
		const msg = [
			TM_COMMAND | TM_RESPONSE,
			1,
			'',
			'',
			'',
			'',
			JSON.stringify( { name: 'x', payload: { already: 'parsed' } } ),
		];
		expect( unwrapCommandResponse( msg ) ).toEqual( { already: 'parsed' } );
	} );
} );
