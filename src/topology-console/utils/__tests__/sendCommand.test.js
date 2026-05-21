/**
 * Tests for sendWorkerCommand — sends a command descriptor
 * (`{type, name, arguments, to}`) to a worker. Every send is a 2-message BATCH:
 * `connect_worker_input` (mounts the worker's input Partition in the /command
 * process) followed by the real command/typed message, so the second routes to
 * the worker instead of NOT_AVAILABLE. Both messages ride one request so they
 * run serially in one process.
 */

import { sendWorkerCommand, sendWorkerCommands } from '../sendCommand';
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

jest.mock( '../commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );

const { getCommandClient } = require( '../commandClient' );

describe( 'sendWorkerCommand', () => {
	let postBatch;

	beforeEach( () => {
		// Real buildMessage (so the batched messages are well-formed) plus a
		// captured postBatch. sendWorkerCommand builds via buildMessage and
		// dispatches via postBatch — never fetch directly.
		const real = new CommandClient( {
			baseUrl: '/wp-json/',
			nonce: 'NONCE',
		} );
		postBatch = jest
			.fn()
			.mockResolvedValue( [ 0, 0, '', '', '', '', '{}' ] );
		getCommandClient.mockReturnValue( {
			buildMessage: real.buildMessage.bind( real ),
			postBatch,
			baseUrl: '/wp-json/',
			nonce: 'NONCE',
		} );
	} );

	afterEach( () => {
		jest.clearAllMocks();
	} );

	const ctx = { topology: 'demo', partition: 2, ssePid: 4242 };

	const batchPosted = () => {
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
		return postBatch.mock.calls[ 0 ][ 0 ];
	};
	// Every send leads with connect_worker_input → topologies, arg = reader id.
	// Command-type messages go through buildMessage, whose VALUE is the
	// structured command OBJECT itself (no inner JSON string) — read it
	// directly.
	const expectConnectFirst = ( batch ) => {
		expect( batch ).toHaveLength( 2 );
		expect( batch[ 0 ][ TO ] ).toBe( 'topologies' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'connect_worker_input' );
		expect( batch[ 0 ][ VALUE ].arguments ).toBe( 'demo.p2' );
	};

	it( 'default command verb batches connect + the command at the worker reader id', () => {
		sendWorkerCommand(
			{ type: 'command', name: 'ls', arguments: '' },
			ctx
		);
		const batch = batchPosted();
		expectConnectFirst( batch );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'ls' );
		expect( batch[ 1 ][ FROM ] ).toBe( '_http/4242' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:typed' );
	} );

	it( 'cmd <path> <verb> addresses a node inside the worker by path', () => {
		sendWorkerCommand(
			{
				type: 'command',
				to: 'firehose-in',
				name: 'dump_metadata',
				arguments: '',
			},
			ctx
		);
		const batch = batchPosted();
		expectConnectFirst( batch );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/firehose-in' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'dump_metadata' );
	} );

	it( 'honours a custom key so silent canvas polls route to gui:auto', () => {
		sendWorkerCommand(
			{ type: 'command', name: 'dump_metadata', arguments: '' },
			{ ...ctx, key: 'gui:auto' }
		);
		const batch = batchPosted();
		// Both the connect and the command carry the caller's key.
		expect( batch[ 0 ][ KEY ] ).toBe( 'gui:auto' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:auto' );
	} );

	it( 'ping batches connect + a TM_PING positional message', async () => {
		await sendWorkerCommand( { type: 'ping', to: '' }, ctx );
		const batch = batchPosted();
		expectConnectFirst( batch );
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_PING );
		expect( batch[ 1 ][ FROM ] ).toBe( '_http/4242' );
		// Empty `to` → address the worker reader id directly.
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:typed' );
		// VALUE carries the send timestamp (seconds) so the bounced reply's
		// round-trip computes — an empty VALUE renders "round trip time: NaN ms".
		expect( typeof batch[ 1 ][ VALUE ] ).toBe( 'number' );
		expect( batch[ 1 ][ VALUE ] ).toBeGreaterThan( 0 );
	} );

	it( 'info carries arguments as VALUE at the worker path', async () => {
		await sendWorkerCommand(
			{ type: 'info', to: 'firehose-in', arguments: 'hello' },
			ctx
		);
		const batch = batchPosted();
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_INFO );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/firehose-in' );
		expect( batch[ 1 ][ VALUE ] ).toBe( 'hello' );
	} );

	it( 'bytestream posts a TM_BYTESTREAM message', async () => {
		await sendWorkerCommand(
			{ type: 'bytestream', to: 'log-node', arguments: 'line\n' },
			ctx
		);
		const batch = batchPosted();
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_BYTESTREAM );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/log-node' );
		expect( batch[ 1 ][ VALUE ] ).toBe( 'line\n' );
	} );

	it( 'eof posts a TM_EOF message with no VALUE', async () => {
		await sendWorkerCommand( { type: 'eof', to: 'drain-node' }, ctx );
		const batch = batchPosted();
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_EOF );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/drain-node' );
		expect( batch[ 1 ][ VALUE ] ).toBe( '' );
	} );

	it( 'request posts a TM_REQUEST message carrying arguments', async () => {
		await sendWorkerCommand(
			{ type: 'request', to: 'consumer', arguments: 'GET_LAG' },
			ctx
		);
		const batch = batchPosted();
		expect( batch[ 1 ][ TYPE ] ).toBe( TM_REQUEST );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p2/consumer' );
		expect( batch[ 1 ][ VALUE ] ).toBe( 'GET_LAG' );
	} );

	it( 'rejects an unsupported message type without posting', async () => {
		await expect(
			sendWorkerCommand( { type: 'bogus' }, ctx )
		).rejects.toThrow( 'unsupported command type' );
		expect( postBatch ).not.toHaveBeenCalled();
	} );

	it( 'returns the postBatch promise', async () => {
		postBatch.mockResolvedValueOnce( { queued: true } );
		const result = await sendWorkerCommand( { type: 'ping', to: '' }, ctx );
		expect( result ).toEqual( { queued: true } );
	} );

	it( 'sendWorkerCommands batches one connect + each command with its own key', () => {
		sendWorkerCommands(
			[
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
			ctx
		);
		const batch = batchPosted();
		// One leading connect_worker_input, then every command — three JSONL lines.
		expect( batch ).toHaveLength( 3 );
		expect( batch[ 0 ][ TO ] ).toBe( 'topologies' );
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'connect_worker_input' );
		expect( batch[ 0 ][ VALUE ].arguments ).toBe( 'demo.p2' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'dump_metadata' );
		expect( batch[ 1 ][ KEY ] ).toBe( 'gui:auto' );
		expect( batch[ 2 ][ VALUE ].name ).toBe( 'uptime' );
		expect( batch[ 2 ][ KEY ] ).toBe( 'gui:uptime' );
	} );
} );
