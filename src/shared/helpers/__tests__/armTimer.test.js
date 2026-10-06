/**
 * armTimer — arming a disarmed hitchhiker polls at once, through the timer's
 * own due flag and one Router tick; re-arming an armed one waits its grid.
 */

import { Core, mountExospine } from '@newspack-nodes/runtime';
import names from '../../../runtime/reserved-node-names.json';
import { armTimer } from '../armTimer';

const SLOW_MS = 13000;

let host;
let timer;
let fires;

beforeEach( () => {
	Core.reset();
	host = mountExospine();
	timer = Core.node( names.COMMAND_INTERPRETER ).makeNode(
		'Timer',
		'heron:timer'
	);
	// makeNode arms a bare Timer at the Router's cadence; start disarmed.
	timer.stopTimer();
	fires = 0;
	timer.register( 'FIRE', 'heron:count', () => {
		fires++;
	} );
} );

afterEach( () => {
	host.teardown();
	Core.reset();
} );

it( 'fires a disarmed timer on the next Router tick, whatever its grid says', async () => {
	timer.lastFireTime = Core.now();

	armTimer( timer, SLOW_MS );
	await Promise.resolve();

	expect( timer.mode ).toBe( 'router' );
	expect( timer.interval_ms ).toBe( SLOW_MS );
	expect( fires ).toBe( 1 );
} );

it( 'leaves an armed timer on its grid when the cadence changes', async () => {
	armTimer( timer, SLOW_MS );
	await Promise.resolve();
	const requestTick = jest.spyOn( Core.node( names.ROUTER ), 'requestTick' );

	armTimer( timer, SLOW_MS * 2 );
	await Promise.resolve();

	expect( timer.interval_ms ).toBe( SLOW_MS * 2 );
	expect( requestTick ).not.toHaveBeenCalled();
	expect( fires ).toBe( 1 );
} );

it( 'asks no Router tick for a sub-second timer on a slot of its own', () => {
	const requestTick = jest.spyOn( Core.node( names.ROUTER ), 'requestTick' );

	armTimer( timer, 250 );

	expect( timer.mode ).toBe( 'event_framework' );
	expect( requestTick ).not.toHaveBeenCalled();
	timer.stopTimer();
} );
