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
} );
