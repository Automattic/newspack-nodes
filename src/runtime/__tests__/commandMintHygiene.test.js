/**
 * Every command SOURCE mints with ID and KEY empty.
 *
 * A reply is addressed, not correlated: the minter stamps `FROM = <its own
 * name>`, the server replies `TO = FROM`, and the reply lands on that node for
 * its `fill()` to handle. Stamping an id so a reply can be matched — or
 * pressing KEY into service as a demux discriminator when several verbs batch
 * into one tick — re-implements routing that already happened. The fix for
 * "N verbs need telling apart" is N nodes, not a correlation table.
 *
 * These pin the minters. A reply ECHOING the inbound ID/KEY back
 * (`CommandInterpreterNode._respond`, Router's error path) is a different
 * thing and is not covered here.
 *
 * See ADR-7, and the `addSliceFetcher` docblock: "an independent reply path
 * per slice, nothing crosses."
 */

/* eslint-disable jest/expect-expect -- expectUncorrelated IS the assertion. */
import { Node } from '../node';
import { FetcherNode } from '../fetcher-node';
import { ShellNode } from '../shell-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { RouterNode } from '../router-node';
import { Core } from '../core';
import names from '../reserved-node-names.json';
import { ID, KEY, TYPE, TM_COMMAND } from '../message';

// Distinct from '' so a minter that copied the wrong slot is visible, and from
// each other so a swap between them fails too.
const NOT_AN_ID = 'op-1700000000-42';
const NOT_A_KEY = 'slice-demux';

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

/**
 * Every minted command carries neither.
 *
 * @param {Array} m The minted 7-field positional Message.
 */
const expectUncorrelated = ( m ) => {
	expect( m[ TYPE ] & TM_COMMAND ).toBeTruthy();
	expect( m[ ID ] ).toBe( '' );
	expect( m[ KEY ] ).toBe( '' );
};

test( 'Node.command() — the canonical minter', () => {
	const node = new Node();
	node.name = 'minter';
	node.target = 'somewhere';

	expectUncorrelated( node.command( 'uptime', [] ) );
} );

test( 'FetcherNode — one command per slice, per tick', () => {
	const sent = [];
	const fetcher = new FetcherNode();
	fetcher.name = 'fetch-counts';
	fetcher.receiver = 'recv-counts';
	fetcher.command = 'counts';
	fetcher.sink = { fill: ( m ) => sent.push( m ) };

	fetcher.fill( [] );

	expect( sent ).toHaveLength( 1 );
	expectUncorrelated( sent[ 0 ] );
	// The reply's address, and the only correlation there is.
	expect( sent[ 0 ][ 1 + 1 ] ).toBe( 'recv-counts' ); // FROM
} );

test( 'Shell `cmd` — no message.id / message.key vars set', () => {
	const shell = new ShellNode();
	shell.path = '_http/demo.p0';

	expectUncorrelated( shell.parse( 'cmd _uptime uptime' ) );
} );

test( 'CommandInterpreterNode `reply_to` re-mint', () => {
	const router = new RouterNode();
	router.name = names.ROUTER;
	router.stopTimer();
	const ci = new CommandInterpreterNode();
	ci.name = names.COMMAND_INTERPRETER;
	const sent = [];
	ci.sink = { fill: ( m ) => sent.push( m ) };

	ci.dispatch( 'reply_to', [ 'somewhere', 'uptime' ] );

	const cmd = sent.find( ( m ) => m[ TYPE ] & TM_COMMAND );
	expectUncorrelated( cmd );
} );

// @longform
// The guard the four above are worth having: each asserts a field is empty, and
// an empty field is also the newMessage() default — so on its own each could
// pass because the minter never touched the slot OR because the slot happens to
// start blank. This proves the assertion actually bites: a message carrying
// either field fails it, so a minter that starts stamping one is caught.
test( 'the assertion fails on a command carrying either field', () => {
	const node = new Node();
	node.name = 'minter';
	node.target = 'somewhere';

	const withId = node.command( 'uptime', [] );
	withId[ ID ] = NOT_AN_ID;
	expect( () => expectUncorrelated( withId ) ).toThrow();

	const withKey = node.command( 'uptime', [] );
	withKey[ KEY ] = NOT_A_KEY;
	expect( () => expectUncorrelated( withKey ) ).toThrow();
} );
