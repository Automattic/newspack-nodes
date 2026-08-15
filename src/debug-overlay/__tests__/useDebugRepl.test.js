import { renderHook, act } from '@testing-library/react';
import { StrictMode } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import names from '../../runtime/reserved-node-names.json';
import { ShellNode } from '../../runtime/shell-node';
import {
	newMessage,
	FROM,
	KEY,
	TYPE,
	VALUE,
	TM_BYTESTREAM,
} from '../../runtime/message';
import { useDebugRepl } from '../useDebugRepl';

// Build a Shell like DebugOverlay does: empty cwd, sinks into the page CI.
function makeShell() {
	const shell = new ShellNode();
	shell.path = '';
	shell.sink = Core.node( names.COMMAND_INTERPRETER );
	return shell;
}

describe( 'useDebugRepl', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
	} );

	it( 'restores debug_level, transcript, and debug_state from localStorage [87]', () => {
		window.localStorage.setItem(
			'newspack-nodes:console:debug-level',
			'2'
		);
		window.localStorage.setItem(
			'newspack-nodes:console:debug-state',
			'1'
		);
		window.localStorage.setItem(
			'newspack-nodes:console:transcript',
			JSON.stringify( [ { kind: 'recv', text: 'old line' } ] )
		);
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		// Recent transcript restored into the displayed mirror.
		expect( result.current.transcript.map( ( e ) => e.text ) ).toContain(
			'old line'
		);
		// debug_state restored onto the browser interpreter.
		expect( Core.node( names.COMMAND_INTERPRETER ).debugState ).toBe( 1 );
		// debug_level restored (2): no-arg toggles >0 → 0, then persists.
		act( () => result.current.sendLine( 'debug_level' ) );
		expect(
			window.localStorage.getItem( 'newspack-nodes:console:debug-level' )
		).toBe( '0' );
		teardown();
	} );

	it( 'exposes a reactive debugLevel that tracks debug_level dispatch (the Verbose toggle reads it)', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		// Seeds from localStorage (empty → 0).
		expect( result.current.debugLevel ).toBe( 0 );
		// An explicit set to 2 (the Verbose toggle's command) is observable.
		act( () => result.current.sendLine( 'debug_level 2' ) );
		expect( result.current.debugLevel ).toBe( 2 );
		act( () => result.current.sendLine( 'debug_level 0' ) );
		expect( result.current.debugLevel ).toBe( 0 );
		teardown();
	} );

	it( 'persists debug_state and transcript as they change [87]', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		// `trace` toggles the interpreter's debug_state 0 → 1
		act( () => result.current.sendLine( 'trace' ) );
		expect(
			window.localStorage.getItem( 'newspack-nodes:console:debug-state' )
		).toBe( '1' );

		act( () => result.current.append( { kind: 'info', text: 'hello' } ) );
		const saved = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:console:transcript' )
		);
		expect( saved.map( ( e ) => e.text ) ).toContain( 'hello' );
		teardown();
	} );

	it( 'ready is false when inactive', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( false, shell ) );
		expect( result.current.ready ).toBe( false );
		teardown();
	} );

	it( 'ready becomes true once the mount effect registers the infra nodes', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// After commit-phase effect mounts _output/_completion/_metadata/_cwd.
		expect( Core.node( names.OUTPUT ) ).not.toBeNull();
		expect( result.current.ready ).toBe( true );
		teardown();
	} );

	it( 'ready flips back to false when the panel goes inactive (infra torn down)', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result, rerender } = renderHook(
			( { active } ) => useDebugRepl( active, shell ),
			{ initialProps: { active: true } }
		);
		expect( result.current.ready ).toBe( true );
		rerender( { active: false } );
		expect( result.current.ready ).toBe( false );
		teardown();
	} );

	it( 'surfaces the Dumper node as the transcript source of truth', () => {
		// Characterisation, not a regression: the read moved from a
		// hand-rolled register+useState mirror to useNodeState, which is what
		// the console does and what this file already does for `completion`.
		// Behaviour is identical either way — this pins WHERE it comes from.
		const shell = new ShellNode();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		const dumper = Core.node( names.OUTPUT );
		act( () => {
			dumper.setState( 'transcript', [
				{ text: 'quokka census 2026', kind: 'out' },
			] );
		} );

		expect( result.current.transcript.map( ( e ) => e.text ) ).toEqual( [
			'quokka census 2026',
		] );
		// The React read must come off the node's cache, so a fresh consumer
		// mounting later sees the same value with no replay.
		expect( dumper.setStateCache.transcript ).toHaveLength( 1 );
	} );

	it( 'registers a transcript node on mount and unregisters on unmount', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { unmount } = renderHook( () => useDebugRepl( true, shell ) );
		expect( Core.node( names.OUTPUT ) ).not.toBeNull();
		unmount();
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		teardown();
	} );

	it( 'does not register a transcript node when inactive', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		renderHook( () => useDebugRepl( false, shell ) );
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		teardown();
	} );

	it( 'binds shell.sink to the _shell Tap at build time, before render — so dispatch never null-resolves', () => {
		// Build-before-render: useState initializer binds shell.sink now.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.path = '';
		shell.sink = null; // unbound until the hook's build binds it
		const interpreter = Core.node( names.COMMAND_INTERPRETER );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// Bound during the build (render-phase), not in a post-render effect.
		expect( shell.sink ).toBeTruthy();
		act( () => result.current.sendLine( 'ls' ) );
		// The _shell Tap forwards to the interpreter, so its fill still runs.
		expect( fillSpy ).toHaveBeenCalled();
		teardown();
	} );

	it( 'survives StrictMode double-invoked initializer without a name collision', () => {
		// StrictMode double-invoke reuses infra, no name collision.
		const { teardown } = mountExospine();
		const shell = makeShell();
		expect( () => {
			renderHook( () => useDebugRepl( true, shell ), {
				wrapper: StrictMode,
			} );
		} ).not.toThrow();
		expect( Core.node( names.OUTPUT ) ).not.toBeNull();
		teardown();
	} );

	it( 'rebuilds its infra nodes on a graphGeneration bump (overlay half of Reset Graph)', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		renderHook( () => useDebugRepl( true, shell ) );
		const firstOutput = Core.node( names.OUTPUT );
		const firstMetadata = Core.node( names.METADATA );
		expect( firstOutput ).not.toBeNull();

		act( () => Core.bumpGraphGeneration() );

		// Fresh instances, same names — rebuilt off the same signal.
		expect( Core.node( names.OUTPUT ) ).not.toBeNull();
		expect( Core.node( names.OUTPUT ) ).not.toBe( firstOutput );
		expect( Core.node( names.METADATA ) ).not.toBe( firstMetadata );
		teardown();
	} );

	it( 'unmount unregisters _metadata TIMER from the router (TimerNode self-manages)', () => {
		const { teardown } = mountExospine();
		const router = Core.node( names.ROUTER );
		const shell = makeShell();
		const { unmount } = renderHook( () => useDebugRepl( true, shell ) );
		// _metadata hitchhikes the router TIMER by name (set_timer()).
		expect( names.METADATA in router.registrations.TIMER ).toBe( true );

		unmount();

		// removeNode → stop_timer → unregister: a leak polls _metadata.
		expect( names.METADATA in router.registrations.TIMER ).toBe( false );
		teardown();
	} );

	it( 'after a bump, _metadata is still registered on the SAME router', () => {
		const { teardown } = mountExospine( () => {} );
		const shell = makeShell();
		renderHook( () => useDebugRepl( true, shell ) );
		const firstRouter = Core.node( names.ROUTER );
		expect( names.METADATA in firstRouter.registrations.TIMER ).toBe(
			true
		);

		act( () => Core.bumpGraphGeneration() );

		// @longform
		// This used to assert a FRESH router and called itself "the critical
		// ordering": a rebuild replaced the Router, so `_metadata` had to
		// re-register on the new one, and the new one had to exist before the
		// async re-register or the overlay froze. A rebuild keeps the Router
		// now, so the ordering hazard the assertion guarded cannot arise —
		// there is nothing to re-register onto.
		expect( Core.node( names.ROUTER ) ).toBe( firstRouter );
		expect( names.METADATA in firstRouter.registrations.TIMER ).toBe(
			true
		);
		teardown();
	} );

	it( 'sendLine echoes a non-empty input into the transcript', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'help' ) );
		const transcript = result.current.transcript;
		const sentEntry = transcript.find( ( e ) => e.kind === 'sent' );
		expect( sentEntry ).toBeTruthy();
		expect( sentEntry.text ).toBe( 'help' );
		teardown();
	} );

	it( 'sendLine on an empty input is silent (no transcript entry)', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( '' ) );
		expect( result.current.transcript ).toEqual( [] );
		teardown();
	} );

	it( 'sendLine `clear` empties the transcript', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'help' ) );
		expect( result.current.transcript.length ).toBeGreaterThan( 0 );
		act( () => result.current.sendLine( 'clear' ) );
		expect( result.current.transcript ).toEqual( [] );
		teardown();
	} );

	it( 'sendLine `print hello world` appends a recv entry with that text', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'print hello world' ) );
		const recv = result.current.transcript.find(
			( e ) => e.kind === 'recv'
		);
		expect( recv ).toBeTruthy();
		expect( recv.text ).toBe( 'hello world' );
		teardown();
	} );

	it( 'routes a typed wire command through shell.dispatch so the onDispatch tap fires', () => {
		// Bug 3: REPL and GUI rewires both funnel through Shell.dispatch.
		const { teardown } = mountExospine();
		const shell = makeShell();
		const seen = [];
		shell.onDispatch = ( m ) => seen.push( m[ VALUE ].name );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'connect_node a b' ) );
		expect( seen ).toEqual( [ 'connect_node' ] );
		teardown();
	} );

	it( 'sendLine dispatches a Message into the local interpreter', () => {
		const { interpreter, teardown } = mountExospine();
		const shell = makeShell();
		const spy = jest.spyOn( interpreter, 'fill' );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// `help` is a bare verb; Shell.parse returns a TM_COMMAND Message.
		act( () => result.current.sendLine( 'help' ) );
		expect( spy ).toHaveBeenCalled();
		teardown();
	} );

	it( 'sendLine of a wire command surfaces a stderr warning naming the dropped verb when there is NO command interpreter', () => {
		// No Tap/interpreter → shell.sink null; surface via Core.stderr.
		mountExospine();
		const shell = new ShellNode();
		shell.path = '';
		shell.sink = null;
		const stderrSpy = jest.spyOn( Core, 'stderr' ).mockImplementation();
		// Remove both bind targets (keep _router for the metadata timer).
		Core.nodes.delete( names.CONSOLE_TAP );
		Core.nodes.delete( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'ls' ) );
		expect( stderrSpy ).toHaveBeenCalledTimes( 1 );
		expect( stderrSpy.mock.calls[ 0 ][ 0 ] ).toMatch(
			/no command interpreter/i
		);
		expect( stderrSpy.mock.calls[ 0 ][ 0 ] ).toMatch( /\bls\b/ );
		stderrSpy.mockRestore();
	} );

	it( 'invalid `debug_level` arg prints the usage instead of moving the dial', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// Shell rejects out-of-range and prints the usage through `_stdout`.
		act( () => result.current.sendLine( 'debug_level 9' ) );
		const usage = result.current.transcript.find( ( e ) =>
			/^usage: debug_level/.test( e.text )
		);
		expect( usage ).toBeTruthy();
		teardown();
	} );

	it( 'sendLine `debug_level 2` sets the level and reports it', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'debug_level 2' ) );
		const info = result.current.transcript.at( -1 );
		expect( info.kind ).toBe( 'recv' );
		expect( info.text ).toBe( 'debug_level: 2' );
		teardown();
	} );

	it( 'bare `debug_level` toggles 0 ↔ 1', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'debug_level' ) );
		expect( result.current.transcript.at( -1 ).text ).toBe(
			'debug_level: 1'
		);
		act( () => result.current.sendLine( 'debug_level' ) );
		expect( result.current.transcript.at( -1 ).text ).toBe(
			'debug_level: 0'
		);
		teardown();
	} );

	it( 'sendLine `status` appends each status line as recv entries', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		shell.statusLines = [ 'connected', 'last seen 5s ago' ];
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'status' ) );
		const recvs = result.current.transcript.filter(
			( e ) => e.kind === 'recv'
		);
		const texts = recvs.map( ( r ) => r.text );
		expect( texts ).toContain( 'connected' );
		expect( texts ).toContain( 'last seen 5s ago' );
		teardown();
	} );

	it( 'sendLine `show_parse` reports the current setting', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'show_parse' ) );
		const info = result.current.transcript.at( -1 );
		expect( info.kind ).toBe( 'recv' );
		expect( info.text ).toMatch( /show_parse: (on|off)/ );
		teardown();
	} );

	it( 'setPath() programmatically sends a `cd` line and updates the cwd', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		expect( result.current.cwd ).toBe( '' );
		act( () => result.current.setPath( '_http' ) );
		expect( result.current.cwd ).toBe( '_http' );
		// _cwd indirection node's target should follow.
		expect( Core.node( names.CWD ).target ).toBe( '_http' );
		teardown();
	} );

	it( 'sendLine of multiple semicolon-separated statements dispatches each', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'print one; print two' ) );
		const recvs = result.current.transcript
			.filter( ( e ) => e.kind === 'recv' )
			.map( ( e ) => e.text );
		expect( recvs ).toContain( 'one' );
		expect( recvs ).toContain( 'two' );
		teardown();
	} );

	it( 'when active flips to false, the hook tears down _output and the transcript empties', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result, rerender } = renderHook(
			( { active } ) => useDebugRepl( active, shell ),
			{ initialProps: { active: true } }
		);
		act( () => result.current.sendLine( 'help' ) );
		expect( result.current.transcript.length ).toBeGreaterThan( 0 );
		rerender( { active: false } );
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		expect( result.current.transcript ).toEqual( [] );
		teardown();
	} );

	/**
	 * ONE dispatch path. The overlay used to inject its own `sendVerb`-based
	 * dispatcher into useGraphHandlers while the console injected `sendLine`,
	 * so an Inspector action never reached the persist/cwd bookkeeping that
	 * lives on sendLine. `trace * 0` was the visible cost: the toggle worked,
	 * nothing was written, and the next load seeded the stale level back onto
	 * the interpreter, which stamps it onto every node made afterwards.
	 */
	it( 'persists debug_state through sendLine, the one dispatch path [87]', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		// 3, not 1: a level no default or toggle would land on by accident.
		act( () => result.current.sendLine( 'trace * 3' ) );

		expect( Core.node( names.COMMAND_INTERPRETER ).debugState ).toBe( 3 );
		expect(
			window.localStorage.getItem( 'newspack-nodes:console:debug-state' )
		).toBe( '3' );
		teardown();
	} );

	it( 'persists an OFF the same as an ON — 0 is a value, not an absence [87]', () => {
		window.localStorage.setItem(
			'newspack-nodes:console:debug-state',
			'1'
		);
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		expect( Core.node( names.COMMAND_INTERPRETER ).debugState ).toBe( 1 );

		act( () => result.current.sendLine( 'trace * 0' ) );

		expect(
			window.localStorage.getItem( 'newspack-nodes:console:debug-state' )
		).toBe( '0' );
		teardown();
	} );

	it( 'carries compose fields, so the flags path needs no second dispatcher', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const seen = [];
		Core.node( names.COMMAND_INTERPRETER ).fill = ( m ) => seen.push( m );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		act( () =>
			result.current.sendLine( 'send_eof _router', { key: 'k-9182' } )
		);

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ KEY ] ).toBe( 'k-9182' );
		teardown();
	} );

	it( 'spends the compose fields on their own statement, leaving a later mint addressed as minted', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const seen = [];
		Core.node( names.COMMAND_INTERPRETER ).fill = ( m ) => seen.push( m );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		act( () =>
			result.current.sendLine( 'send_eof _router', {
				from: '_output/7734',
			} )
		);
		// The invoke path mints into the gate itself, already addressed.
		const later = newMessage();
		later[ TYPE ] = TM_BYTESTREAM;
		later[ FROM ] = '_overlay:receiver';
		act( () => shell.sink.fill( later ) );

		expect( seen[ 0 ][ FROM ] ).toBe( '_output/7734' );
		expect( seen[ 1 ][ FROM ] ).toBe( '_overlay:receiver' );
		teardown();
	} );
} );
