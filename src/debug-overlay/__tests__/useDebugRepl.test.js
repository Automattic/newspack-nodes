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

	it( 'sendLine dispatches a Message into the local CI', () => {
		const { ci, teardown } = mountExospine();
		const shell = makeShell();
		const spy = jest.spyOn( ci, 'fill' );
		const { result } = renderHook( () => useDebugRepl( true, shell ) );
		// `help` is a bare verb; Shell.parse returns a TM_COMMAND Message.
		act( () => result.current.sendLine( 'help' ) );
		expect( spy ).toHaveBeenCalled();
		teardown();
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
