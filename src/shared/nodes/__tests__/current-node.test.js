/**
 * CurrentNode — the gate that lets through only the answer to a question its
 * Fetcher still asks.
 *
 * A reply names the question it answers: its remaining TO is the subject and
 * its VALUE echoes the arguments. The Fetcher's outbox holds the questions
 * still standing, so the gate asks the Fetcher, `answers()`, and drops every
 * reply to a question since replaced. An answer goes on as a Tee sends it; a
 * refusal of a standing ask, or one echoing no arguments, goes straight to the
 * view, around any transform.
 */

import {
	Core,
	CommandInterpreterNode,
	TeeNode,
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_RESPONSE,
} from '@newspack-nodes/runtime';
import { NodeRegistry } from '../../../runtime/node-registry';
import { CurrentNode } from '../current-node';

let interpreter;
let fetcher;
let gate;
let forwarded;

/**
 * @param {string}   path The reply's remaining TO.
 * @param {string[]} args The tokens it echoes.
 * @param {number}   kind TM_RESPONSE or TM_ERROR.
 * @return {Array} A reply as it reaches the gate off its receiver Tee.
 */
const reply = ( path, args, kind = TM_RESPONSE ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | kind;
	m[ TO ] = path;
	m[ VALUE ] = { name: 'urls', arguments: args, payload: { rows: 7 } };
	return m;
};

/**
 * @param {string} path The remaining TO.
 * @param {number} kind The bounce's TYPE.
 * @return {Array} A reply echoing no arguments, as the Router bounces one.
 */
const bare = ( path, kind = TM_ERROR ) => {
	const m = newMessage();
	m[ TYPE ] = kind;
	m[ TO ] = path;
	m[ VALUE ] = 'NOT_AVAILABLE\n';
	return m;
};

beforeEach( () => {
	Core.reset();
	interpreter = new CommandInterpreterNode();
	interpreter.name = '_ci_current_test';
	fetcher = interpreter.makeNode( 'Fetcher', 'urls:fetch', [
		'urls:in',
		'urls',
	] );
	fetcher.command_args = () => null;
	fetcher.sink = { fill: () => {} };
	interpreter.makeNode( 'Node', 'urls:merge' );
	interpreter.makeNode( 'Node', 'urls:view' );
	gate = interpreter.makeNode( CurrentNode, 'urls:in:current', [
		'urls:fetch',
		'urls:view',
	] );
	gate.connectNode( 'urls:merge' );
	forwarded = [];
	gate.sink = { fill: ( m ) => forwarded.push( m ) };
} );

describe( 'CurrentNode', () => {
	it( 'names its Fetcher and its view from its two arguments', () => {
		expect( gate.fetcher ).toBe( 'urls:fetch' );
		expect( gate.view ).toBe( 'urls:view' );
		expect( gate.arguments ).toEqual( [ 'urls:fetch', 'urls:view' ] );
	} );

	it( 'is a Tee, so an answer goes on as a Tee sends it', () => {
		expect( gate ).toBeInstanceOf( TeeNode );
		fetcher.send( [ '--search', 'wombat-4471' ] );
		gate.fill( reply( '', [ '--search', 'wombat-4471' ] ) );
		expect( forwarded ).toHaveLength( 1 );
		expect( forwarded[ 0 ][ TO ] ).toBe( 'urls:merge' );
		expect( forwarded[ 0 ][ VALUE ].payload ).toEqual( { rows: 7 } );
	} );

	it( 'keeps the subject on the address of an answer', () => {
		fetcher.send( [ 'spoke-0417' ], 'spoke-0417' );
		gate.fill( reply( 'spoke-0417', [ 'spoke-0417' ] ) );
		expect( forwarded[ 0 ][ TO ] ).toBe( 'urls:merge/spoke-0417' );
	} );

	it( 'drops, and counts, the answer to a question since replaced', () => {
		fetcher.send( [ '--search', 'wombat-4471' ] );
		fetcher.send( [ '--search', 'quokka-8823' ], null, true );
		gate.fill( reply( '', [ '--search', 'wombat-4471' ] ) );
		expect( forwarded ).toEqual( [] );
		expect( gate.counter ).toBe( 1 );
	} );

	it( 'drops an answer about a subject its Fetcher is not asking', () => {
		fetcher.send( [ 'spoke-0417' ], 'spoke-0417' );
		gate.fill( reply( 'spoke-0932', [ 'spoke-0417' ] ) );
		expect( forwarded ).toEqual( [] );
	} );

	// A transform shapes data; a refusal is the view's to show as it came.
	it( 'sends a refusal to the view', () => {
		fetcher.send( [ '--search', 'wombat-4471' ] );
		gate.fill( reply( '', [ '--search', 'wombat-4471' ], TM_ERROR ) );
		expect( forwarded ).toHaveLength( 1 );
		expect( forwarded[ 0 ][ TO ] ).toBe( 'urls:view' );
		expect( forwarded[ 0 ][ TYPE ] & TM_ERROR ).toBe( TM_ERROR );
	} );

	// A transport refusal echoes its arguments, so it names the ask it fails.
	it( 'drops, and counts, an undelivered refusal of a replaced ask', () => {
		fetcher.send( [ '--search', 'wombat-4471' ] );
		fetcher.send( [ '--search', 'quokka-8823' ], null, true );
		const stale = reply( '', [ '--search', 'wombat-4471' ], TM_ERROR );
		stale[ VALUE ] = {
			name: 'urls',
			arguments: [ '--search', 'wombat-4471' ],
			payload: 'Command not delivered: HTTP 502',
			undelivered: true,
		};
		gate.fill( stale );
		expect( forwarded ).toEqual( [] );
		expect( gate.counter ).toBe( 1 );
	} );

	// The view stopped wanting it: no newer question replaced this one.
	it( 'drops the answer to an ask its Fetcher withdrew', () => {
		fetcher.send( [ '--search', 'kakapo-3317' ] );
		fetcher.withdraw();
		gate.fill( reply( '', [ '--search', 'kakapo-3317' ] ) );
		gate.fill( reply( '', [ '--search', 'kakapo-3317' ], TM_ERROR ) );
		expect( forwarded ).toEqual( [] );
		expect( gate.counter ).toBe( 2 );
	} );

	it( 'drops an interpreter refusal of a replaced ask', () => {
		fetcher.send( [ 'spoke-0417' ], 'spoke-0417' );
		fetcher.send( [ 'spoke-0932' ], 'spoke-0932', true );
		gate.fill( reply( 'spoke-0417', [ 'spoke-0417' ], TM_ERROR ) );
		expect( forwarded ).toEqual( [] );
	} );

	// The view shows "not available" rather than spinning on an ask it settled.
	it( 'sends an error echoing no arguments to the view, subject kept', () => {
		fetcher.send( [ 'spoke-0417' ], 'spoke-0417' );
		gate.fill( bare( 'spoke-0417' ) );
		expect( forwarded ).toHaveLength( 1 );
		expect( forwarded[ 0 ][ TO ] ).toBe( 'urls:view/spoke-0417' );
		expect( forwarded[ 0 ][ VALUE ] ).toBe( 'NOT_AVAILABLE\n' );
	} );

	// A refusal is never a stale answer to hide: the view shows every one.
	it( 'sends a refusal to the view even when nothing is asked', () => {
		gate.fill( bare( 'spoke-0932' ) );
		expect( forwarded ).toHaveLength( 1 );
		expect( forwarded[ 0 ][ TO ] ).toBe( 'urls:view/spoke-0932' );
	} );

	it( 'drops a reply that is no error and echoes no arguments', () => {
		fetcher.send( [ 'spoke-0417' ], 'spoke-0417' );
		gate.fill( bare( 'spoke-0417', TM_COMMAND | TM_RESPONSE ) );
		expect( forwarded ).toEqual( [] );
	} );

	it( 'drops everything while its Fetcher is not in the graph', () => {
		fetcher.send( [ '--search', 'wombat-4471' ] );
		gate.fetcher = 'urls:gone';
		gate.fill( reply( '', [ '--search', 'wombat-4471' ] ) );
		expect( forwarded ).toEqual( [] );
		expect( gate.counter ).toBe( 1 );
	} );

	// A draft graph's nodes live in a registry Core cannot see.
	it( 'finds its Fetcher in its own registry, not Core', () => {
		const draft = new CommandInterpreterNode();
		draft.childRegistry = new NodeRegistry();
		draft.name = '_ci_current_draft';
		const draftFetcher = draft.makeNode( 'Fetcher', 'urls:fetch', [
			'urls:in',
			'urls',
		] );
		draft.makeNode( 'Node', 'urls:view' );
		const draftGate = draft.makeNode( CurrentNode, 'urls:in:current', [
			'urls:fetch',
			'urls:view',
		] );
		draftGate.connectNode( 'urls:view' );
		const seen = [];
		draftGate.sink = { fill: ( m ) => seen.push( m ) };

		draftFetcher.send( [ '--search', 'numbat-6610' ] );
		draftGate.fill( reply( '', [ '--search', 'numbat-6610' ] ) );
		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ][ TO ] ).toBe( 'urls:view' );
	} );

	it( 'stays off the palette: a slice builder wires it, an operator does not', () => {
		const schema = CurrentNode.nodeSchema();
		expect( schema.category ).toBe( 'Hidden' );
		expect( schema.arguments ).toEqual( [
			expect.objectContaining( { name: 'fetcher', required: true } ),
			expect.objectContaining( { name: 'view', required: true } ),
		] );
	} );
} );
