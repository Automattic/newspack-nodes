import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import names from '../../runtime/reserved-node-names.json';
import { Shell } from '../../topology-console/nodes/shell';
import { useDebugRepl } from '../useDebugRepl';

// Build a Shell configured the same way DebugOverlay does — empty cwd, sinks
// into the page's CommandInterpreter. Shared by every test that mounts the hook.
function makeShell() {
	const shell = new Shell();
	shell.path = '';
	shell.sink = Core.node( names.COMMAND_INTERPRETER );
	return shell;
}

describe( 'useDebugRepl', () => {
	beforeEach( () => {
		Core.reset();
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

	it( 'unmount unregisters _metadata TIMER from the router (no stale-closure leak)', () => {
		const { teardown } = mountExospine();
		const router = Core.node( names.ROUTER );
		const shell = makeShell();
		const { unmount } = renderHook( () => useDebugRepl( true, shell ) );
		// _metadata's poll closure is registered on the router's TIMER.
		expect( router.registrations.TIMER?.[ names.METADATA ] ).toBeTruthy();

		unmount();

		// Cleanup detaches it — the router (a sibling-owned backbone node) survives
		// a panel close, so a lingering closure would poll a dead _metadata forever.
		expect( router.registrations.TIMER?.[ names.METADATA ] ).toBeFalsy();
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
		expect(
			firstRouter.registrations.TIMER?.[ names.METADATA ]
		).toBeTruthy();

		act( () => Core.bumpGraphGeneration() );

		const freshRouter = Core.node( names.ROUTER );
		expect( freshRouter ).not.toBe( firstRouter );
		// The TIMER lands on the FRESH router, not the torn-down one.
		expect(
			freshRouter.registrations.TIMER?.[ names.METADATA ]
		).toBeTruthy();
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

	it( 'sendLine of a wire command with shell.sink=null surfaces a stderr warning naming the dropped verb', () => {
		// Bug witnessed in production: DebugOverlay's shell.sink useEffect ran
		// while the dashboard's interpreter was still null in Core, the lookup
		// stayed null forever, and every wire-command dispatch via
		// `s.sink?.fill(parsed)` silently dropped — local builtins (echo, cd)
		// worked but `ls` / `dump_node` / etc. produced zero /command POSTs and
		// zero diagnostic. The optional-chain itself is the trap; surface the
		// drop via Core.stderr so the next operator sees what happened.
		mountExospine();
		const shell = new Shell();
		shell.path = '';
		shell.sink = null; // simulate the captured-null condition
		const stderrSpy = jest.spyOn( Core, 'stderr' ).mockImplementation();
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		act( () => result.current.sendLine( 'ls' ) );
		expect( stderrSpy ).toHaveBeenCalledTimes( 1 );
		expect( stderrSpy.mock.calls[ 0 ][ 0 ] ).toMatch( /shell\.sink/i );
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
