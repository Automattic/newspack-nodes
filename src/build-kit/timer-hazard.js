/**
 * The arm-then-fake guard: a runtime node armed while `setInterval` was REAL,
 * still armed when a suite fakes `setInterval` out from under it.
 *
 * That combination silently does nothing. `advanceTimersByTime` moves the fake
 * clock, but the node's handle belongs to the real one, so its callback never
 * fires — the test asserts against a graph that did not tick and passes for the
 * wrong reason, while a live real interval keeps firing beside a frozen clock.
 *
 * Two remedies, both one line. Install fake timers BEFORE mounting or arming
 * the graph; or, when the test needs the real clock to mount (an awaited
 * `requestAnimationFrame` never resolves against a fake one), fake only what it
 * actually advances: `jest.useFakeTimers( { doNotFake: [ 'setInterval',
 * 'requestAnimationFrame' ] } )`. Faking `setTimeout` alone to drive a
 * component debounce is not a hazard and is not reported.
 *
 * Kept apart from `jest-node-timers.js` so the decision is unit-testable: that
 * file is a jest setup module, which only ever runs inside the harness it
 * configures.
 */

/**
 * @param {function(Error): string} [describeSite] Maps an Error captured at arming time to a printable site, or '' to omit it.
 * @return {{onArm: function(Object, boolean, Error=): void, onDispose: function(Object): void, onClear: function(): void, onTimerSwap: function(boolean): void, assertClean: function(): void}} Guard
 *   the jest harness drives from its arm, dispose, per-test teardown, and
 *   timer-swap hooks.
 */
function createTimerHazardGuard( describeSite = defaultSite ) {
	// Nodes armed while setInterval was real, by the Error recording where.
	const armedUnderReal = new Map();
	let sawFakeInstall = false;

	return {
		/**
		 * @param {Object}  node    The node that just armed a timer.
		 * @param {boolean} areFake Whether `setInterval` was already faked.
		 * @param {Error}   [site]  Where the arming happened.
		 */
		onArm( node, areFake, site = new Error() ) {
			if ( areFake ) {
				armedUnderReal.delete( node );
				return;
			}
			armedUnderReal.set( node, site );
		},

		// A node that disposed its timer can no longer strand anything.
		onDispose( node ) {
			armedUnderReal.delete( node );
		},

		// Per-test teardown: forget everything before the next test.
		onClear() {
			armedUnderReal.clear();
			sawFakeInstall = false;
		},

		/**
		 * `setInterval` was reassigned. Only real→fake is the hazard;
		 * `useRealTimers` restoring it is the safe direction.
		 *
		 * Recorded, never thrown from here: this runs inside jest's own
		 * fake-timer install, and throwing mid-install leaves the timer state
		 * half-swapped and cascades into every later test in the file.
		 *
		 * @param {boolean} installingFake Whether this swap installs fake timers.
		 */
		onTimerSwap( installingFake ) {
			sawFakeInstall = sawFakeInstall || installingFake;
		},

		/**
		 * Report at teardown, where throwing is safe and the verdict is final:
		 * an arming only stranded something if it was still live at the end.
		 * A test that disposes the old graph before re-mounting under fake
		 * timers has fixed the problem and must not be reported.
		 *
		 * @throws {Error} When the test faked setInterval over a live arming.
		 */
		assertClean() {
			if ( ! sawFakeInstall || ! armedUnderReal.size ) {
				return;
			}
			const count = armedUnderReal.size;
			const sites = [ ...armedUnderReal.values() ]
				.map( describeSite )
				.filter( Boolean );
			armedUnderReal.clear();
			sawFakeInstall = false;
			throw new Error(
				`jest.useFakeTimers() faked setInterval with ${ count } runtime ` +
					'timer(s) left armed on the REAL clock.\n' +
					'Those cannot fire from advanceTimersByTime, so the graph ' +
					'will not tick and the test passes for the wrong reason.\n' +
					'Arm the graph AFTER installing fake timers, dispose it ' +
					'before re-mounting, or fake only what you advance:\n' +
					"  jest.useFakeTimers( { doNotFake: [ 'setInterval', " +
					"'requestAnimationFrame' ] } )\n  " +
					sites.join( '\n  ' )
			);
		},
	};
}

/**
 * @param {Error} err Error captured at arming time.
 * @return {string} The first test-file frame, or ''.
 */
function defaultSite( err ) {
	const line = ( err.stack || '' )
		.split( '\n' )
		.find( ( l ) => l.includes( '__tests__' ) );
	return line ? line.trim() : '';
}

module.exports = { createTimerHazardGuard };
