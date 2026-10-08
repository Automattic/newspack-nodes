/**
 * useCommandOnce — a mutation that rides the batch.
 *
 * Save, delete and activate used to mint their own POST from a React callback,
 * outside the router's lock/flush bracket, and hand back a Promise. Riding the
 * tick is what puts them in the same request as everything else that tick; the
 * hard part is that a mutation must go EXACTLY ONCE, which is the opposite of a
 * poll's "ask again until it lands".
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import {
	Core,
	FROM,
	TO,
	TYPE,
	VALUE,
	TM_ERROR,
	newMessage,
} from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useCommandOnce } from '../useCommandOnce';

const ROUTER = '_router';

/** The surface every hook here sends for, distinct from any real one. */
const GROUP = 'wombat';

/** Where `clock` starts each test, in seconds. */
const CLOCK_BASE = 1912345678;

let replyFor;

/**
 * Substrate seconds, as `Core.now()` reads them. Frozen between ticks, so the
 * retry window, the Timer grid and the re-auth backoff move only on a tick.
 */
let clock;

/**
 * Mount the hook, then stop the Router's own 1s slot: the heartbeat is the
 * test's to drive, one `tick()` at a time, never the wall clock's.
 *
 * @param {Object} options useCommandOnce options.
 * @return {Object} The renderHook handle.
 */
const mount = ( options ) => {
	const hook = renderHook( () =>
		useCommandOnce( { group: GROUP, ...options } )
	);
	Core.node( ROUTER ).stopTimer();
	return hook;
};

const renderSave = () => mount( { ci: 'topologies', command: 'save' } );

const renderGet = ( extra ) =>
	mount( { ci: 'topologies', command: 'get', retry: true, ...extra } );

/** Let every POST in flight answer; the wire resolves over a few macrotasks. */
const settle = () =>
	act( async () => {
		for ( let i = 0; i < 5; i++ ) {
			await new Promise( ( r ) => setTimeout( r, 0 ) );
		}
	} );

/**
 * One Router heartbeat, `seconds` of substrate time after the last, and
 * whatever it put on the wire answered.
 *
 * @param {number} [seconds] Substrate seconds the clock moves first.
 */
const tick = async ( seconds = 1 ) => {
	clock += seconds;
	await act( async () => {
		Core.node( ROUTER ).fireCb();
	} );
	await settle();
};

/**
 * Heartbeats a second apart, none of them crossing a retry window alone.
 *
 * @param {number} count How many.
 */
const ticks = async ( count ) => {
	for ( let i = 0; i < count; i++ ) {
		await tick();
	}
};

/**
 * Two ticks, then one a minute on: past a read's retry window and a write's
 * own cadence, so anything left to send has had every chance to go.
 */
const later = async () => {
	await ticks( 2 );
	await tick( 60 );
};

beforeEach( () => {
	Core.reset();
	clock = CLOCK_BASE;
	jest.spyOn( Core, 'now' ).mockImplementation( () => clock );
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => ( { restarted_fleets: [ 'demo.p0' ] } ) );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

afterEach( () => {
	Core.now.mockRestore();
} );

describe( 'useCommandOnce', () => {
	// The egress path was spelled five ways across 21 call sites — a literal, a
	// template over `names`, a per-file TARGET const. The hook takes the CI
	// mount and builds it, and names its own nodes after the verb.
	it( 'builds its egress path and node names from the group and CI mount', async () => {
		renderSave();
		await act( async () => {} );
		expect( Core.node( 'topologies:save:fetch' ).target ).toBe(
			'shell:wombat/_http/topologies'
		);
		expect( Core.node( 'topologies:save:result' ) ).toBeTruthy();
	} );

	// The graph decides which reply is wanted, ahead of the result node.
	it( 'gates its result node on the Fetcher, ahead of the settle', async () => {
		mount( { ci: 'vault', command: 'rotate', scope: 'kea-rotate' } );
		await act( async () => {} );
		expect( Core.node( 'kea-rotate:in' ).target ).toEqual( [
			'kea-rotate:in:current',
			'kea-rotate:fetch',
		] );
		expect( Core.node( 'kea-rotate:in:current' ).target ).toEqual( [
			'kea-rotate:result',
		] );
	} );

	// A stale `target` used to be silently ignored, which pointed a Fetcher at
	// the bare egress and lost every reply. An option the hook does not take
	// is a mistake, and it says so.
	it( 'refuses an option it no longer takes', () => {
		// React logs the throw as it unwinds; the next beforeEach re-spies.
		console.error = () => {};
		expect( () =>
			renderHook( () =>
				useCommandOnce( {
					group: GROUP,
					command: 'save',
					target: 'shell:wombat/_http/topologies',
				} )
			)
		).toThrow( /target/ );
	} );

	// No default group: a one-shot names the surface its command belongs to.
	it( 'refuses a send naming no group', () => {
		console.error = () => {};
		expect( () =>
			renderHook( () =>
				useCommandOnce( { ci: 'topologies', command: 'save' } )
			)
		).toThrow( /group/ );
	} );

	it( "sends through its group's Tap, which stands while it is mounted", async () => {
		const { result, unmount } = renderSave();
		await act( async () => {} );
		act( () => result.current.run( [ 'kea' ] ) );
		await tick();

		expect( replyFor ).toHaveBeenCalledTimes( 1 );
		expect( Core.node( 'shell:wombat' ).counter ).toBe( 1 );

		unmount();
		expect( Core.node( 'shell:wombat' ) ).toBeNull();
	} );

	// `dump_metadata` is an interpreter builtin: there is no CI after the egress.
	it( 'targets the bare egress for a builtin verb', async () => {
		mount( { command: 'dump_metadata' } );
		await act( async () => {} );
		expect( Core.node( 'dump_metadata:fetch' ).target ).toBe(
			'shell:wombat/_http'
		);
	} );

	// A one-shot clips onto whatever graph the page already has. Owning the
	// backbone means owning Reset Graph and the full rebuild, and hook
	// declaration order would decide that — a save's four nodes taking the
	// lifecycle of the dashboard they sit beside.
	it( 'clips onto the backbone as a passenger, never its owner', async () => {
		renderSave();
		await act( async () => {} );
		expect( Core.backboneOwner ).toBeNull();
		expect( Core.rebuildable ).toBe( false );
	} );

	it( 'sends nothing until it is run', async () => {
		renderSave();
		await ticks( 2 );
		expect( replyFor ).not.toHaveBeenCalled();
	} );

	it( 'sends the command once and publishes the reply', async () => {
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', 'make_node Echo e' ] );
		} );

		await waitFor( () => expect( result.current.result ).not.toBeNull() );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ] ).toMatchObject( {
			name: 'save',
			arguments: [ 'wombat-4471', 'make_node Echo e' ],
		} );
		expect( result.current.result ).toEqual( {
			restarted_fleets: [ 'demo.p0' ],
		} );
		expect( result.current.error ).toBeNull();
	} );

	// A click must not wait out the heartbeat: `run()` asks the Router for a
	// tick, coalesced with every other ask in the same commit.
	it( 'sends on the tick it asks for, not the next cadence', async () => {
		const { result } = renderSave();
		// Spend the mount's own tick; what follows must be run()'s doing.
		await act( async () => {} );
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		// One microtask — no timer advanced, no fireCb driven by hand.
		await act( async () => {} );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	// The whole reason a mutation cannot be a poll: a save that replayed every
	// second would keep rewriting the file, and a delete would race its own
	// "no such topology" refusal.
	it( 'never repeats the command on later ticks', async () => {
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );

		await later();
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'publishes a refusal as an error, leaving the result null', async () => {
		replyFor.mockImplementation( () => new Error( 'unparseable-8823' ) );
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', 'garbage' ] );
		} );

		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		expect( result.current.error ).toContain( 'unparseable-8823' );
		expect( result.current.result ).toBeNull();
	} );

	// Two saves of the same topology answer identically. The second still has
	// to register as an answer, or the caller's confirmation never fires.
	it( 'reports a second run even when the answer is identical', async () => {
		const onDone = jest.fn();
		const { result } = mount( {
			ci: 'topologies',
			command: 'save',
			onDone,
		} );
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );

		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 2 ) );
		expect( replyFor ).toHaveBeenCalledTimes( 2 );
	} );

	// `pending` is what a Save button disables itself on; it must clear whether
	// the answer was a success or a refusal.
	it( 'reports pending from the run until the answer lands', async () => {
		const { result } = renderSave();
		expect( result.current.pending ).toBe( false );
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		expect( result.current.pending ).toBe( true );
		await waitFor( () => expect( result.current.pending ).toBe( false ) );
	} );

	// The call sites are `try { await save() } catch`, and what follows the
	// await is the interesting half: a toast, a mode change, a catalog reload.
	// `onDone` is where that half goes, fired once per reply with the arguments
	// that produced it — a save's confirmation names the topology it saved.
	it( 'fires onDone once per reply, with the arguments that were sent', async () => {
		const onDone = jest.fn();
		const { result } = mount( {
			ci: 'topologies',
			command: 'save',
			onDone,
		} );
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );

		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );
		expect( onDone ).toHaveBeenCalledWith( {
			result: { restarted_fleets: [ 'demo.p0' ] },
			// The subject rides in the reply's address, not in its payload.
			subject: 'wombat-4471',
			error: null,
			errorData: null,
			args: [ 'wombat-4471', '' ],
		} );

		await later();
		expect( onDone ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'fires onDone with the refusal when the verb refuses', async () => {
		replyFor.mockImplementation( () => new Error( 'unparseable-6612' ) );
		const onDone = jest.fn();
		const { result } = mount( {
			ci: 'topologies',
			command: 'save',
			onDone,
		} );
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );

		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );
		expect( onDone.mock.calls[ 0 ][ 0 ].result ).toBeNull();
		expect( onDone.mock.calls[ 0 ][ 0 ].error ).toContain(
			'unparseable-6612'
		);
	} );

	// A read may be retried; a write may not. That is the whole difference,
	// and it is about the request going MISSING — dropped on the wire, sent
	// while the session was being renewed — not about the answer being a
	// refusal. A refusal IS an answer: retrying it forever would put a command
	// per second on the wire for a topology that simply does not exist.
	it( 'retries an UNANSWERED read until a reply lands', async () => {
		replyFor.mockImplementation( () => undefined );
		const { result } = renderGet();
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );
		// Asked again once the retry window has passed — not every tick.
		await tick();
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
		await tick( 4 );
		await waitFor( () =>
			expect( replyFor.mock.calls.length ).toBeGreaterThan( 1 )
		);

		replyFor.mockImplementation( () => ( { name: 'wombat-4471' } ) );
		await tick( 5 );
		await waitFor( () =>
			expect( result.current.result ).toEqual( {
				name: 'wombat-4471',
			} )
		);

		const answered = replyFor.mock.calls.length;
		await later();
		expect( replyFor ).toHaveBeenCalledTimes( answered );
	} );

	// A transport refusal is NOT the server's answer: a 401 on an evicted
	// session, a 5xx, a network drop. The batch never reached the verb, so a
	// read that gave up there is the overnight tab loaded halfway — which is
	// the failure this retry exists for.
	it( 'keeps asking when the request never reached the server', async () => {
		const { result } = renderGet();
		const posts = jest.fn();
		global.fetch = /** @type {typeof fetch} */ (
			async ( url ) => {
				posts( url );
				return {
					ok: false,
					status: 401,
					text: async () => '{"code":"rest_forbidden"}',
				};
			}
		);
		global.expectConsoleWarn( 'ERROR: /command failed - HTTP 401' );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( posts ).toHaveBeenCalledTimes( 1 ) );
		// The refusal reached the hook; it must not read as an answer.
		await ticks( 2 );
		await waitFor( () =>
			expect( posts.mock.calls.length ).toBeGreaterThan( 1 )
		);
	} );

	it( 'stops a retried read on a refusal, which is an answer', async () => {
		replyFor.mockImplementation( () => new Error( 'no-such-topology' ) );
		const { result } = renderGet();
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( result.current.error ).not.toBeNull() );

		const answered = replyFor.mock.calls.length;
		await later();
		expect( replyFor ).toHaveBeenCalledTimes( answered );
	} );

	// @longform The mirror of the retried read above. A WRITE does not re-ask,
	// so a transport refusal has to SETTLE it: the row's button must re-enable
	// and the refusal must reach the caller. It only works because the refusal
	// echoes the arguments it was answering, exactly as the server does — a
	// reply naming just the verb left the send outstanding forever.
	it( 'settles a WRITE the transport refused, and says so', async () => {
		const onDone = jest.fn();
		const { result } = mount( { ci: 'vault', command: 'remove', onDone } );
		global.fetch = /** @type {typeof fetch} */ (
			async () => ( {
				ok: false,
				status: 401,
				text: async () => '{"code":"rest_forbidden"}',
			} )
		);
		global.expectConsoleWarn( 'ERROR: /command failed - HTTP 401' );
		act( () => {
			result.current.run( [ 'spoke-4471' ] );
		} );

		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );
		expect( onDone.mock.calls[ 0 ][ 0 ].args ).toEqual( [ 'spoke-4471' ] );
		expect( onDone.mock.calls[ 0 ][ 0 ].error ).toMatch( /401/ );
		expect( result.current.pending ).toBe( false );
		expect( result.current.answeredArgs ).toEqual( [ 'spoke-4471' ] );
	} );

	// @longform A Router bounces a miss as a bare `NOT_AVAILABLE` string that
	// echoes no arguments. It still names the write by its address, so the
	// caller hears the refusal and the row's button comes back, instead of the
	// write standing until it expires.
	it( 'settles a WRITE a NOT_AVAILABLE bounce names, and says so', async () => {
		replyFor.mockImplementation( () => undefined );
		const onDone = jest.fn();
		const { result } = mount( { ci: 'vault', command: 'remove', onDone } );
		act( () => {
			result.current.run( [ 'spoke-4471' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );
		expect( result.current.pending ).toBe( true );

		const bounce = newMessage();
		bounce[ TYPE ] = TM_ERROR;
		bounce[ TO ] = 'vault:remove:in/spoke-4471';
		bounce[ VALUE ] = 'NOT_AVAILABLE\n';
		await act( async () => {
			Core.node( '_command_interpreter' ).fill( bounce );
		} );

		expect( onDone ).toHaveBeenCalledTimes( 1 );
		expect( onDone.mock.calls[ 0 ][ 0 ] ).toMatchObject( {
			result: null,
			subject: 'spoke-4471',
			args: [],
		} );
		expect( onDone.mock.calls[ 0 ][ 0 ].error ).toMatch( /NOT_AVAILABLE/ );
		expect( result.current.pending ).toBe( false );
	} );

	// A write that got no reply may already have been applied; sending it
	// again would write twice.
	it( 'never retries an unanswered WRITE', async () => {
		replyFor.mockImplementation( () => undefined );
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );

		await later();
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
		// It is still outstanding, and says so: a send leaves the outbox only
		// when a reply names it, so a verb answering nothing stays pending.
		expect( result.current.pending ).toBe( true );
	} );

	// Two rows removed in the same second are two writes that BOTH have to go.
	// A read supersedes (only the latest answer matters); a write queues, or
	// the second click silently replaces the first and one row never goes.
	it( 'queues writes so a second run does not replace the first', async () => {
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
			result.current.run( [ 'quokka-8823', '' ] );
		} );

		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ) );
		const sent = replyFor.mock.calls.map(
			( [ m ] ) => m[ VALUE ].arguments[ 0 ]
		);
		expect( sent ).toEqual( [ 'wombat-4471', 'quokka-8823' ] );
	} );

	// A reply slower than the retry window means BOTH asks are answered. The
	// second answer is about an ask already settled; firing `onDone` again
	// re-runs whatever the caller does with an answer.
	it( 'fires onDone once when a retried read is answered twice', async () => {
		const onDone = jest.fn();
		let answerFirst;
		replyFor.mockImplementationOnce(
			() => new Promise( ( r ) => ( answerFirst = r ) )
		);
		replyFor.mockImplementation( () => ( { name: 'wombat-4471' } ) );
		const { result } = renderGet( { onDone } );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );
		// The retry window passes, so the read asks a second time.
		await tick( 5 );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ) );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );

		// Now the FIRST ask answers too — an answer to a settled question.
		await act( async () => {
			answerFirst( { name: 'wombat-4471' } );
		} );
		await tick();
		expect( onDone ).toHaveBeenCalledTimes( 1 );
	} );

	// A reply says which command it answers: both interpreters echo the verb
	// and its arguments. That is what lets a caller sending about several
	// subjects say which one it is looking at — no table, no id.
	it( 'names the subject its reply answered', async () => {
		replyFor.mockImplementation( () => new Error( 'vault sealed' ) );
		const { result } = mount( { ci: 'vault', command: 'test' } );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		expect( result.current.answeredArgs ).toBeNull();
		expect( result.current.pending ).toBe( true );

		await waitFor( () => expect( result.current.pending ).toBe( false ) );
		expect( result.current.answeredArgs ).toEqual( [ 'wombat-4471' ] );
		expect( result.current.error ).toContain( 'vault sealed' );
	} );

	// A row's spinner has to last until the ANSWER, not until the send. The
	// outbox used to drop a write the moment it went on the wire, so a screen
	// that re-renders on its own clock (the aggregator's per-tick clock) showed
	// the row go idle mid-flight and re-enabled its button.
	it( 'stays busy from the run until the reply lands, not until it is sent', async () => {
		const held = [];
		replyFor.mockImplementation(
			() => new Promise( ( resolve ) => held.push( () => resolve( {} ) ) )
		);
		const { result } = mount( { ci: 'vault', command: 'test' } );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		// Wait until it is demonstrably ON THE WIRE and still unanswered.
		await waitFor( () => expect( held.length ).toBe( 1 ) );
		expect( result.current.pending ).toBe( true );
		expect( result.current.answeredArgs ).toBeNull();

		await act( async () => {
			held.forEach( ( release ) => release() );
		} );
		await waitFor( () => expect( result.current.pending ).toBe( false ) );
		expect( result.current.answeredArgs ).toEqual( [ 'wombat-4471' ] );
	} );

	// @longform The subject rides in the ADDRESS: FROM is `<receiver>/<id>`,
	// the server echoes TO = FROM, the Router peels the receiver off and the
	// answer arrives naming the row it is about. One node, many rows, and
	// nothing filed under anything — which is why there is no node per row.
	it( 'addresses each send by its subject, and answers naming it', async () => {
		const held = [];
		const seen = [];
		replyFor.mockImplementation(
			( m ) =>
				new Promise( ( resolve ) =>
					held.push( () => resolve( { asked: m[ FROM ] } ) )
				)
		);
		const { result } = mount( {
			ci: 'vault',
			command: 'test',
			onDone: ( { subject } ) => seen.push( subject ),
		} );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 2 ) );

		// Each command carries its own reply path.
		const from = replyFor.mock.calls.map( ( [ m ] ) => m[ FROM ] );
		expect( from ).toEqual( [
			'vault:test:in/wombat-4471',
			'vault:test:in/quokka-8823',
		] );

		await act( async () => {
			held.forEach( ( release ) => release() );
		} );
		await waitFor( () => expect( seen.length ).toBe( 2 ) );
		expect( seen.sort() ).toEqual( [ 'quokka-8823', 'wombat-4471' ] );
		expect( result.current.pending ).toBe( false );
	} );

	// A subject is an ADDRESS segment, so it is escaped going out and read back
	// as what the caller named — otherwise a label holding a slash would peel
	// as two hops and the answer would arrive somewhere else entirely.
	it( 'escapes a subject that would otherwise change the address', async () => {
		const seen = [];
		const { result } = mount( {
			ci: 'sessions',
			command: 'create',
			onDone: ( { subject } ) => seen.push( subject ),
		} );
		act( () => result.current.run( [ 'laptop mcp' ] ) );

		await waitFor( () => expect( seen.length ).toBe( 1 ) );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ FROM ] ).toBe(
			'sessions:create:in/laptop%20mcp'
		);
		expect( seen[ 0 ] ).toBe( 'laptop mcp' );
	} );

	// @longform A BODY is not a subject. Left to the default, a verb whose
	// first token is a JSON document or a pasted URL would address its reply
	// with the whole thing — past the substrate's FROM cap, and the reply is
	// dropped. It sends WITHOUT a subject instead: a save the operator clicked
	// must not become an exception out of the click handler because the caller
	// forgot an option. The console says which command needs `subjectOf`.
	it( 'sends without a subject when one is too long to address a reply', async () => {
		expectConsoleWarn( 'ERROR: useCommandOnce' );
		const { result } = mount( { ci: 'rules', command: 'upsert' } );
		await act( async () => {} );
		const document_ = JSON.stringify( { pattern: 'x'.repeat( 200 ) } );

		expect( () =>
			act( () => result.current.run( [ document_ ] ) )
		).not.toThrow();

		await waitFor( () =>
			expect(
				replyFor.mock.calls.some(
					( [ m ] ) => m[ VALUE ]?.name === 'upsert'
				)
			).toBe( true )
		);
		const sent = replyFor.mock.calls.find(
			( [ m ] ) => m[ VALUE ]?.name === 'upsert'
		)[ 0 ];
		expect( sent[ FROM ] ).toBe( 'rules:upsert:in' );
	} );

	// Two rows acted on in the same second are two commands in flight. Neither
	// waits for the other: the reply carries the arguments it answered, so the
	// node it lands on can say which row it is about — no queue, no pairing.
	it( 'sends two commands while neither is answered, and matches each reply to its own arguments', async () => {
		const held = [];
		replyFor.mockImplementation(
			( m ) =>
				new Promise( ( resolve ) =>
					held.push( () =>
						resolve( { echoed: m[ VALUE ].arguments[ 0 ] } )
					)
				)
		);
		const seen = [];
		const { result } = mount( {
			ci: 'vault',
			command: 'delete',
			onDone: ( { args, result: r } ) =>
				seen.push( [ args[ 0 ], r?.echoed ] ),
		} );
		await act( async () => {} );

		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );
		// BOTH are on the wire while neither has been answered.
		await ticks( 4 );
		expect( held.length ).toBe( 2 );

		await act( async () => {
			held.forEach( ( release ) => release() );
		} );
		await waitFor( () => expect( seen.length ).toBe( 2 ) );
		// Each answer names the row it was about — nothing paired by order.
		expect( seen.sort() ).toEqual( [
			[ 'quokka-8823', 'quokka-8823' ],
			[ 'wombat-4471', 'wombat-4471' ],
		] );
	} );

	// @longform A caller that re-asks for the SUBJECT ALREADY OUTSTANDING is
	// saying nothing new — the retry window already owns "ask again for this".
	// Treating it as a fresh ask resets that window and pokes a router tick,
	// so a caller whose dependency identity churns (an object literal rebuilt
	// each render) puts a command and a whole tick on the wire per render.
	it( 'ignores a re-ask for the subject already outstanding', async () => {
		let held;
		replyFor.mockImplementation(
			() => new Promise( ( resolve ) => ( held = resolve ) )
		);
		const { result } = renderGet();
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );

		// Twenty re-asks for the same subject, as a churning dep would make.
		act( () => {
			for ( let i = 0; i < 20; i++ ) {
				result.current.run( [ 'wombat-4471' ] );
			}
		} );
		await ticks( 2 );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );

		held?.( { ok: 1 } );
		await waitFor( () => expect( result.current.pending ).toBe( false ) );
	} );

	// @longform A read superseded under the SAME subject asks a new question
	// about the same row. The late answer to the old question is not the
	// answer to the new one: it must neither run `onDone` nor settle the ask,
	// or the new answer arrives to find nothing standing and is dropped.
	it( 'answers a superseded read only with the reply to its new arguments', async () => {
		const held = [];
		replyFor.mockImplementation(
			( m ) =>
				new Promise( ( resolve ) =>
					held.push( () =>
						resolve( { asked: m[ VALUE ].arguments[ 1 ] } )
					)
				)
		);
		const onDone = jest.fn();
		const { result } = renderGet( { onDone } );
		act( () => {
			result.current.run( [ 'wombat-4471', 'rev-3' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 1 ) );
		act( () => {
			result.current.run( [ 'wombat-4471', 'rev-9' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 2 ) );

		await act( async () => {
			held[ 0 ]();
		} );
		await settle();
		expect( onDone ).not.toHaveBeenCalled();
		expect( result.current.isPending( 'wombat-4471' ) ).toBe( true );

		await act( async () => {
			held[ 1 ]();
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );
		expect( onDone.mock.calls[ 0 ][ 0 ].args ).toEqual( [
			'wombat-4471',
			'rev-9',
		] );
		expect( result.current.pending ).toBe( false );
	} );

	// A read is the opposite: opening one topology and then another must not
	// fetch the first, whose answer nobody wants any more.
	// @longform Three admin screens each kept a `busy` flag per row, flipped on
	// the click and cleared by the answer — a re-derivation of the outbox this
	// hook already keeps, in the one place that cannot get it wrong. The screen
	// asks instead.
	it( 'says which subjects are outstanding, and stops when each is answered', async () => {
		const held = [];
		replyFor.mockImplementation(
			( m ) =>
				new Promise( ( resolve ) =>
					held.push( () =>
						resolve( { asked: m[ VALUE ].arguments[ 0 ] } )
					)
				)
		);
		const { result } = mount( { ci: 'vault', command: 'test' } );
		expect( result.current.isPending( 'wombat-4471' ) ).toBe( false );

		// Separate ticks, so each rides its own POST and answers on its own —
		// two sends in ONE batch share a response body and settle together.
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 1 ) );
		act( () => {
			result.current.run( [ 'quokka-8823' ] );
		} );
		expect( result.current.isPending( 'wombat-4471' ) ).toBe( true );
		expect( result.current.isPending( 'quokka-8823' ) ).toBe( true );
		expect( result.current.isPending( 'never-asked' ) ).toBe( false );

		await waitFor( () => expect( held.length ).toBe( 2 ) );
		await act( async () => {
			held[ 0 ]();
		} );
		await waitFor( () =>
			expect( result.current.isPending( 'wombat-4471' ) ).toBe( false )
		);
		// The other is still out; one answer does not clear the table.
		expect( result.current.isPending( 'quokka-8823' ) ).toBe( true );
	} );

	// @longform A write has no cadence — only `run()` pokes it — so it arms at
	// a minute rather than fanning out every second to find an empty outbox.
	// The queue behind a send then has to ask for its own tick: two rows
	// deleted in the same second are two commands, and the second must not wait
	// out that minute.
	it( 'sends a queued write on the next tick, not the next cadence', async () => {
		const held = [];
		replyFor.mockImplementation(
			( m ) =>
				new Promise( ( resolve ) =>
					held.push( () =>
						resolve( { asked: m[ VALUE ].arguments[ 0 ] } )
					)
				)
		);
		const { result } = mount( { ci: 'vault', command: 'delete' } );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );

		// Both on the wire inside a few router ticks — nowhere near a minute.
		await waitFor( () => expect( held.length ).toBe( 2 ) );
	} );

	// @longform An emptied search box asks no new question, so nothing
	// supersedes the old one. `abandon()` withdraws it: the request still
	// completes on the wire, and its answer stops at the gate.
	it( 'abandons a read, so its late answer reaches nobody and nothing waits', async () => {
		const held = [];
		replyFor.mockImplementation(
			() => new Promise( ( resolve ) => held.push( resolve ) )
		);
		const onDone = jest.fn();
		const { result } = renderGet( { onDone } );
		act( () => {
			result.current.run( [ 'kakapo-3317' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 1 ) );
		expect( result.current.pending ).toBe( true );

		act( () => {
			result.current.abandon();
		} );
		expect( result.current.pending ).toBe( false );
		expect( result.current.isPending( 'kakapo-3317' ) ).toBe( false );

		await act( async () => {
			held[ 0 ]( { name: 'kakapo-3317' } );
		} );
		await settle();
		expect( onDone ).not.toHaveBeenCalled();
		expect( result.current.result ).toBeNull();
		expect( result.current.answeredArgs ).toBeNull();

		await later();
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	// The owner decides what an abandoned box shows; the hook keeps its last.
	it( 'leaves the last answer standing when it abandons the next ask', async () => {
		const held = [];
		replyFor.mockImplementation(
			( m ) =>
				new Promise( ( resolve ) =>
					held.push( () =>
						resolve( { name: m[ VALUE ].arguments[ 0 ] } )
					)
				)
		);
		const { result } = renderGet();
		act( () => {
			result.current.run( [ 'kakapo-3317' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 1 ) );
		await act( async () => {
			held[ 0 ]();
		} );
		await waitFor( () =>
			expect( result.current.result ).toEqual( { name: 'kakapo-3317' } )
		);

		act( () => {
			result.current.run( [ 'takahe-0912' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 2 ) );
		act( () => {
			result.current.abandon();
		} );
		await act( async () => {
			held[ 1 ]();
		} );
		await settle();
		expect( result.current.result ).toEqual( { name: 'kakapo-3317' } );
		expect( result.current.answeredArgs ).toEqual( [ 'kakapo-3317' ] );
	} );

	// Withdrawn means no longer asked, so the same question is asked afresh.
	it( 'asks an abandoned question again when it is run again', async () => {
		const held = [];
		replyFor.mockImplementation(
			() => new Promise( ( resolve ) => held.push( resolve ) )
		);
		const onDone = jest.fn();
		const { result } = renderGet( { onDone } );
		act( () => {
			result.current.run( [ 'kakapo-3317' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 1 ) );
		act( () => {
			result.current.abandon();
			result.current.run( [ 'kakapo-3317' ] );
		} );
		await waitFor( () => expect( held.length ).toBe( 2 ) );
		expect( result.current.pending ).toBe( true );

		await act( async () => {
			held[ 1 ]( { name: 'kakapo-3317' } );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );
		expect( result.current.pending ).toBe( false );
	} );

	it( 'supersedes a read rather than queueing it', async () => {
		const { result } = renderGet();
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );

		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ].arguments ).toEqual( [
			'quokka-8823',
		] );

		await later();
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	// Which answer is about which row: the reply carries the ARGUMENTS that
	// produced it, taken in the order they were sent. Reading "the last thing
	// sent" would name the second row while answering the first.
	it( 'reports each answer with its OWN arguments, in order', async () => {
		const seen = [];
		const { result } = mount( {
			ci: 'vault',
			command: 'delete',
			onDone: ( { args } ) => seen.push( args[ 0 ] ),
		} );
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );

		await waitFor( () => expect( seen ).toHaveLength( 2 ) );
		expect( seen ).toEqual( [ 'wombat-4471', 'quokka-8823' ] );
		expect( result.current.answeredArgs ).toEqual( [ 'quokka-8823' ] );
	} );

	// A Reset Graph rebuilds the result node, whose `seq` starts again at 1
	// while the hook's watermark survives in a ref. Reading the restart as
	// "already seen" swallowed every reply until the count caught up — and on
	// a promise nobody ever settles.
	it( 'keeps answering after a rebuild restarts the reply count', async () => {
		const onDone = jest.fn();
		const { result } = mount( {
			ci: 'topologies',
			command: 'save',
			onDone,
		} );
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ) );

		// Reset Graph: every built node is torn down and rebuilt.
		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		act( () => {
			result.current.run( [ 'quokka-8823', '' ] );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 2 ) );
		expect( onDone.mock.calls[ 1 ][ 0 ].args ).toEqual( [
			'quokka-8823',
			'',
		] );
	} );

	// A read whose answer takes longer than the tick must not be re-sent every
	// second: the verb behind one can be a log scan, and each duplicate reply
	// is another `onDone`.
	it( 'does not re-ask a slow read on every tick', async () => {
		let answer;
		replyFor.mockImplementation(
			() => new Promise( ( resolve ) => ( answer = resolve ) )
		);
		const { result } = renderGet();
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );

		// Three ticks pass with the answer still outstanding.
		await ticks( 3 );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );

		await act( async () => {
			answer( { name: 'wombat-4471' } );
		} );
		await waitFor( () =>
			expect( result.current.result ).toEqual( {
				name: 'wombat-4471',
			} )
		);
	} );
} );
