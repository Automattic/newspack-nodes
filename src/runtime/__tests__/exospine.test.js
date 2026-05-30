import { mountExospine } from '../exospine';
import { Core } from '../core';
import { RouterNode } from '../router-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import names from '../reserved-node-names.json';

beforeEach( () => Core.reset() );

test( 'mounts _command_interpreter and _router under their reserved names', () => {
	const { interpreter, router } = mountExospine();

	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBe( interpreter );
	expect( Core.node( names.ROUTER ) ).toBe( router );
	expect( interpreter ).toBeInstanceOf( CommandInterpreterNode );
	expect( router ).toBeInstanceOf( RouterNode );
} );

test( 'the interpreter sinks into the router (everything → interpreter → router)', () => {
	const { interpreter, router } = mountExospine();

	expect( interpreter.sink ).toBe( router );
} );

test( 'the router stays bare — no sink, no target (rule #2)', () => {
	const { router } = mountExospine();

	expect( router.sink ).toBeNull();
	expect( router.target ).toBe( '' );
} );

test( 'teardown unregisters both backbone nodes from Core', () => {
	const { teardown } = mountExospine();

	teardown();

	expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeNull();
	expect( Core.node( names.ROUTER ) ).toBeNull();
} );

test( 'teardown fully clears the backbone (sink edge + caller TIMER listeners)', () => {
	const { interpreter, router, teardown } = mountExospine();
	// A caller clips a poll node onto the router TIMER, as the console does.
	router.register( 'TIMER', 'poll', () => {} );

	teardown();

	expect( interpreter.sink ).toBeNull();
	// removeNode wipes registrations wholesale, so the caller's TIMER listener
	// cannot survive teardown.
	expect( router.registrations.TIMER?.poll ).toBeUndefined();
} );
