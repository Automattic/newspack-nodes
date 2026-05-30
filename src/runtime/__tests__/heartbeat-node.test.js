/**
 * Heartbeat node tests — the `_heartbeat` node. It is a silent poll node (like
 * Metadata / Uptime): on the Router TIMER it emits a `workers/heartbeat` command
 * to refresh this session's SSE slot TTL, batched into the same POST as the
 * canvas polls. Its reply is consumed, never transcripted.
 */

import { HeartbeatNode } from '../heartbeat-node';
import { Node } from '../node';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

describe( 'Heartbeat node', () => {
	afterEach( () => {
		Core.reset();
		jest.restoreAllMocks();
	} );

	const build = () => {
		const node = new HeartbeatNode();
		node.setName( '_heartbeat' );
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };
		return { node, sent };
	};

	it( 'pre-declares no transcript subscription (it is consume-only)', () => {
		const node = new HeartbeatNode();
		expect( node.pollTo ).toBeUndefined();
		expect( node.slot ).toBeNull();
	} );

	describe( 'onTimer poll emission', () => {
		it( 'emits a heartbeat command addressed to this.target when a slot is held', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 3, 0 );
			node.onTimer();
			expect( sent ).toHaveLength( 1 );
			const m = sent[ 0 ];
			expect( m[ TYPE ] ).toBe( TM_COMMAND );
			expect( m[ VALUE ].name ).toBe( 'heartbeat' );
			expect( m[ VALUE ].arguments ).toBe( '3 10 0' );
			expect( m[ TO ] ).toBe( '_sse/workers' );
			expect( m[ FROM ] ).toBe( '_heartbeat' );
			expect( m[ LOCAL ] ).toBe( true );
		} );

		it( 'emits nothing when no slot has been acquired', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.onTimer();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'throttles: two onTimer calls <5s apart emit once', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 1, 0 );
			nowSpy.mockReturnValue( 100 );
			node.onTimer();
			nowSpy.mockReturnValue( 103 );
			node.onTimer();
			expect( sent ).toHaveLength( 1 );
		} );

		it( 'emits twice when calls are >=5s apart', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 1, 0 );
			nowSpy.mockReturnValue( 100 );
			node.onTimer();
			nowSpy.mockReturnValue( 105 );
			node.onTimer();
			expect( sent ).toHaveLength( 2 );
		} );

		it( 'clearSlot() disables emission (SSE stream closed)', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 1, 0 );
			node.clearSlot();
			node.onTimer();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'does not throw when there is no sink', () => {
			const node = new HeartbeatNode();
			node.target = '_sse/workers';
			node.setSlot( 1, 0 );
			expect( () => node.onTimer() ).not.toThrow();
		} );
	} );

	describe( 'fill (reply intake)', () => {
		it( 'consumes a heartbeat reply without publishing to any transcript', () => {
			const node = new HeartbeatNode();
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			m[ VALUE ] = {
				name: 'heartbeat',
				payload: { success: true, slot: 1 },
			};
			expect( () => node.fill( m ) ).not.toThrow();
			expect( node.counter ).toBe( 1 );
		} );

		it( 'works as a real router sink target (router → heartbeat.fill)', () => {
			const node = new HeartbeatNode();
			node.setName( '_heartbeat' );
			const router = new Node();
			router.sink = node;
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ VALUE ] = 'ok';
			router.fill( m );
			expect( node.counter ).toBe( 1 );
		} );
	} );
} );
