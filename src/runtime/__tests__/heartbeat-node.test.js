/**
 * Heartbeat node tests — the `_heartbeat` node. It is a silent poll node (like
 * Metadata / Uptime): on the Router TIMER it emits a `workers/heartbeat` command
 * to refresh this session's SSE slot TTL, batched into the same POST as the
 * canvas polls. Its reply is consumed, never transcripted.
 */

import { HeartbeatNode } from '../heartbeat-node';
import { Node } from '../node';
import { TimerNode } from '../timer-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import names from '../reserved-node-names.json';
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
		// setSlot() hitchhike-arms, so the poke timer needs a live _router.
		const router = new RouterNode();
		router.name = names.ROUTER;
		router.stopTimer();
		const node = new HeartbeatNode();
		node.name = '_heartbeat';
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };
		return { node, sent, router };
	};

	it( 'pre-declares no transcript subscription (it is consume-only)', () => {
		const node = new HeartbeatNode();
		expect( node.pollTo ).toBeUndefined();
		expect( node.slot ).toBeNull();
	} );

	describe( 'fire() poll emission', () => {
		it( 'emits a heartbeat command addressed to this.target when a slot is held', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 3 );
			node.fire();
			expect( sent ).toHaveLength( 1 );
			const m = sent[ 0 ];
			expect( m[ TYPE ] ).toBe( TM_COMMAND );
			expect( m[ VALUE ].name ).toBe( 'heartbeat' );
			expect( m[ VALUE ].arguments ).toEqual( [ '3', '10' ] );
			expect( m[ TO ] ).toBe( '_sse/workers' );
			expect( m[ FROM ] ).toBe( '_heartbeat' );
			expect( m[ LOCAL ] ).toBe( true );
		} );

		it( 'emits nothing when no slot has been acquired', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.fire();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'throttles: two fireCb() ticks <5s apart emit once', () => {
			// 5s cadence = base Timer throttle in fireCb(); fire() unthrottled.
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 1 );
			node.interval_ms = 5000;
			nowSpy.mockReturnValue( 100 );
			node.fireCb();
			nowSpy.mockReturnValue( 103 );
			node.fireCb();
			expect( sent ).toHaveLength( 1 );
		} );

		it( 'emits twice when ticks are >=5s apart', () => {
			const nowSpy = jest.spyOn( Core, 'now' );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 1 );
			node.interval_ms = 5000;
			nowSpy.mockReturnValue( 100 );
			node.fireCb();
			nowSpy.mockReturnValue( 105 );
			node.fireCb();
			expect( sent ).toHaveLength( 2 );
		} );

		it( 'clearSlot() disables emission (SSE stream closed)', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 1 );
			node.clearSlot();
			node.fire();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'only the owning stream can clear a shared slot', () => {
			const { node } = build();
			const inactive = { name: 'inactive-link-349' };
			const active = { name: 'active-link-947' };
			node.setSlot( 47, active );

			node.clearSlot( inactive );
			expect( node.slot ).toBe( 47 );

			node.clearSlot( active );
			expect( node.slot ).toBeNull();
		} );

		it( 'keeps every live owner slot armed independently', () => {
			const { node, sent } = build();
			node.target = '_sse/workers';
			const first = { name: 'first-link-349' };
			const second = { name: 'second-link-947' };
			node.setSlot( 13, first );
			node.setSlot( 47, second );

			node.fire();
			expect(
				sent.map( ( message ) => message[ VALUE ].arguments )
			).toEqual( [
				[ '13', '10' ],
				[ '47', '10' ],
			] );

			node.clearSlot( second );
			sent.length = 0;
			node.fire();
			expect(
				sent.map( ( message ) => message[ VALUE ].arguments )
			).toEqual( [ [ '13', '10' ] ] );
			expect( node.slot ).toBe( 13 );
		} );

		it( 'does not throw when there is no sink', () => {
			const { node } = build();
			node.sink = null;
			node.target = '_sse/workers';
			node.setSlot( 1 );
			expect( () => node.fire() ).not.toThrow();
		} );
	} );

	describe( 'TimerNode integration (router-hitchhike via notify_timer)', () => {
		it( 'is a TimerNode subclass', () => {
			expect( new HeartbeatNode() ).toBeInstanceOf( TimerNode );
		} );

		it( 'setSlot() arms the router-hitchhike poke; notify_timer fires it (no manual setTimer)', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent, router } = build();
			node.target = '_sse/workers';
			node.setSlot( 7 );
			expect( node.mode ).toBe( 'router' );
			router.notifyTimer();
			expect( sent ).toHaveLength( 1 );
			expect( sent[ 0 ][ VALUE ].name ).toBe( 'heartbeat' );
			node.stopTimer();
		} );

		it( 'clearSlot() stops the poke timer — no slot, nothing to keep alive', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent, router } = build();
			node.target = '_sse/workers';
			node.setSlot( 7 );
			node.clearSlot();
			expect( node.mode ).toBe( 'inactive' );
			router.notifyTimer();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'removeNode unregisters from the router TIMER (no leak)', () => {
			const { node, router } = build();
			node.setSlot( 1 );
			node.removeNode();
			expect( '_heartbeat' in router.registrations.TIMER ).toBe( false );
			expect( () => router.notifyTimer() ).not.toThrow();
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
			node.name = '_heartbeat';
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
