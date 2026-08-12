/**
 * The arm-then-fake HARNESS: hook order is the whole guard.
 *
 * `timer-hazard.test.js` covers the decision table; this covers the wiring that
 * feeds it. The setup module can only run as jest's own setup file, so it is
 * loaded here into an isolated registry with the hook globals shadowed — that
 * captures the `afterEach` / `afterAll` callbacks in REGISTRATION order, which
 * is the order jest-circus runs same-block hooks in.
 */

/* eslint-env jest */

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.readyState = 0;
	}
	addEventListener() {}
	close() {
		this.readyState = 2;
	}
}

// Load the setup module against captured hooks + a fresh runtime registry.
function loadHarness() {
	const hooks = { afterEach: [], afterAll: [] };
	const realHooks = {
		afterEach: global.afterEach,
		afterAll: global.afterAll,
	};
	const descriptors = {
		setInterval: Object.getOwnPropertyDescriptor( global, 'setInterval' ),
		clearInterval: Object.getOwnPropertyDescriptor(
			global,
			'clearInterval'
		),
	};
	const rawClearInterval = global.clearInterval;
	let runtime;
	global.afterEach = ( fn ) => hooks.afterEach.push( fn );
	global.afterAll = ( fn ) => hooks.afterAll.push( fn );
	global.EventSource = FakeEventSource;
	try {
		jest.isolateModules( () => {
			require( '../jest-node-timers' );
			runtime = {
				SseInNode: require( '../../runtime/sse-in-node' ).SseInNode,
				TimerNode: require( '../../runtime/timer-node' ).TimerNode,
			};
		} );
	} finally {
		Object.assign( global, realHooks );
	}
	return {
		...runtime,
		// Circus runs every afterEach even when one throws; the first error wins.
		runAfterEach: () => {
			const errors = [];
			hooks.afterEach.forEach( ( fn ) => {
				try {
					fn();
				} catch ( err ) {
					errors.push( err );
				}
			} );
			if ( errors.length ) {
				throw errors[ 0 ];
			}
		},
		runAfterAll: () => hooks.afterAll.forEach( ( fn ) => fn() ),
		// What `jest.useFakeTimers()` does: assign the timer globals.
		installFakeTimers: () => {
			global.setInterval = () => 0;
			global.clearInterval = () => {};
		},
		restore: ( ...ids ) => {
			ids.forEach( ( id ) => rawClearInterval( id ) );
			Object.defineProperty(
				global,
				'setInterval',
				descriptors.setInterval
			);
			Object.defineProperty(
				global,
				'clearInterval',
				descriptors.clearInterval
			);
			delete global.EventSource;
		},
	};
}

describe( 'jest-node-timers', () => {
	it( 'reports an SseInNode armed on the real clock before the suite faked setInterval', () => {
		const harness = loadHarness();
		const node = new harness.SseInNode();
		node.baseUrl = 'https://example.invalid';
		node.nonce = 'zz-nonce';
		node.start();
		const handle = node._handle;
		try {
			harness.installFakeTimers();

			expect( () => harness.runAfterEach() ).toThrow(
				/left armed on the REAL clock/
			);
		} finally {
			harness.restore( handle );
		}
	} );

	it( 'still disposes the armed nodes when the verdict throws', () => {
		const harness = loadHarness();
		const node = new harness.TimerNode();
		node.setTimer( 30 );
		const handle = node._handle;
		try {
			harness.installFakeTimers();

			expect( () => harness.runAfterEach() ).toThrow();
			expect( node._handle ).toBeNull();
		} finally {
			harness.restore( handle );
		}
	} );

	it( 'does not report a leak for a timer the test itself disposed under fake timers', () => {
		const harness = loadHarness();
		const node = new harness.TimerNode();
		node.setTimer( 30 );
		const handle = node._handle;
		try {
			harness.installFakeTimers();
			node.stopTimer();
			harness.runAfterEach();

			expect( () => harness.runAfterAll() ).not.toThrow();
		} finally {
			harness.restore( handle );
		}
	} );

	it( 'does not report a router-hitchhiking node, which took no real interval', () => {
		const harness = loadHarness();
		const router = new harness.TimerNode();
		router.isRouter = true;
		router.register = () => {};
		const node = new harness.TimerNode();
		node.registry = {
			node: ( name ) => ( '_router' === name ? router : null ),
			registerNode: () => {},
		};
		node.name = 'zz-hitchhiker';
		node.setTimer( 2500 );
		try {
			harness.installFakeTimers();

			expect( () => harness.runAfterEach() ).not.toThrow();
		} finally {
			harness.restore();
		}
	} );
} );
