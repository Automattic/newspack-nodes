/**
 * Uptime node tests — the `_uptime` node. `_router` delivers the uptime poll
 * reply (a POSITIONAL Message); the node trims the `up ...` half and publishes
 * it ( useNodeState( '_uptime', 'uptime' ) ). Never touches the transcript.
 */

import { Uptime } from '../uptime';
import { Node } from '../node';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

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

	describe( 'onTimer poll emission (5s throttle)', () => {
		afterEach( () => {
			Core.reset();
			jest.restoreAllMocks();
		} );

		const build = () => {
			const node = new Uptime();
			node.setName( '_uptime' );
			const sent = [];
			node.sink = { fill: ( m ) => sent.push( m ) };
			return { node, sent };
		};

		it( 'emits an uptime TM_COMMAND addressed to this.target (the _cwd indirection)', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_cwd';
			node.onTimer();
			expect( sent ).toHaveLength( 1 );
			const m = sent[ 0 ];
			expect( m[ TYPE ] ).toBe( TM_COMMAND );
			expect( m[ VALUE ].name ).toBe( 'uptime' );
			expect( m[ TO ] ).toBe( '_cwd' );
			expect( m[ FROM ] ).toBe( '_uptime' );
			expect( node.pollTo ).toBeUndefined();
		} );

		it( 'throttles: two onTimer calls <5s apart emit once', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build();
			node.target = '_cwd';
			nowSpy.mockReturnValue( 100 );
			node.onTimer();
			nowSpy.mockReturnValue( 103 ); // 3s later
			node.onTimer();
			expect( sent ).toHaveLength( 1 );
		} );

		it( 'emits twice when calls are >=5s apart', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build();
			node.target = '_cwd';
			nowSpy.mockReturnValue( 100 );
			node.onTimer();
			nowSpy.mockReturnValue( 105 ); // 5s later
			node.onTimer();
			expect( sent ).toHaveLength( 2 );
		} );

		it( 'emits nothing when there is no sink', () => {
			const node = new Uptime();
			node.target = '_cwd';
			expect( () => node.onTimer() ).not.toThrow();
		} );
	} );
} );
