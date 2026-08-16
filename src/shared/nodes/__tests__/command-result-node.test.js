/**
 * CommandResultNode — where a one-shot's reply lands.
 *
 * A slice keeps the last good model and swallows a bad tick; a one-shot must do
 * the opposite. Its caller asked for exactly one thing and is waiting to hear
 * how it went, so EVERY reply publishes, failures included, and every one
 * notifies — a listener hears each reply, where a re-render would collapse two
 * that landed in the same batch into the later one.
 */

import {
	newMessage,
	TYPE,
	TO,
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

const replyWithArgs = ( node, args ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name: 'delete', arguments: args, payload: { ok: 1 } };
	node.fill( m );
};

describe( 'CommandResultNode', () => {
	it( 'publishes nothing until a reply lands', () => {
		const node = new CommandResultNode();
		expect( node.setStateCache.result ).toBeUndefined();
	} );

	it( 'publishes the payload', () => {
		const node = new CommandResultNode();
		replyWith( node, { restarted_fleets: [ 'wombat-4471' ] } );
		expect( node.setStateCache.result ).toEqual( {
			ok: true,
			subject: null,
			args: [],
			payload: { restarted_fleets: [ 'wombat-4471' ] },
			error: null,
			errorData: null,
			undelivered: false,
		} );
	} );

	// The failure is the whole point of waiting: a refused save must reach the
	// caller, not be swallowed to keep a widget looking healthy.
	it( 'publishes a refusal as an error', () => {
		const node = new CommandResultNode();
		replyWith( node, 'unparseable tsl: line 3', true );
		expect( node.setStateCache.result ).toMatchObject( {
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

	// The reply names the command it answers, so a node that sent several can
	// tell them apart without keeping a queue.
	it( 'publishes the arguments the reply echoed back', () => {
		const node = new CommandResultNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = {
			name: 'delete',
			arguments: [ 'wombat-4471' ],
			payload: { ok: 1 },
		};
		node.fill( m );
		expect( node.setStateCache.result.args ).toEqual( [ 'wombat-4471' ] );
	} );

	// Two replies in one batch are two notifications. A consumer comparing
	// rendered state sees only the later, which is why anything acting on each
	// reply registers instead — and why the count is what this asserts.
	it( 'notifies once per reply, even when the answers are identical', () => {
		const node = new CommandResultNode();
		const heard = [];
		node.register( 'result', 'test', ( model ) => {
			heard.push( model.args[ 0 ] );
			return true;
		} );
		replyWithArgs( node, [ 'wombat-4471' ] );
		replyWithArgs( node, [ 'quokka-8823' ] );
		expect( heard ).toEqual( [ 'wombat-4471', 'quokka-8823' ] );
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

// @longform The Router peels FROM one segment at a time, so a reply minted
// from `vault:test:in/tw0` reaches this node with TO `tw0` — the subject it
// is about, carried by the ADDRESS. One node answers about every row that
// way, and nothing has to be filed under anything.
describe( 'the subject rides in the address', () => {
	it( 'publishes the remaining TO as the subject', () => {
		const node = new CommandResultNode();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ TO ] = 'tw0';
		m[ VALUE ] = { name: 'test', arguments: [ 'tw0' ], payload: { ok: 1 } };
		node.fill( m );

		expect( node.setStateCache.result.subject ).toBe( 'tw0' );
	} );

	it( 'publishes a null subject for a reply addressed to the node itself', () => {
		const node = new CommandResultNode();
		replyWith( node, { rows: [] } );
		expect( node.setStateCache.result.subject ).toBeNull();
	} );
} );
