/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * Tests for unwrapCommandResponse — extracts a verb's response payload from
 * the raw 7-field Message array that CommandClient.send() returns. Mirrors
 * the app-side helper in
 * `newspack-event-logger-nodes/src/shared/utils/unwrapCommandResponse.js`
 * but lives here because the substrate has no dependency on the application
 * repo.
 */

import { TM_COMMAND, TM_RESPONSE, TM_ERROR } from '../../../runtime/message';

import unwrapCommandResponse from '../unwrapCommandResponse';

describe( 'unwrapCommandResponse', () => {
	function buildMessage( type, valueObject ) {
		return [
			type,
			1.23,
			'topologies',
			'',
			'cmd-1',
			'',
			JSON.stringify( valueObject ),
		];
	}

	it( 'returns the parsed payload object for a successful TM_RESPONSE', () => {
		const inner = {
			topologies: [ { name: 'firehose-workers' } ],
			user_dir: '/tmp/foo',
		};
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'list',
			payload: JSON.stringify( inner ),
		} );
		expect( unwrapCommandResponse( msg ) ).toEqual( inner );
	} );

	it( 'returns null when payload is an empty string', () => {
		const msg = buildMessage( TM_COMMAND | TM_RESPONSE, {
			name: 'list',
			payload: '',
		} );
		expect( unwrapCommandResponse( msg ) ).toBeNull();
	} );

	it( 'throws an Error with the payload string when TYPE has TM_ERROR set', () => {
		const msg = buildMessage( TM_COMMAND | TM_ERROR, {
			name: 'save',
			payload: 'validation failed at line 3: forbidden verb',
		} );
		expect( () => unwrapCommandResponse( msg ) ).toThrow(
			'validation failed at line 3: forbidden verb'
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
