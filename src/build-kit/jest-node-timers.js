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
	const { createTimerHazardGuard, firstFrame } = require( './timer-hazard' );
	const guard = createTimerHazardGuard();

	// @longform
	// Registered BEFORE the dispose hooks below, because jest-circus runs
	// same-block afterEach hooks in declaration order and every dispose tells
	// the guard to forget that node. Read the verdict first, then reset: a
	// dispose loop running ahead of it erases the evidence it is about to read.
	afterEach( () => {
		try {
			guard.assertClean();
		} finally {
			guard.onClear();
		}
	} );

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
			const site = firstFrame( err, '/src/runtime/' );
			if ( site ) {
				sites.push( site );
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
	 * Track every instance that arms a timer, report the arming to the guard,
	 * and disarm it after each test — on the REAL clock, since the node's own
	 * dispose reaches for whichever clearInterval is currently installed.
	 *
	 * @param {Object} proto   Prototype to instrument.
	 * @param {string} arm     Method that arms the timer.
	 * @param {string} dispose Method that releases it.
	 * @param {string} handle  Property holding the raw interval id.
	 */
	const disarmAfterEach = ( proto, arm, dispose, handle ) => {
		const armed = new Set();
		const original = proto[ arm ];
		proto[ arm ] = function ( ...args ) {
			armed.add( this );
			const result = original.apply( this, args );
			// Only an OWN slot strands a timer; a hitchhiker holds no handle.
			if ( null !== this[ handle ] ) {
				guard.onArm( this, currentSetInterval !== accounting );
			}
			return result;
		};
		// Clears both records here, since a FAKE clearInterval clears neither.
		const originalDispose = proto[ dispose ];
		proto[ dispose ] = function ( ...args ) {
			live.delete( this[ handle ] );
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
		} );
	};

	/**
	 * Close after each test whatever a test opened. No timer accounting: the
	 * SSE watchdog is a TimerNode timer, disarmed by `disarmAfterEach` above,
	 * and close() is wanted here for the REST of a live stream — the reopen
	 * timeout and the visibility listener.
	 *
	 * @param {Object} proto Prototype to instrument.
	 * @param {string} open  Method that opens the stream.
	 * @param {string} close Method that closes it.
	 */
	const closeAfterEach = ( proto, open, close ) => {
		const opened = new Set();
		const original = proto[ open ];
		proto[ open ] = function ( ...args ) {
			opened.add( this );
			return original.apply( this, args );
		};
		afterEach( () => {
			opened.forEach( ( node ) => node[ close ]() );
			opened.clear();
		} );
	};

	disarmAfterEach( TimerNode.prototype, 'setTimer', 'stopTimer', '_handle' );
	closeAfterEach( SseInNode.prototype, 'start', 'close' );
}
