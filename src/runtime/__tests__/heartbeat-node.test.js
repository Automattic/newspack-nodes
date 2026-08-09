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
	TM_ERROR,
	TM_RESPONSE,
} from '../message';

const LEASE_OWNER = '9007199254740993';
const SECOND_LEASE_OWNER = '9007199254740995';
const LONG_NON_BOOLEAN_ERROR =
	'Heartbeat reply used a non-boolean success marker 619: ' +
	'x'.repeat( 600 );

// The slot TTL is the server's (SSE_Slot_Pool::$ttl, 60s) and the client poke
// is the ONLY thing that refreshes it, so the interval has to clear the TTL
// with margin — but 5s was 12x more often than needed, and 3x harder than
// Remote_Link_Node::HEARTBEAT_INTERVAL doing the identical job server-side.
describe( 'HeartbeatNode — poke cadence', () => {
	it( 'pokes on the same cadence as the server-side client, well inside the TTL', () => {
		// SSE_Slot_Pool::$ttl. Duplicated here rather than exported from
		// production, which never reads it — nothing pins the two together, so
		// a constant claiming to know the server's TTL would be a lie.
		const slotTtlMs = 60 * 1000;
		const router = new RouterNode();
		router.name = names.ROUTER;
		const node = new HeartbeatNode();
		node.name = names.HEARTBEAT;
		node.sink = { fill: () => {} };
		node.setSlot( 3, '42424243', 'demo.p0' );

		expect( node.interval_ms ).toBe( 15000 );
		expect( node.interval_ms ).toBeLessThan( slotTtlMs / 3 );
		// RouterNode arms a REAL 1s interval; leaving it running outlives the
		// test and warns from notifyTimer once Core.reset() drops the map.
		router.stopTimer();
		node.stopTimer();
	} );
} );

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
		expect( node.leaseOwner ).toBeNull();
	} );

	describe( 'fire() poll emission', () => {
		it( 'emits the exact slot + greater-than-2^53 owner without a client TTL', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 100 );
			const { node, sent } = build();
			node.target = '_sse/workers';
			node.setSlot( 7, LEASE_OWNER );
			node.fire();
			expect( sent ).toHaveLength( 1 );
			const m = sent[ 0 ];
			expect( m[ TYPE ] ).toBe( TM_COMMAND );
			expect( m[ VALUE ].name ).toBe( 'heartbeat' );
			expect( m[ VALUE ].arguments ).toEqual( [ '7', LEASE_OWNER ] );
			expect( m[ TO ] ).toBe( '_sse/workers' );
			expect( m[ FROM ] ).toBe( '_heartbeat' );
			expect( m[ LOCAL ] ).toBe( true );
		} );

		it.each( [ undefined, '', '0', '-42424243', '042424243', 'owner-7' ] )(
			'rejects a missing or non-canonical lease owner (%s)',
			( leaseOwner ) => {
				const { node } = build();
				expect( () => node.setSlot( 7, leaseOwner ) ).toThrow(
					'Heartbeat lease owner must be a canonical positive decimal string'
				);
				expect( node.slot ).toBeNull();
				expect( node.leaseOwner ).toBeNull();
			}
		);

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
			node.setSlot( 1, LEASE_OWNER );
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
			node.setSlot( 1, LEASE_OWNER );
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
			node.setSlot( 1, LEASE_OWNER );
			node.clearSlot();
			node.fire();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'only the owning stream can clear a shared slot', () => {
			const { node } = build();
			const inactive = { name: 'inactive-link-349' };
			const active = { name: 'active-link-947' };
			node.setSlot( 47, LEASE_OWNER, active );

			node.clearSlot( inactive );
			expect( node.slot ).toBe( 47 );
			expect( node.leaseOwner ).toBe( LEASE_OWNER );

			node.clearSlot( active );
			expect( node.slot ).toBeNull();
			expect( node.leaseOwner ).toBeNull();
		} );

		it( 'keeps every stream identity mapped to its own exact lease pair', () => {
			const { node, sent } = build();
			node.target = '_sse/workers';
			const first = { name: 'first-link-349' };
			const second = { name: 'second-link-947' };
			node.setSlot( 13, LEASE_OWNER, first );
			node.setSlot( 47, SECOND_LEASE_OWNER, second );

			node.fire();
			expect(
				sent.map( ( message ) => message[ VALUE ].arguments )
			).toEqual( [
				[ '13', LEASE_OWNER ],
				[ '47', SECOND_LEASE_OWNER ],
			] );

			node.clearSlot( second );
			sent.length = 0;
			node.fire();
			expect(
				sent.map( ( message ) => message[ VALUE ].arguments )
			).toEqual( [ [ '13', LEASE_OWNER ] ] );
			expect( node.slot ).toBe( 13 );
			expect( node.leaseOwner ).toBe( LEASE_OWNER );
		} );

		it( 'does not throw when there is no sink', () => {
			const { node } = build();
			node.sink = null;
			node.target = '_sse/workers';
			node.setSlot( 1, LEASE_OWNER );
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
			node.setSlot( 7, LEASE_OWNER );
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
			node.setSlot( 7, LEASE_OWNER );
			node.clearSlot();
			expect( node.mode ).toBe( 'inactive' );
			router.notifyTimer();
			expect( sent ).toHaveLength( 0 );
		} );

		it( 'removeNode unregisters from the router TIMER (no leak)', () => {
			const { node, router } = build();
			node.setSlot( 1, LEASE_OWNER );
			node.removeNode();
			expect( '_heartbeat' in router.registrations.TIMER ).toBe( false );
			expect( () => router.notifyTimer() ).not.toThrow();
		} );
	} );

	describe( 'fill (reply intake)', () => {
		it( 'records a successful heartbeat reply without publishing a transcript', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 4242.43 );
			const node = new HeartbeatNode();
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			m[ VALUE ] = {
				name: 'heartbeat',
				arguments: [ '7', LEASE_OWNER ],
				payload: {
					success: true,
					slot: 7,
					owner: LEASE_OWNER,
				},
			};
			expect( () => node.fill( m ) ).not.toThrow();
			expect( node.counter ).toBe( 1 );
			expect( node.lastHeartbeatResponse ).toBe( 4242.43 );
			expect( node.lastHeartbeatError ).toBeNull();
		} );

		it( 'a command transport error clears a prior success and retains its safe reason', () => {
			jest.spyOn( Core, 'now' ).mockReturnValue( 5151.53 );
			const node = new HeartbeatNode();
			const success = newMessage();
			success[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			success[ VALUE ] = {
				name: 'heartbeat',
				arguments: [ '7', LEASE_OWNER ],
				payload: { success: true },
			};
			node.fill( success );
			expect( node.lastHeartbeatResponse ).toBe( 5151.53 );

			expectConsoleWarn(
				'ERROR: client heartbeat failed - SSE slot lease ownership mismatch'
			);
			const failed = newMessage();
			failed[ TYPE ] = TM_COMMAND | TM_ERROR;
			failed[ VALUE ] = {
				name: 'heartbeat',
				arguments: [ '7', LEASE_OWNER ],
				payload: 'SSE slot lease ownership mismatch',
			};
			node.fill( failed );

			expect( node.lastHeartbeatResponse ).toBeNull();
			expect( node.lastHeartbeatError ).toBe(
				'SSE slot lease ownership mismatch'
			);
		} );

		it( 'treats a released slot as the race it is: keeps the green status, logs nothing', () => {
			const stderr = jest.spyOn( Core, 'stderr' ).mockImplementation();
			jest.spyOn( Core, 'now' ).mockReturnValue( 7171.71 );
			const node = new HeartbeatNode();
			const success = newMessage();
			success[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			success[ VALUE ] = {
				name: 'heartbeat',
				payload: { success: true },
			};
			node.fill( success );

			const released = newMessage();
			released[ TYPE ] = TM_COMMAND | TM_ERROR;
			released[ VALUE ] = {
				name: 'heartbeat',
				payload: 'SSE slot lease not owned: slot_released',
			};
			node.fill( released );

			// The server let the idle stream go; the reconnect takes a new slot.
			expect( node.lastHeartbeatError ).toBeNull();
			expect( node.lastHeartbeatResponse ).toBe( 7171.71 );
			expect( stderr ).not.toHaveBeenCalled();
			stderr.mockRestore();
		} );

		it( 'logs a heartbeat failure that is NOT a released slot', () => {
			const stderr = jest.spyOn( Core, 'stderr' ).mockImplementation();
			const node = new HeartbeatNode();
			const failed = newMessage();
			failed[ TYPE ] = TM_COMMAND | TM_ERROR;
			failed[ VALUE ] = {
				name: 'heartbeat',
				payload: 'SSE slot lease not owned: pointer_owner_mismatch',
			};
			node.fill( failed );

			expect( node.lastHeartbeatError ).toBe(
				'SSE slot lease not owned: pointer_owner_mismatch'
			);
			expect( stderr.mock.calls[ 0 ][ 0 ] ).toContain(
				'ERROR: client heartbeat failed - SSE slot lease not owned: pointer_owner_mismatch'
			);
			stderr.mockRestore();
		} );

		it( 'a success:false application reply clears a prior success and retains its error', () => {
			expectConsoleWarn( 'ERROR: client heartbeat failed - ' );
			jest.spyOn( Core, 'now' ).mockReturnValue( 6262.67 );
			const node = new HeartbeatNode();
			const success = newMessage();
			success[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			success[ VALUE ] = {
				name: 'heartbeat',
				arguments: [ '7', LEASE_OWNER ],
				payload: { success: true },
			};
			node.fill( success );
			expect( node.lastHeartbeatResponse ).toBe( 6262.67 );

			const failed = newMessage();
			failed[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			failed[ VALUE ] = {
				name: 'heartbeat',
				arguments: [ '7', LEASE_OWNER ],
				payload: {
					success: false,
					error: 'SSE slot lease lost',
				},
			};
			node.fill( failed );

			expect( node.lastHeartbeatResponse ).toBeNull();
			expect( node.lastHeartbeatError ).toBe( 'SSE slot lease lost' );
		} );

		it.each( [
			[ 'null payload', null, 'Heartbeat rejected' ],
			[
				'non-object payload',
				'Heartbeat reply was scalar 947',
				'Heartbeat reply was scalar 947',
			],
			[
				'missing success',
				{ error: 'Heartbeat reply omitted success 863' },
				'Heartbeat reply omitted success 863',
			],
			[
				'non-boolean success',
				{
					success: 'accepted-619',
					error: LONG_NON_BOOLEAN_ERROR,
				},
				LONG_NON_BOOLEAN_ERROR.slice( 0, 512 ),
			],
		] )(
			'a %s clears prior success and records a bounded failure',
			( _case, payload, expectedError ) => {
				expectConsoleWarn( 'ERROR: client heartbeat failed - ' );
				const now = jest.spyOn( Core, 'now' );
				const node = new HeartbeatNode();
				const success = newMessage();
				success[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				success[ VALUE ] = {
					name: 'heartbeat',
					arguments: [ '7', LEASE_OWNER ],
					payload: { success: true },
				};
				now.mockReturnValue( 7373.79 );
				node.fill( success );
				expect( node.lastHeartbeatResponse ).toBe( 7373.79 );

				const invalid = newMessage();
				invalid[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				invalid[ VALUE ] = {
					name: 'heartbeat',
					arguments: [ '7', SECOND_LEASE_OWNER ],
					payload,
				};
				now.mockReturnValue( 8484.89 );
				node.fill( invalid );

				expect( node.lastHeartbeatResponse ).toBeNull();
				expect( node.lastHeartbeatError ).toBe( expectedError );
				expect( node.lastHeartbeatError.length ).toBeLessThanOrEqual(
					512
				);
			}
		);

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
