/**
 * CommandOut — the in-browser graph node that performs the worker-bound
 * command send. It folds in the routing/pivot/connect logic that used to
 * live in the standalone sendCommand util: every fill posts a BATCH of
 * one leading `connect_worker_input` (mounts the worker's input Partition
 * in the request-scoped /command process) followed by each worker
 * command, pivoting replies through the open SSE session via
 * FROM=`_http/<ssePid>`.
 *
 * The reply-pivot pid is read from the SseConnector at fill time (via
 * connector.pid()), so a reconnect that re-keys the session is picked up
 * automatically on the next send.
 */

import { CommandOut } from '../CommandOut';
import { CommandClient } from '../../../runtime/command_client';
import {
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_PING,
	TM_INFO,
	TM_BYTESTREAM,
	TM_EOF,
	TM_REQUEST,
} from '../../../runtime/message';

function makeNode( { pid = 4242 } = {} ) {
	const real = new CommandClient( { baseUrl: '/wp-json/', nonce: 'NONCE' } );
	const postBatch = jest
		.fn()
		.mockResolvedValue( [ 0, 0, '', '', '', '', '{}' ] );
	const client = {
		buildMessage: real.buildMessage.bind( real ),
		postBatch,
	};
	const connector = { pid: () => pid };
	const node = new CommandOut( {
		topology: 'demo',
		partition: 2,
		connector,
		client,
	} );
	return { node, postBatch };
}

const batchOf = ( postBatch ) => {
	expect( postBatch ).toHaveBeenCalledTimes( 1 );
	return postBatch.mock.calls[ 0 ][ 0 ];
};

const expectConnectFirst = ( batch ) => {
	expect( batch[ 0 ][ TO ] ).toBe( 'topologies' );
	expect( batch[ 0 ][ VALUE ].name ).toBe( 'connect_worker_input' );
	expect( batch[ 0 ][ VALUE ].arguments ).toBe( 'demo.p2' );
};

describe( 'CommandOut', () => {
	it( 'fills a command descriptor: leads with connect_worker_input then the command', () => {
		const { node, postBatch } = makeNode();
		node.fill( {
			commands: [ { type: 'command', name: 'ls', arguments: '' } ],
		} );
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 2 );
		expectConnectFirst( batch );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'ls' );
		expect( batch[ 1 ][ FROM ] ).toBe( '_http/4242' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:typed' );
	} );

	it( 'addresses a node inside the worker by path', () => {
		const { node, postBatch } = makeNode();
		node.fill( {
			commands: [
				{
					type: 'command',
					to: 'firehose-in',
					name: 'dump_metadata',
					arguments: '',
				},
			],
		} );
		const batch = batchOf( postBatch );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/firehose-in' );
	} );

	it( 'honours a per-command key for the silent canvas polls', () => {
		const { node, postBatch } = makeNode();
		node.fill( {
			commands: [
				{
					type: 'command',
					name: 'dump_metadata',
					arguments: '',
					key: 'gui:auto',
				},
			],
		} );
		const batch = batchOf( postBatch );
		// Both the connect and the command carry the caller's key.
		expect( batch[ 0 ][ KEY ] ).toBe( 'gui:auto' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:auto' );
	} );

	it( 'batches one connect + each command with its own key', () => {
		const { node, postBatch } = makeNode();
		node.fill( {
			commands: [
				{
					type: 'command',
					name: 'dump_metadata',
					arguments: '',
					key: 'gui:auto',
				},
				{
					type: 'command',
					name: 'uptime',
					arguments: '',
					key: 'gui:uptime',
				},
			],
		} );
		const batch = batchOf( postBatch );
		expect( batch ).toHaveLength( 3 );
		expectConnectFirst( batch );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'dump_metadata' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:auto' );
		expect( batch[ 2 ][ VALUE ].name ).toBe( 'uptime' );
		expect( batch[ 2 ][ KEY ] ).toBe( 'gui:uptime' );
	} );

	it( 'builds a TM_PING positional message carrying the send timestamp', () => {
		const { node, postBatch } = makeNode();
		node.fill( { commands: [ { type: 'ping', to: '' } ] } );
		const batch = batchOf( postBatch );
		expectConnectFirst( batch );
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_PING );
		expect( batch[ 1 ][ FROM ] ).toBe( '_http/4242' );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2' );
		expect( typeof batch[ 1 ][ VALUE ] ).toBe( 'number' );
		expect( batch[ 1 ][ VALUE ] ).toBeGreaterThan( 0 );
	} );

	it( 'builds TM_INFO / TM_BYTESTREAM / TM_EOF / TM_REQUEST typed messages', () => {
		const cases = [
			[ 'info', TM_INFO, 'hello', 'hello' ],
			[ 'bytestream', TM_BYTESTREAM, 'line\n', 'line\n' ],
			[ 'eof', TM_EOF, undefined, '' ],
			[ 'request', TM_REQUEST, 'GET_LAG', 'GET_LAG' ],
		];
		for ( const [ type, flag, args, expectedValue ] of cases ) {
			const { node, postBatch } = makeNode();
			node.fill( {
				commands: [ { type, to: 'n', arguments: args } ],
			} );
			const batch = batchOf( postBatch );
			expect( batch[ 1 ][ TYPE ] ).toBe( flag );
			expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/n' );
			expect( batch[ 1 ][ VALUE ] ).toBe( expectedValue );
		}
	} );

	it( 'rejects an unsupported message type without posting', async () => {
		const { node, postBatch } = makeNode();
		await expect(
			node.fill( { commands: [ { type: 'bogus' } ] } )
		).rejects.toThrow( 'unsupported command type' );
		expect( postBatch ).not.toHaveBeenCalled();
	} );

	it( 'returns the postBatch promise', async () => {
		const { node, postBatch } = makeNode();
		postBatch.mockResolvedValueOnce( { queued: true } );
		const out = await node.fill( {
			commands: [ { type: 'ping', to: '' } ],
		} );
		expect( out ).toEqual( { queued: true } );
	} );

	it( 'reads the reply-pivot pid from the connector at fill time', () => {
		let pid = 1;
		const real = new CommandClient( { baseUrl: '/', nonce: 'N' } );
		const postBatch = jest.fn().mockResolvedValue( null );
		const node = new CommandOut( {
			topology: 'demo',
			partition: 0,
			connector: { pid: () => pid },
			client: { buildMessage: real.buildMessage.bind( real ), postBatch },
		} );
		node.fill( { commands: [ { type: 'command', name: 'ls' } ] } );
		expect( postBatch.mock.calls[ 0 ][ 0 ][ 1 ][ FROM ] ).toBe( '_http/1' );
		// Reconnect re-keys the session; next send picks up the new pid.
		pid = 99;
		node.fill( { commands: [ { type: 'command', name: 'ls' } ] } );
		expect( postBatch.mock.calls[ 1 ][ 0 ][ 1 ][ FROM ] ).toBe(
			'_http/99'
		);
	} );

	it( 'increments the base Node counter on each fill', () => {
		const { node } = makeNode();
		node.fill( { commands: [ { type: 'ping', to: '' } ] } );
		node.fill( { commands: [ { type: 'ping', to: '' } ] } );
		expect( node.counter ).toBe( 2 );
	} );
} );
