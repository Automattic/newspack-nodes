/**
 * fakeExitClock fakes the timeout a dialog's exit runs on, and nothing a
 * graph armed on the real clock: its intervals and frames keep running.
 */

import { fakeExitClock } from '../answerConfirm';

afterEach( () => jest.useRealTimers() );

test( 'fakeExitClock fakes timeouts and leaves intervals and frames real', () => {
	const { setInterval, requestAnimationFrame } = window;
	const curlew = jest.fn();

	fakeExitClock();
	window.setTimeout( curlew, 240 );
	jest.advanceTimersByTime( 240 );

	expect( curlew ).toHaveBeenCalledTimes( 1 );
	expect( window.setInterval ).toBe( setInterval );
	expect( window.requestAnimationFrame ).toBe( requestAnimationFrame );
} );
