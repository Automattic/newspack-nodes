import { renderHook } from '@testing-library/react';
import { StrictMode } from '@wordpress/element';
import { useNodeGraph } from '../useNodeGraph';
import { mountExospine } from '../exospine';
import { Core } from '../core';
import { CommandInterpreterNode } from '../command-interpreter-node';
import names from '../reserved-node-names.json';

beforeEach( () => Core.reset() );

test( 'builds the graph before first render and tears down on unmount', () => {
	let sawInterpreterDuringRender = false;
	const { unmount } = renderHook( () => {
		useNodeGraph( () => {} );
		sawInterpreterDuringRender = !! Core.node( names.COMMAND_INTERPRETER );
	} );
	expect( sawInterpreterDuringRender ).toBe( true ); // built during render
	unmount();
	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
} );

test( 'returns the spine built by mountExospine', () => {
	const { result } = renderHook( () => useNodeGraph( () => {} ) );
	expect( result.current.interpreter ).toBeInstanceOf(
		CommandInterpreterNode
	);
	expect( result.current.interpreter ).toBe(
		Core.node( names.COMMAND_INTERPRETER )
	);
} );

test( 'runs the build callback with the spine before render', () => {
	let builtName = null;
	renderHook( () =>
		useNodeGraph( ( spine ) => {
			builtName = spine.interpreter.name;
		} )
	);
	expect( builtName ).toBe( names.COMMAND_INTERPRETER );
} );

test( 'survives StrictMode double-invoked initializer without a name collision', () => {
	// StrictMode double-invokes init, so the second mountExospine must reuse.
	expect( () => {
		renderHook( () => useNodeGraph( () => {} ), {
			wrapper: StrictMode,
		} );
	} ).not.toThrow();
} );

test( 'mountExospine reuses the existing backbone instead of recreating it (StrictMode guard)', () => {
	// mountBackbone idempotency: a second mount reuses, doesn't collide.
	const first = mountExospine();
	const firstInterpreter = Core.node( names.COMMAND_INTERPRETER );
	const second = mountExospine();
	expect( second.interpreter ).toBe( firstInterpreter );
	expect( first.interpreter ).toBe( second.interpreter );
} );
