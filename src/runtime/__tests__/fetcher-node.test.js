import { FetcherNode } from '../fetcher-node';
import { forgetSession, hasSession, __setAuthFetch } from '../command-auth';
import { CommandInterpreterNode } from '../command-interpreter-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_BYTESTREAM,
	TM_STRUCT,
} from '../message';

test( 'arguments parses receiver + command with no command args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'countsIn', 'counts' ];
	expect( f.receiver ).toBe( 'countsIn' );
	expect( f.verb ).toBe( 'counts' );
	expect( f.command_args ).toEqual( [] );
} );

test( 'arguments parses receiver + command + variadic command args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'topIn', 'rank', '--limit', '10' ];
	expect( f.receiver ).toBe( 'topIn' );
	expect( f.verb ).toBe( 'rank' );
	expect( f.command_args ).toEqual( [ '--limit', '10' ] );
} );

test( 'fill emits ONE TM_COMMAND with FROM=receiver and the configured command VALUE', () => {
	const f = new FetcherNode();
	f.arguments = [ 'topIn', 'rank', '--limit', '10' ];
	f.target = '_http/ci';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	const trigger = newMessage();
	trigger[ TYPE ] = TM_BYTESTREAM;
	trigger[ VALUE ] = '1750000000';
	f.fill( trigger );

	expect( sent ).toHaveLength( 1 );
	const m = sent[ 0 ];
	expect( m[ TYPE ] & TM_COMMAND ).toBe( TM_COMMAND );
	expect( m[ FROM ] ).toBe( 'topIn' );
	expect( m[ VALUE ] ).toMatchObject( {
		name: 'rank',
		arguments: [ '--limit', '10' ],
	} );
	expect( m[ TO ] ).toBe( '_http/ci' );
} );

test( 'fill ignores the trigger payload — a struct trigger carrying its own command changes nothing', () => {
	const f = new FetcherNode();
	f.arguments = [ 'countsIn', 'counts' ];
	f.target = '_shell';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	const trigger = newMessage();
	trigger[ TYPE ] = TM_STRUCT;
	trigger[ FROM ] = 'someClock';
	trigger[ VALUE ] = { name: 'EVIL', arguments: 'rm -rf' };
	f.fill( trigger );

	expect( sent ).toHaveLength( 1 );
	const m = sent[ 0 ];
	expect( m[ FROM ] ).toBe( 'countsIn' );
	expect( m[ VALUE ] ).toMatchObject( { name: 'counts', arguments: [] } );
	expect( m[ TO ] ).toBe( '_shell' );
} );

test( 'fill on an empty trigger still emits the configured command', () => {
	const f = new FetcherNode();
	f.arguments = [ 'countsIn', 'counts' ];
	f.target = '_shell';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'counts',
		arguments: [],
	} );
} );

test( 'command_args may be a FUNCTION, called at fire time to get current args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'urls:in', 'urls' ];
	f.target = '_http/perf';
	let live = [ '--sort', 'count' ];
	f.command_args = () => live;
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'urls',
		arguments: [ '--sort', 'count' ],
	} );

	// A later tick reflects the CURRENT value the getter returns.
	live = [ '--sort', 'avg_ms', '--order', 'asc' ];
	f.fill( newMessage() );
	expect( sent[ 1 ][ VALUE ] ).toMatchObject( {
		name: 'urls',
		arguments: [ '--sort', 'avg_ms', '--order', 'asc' ],
	} );
} );

test( 'a function command_args returning a non-string coerces to empty args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'urls:in', 'urls' ];
	f.command_args = () => null;
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };
	f.fill( newMessage() );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'urls',
		arguments: [],
	} );
} );

test( 'static string command_args still works byte-identically (no getter)', () => {
	const f = new FetcherNode();
	f.arguments = [ 'topIn', 'rank', '--limit', '10' ];
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };
	f.fill( newMessage() );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'rank',
		arguments: [ '--limit', '10' ],
	} );
} );

test( 'counter bumps per trigger', () => {
	const f = new FetcherNode();
	f.arguments = [ 'countsIn', 'counts' ];
	f.sink = { fill: () => {} };
	f.fill( newMessage() );
	f.fill( newMessage() );
	expect( f.counter ).toBe( 2 );
} );

test( "makeNode('Fetcher', name) resolves the registered class", () => {
	const ci = new CommandInterpreterNode();
	ci.name = '_ci_fetcher_test';
	const node = ci.makeNode( 'Fetcher', 'myFetcher', [
		'countsIn',
		'counts',
	] );
	expect( node ).toBeInstanceOf( FetcherNode );
	expect( node.receiver ).toBe( 'countsIn' );
	expect( node.verb ).toBe( 'counts' );
} );

/**
 * A poll tick that finds no session must also ASK for one. Skipping alone
 * leaves the page dead after an eviction or a server restart: the session is
 * gone, every tick skips, and nothing ever re-auths. ensureSession() carries
 * its own backoff, so this costs one /auth per window, not one per tick.
 */
test( 'a poll tick with no session re-authenticates', async () => {
	forgetSession();
	let issued = 0;
	__setAuthFetch( async () => {
		issued++;
		return {
			handle: 'bbbb2222bbbb2222bbbb2222bbbb2222',
			key: 'key-after-eviction',
			expires_in: 3600,
			now: 1771000000,
		};
	} );

	const f = new FetcherNode();
	f.arguments = [ 'topIn', 'rank' ];
	f.sink = { fill: () => {} };

	const trigger = newMessage();
	trigger[ TYPE ] = TM_BYTESTREAM;
	f.fill( trigger );
	await Promise.resolve();
	await Promise.resolve();

	expect( issued ).toBe( 1 );
	expect( hasSession() ).toBe( true );

	forgetSession();
	__setAuthFetch( null );
} );

test( 'keeps the inherited command() minting helper', async () => {
	forgetSession();
	__setAuthFetch( async () => ( {
		handle: 'cccc3333cccc3333cccc3333cccc3333',
		key: 'key-for-mint-helper',
		expires_in: 3600,
		now: 1771000000,
	} ) );

	const f = new FetcherNode();
	f.name = 'spline-fetcher';
	f.arguments = [ 'splineIn', 'reticulate', '--depth', '7' ];

	// The configured verb must not displace Node#command, which six sibling
	// nodes call and any generic `Core.node(x)?.command(...)` walk expects.
	expect( typeof f.command ).toBe( 'function' );

	f.sink = { fill: () => {} };
	const trigger = newMessage();
	trigger[ TYPE ] = TM_BYTESTREAM;
	f.fill( trigger );
	await Promise.resolve();
	await Promise.resolve();

	const m = f.command( 'reticulate', [ '--depth', '7' ] );
	expect( m[ VALUE ] ).toMatchObject( {
		name: 'reticulate',
		arguments: [ '--depth', '7' ],
	} );
	// It signs, too — the helper is whole, not merely present.
	expect( m[ VALUE ].auth ).toMatchObject( {
		handle: 'cccc3333cccc3333cccc3333cccc3333',
	} );

	forgetSession();
	__setAuthFetch( null );
} );
