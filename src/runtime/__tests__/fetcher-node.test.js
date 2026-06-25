import { FetcherNode } from '../fetcher-node';
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
	f.arguments = 'countsIn counts';
	expect( f.receiver ).toBe( 'countsIn' );
	expect( f.command ).toBe( 'counts' );
	expect( f.command_args ).toBe( '' );
} );

test( 'arguments parses receiver + command + variadic command args', () => {
	const f = new FetcherNode();
	f.arguments = 'topIn rank --limit 10';
	expect( f.receiver ).toBe( 'topIn' );
	expect( f.command ).toBe( 'rank' );
	expect( f.command_args ).toBe( '--limit 10' );
} );

test( 'fill emits ONE TM_COMMAND with FROM=receiver and the configured command VALUE', () => {
	const f = new FetcherNode();
	f.arguments = 'topIn rank --limit 10';
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
	expect( m[ VALUE ] ).toEqual( {
		name: 'rank',
		arguments: '--limit 10',
	} );
	expect( m[ TO ] ).toBe( '_http/ci' );
} );

test( 'fill ignores the trigger payload — a struct trigger carrying its own command changes nothing', () => {
	const f = new FetcherNode();
	f.arguments = 'countsIn counts';
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
	expect( m[ VALUE ] ).toEqual( { name: 'counts', arguments: '' } );
	expect( m[ TO ] ).toBe( '_shell' );
} );

test( 'fill on an empty trigger still emits the configured command', () => {
	const f = new FetcherNode();
	f.arguments = 'countsIn counts';
	f.target = '_shell';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ VALUE ] ).toEqual( { name: 'counts', arguments: '' } );
} );

test( 'counter bumps per trigger', () => {
	const f = new FetcherNode();
	f.arguments = 'countsIn counts';
	f.sink = { fill: () => {} };
	f.fill( newMessage() );
	f.fill( newMessage() );
	expect( f.counter ).toBe( 2 );
} );

test( "makeNode('Fetcher', name) resolves the registered class", () => {
	const ci = new CommandInterpreterNode();
	ci.name = '_ci_fetcher_test';
	const node = ci.makeNode( 'Fetcher', 'myFetcher', 'countsIn counts' );
	expect( node ).toBeInstanceOf( FetcherNode );
	expect( node.receiver ).toBe( 'countsIn' );
	expect( node.command ).toBe( 'counts' );
} );
