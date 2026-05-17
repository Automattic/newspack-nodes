import { Timer } from '../timer';

jest.useFakeTimers();

test( 'start schedules fireCb at the configured interval', () => {
	const t = new Timer();
	const ticks = [];
	t.fireCb = () => ticks.push( 'tick' );
	t.setInterval( 100 );
	jest.advanceTimersByTime( 350 );
	expect( ticks ).toHaveLength( 3 );
	t.stop();
} );

test( 'stop clears the timer', () => {
	const t = new Timer();
	const ticks = [];
	t.fireCb = () => ticks.push( 'tick' );
	t.setInterval( 100 );
	jest.advanceTimersByTime( 150 );
	t.stop();
	jest.advanceTimersByTime( 500 );
	expect( ticks ).toHaveLength( 1 );
} );
