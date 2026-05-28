import { Timer } from '../timer';
import { TYPE, VALUE, TM_INFO } from '../message';

jest.useFakeTimers();

test( 'setInterval schedules fire() at the configured interval', () => {
	const t = new Timer();
	t.setName( 't1' );
	const sent = [];
	t.sink = { fill: ( m ) => sent.push( m ) };
	t.target = '_output';
	t.setInterval( 100 );
	jest.advanceTimersByTime( 350 );
	expect( sent ).toHaveLength( 3 );
	for ( const m of sent ) {
		// eslint-disable-next-line no-bitwise
		expect( m[ TYPE ] & TM_INFO ).toBeTruthy();
		expect( typeof m[ VALUE ] ).toBe( 'number' );
	}
	t.stop();
} );

test( 'stop clears the interval', () => {
	const t = new Timer();
	t.setName( 't2' );
	const sent = [];
	t.sink = { fill: ( m ) => sent.push( m ) };
	t.setInterval( 100 );
	jest.advanceTimersByTime( 150 );
	t.stop();
	jest.advanceTimersByTime( 500 );
	expect( sent ).toHaveLength( 1 );
} );

test( 'arguments=N self-starts the timer (Tachikoma parity)', () => {
	const t = new Timer();
	t.setName( 't3' );
	const sent = [];
	t.sink = { fill: ( m ) => sent.push( m ) };
	t.arguments = '250';
	expect( t.interval_ms ).toBe( 250 );
	jest.advanceTimersByTime( 600 );
	expect( sent.length ).toBeGreaterThanOrEqual( 2 );
	t.stop();
} );

test( 'notify("FIRE") fires registered subscribers each tick', () => {
	const t = new Timer();
	t.setName( 't4' );
	const ticks = [];
	t.register( 'FIRE', 'sub', ( now ) => {
		ticks.push( now );
		return true;
	} );
	t.setInterval( 100 );
	jest.advanceTimersByTime( 250 );
	expect( ticks ).toHaveLength( 2 );
	t.stop();
} );
