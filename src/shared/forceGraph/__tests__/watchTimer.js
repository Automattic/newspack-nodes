/**
 * Have a d3 timer say whether it runs.
 *
 * @param {Object} timer The timer, running.
 * @return {Object} The same, with `runs`.
 */
export const watchTimer = ( timer ) => {
	const { restart, stop } = timer;
	return Object.assign( timer, {
		runs: true,
		restart: ( ...args ) => {
			timer.runs = true;
			restart.apply( timer, args );
		},
		stop: () => {
			timer.runs = false;
			stop.call( timer );
		},
	} );
};
