import { mountExospine } from '../exospine';
import { Core } from '../core';
import { CompletionNode } from '../completion-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../message';
import names from '../reserved-node-names.json';

beforeEach( () => Core.reset() );

test( 'completion round-trip: a KEY=completion command publishes candidates on _completion', () => {
	const { interpreter } = mountExospine();
	const completion = new CompletionNode();
	completion.setName( names.COMPLETION );
	completion.sink = interpreter;

	let published = null;
	completion.register( 'candidates', 'test', ( payload ) => {
		published = payload;
		return true;
	} );

	// Exactly what DebugOverlay.requestCompletion builds for a first-token Tab.
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = names.COMPLETION;
	m[ TO ] = '';
	m[ KEY ] = 'completion';
	m[ VALUE ] = { name: 'help', arguments: '' };
	m[ LOCAL ] = true;

	interpreter.fill( m );

	expect( published ).not.toBeNull();
	expect( Array.isArray( published.candidates ) ).toBe( true );
	expect( published.candidates ).toContain( 'make_node' );
} );
