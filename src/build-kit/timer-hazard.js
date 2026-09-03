/**
 * The arm-then-fake guard: a runtime node armed while `setInterval` was REAL,
 * still armed when a suite fakes `setInterval` out from under it.
 *
 * That combination silently does nothing. `advanceTimersByTime` moves the fake
 * clock, but the node's handle belongs to the real one, so its callback never
 * fires — the test asserts against a graph that did not tick and passes for the
 * wrong reason, while a live real interval keeps firing beside a frozen clock.
 *
 * Three remedies, each one line, and the thrown message names all three.
 * Install fake timers BEFORE mounting or arming the graph. Dispose the stale
 * graph before re-mounting under fake timers. Or, when the mount needs the real
 * clock (an awaited `requestAnimationFrame` never resolves against a fake one),
 * fake only what the test advances: `jest.useFakeTimers( { doNotFake: [
 * 'setInterval', 'requestAnimationFrame' ] } )`. Faking `setTimeout` alone to
 * drive a component debounce is not a hazard and is not reported.
 *
 * Kept apart from `jest-node-timers.js` so the decision is unit-testable: that
 * file is a jest setup module, which only ever runs inside the harness it
 * configures.
 */

/**
 * Build a guard over one suite's armings and timer swaps.
 *
 * The verdict waits for `assertClean()` at teardown, because only teardown
 * knows whether an arming made on the real clock was still live when the suite
 * faked `setInterval`, and teardown is the one place throwing is safe.
 *
 * @param {function(Error): string} [describeSite] Maps an Error captured at arming time to a printable site, or '' to omit it.
 * @return {{onArm: function(Object, boolean, Error=): void, onDispose: function(Object): void, onClear: function(): void, onTimerSwap: function(boolean): void, assertClean: function(): void}} The hooks the jest harness drives from its arm, dispose, per-test teardown and timer-swap points.
 */
function createTimerHazardGuard( describeSite = defaultSite ) {
	// Nodes armed while setInterval was real, mapped to the arming Error.
	const armedUnderReal = new Map();
	let sawFakeInstall = false;

	return {
		/**
		 * Record an arming, or forget one the node has re-armed under fake
		 * timers: that second arming replaces the stranded handle, which
		 * `advanceTimersByTime` then drives.
		 *
		 * @param {Object}  node    The node that just armed a timer.
		 * @param {boolean} areFake Whether `setInterval` was already faked.
		 * @param {Error}   [site]  Where the arming happened; the default captures the caller's stack.
		 */
		onArm( node, areFake, site = new Error() ) {
			if ( areFake ) {
				armedUnderReal.delete( node );
				return;
			}
			armedUnderReal.set( node, site );
		},

		/**
		 * Forget a node that released its timer: it strands nothing now.
		 *
		 * @param {Object} node The node that disposed its timer.
		 */
		onDispose( node ) {
			armedUnderReal.delete( node );
		},

		/**
		 * Forget every arming and the fake install, ready for the next test.
		 */
		onClear() {
			armedUnderReal.clear();
			sawFakeInstall = false;
		},

		/**
		 * Record that `setInterval` was reassigned. Only a swap from the real
		 * function to a fake one is the hazard; `useRealTimers` restoring the
		 * real one is the safe direction. The flag latches, because a suite that
		 * restores real timers in a `finally` does so before teardown, where
		 * sampling the timer state would read real and hide the install.
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
		 * Reads without resetting; `onClear()` is the one reset, so the caller
		 * decides when the verdict is spent.
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
 * The first stack frame naming `needle`, trimmed.
 *
 * Both halves of the guard report a site through this one extractor: the
 * arming's test frame here, the leaked interval's runtime frame in
 * `jest-node-timers.js`.
 *
 * @param {Error}  err    Error whose stack holds the site.
 * @param {string} needle Path fragment the wanted frame contains.
 * @return {string} The frame, or '' when none matches or the Error carries no stack.
 */
function firstFrame( err, needle ) {
	const line = ( err.stack || '' )
		.split( '\n' )
		.find( ( l ) => l.includes( needle ) );
	return line ? line.trim() : '';
}

/**
 * The site extractor the harness uses: the first frame inside a test file.
 *
 * Every remedy is an edit to the test, so the test's own frame is the line
 * worth printing rather than the runtime frame that called `setInterval`.
 *
 * @param {Error} err Error captured at arming time.
 * @return {string} The first test-file frame, or ''.
 */
function defaultSite( err ) {
	return firstFrame( err, '__tests__' );
}

module.exports = { createTimerHazardGuard, firstFrame };
