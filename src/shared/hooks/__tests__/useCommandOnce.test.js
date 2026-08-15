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
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useCommandOnce } from '../useCommandOnce';

let replyFor;

const renderSave = () =>
	renderHook( () =>
		useCommandOnce( {
			ci: 'topologies',
			command: 'save',
		} )
	);

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => ( { restarted_fleets: [ 'demo.p0' ] } ) );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

describe( 'useCommandOnce', () => {
	// The egress path was spelled five ways across 21 call sites — a literal, a
	// template over `names`, a per-file TARGET const. The hook takes the CI
	// mount and builds it, and names its own nodes after the verb.
	it( 'builds its egress path and node names from the CI mount', async () => {
		renderHook( () =>
			useCommandOnce( { ci: 'topologies', command: 'save' } )
		);
		await act( async () => {} );
		expect( Core.node( 'topologies:save:fetch' ).target ).toBe(
			'_shell/_http/topologies'
		);
		expect( Core.node( 'topologies:save:result' ) ).toBeTruthy();
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
					command: 'save',
					target: '_shell/_http/topologies',
				} )
			)
		).toThrow( /target/ );
	} );

	// `taillog` is an interpreter builtin: there is no CI after the egress.
	it( 'targets the bare egress for a builtin verb', async () => {
		renderHook( () => useCommandOnce( { command: 'taillog' } ) );
		await act( async () => {} );
		expect( Core.node( 'taillog:fetch' ).target ).toBe( '_shell/_http' );
	} );

	// A one-shot clips onto whatever graph the page already has. Owning the
	// backbone means owning Reset Graph and the full rebuild, and hook
	// declaration order would decide that — a save's four nodes taking the
	// lifecycle of the dashboard they sit beside.
	it( 'clips onto the backbone as a passenger, never its owner', async () => {
		renderSave();
		await act( async () => {} );
		expect( Core.backboneOwned ).toBe( false );
		expect( Core.rebuildable ).toBe( false );
	} );

	it( 'sends nothing until it is run', async () => {
		renderSave();
		await new Promise( ( r ) => setTimeout( r, 1200 ) );
		expect( replyFor ).not.toHaveBeenCalled();
	} );

	it( 'sends the command once and publishes the reply', async () => {
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', 'make_node Echo e' ] );
		} );

		await waitFor( () => expect( result.current.result ).not.toBeNull(), {
			timeout: 4000,
		} );
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
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );

		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'publishes a refusal as an error, leaving the result null', async () => {
		replyFor.mockImplementation( () => new Error( 'unparseable-8823' ) );
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', 'garbage' ] );
		} );

		await waitFor( () => expect( result.current.error ).not.toBeNull(), {
			timeout: 4000,
		} );
		expect( result.current.error ).toContain( 'unparseable-8823' );
		expect( result.current.result ).toBeNull();
	} );

	// Two saves of the same topology answer identically. The second still has
	// to register as an answer, or the caller's confirmation never fires.
	it( 'reports a second run even when the answer is identical', async () => {
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( result.current.result ).not.toBeNull(), {
			timeout: 4000,
		} );
		const first = result.current.seq;

		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( result.current.seq ).toBe( first + 1 ), {
			timeout: 4000,
		} );
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
		await waitFor( () => expect( result.current.pending ).toBe( false ), {
			timeout: 4000,
		} );
	} );

	// The call sites are `try { await save() } catch`, and what follows the
	// await is the interesting half: a toast, a mode change, a catalog reload.
	// `onDone` is where that half goes, fired once per reply with the arguments
	// that produced it — a save's confirmation names the topology it saved.
	it( 'fires onDone once per reply, with the arguments that were sent', async () => {
		const onDone = jest.fn();
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'save',
				onDone,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );

		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
		expect( onDone ).toHaveBeenCalledWith( {
			result: { restarted_fleets: [ 'demo.p0' ] },
			error: null,
			errorData: null,
			args: [ 'wombat-4471', '' ],
		} );

		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( onDone ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'fires onDone with the refusal when the verb refuses', async () => {
		replyFor.mockImplementation( () => new Error( 'unparseable-6612' ) );
		const onDone = jest.fn();
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'save',
				onDone,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );

		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
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
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'get',
				retry: true,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		// Asked again once the retry window has passed — not every tick.
		await waitFor(
			() => expect( replyFor.mock.calls.length ).toBeGreaterThan( 1 ),
			{ timeout: 12000 }
		);

		replyFor.mockImplementation( () => ( { name: 'wombat-4471' } ) );
		await waitFor(
			() =>
				expect( result.current.result ).toEqual( {
					name: 'wombat-4471',
				} ),
			{ timeout: 12000 }
		);

		const answered = replyFor.mock.calls.length;
		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( answered );
	}, 40000 );

	// A transport refusal is NOT the server's answer: a 401 on an evicted
	// session, a 5xx, a network drop. The batch never reached the verb, so a
	// read that gave up there is the overnight tab loaded halfway — which is
	// the failure this retry exists for.
	it( 'keeps asking when the request never reached the server', async () => {
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'get',
				retry: true,
			} )
		);
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
		await waitFor( () => expect( posts ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
		// The refusal reached the hook; it must not read as an answer.
		await waitFor(
			() => expect( posts.mock.calls.length ).toBeGreaterThan( 1 ),
			{ timeout: 12000 }
		);
	}, 40000 );

	it( 'stops a retried read on a refusal, which is an answer', async () => {
		replyFor.mockImplementation( () => new Error( 'no-such-topology' ) );
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'get',
				retry: true,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( result.current.error ).not.toBeNull(), {
			timeout: 4000,
		} );

		const answered = replyFor.mock.calls.length;
		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( answered );
	} );

	// A write that got no reply may already have been applied; sending it
	// again would write twice.
	it( 'never retries an unanswered WRITE', async () => {
		replyFor.mockImplementation( () => undefined );
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );

		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
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

		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ), {
			timeout: 6000,
		} );
		const sent = replyFor.mock.calls.map(
			( [ m ] ) => m[ VALUE ].arguments[ 0 ]
		);
		expect( sent ).toEqual( [ 'wombat-4471', 'quokka-8823' ] );
	}, 15000 );

	// One command in flight at a time, which is what `RequestNode` guaranteed
	// structurally. Two writes in two POSTs can be answered in either order,
	// and pairing each reply with the oldest send then names the wrong row.
	it( 'holds the queue until the outstanding write is answered', async () => {
		let answerFirst;
		replyFor.mockImplementationOnce(
			() => new Promise( ( r ) => ( answerFirst = r ) )
		);
		const { result } = renderSave();
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
			result.current.run( [ 'quokka-8823', '' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );

		// Several ticks pass; the second write waits on the first's answer.
		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );

		await act( async () => {
			answerFirst( { restarted_fleets: [] } );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ), {
			timeout: 4000,
		} );
		expect(
			replyFor.mock.calls.map( ( [ m ] ) => m[ VALUE ].arguments[ 0 ] )
		).toEqual( [ 'wombat-4471', 'quokka-8823' ] );
	}, 20000 );

	// A verb whose result is the empty string draws NO reply at all
	// (`Command_Interpreter_Node::interpret`), and TM_NOREPLY draws none by
	// design. Without a deadline that write holds the slot forever: `pending`
	// never clears and every later reply answers the wrong arguments.
	it( 'gives up on a write that draws no reply, and says so', async () => {
		replyFor.mockImplementation( () => undefined );
		const onDone = jest.fn();
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'save',
				onDone,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
		expect( result.current.pending ).toBe( true );

		const realNow = Date.now;
		Date.now = () => realNow() + 31000;
		try {
			await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
				timeout: 4000,
			} );
		} finally {
			Date.now = realNow;
		}
		expect( onDone.mock.calls[ 0 ][ 0 ].error ).toMatch( /no reply/i );
		expect( onDone.mock.calls[ 0 ][ 0 ].args ).toEqual( [
			'wombat-4471',
			'',
		] );
		await waitFor( () => expect( result.current.pending ).toBe( false ), {
			timeout: 4000,
		} );
	}, 20000 );

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
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'get',
				retry: true,
				onDone,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		// The retry window passes, so the read asks a second time.
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ), {
			timeout: 12000,
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );

		// Now the FIRST ask answers too — an answer to a settled question.
		await act( async () => {
			answerFirst( { name: 'wombat-4471' } );
		} );
		await new Promise( ( r ) => setTimeout( r, 1200 ) );
		expect( onDone ).toHaveBeenCalledTimes( 1 );
	}, 40000 );

	// A read is the opposite: opening one topology and then another must not
	// fetch the first, whose answer nobody wants any more.
	it( 'supersedes a read rather than queueing it', async () => {
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'get',
				retry: true,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );

		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ].arguments ).toEqual( [
			'quokka-8823',
		] );

		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	}, 15000 );

	// Which answer is about which row: the reply carries the ARGUMENTS that
	// produced it, taken in the order they were sent. Reading "the last thing
	// sent" would name the second row while answering the first.
	it( 'reports each answer with its OWN arguments, in order', async () => {
		const seen = [];
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'vault',
				command: 'delete',
				onDone: ( { args } ) => seen.push( args[ 0 ] ),
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
			result.current.run( [ 'quokka-8823' ] );
		} );

		await waitFor( () => expect( seen ).toHaveLength( 2 ), {
			timeout: 6000,
		} );
		expect( seen ).toEqual( [ 'wombat-4471', 'quokka-8823' ] );
		expect( result.current.answeredArgs ).toEqual( [ 'quokka-8823' ] );
	}, 15000 );

	// A Reset Graph rebuilds the result node, whose `seq` starts again at 1
	// while the hook's watermark survives in a ref. Reading the restart as
	// "already seen" swallowed every reply until the count caught up — and on
	// `useAwaitableCommand` that is a promise nobody ever settles.
	it( 'keeps answering after a rebuild restarts the reply count', async () => {
		const onDone = jest.fn();
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'save',
				onDone,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471', '' ] );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 1 ), {
			timeout: 6000,
		} );

		// Reset Graph: every built node is torn down and rebuilt.
		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		act( () => {
			result.current.run( [ 'quokka-8823', '' ] );
		} );
		await waitFor( () => expect( onDone ).toHaveBeenCalledTimes( 2 ), {
			timeout: 6000,
		} );
		expect( onDone.mock.calls[ 1 ][ 0 ].args ).toEqual( [
			'quokka-8823',
			'',
		] );
	}, 20000 );

	// A read whose answer takes longer than the tick must not be re-sent every
	// second: the verb behind one can be a log scan, and each duplicate reply
	// is another `onDone`.
	it( 'does not re-ask a slow read on every tick', async () => {
		let answer;
		replyFor.mockImplementation(
			() => new Promise( ( resolve ) => ( answer = resolve ) )
		);
		const { result } = renderHook( () =>
			useCommandOnce( {
				ci: 'topologies',
				command: 'get',
				retry: true,
			} )
		);
		act( () => {
			result.current.run( [ 'wombat-4471' ] );
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );

		// Three ticks pass with the answer still outstanding.
		await new Promise( ( r ) => setTimeout( r, 3200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );

		await act( async () => {
			answer( { name: 'wombat-4471' } );
		} );
		await waitFor( () =>
			expect( result.current.result ).toEqual( {
				name: 'wombat-4471',
			} )
		);
	}, 20000 );
} );
