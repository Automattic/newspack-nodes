/**
 * Shared jest setup: no runtime node may leave a timer armed past its test.
 *
 * Loaded by `createJestConfig` ahead of each consumer's own `jest.setup.js`, so
 * the substrate and every plugin that composes runtime nodes inherit one copy.
 * Consumers that never import `@newspack-nodes/runtime` build their jest config
 * by hand and never load this.
 *
 * A node that arms a real interval and outlives its test is a live grenade: when
 * a later test installs fake timers and advances the clock, the zombie's callback
 * fires against a jumped clock inside somebody else's test. SseInNode is the one
 * that bit — it read the jump as stream silence, reconnected, and printed, which
 * fails the running test wherever unexpected console output is a failure. Fixing
 * the leaking suites one at a time missed the next one twice, so teardown lives
 * here and no suite can leak one.
 *
 * Browser-only: build-tooling suites run in the node environment and must not
 * pull in the runtime graph.
 */

/* eslint-env jest */

if ( 'undefined' !== typeof window ) {
	const { SseInNode } = require( '../runtime/sse-in-node' );
	const { TimerNode } = require( '../runtime/timer-node' );
	const { createTimerHazardGuard } = require( './timer-hazard' );
	const guard = createTimerHazardGuard();

	// @longform
	// Interval accounting, and the standing guard the teardown below is
	// measured against. Installed FIRST so the teardown captures this wrapper
	// as its clearInterval — capture the raw one and disposal goes unrecorded,
	// making every disposed timer read as a leak. Scoped to runtime-armed
	// intervals: a NODE is what outlives a test and fires into the next one,
	// while a React effect's interval is unmounted by testing-library. The
	// Error is stored unformatted; `.stack` is read only when a suite fails.
	const rawSetInterval = global.setInterval;
	const rawClearInterval = global.clearInterval;
	const live = new Map();

	global.setInterval = function ( ...args ) {
		const id = rawSetInterval.apply( this, args );
		live.set( id, new Error() );
		return id;
	};

	global.clearInterval = function ( id ) {
		live.delete( id );
		return rawClearInterval.call( this, id );
	};

	// @longform
	// Fake timers install by ASSIGNING the timer globals, and a setup file
	// cannot intercept `jest.useFakeTimers` itself — the test module gets its
	// own `jest` facade, so a reassignment here is never seen. An accessor
	// property is the one hook that does catch the swap, in either direction.
	// Scoped to setInterval: that is the API a node timer holds, so faking
	// setTimeout alone (a component debounce) is correctly not a hazard.
	const accounting = global.setInterval;
	let currentSetInterval = accounting;
	Object.defineProperty( global, 'setInterval', {
		configurable: true,
		get: () => currentSetInterval,
		set: ( replacement ) => {
			const installingFake =
				currentSetInterval === accounting && replacement !== accounting;
			currentSetInterval = replacement;
			guard.onTimerSwap( installingFake );
		},
	} );

	afterAll( () => {
		const sites = [];
		live.forEach( ( err ) => {
			const site = ( err.stack || '' )
				.split( '\n' )
				.find( ( line ) => line.includes( '/src/runtime/' ) );
			if ( site ) {
				sites.push( site.trim() );
			}
		} );
		live.clear();
		if ( sites.length ) {
			throw new Error(
				`${ sites.length } runtime interval(s) still armed after the last test.\n` +
					`A node that outlives its test fires into the next one.\n  ${ sites.join(
						'\n  '
					) }`
			);
		}
	} );

	// @longform
	// Captured after the accounting wrapper is installed, and before any suite
	// installs fake timers: a node's own dispose call reaches for whichever
	// clearInterval is current, which cannot cancel a real handle while fake
	// timers are installed. Never call useRealTimers() here —
	// timer-node.test.js installs fake timers once at module scope, so
	// uninstalling them between tests breaks every later advanceTimersByTime.
	const realClearInterval = global.clearInterval;

	/**
	 * Track every instance that arms a timer, and dispose it after each test.
	 *
	 * @param {Object} proto   Prototype to instrument.
	 * @param {string} arm     Method that arms the timer.
	 * @param {string} dispose Method that releases it.
	 * @param {string} handle  Property holding the raw interval id.
	 */
	const disposeAfterEach = ( proto, arm, dispose, handle ) => {
		const armed = new Set();
		const original = proto[ arm ];
		proto[ arm ] = function ( ...args ) {
			armed.add( this );
			guard.onArm( this, currentSetInterval !== accounting );
			return original.apply( this, args );
		};
		// A disposed node strands nothing, so it clears the standing record.
		const originalDispose = proto[ dispose ];
		proto[ dispose ] = function ( ...args ) {
			guard.onDispose( this );
			return originalDispose.apply( this, args );
		};
		afterEach( () => {
			armed.forEach( ( node ) => {
				const id = node[ handle ];
				node[ dispose ]();
				if ( id ) {
					realClearInterval( id );
				}
			} );
			armed.clear();
			// Verdict BEFORE the reset: onClear discards it by design.
			try {
				guard.assertClean();
			} finally {
				guard.onClear();
			}
		} );
	};

	disposeAfterEach( SseInNode.prototype, 'start', 'close', '_watchdog' );
	disposeAfterEach( TimerNode.prototype, 'setTimer', 'stopTimer', '_handle' );
}
