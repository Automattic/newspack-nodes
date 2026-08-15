/**
 * CommandResultNode — where a one-shot's reply lands.
 *
 * A slice keeps the last good model and swallows a bad tick; a one-shot must do
 * the opposite. Its caller asked for exactly one thing and is waiting to hear
 * how it went, so EVERY reply publishes, failures included, and each one is
 * numbered so "the answer to what I just sent" is tellable from "the answer to
 * what I sent before".
 */

import {
	newMessage,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
} from '@newspack-nodes/runtime';
import { CommandResultNode } from '../command-result-node';

const replyWith = ( node, payload, isError = false ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | ( isError ? TM_ERROR : 0 );
	m[ VALUE ] = { name: 'save', payload };
	node.fill( m );
};

describe( 'CommandResultNode', () => {
	it( 'publishes nothing until a reply lands', () => {
		const node = new CommandResultNode();
		expect( node.setStateCache.result ).toEqual( {
			seq: 0,
			ok: false,
			payload: null,
			error: null,
			errorData: null,
			undelivered: false,
		} );
	} );

	it( 'publishes the payload and numbers the reply', () => {
		const node = new CommandResultNode();
		replyWith( node, { restarted_fleets: [ 'wombat-4471' ] } );
		expect( node.setStateCache.result ).toEqual( {
			seq: 1,
			ok: true,
			payload: { restarted_fleets: [ 'wombat-4471' ] },
			error: null,
			errorData: null,
			undelivered: false,
		} );
	} );

	// The failure is the whole point of waiting: a refused save must reach the
	// caller, not be swallowed to keep a widget looking healthy.
	it( 'publishes a refusal as an error, still numbered', () => {
		const node = new CommandResultNode();
		replyWith( node, 'unparseable tsl: line 3', true );
		expect( node.setStateCache.result ).toMatchObject( {
			seq: 1,
			ok: false,
			error: 'unparseable tsl: line 3',
		} );
	} );

	// A refusal the TRANSPORT minted — a 401, a 5xx, a dropped connection —
	// says the verb was never reached, which is a different thing from the
	// verb saying no. A retried read asks again on the first and not the
	// second, so the difference has to survive as far as the model.
	it( 'marks a reply the transport minted as undelivered', () => {
		const node = new CommandResultNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_ERROR;
		m[ VALUE ] = {
			name: 'get',
			payload: 'Command refused (HTTP 401 rest_forbidden)',
			undelivered: true,
		};
		node.fill( m );
		expect( node.setStateCache.result ).toMatchObject( {
			ok: false,
			undelivered: true,
		} );
	} );

	it( 'leaves a refusal the SERVER minted delivered', () => {
		const node = new CommandResultNode();
		replyWith( node, 'no such topology: wombat-4471', true );
		expect( node.setStateCache.result.undelivered ).toBe( false );
	} );

	// Two saves in a row publish two DIFFERENT results even when the server's
	// answer is byte-identical; without the number the second is invisible.
	it( 'numbers a repeat of the same answer as its own reply', () => {
		const node = new CommandResultNode();
		replyWith( node, { ok: 1 } );
		replyWith( node, { ok: 1 } );
		expect( node.setStateCache.result.seq ).toBe( 2 );
	} );

	// A refusal often carries more than prose — `topologies save` reports the
	// line the TSL stopped parsing on. Coercing the payload to text threw that
	// away, and the console's "(line %d)" hint could never fire.
	it( 'keeps the refusal payload beside its text', () => {
		const node = new CommandResultNode();
		replyWith(
			node,
			{ message: 'unparseable tsl', line_number: 17 },
			true
		);
		expect( node.setStateCache.result ).toMatchObject( {
			error: 'unparseable tsl',
			errorData: { message: 'unparseable tsl', line_number: 17 },
		} );
	} );

	it( 'has no errorData when the refusal is bare text', () => {
		const node = new CommandResultNode();
		replyWith( node, 'no such topology', true );
		expect( node.setStateCache.result.errorData ).toBeNull();
	} );
} );
