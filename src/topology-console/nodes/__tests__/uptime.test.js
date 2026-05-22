/**
 * Uptime node tests — the `_uptime` node. `_router` delivers the uptime poll
 * reply (a POSITIONAL Message); the node trims the `up ...` half and publishes
 * it ( useNodeState( '_uptime', 'uptime' ) ). Never touches the transcript.
 */

import { Uptime } from '../uptime';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';

function msg( type, value ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ VALUE ] = value;
	return m;
}

describe( 'Uptime node', () => {
	it( 'keeps the right half of a bytestream uptime line', () => {
		const node = new Uptime();
		node.fill( msg( TM_BYTESTREAM, '09:44:52  up 0 days, 00:01:00\n' ) );
		expect( node.setStateCache.uptime ).toBe( '0 days, 00:01:00' );
	} );

	it( 'unwraps a {name,payload} command-response envelope', () => {
		const node = new Uptime();
		node.fill(
			// eslint-disable-next-line no-bitwise
			msg( TM_COMMAND | TM_RESPONSE, {
				name: 'uptime',
				payload: '12:00:00  up 5 days, 02:03:04',
			} )
		);
		expect( node.setStateCache.uptime ).toBe( '5 days, 02:03:04' );
	} );

	it( 'ignores a line with no `up` segment', () => {
		const node = new Uptime();
		node.fill( msg( TM_BYTESTREAM, 'no uptime here' ) );
		expect( node.setStateCache.uptime ).toBeUndefined();
	} );

	it( 'pre-declares the `uptime` event so useNodeState can subscribe', () => {
		const node = new Uptime();
		expect( node.registrations.uptime ).toBeDefined();
	} );

	it( 'works as a real sink target (router → uptime.fill)', () => {
		const node = new Uptime();
		const router = new Node();
		router.sink = node;
		router.fill( msg( TM_BYTESTREAM, '00:00:00  up 1 day, 00:00:01' ) );
		expect( node.setStateCache.uptime ).toBe( '1 day, 00:00:01' );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const node = new Uptime();
		node.fill( msg( TM_BYTESTREAM, 'x up a' ) );
		node.fill( msg( TM_BYTESTREAM, 'x up b' ) );
		expect( node.counter ).toBe( 2 );
	} );
} );
