import { renderHook, act } from '@testing-library/react';
import { StrictMode } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import names from '../../runtime/reserved-node-names.json';
import { ShellNode } from '../../runtime/shell-node';
import { VALUE } from '../../runtime/message';
import { useDebugRepl } from '../useDebugRepl';

// Build a Shell configured the same way DebugOverlay does — empty cwd, sinks
// into the page's CommandInterpreter. Shared by every test that mounts the hook.
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
		// debug_level restored (2): a no-arg debug_level toggles >0 → 0 and persists.
		act( () => result.current.sendLine( 'debug_level' ) );
		expect(
			window.localStorage.getItem( 'newspack-nodes:console:debug-level' )
		).toBe( '0' );
		teardown();
	} );

	it( 'persists debug_state and transcript as they change [87]', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );

		act( () => result.current.sendLine( 'debug_state' ) ); // toggles interpreter 0 → 1
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
		// After the commit-phase effect mounts _output/_completion/_metadata/_cwd.
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
		// Build-before-render: the hook constructs its infra in a useState
		// initializer (render-phase, before the canvas paints) and binds
		// shell.sink to the always-present `_shell` Tap (an exospine-backbone
		// fixture that forwards to the interpreter) as part of that build. A fast
		// open-and-type can't hit a null shell.sink, so there is no dispatch-time
		// resolve. shell.sink is bound on the very first render.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.path = '';
		shell.sink = null; // unbound until the hook's build binds it
		const interpreter = Core.node( names.COMMAND_INTERPRETER );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// Bound during the build (render-phase), not in a post-render effect.
		expect( shell.sink ).toBe( Core.node( names.CONSOLE_TAP ) );
		act( () => result.current.sendLine( 'ls' ) );
		// The _shell Tap forwards to the interpreter, so its fill still runs.
		expect( fillSpy ).toHaveBeenCalled();
		teardown();
	} );

	it( 'survives StrictMode double-invoked initializer without a name collision', () => {
		// React StrictMode double-invokes useState initializers in development, so
		// the build-before-render runs twice during render; the second must reuse
		// the already-registered infra rather than throw a name collision on
		// _output/_completion/_metadata/_cwd.
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

		// Fresh instances under the same names — the overlay's own nodes rebuild
		// off the same signal the dashboard graph does.
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

		// metadata.removeNode() -> stop_timer -> unregister: the router (a
		// sibling-owned backbone node) survives a panel close, so a leaked
		// registration would poll a dead _metadata forever.
		expect( names.METADATA in router.registrations.TIMER ).toBe( false );
		teardown();
	} );

	it( 'after a bump, _metadata re-registers its TIMER on the FRESH router (the critical ordering)', () => {
		// Build-delegated mount → mountExospine subscribes, so the bump rebuilds the
		// backbone. This is the production case the bare-mount test above can't cover:
		// the fresh _router must exist (sync fullRebuild) BEFORE useDebugRepl's async
		// effect re-registers _metadata's TIMER onto it — else the canvas freezes.
		const { teardown } = mountExospine( () => {} );
		const shell = makeShell();
		renderHook( () => useDebugRepl( true, shell ) );
		const firstRouter = Core.node( names.ROUTER );
		expect( names.METADATA in firstRouter.registrations.TIMER ).toBe(
			true
		);

		act( () => Core.bumpGraphGeneration() );

		const freshRouter = Core.node( names.ROUTER );
		expect( freshRouter ).not.toBe( firstRouter );
		// The TIMER lands on the FRESH router, not the torn-down one.
		expect( names.METADATA in freshRouter.registrations.TIMER ).toBe(
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

	it( 'sendLine `echo hello world` appends a recv entry with that text', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'echo hello world' ) );
		const recv = result.current.transcript.find(
			( e ) => e.kind === 'recv'
		);
		expect( recv ).toBeTruthy();
		expect( recv.text ).toBe( 'hello world' );
		teardown();
	} );

	it( 'routes a typed wire command through shell.dispatch so the onDispatch tap fires', () => {
		// Bug 3: a REPL rewire must dirty the graph like a GUI rewire. Both now
		// funnel through Shell.dispatch, where useGraphReset taps onDispatch.
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
		// The build binds shell.sink to the `_shell` Tap (else the interpreter) —
		// but when the page genuinely has neither there is nothing to bind, so
		// shell.sink stays null and the command can't be routed. Surface the drop
		// via Core.stderr (the canary) instead of silently no-op'ing. This is the
		// genuine-absence case the build-before-render guarantee can't cover.
		mountExospine();
		const shell = new ShellNode();
		shell.path = '';
		shell.sink = null;
		const stderrSpy = jest.spyOn( Core, 'stderr' ).mockImplementation();
		// Remove both bind targets (keep _router for the metadata timer) so the
		// build has nothing to bind shell.sink to.
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

	it( 'invalid `debug_level` arg emits an error transcript entry', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// Shell rejects out-of-range with `{kind:'error', text:'usage: ...'}`,
		// which the hook appends as an `error` transcript entry.
		act( () => result.current.sendLine( 'debug_level 9' ) );
		const errEntry = result.current.transcript.find(
			( e ) => e.kind === 'error'
		);
		expect( errEntry ).toBeTruthy();
		expect( errEntry.text ).toMatch( /debug_level/ );
		teardown();
	} );

	it( 'sendLine `debug_level 2` clamps to the valid range and appends an info entry', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'debug_level 2' ) );
		const info = result.current.transcript.find(
			( e ) => e.kind === 'info'
		);
		expect( info ).toBeTruthy();
		expect( info.text ).toBe( 'debug_level: 2' );
		teardown();
	} );

	it( 'bare `debug_level` toggles 0 ↔ 1', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'debug_level' ) );
		let info = result.current.transcript
			.filter( ( e ) => e.kind === 'info' )
			.at( -1 );
		expect( info.text ).toBe( 'debug_level: 1' );
		act( () => result.current.sendLine( 'debug_level' ) );
		info = result.current.transcript
			.filter( ( e ) => e.kind === 'info' )
			.at( -1 );
		expect( info.text ).toBe( 'debug_level: 0' );
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

	it( 'sendLine `show_parse` appends an info entry with the current setting', () => {
		const { teardown } = mountExospine();
		const shell = makeShell();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'show_parse' ) );
		const info = result.current.transcript.find(
			( e ) => e.kind === 'info'
		);
		expect( info ).toBeTruthy();
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
		act( () => result.current.sendLine( 'echo one; echo two' ) );
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
} );
