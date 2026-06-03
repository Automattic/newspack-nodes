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
	expect( sawInterpreterDuringRender ).toBe( true ); // built during render, not in an effect
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
	// React StrictMode double-invokes useState initializers in development, so
	// mountExospine runs twice during render; the second must reuse the backbone
	// rather than throw a name collision on the reserved interpreter name.
	expect( () => {
		renderHook( () => useNodeGraph( () => {} ), {
			wrapper: StrictMode,
		} );
	} ).not.toThrow();
} );

test( 'mountExospine reuses the existing backbone instead of recreating it (StrictMode guard)', () => {
	// Direct check of the mountBackbone idempotency guard: a second mount with the
	// interpreter already registered reuses it rather than colliding on the name.
	const first = mountExospine();
	const firstInterpreter = Core.node( names.COMMAND_INTERPRETER );
	const second = mountExospine();
	expect( second.interpreter ).toBe( firstInterpreter );
	expect( first.interpreter ).toBe( second.interpreter );
} );
