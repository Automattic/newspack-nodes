/**
 * The arm-then-fake guard's decision table. Exercised directly rather than
 * through the harness, which can only run as jest's own setup module.
 */

const { createTimerHazardGuard } = require( '../timer-hazard' );

// A site string distinct from anything the default extractor would produce, so
// a guard that ignored the injected describer would fail rather than coincide.
const site = () => 'at Object.setTimer (zz-fixture.test.js:41:9)';

const REAL = false;
const FAKE = true;
const FAKING_SETINTERVAL = true;
const RESTORING_REAL = false;

describe( 'createTimerHazardGuard', () => {
	it( 'reports fake setInterval arriving after a real-clock arming', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).toThrow(
			/1 runtime timer\(s\) left armed on the REAL clock/
		);
	} );

	it( 'names the arming site so the fix is one line away', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).toThrow(
			/zz-fixture\.test\.js:41:9/
		);
	} );

	it( 'points at doNotFake, the remedy when the mount needs a real clock', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).toThrow( /doNotFake/ );
	} );

	it( 'counts each armed node once, however many arm', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( { a: 1 }, REAL );
		guard.onArm( { b: 2 }, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).toThrow( /2 runtime timer\(s\)/ );
	} );

	it( 're-arming the same node does not double-count it', () => {
		const guard = createTimerHazardGuard( site );
		const node = {};
		guard.onArm( node, REAL );
		guard.onArm( node, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).toThrow( /1 runtime timer\(s\)/ );
	} );

	it( 'allows the correct order — fake timers first, then arm', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, FAKE );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	// doNotFake: [ 'setInterval' ] never assigns it, so the swap never happens.
	it( 'allows faking setTimeout alone over a live arming', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 'allows useRealTimers to restore the globals', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( RESTORING_REAL );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 'allows a swap when nothing is armed', () => {
		const guard = createTimerHazardGuard( site );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 'forgets armings the per-test teardown disposed', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onClear();
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 'clears once reported, so the next test starts clean', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );

		expect( () => guard.assertClean() ).toThrow();
		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 'a disposed arming strands nothing, even after a fake install', () => {
		const guard = createTimerHazardGuard( site );
		const node = {};
		guard.onArm( node, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );
		// What `Core.reset()` + re-mount SHOULD do to the stale graph.
		guard.onDispose( node );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 're-arming the same node under fake timers clears it', () => {
		const guard = createTimerHazardGuard( site );
		const node = {};
		guard.onArm( node, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );
		guard.onArm( node, FAKE );

		expect( () => guard.assertClean() ).not.toThrow();
	} );

	it( 'disposing one of two still reports the other', () => {
		const guard = createTimerHazardGuard( site );
		const kept = {};
		const dropped = {};
		guard.onArm( kept, REAL );
		guard.onArm( dropped, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );
		guard.onDispose( dropped );

		expect( () => guard.assertClean() ).toThrow( /1 runtime timer\(s\)/ );
	} );

	describe( 'the default site extractor (what the harness actually uses)', () => {
		const armWithStack = ( stack ) => {
			const guard = createTimerHazardGuard();
			const err = new Error();
			err.stack = stack;
			guard.onArm( {}, REAL, err );
			guard.onTimerSwap( FAKING_SETINTERVAL );
			return guard;
		};

		it( 'reports the first frame inside a test file', () => {
			const guard = armWithStack(
				[
					'Error',
					'    at TimerNode.setTimer (/x/src/runtime/timer-node.js:9:1)',
					'    at Object.mount (/x/src/topology-console/__tests__/Zed.test.js:77:3)',
					'    at Object.other (/x/src/topology-console/__tests__/Zed.test.js:99:3)',
				].join( '\n' )
			);

			expect( () => guard.assertClean() ).toThrow( /Zed\.test\.js:77:3/ );
		} );

		it( 'still reports the count when no test frame survives', () => {
			const guard = armWithStack(
				'Error\n    at TimerNode.setTimer (/x/src/runtime/timer-node.js:9:1)'
			);

			expect( () => guard.assertClean() ).toThrow(
				/1 runtime timer\(s\)/
			);
		} );

		it( 'tolerates an Error with no stack at all', () => {
			const guard = armWithStack( undefined );

			expect( () => guard.assertClean() ).toThrow(
				/1 runtime timer\(s\)/
			);
		} );
	} );

	// @longform
	// The offending suite restores real timers in a `finally`, which runs
	// before the harness teardown. Latching the install rather than sampling
	// the timer state at teardown is what keeps the hazard visible at all.
	it( 'latches the install, so a later useRealTimers cannot hide it', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );
		guard.onTimerSwap( RESTORING_REAL );

		expect( () => guard.assertClean() ).toThrow( /left armed on the REAL/ );
	} );

	// Pins the harness's teardown order: read the verdict, THEN reset.
	it( 'onClear discards a verdict that was never read', () => {
		const guard = createTimerHazardGuard( site );
		guard.onArm( {}, REAL );
		guard.onTimerSwap( FAKING_SETINTERVAL );
		guard.onClear();

		expect( () => guard.assertClean() ).not.toThrow();
	} );
} );
