/**
 * Tests for sendInterpretedCommand — translates a shellInterpret `post`
 * body into a dispatch on the generic `/command` endpoint, pivoting the
 * reply back through the open messages-stream session via FROM=`_http/<pid>`.
 *
 * TM_COMMAND verbs (default + `cmd`) go through the shared CommandClient.
 * The other typed verbs (ping/info/bytestream/eof/request) post a raw
 * positional Message array directly to `/command` (the controller's
 * normalize_body_to_message accepts a 7-field list), since CommandClient
 * only builds TM_COMMAND.
 */

import { sendInterpretedCommand } from '../sendCommand';
import {
	TYPE,
	TIMESTAMP,
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

describe( 'sendInterpretedCommand', () => {
	let send;
	let fetchMock;
	const originalFetch = global.fetch;

	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [ 0, 0, '', '', '', '', '{}' ] );
		getCommandClient.mockReturnValue( {
			send,
			baseUrl: '/wp-json/',
			nonce: 'NONCE',
		} );
		fetchMock = jest
			.fn()
			.mockResolvedValue( { json: () => Promise.resolve( {} ) } );
		global.fetch = fetchMock;
	} );

	afterEach( () => {
		global.fetch = originalFetch;
		jest.clearAllMocks();
	} );

	const ctx = { topology: 'demo', partition: 2, ssePid: 4242 };

	it( 'default command verb routes through CommandClient at the worker reader id', () => {
		// shellInterpret('ls') → { type:'command', name:'ls', arguments:'' }
		sendInterpretedCommand(
			{ type: 'command', name: 'ls', arguments: '' },
			ctx
		);
		expect( send ).toHaveBeenCalledWith( {
			to: 'demo.p2',
			verb: 'ls',
			args: '',
			ssePid: 4242,
			key: 'gui:typed',
		} );
		expect( fetchMock ).not.toHaveBeenCalled();
	} );

	it( 'cmd <path> <verb> addresses a node inside the worker by path', () => {
		// shellInterpret('cmd firehose-in dump_metadata') →
		//   { type:'command', to:'firehose-in', name:'dump_metadata', arguments:'' }
		sendInterpretedCommand(
			{
				type: 'command',
				to: 'firehose-in',
				name: 'dump_metadata',
				arguments: '',
			},
			ctx
		);
		expect( send ).toHaveBeenCalledWith( {
			to: 'demo.p2/firehose-in',
			verb: 'dump_metadata',
			args: '',
			ssePid: 4242,
			key: 'gui:typed',
		} );
	} );

	it( 'honours a custom key so silent canvas polls route to gui:auto', () => {
		sendInterpretedCommand(
			{ type: 'command', name: 'dump_metadata', arguments: '' },
			{ ...ctx, key: 'gui:auto' }
		);
		expect( send ).toHaveBeenCalledWith( {
			to: 'demo.p2',
			verb: 'dump_metadata',
			args: '',
			ssePid: 4242,
			key: 'gui:auto',
		} );
	} );

	it( 'ping posts a raw TM_PING positional array to /command', async () => {
		await sendInterpretedCommand( { type: 'ping', to: '' }, ctx );
		expect( send ).not.toHaveBeenCalled();
		expect( fetchMock ).toHaveBeenCalledTimes( 1 );
		const [ url, opts ] = fetchMock.mock.calls[ 0 ];
		expect( url ).toBe( '/wp-json/newspack-nodes/v1/command' );
		expect( opts.method ).toBe( 'POST' );
		expect( opts.headers[ 'X-WP-Nonce' ] ).toBe( 'NONCE' );
		const arr = JSON.parse( opts.body );
		expect( Array.isArray( arr ) ).toBe( true );
		expect( arr.length ).toBe( 7 );
		expect( arr[ TYPE ] ).toBe( TM_PING );
		expect( arr[ FROM ] ).toBe( '_http/4242' );
		// Empty `to` → address the worker reader id directly (worker CI
		// handles ping locally, bouncing TO=FROM).
		expect( arr[ TO ] ).toBe( 'demo.p2' );
		expect( typeof arr[ TIMESTAMP ] ).toBe( 'number' );
		expect( arr[ KEY ] ).toBe( 'gui:typed' );
	} );

	it( 'info posts a TM_INFO array carrying arguments as VALUE at the worker path', async () => {
		await sendInterpretedCommand(
			{ type: 'info', to: 'firehose-in', arguments: 'hello' },
			ctx
		);
		const arr = JSON.parse( fetchMock.mock.calls[ 0 ][ 1 ].body );
		expect( arr[ TYPE ] ).toBe( TM_INFO );
		expect( arr[ TO ] ).toBe( 'demo.p2/firehose-in' );
		expect( arr[ VALUE ] ).toBe( 'hello' );
	} );

	it( 'bytestream posts a TM_BYTESTREAM array', async () => {
		await sendInterpretedCommand(
			{ type: 'bytestream', to: 'log-node', arguments: 'line\n' },
			ctx
		);
		const arr = JSON.parse( fetchMock.mock.calls[ 0 ][ 1 ].body );
		expect( arr[ TYPE ] ).toBe( TM_BYTESTREAM );
		expect( arr[ TO ] ).toBe( 'demo.p2/log-node' );
		expect( arr[ VALUE ] ).toBe( 'line\n' );
	} );

	it( 'eof posts a TM_EOF array with no VALUE', async () => {
		await sendInterpretedCommand( { type: 'eof', to: 'drain-node' }, ctx );
		const arr = JSON.parse( fetchMock.mock.calls[ 0 ][ 1 ].body );
		expect( arr[ TYPE ] ).toBe( TM_EOF );
		expect( arr[ TO ] ).toBe( 'demo.p2/drain-node' );
		expect( arr[ VALUE ] ).toBe( '' );
	} );

	it( 'request posts a TM_REQUEST array carrying arguments', async () => {
		await sendInterpretedCommand(
			{ type: 'request', to: 'consumer', arguments: 'GET_LAG' },
			ctx
		);
		const arr = JSON.parse( fetchMock.mock.calls[ 0 ][ 1 ].body );
		expect( arr[ TYPE ] ).toBe( TM_REQUEST );
		expect( arr[ TO ] ).toBe( 'demo.p2/consumer' );
		expect( arr[ VALUE ] ).toBe( 'GET_LAG' );
	} );

	it( 'returns the fetch JSON promise for typed posts', async () => {
		fetchMock.mockResolvedValueOnce( {
			json: () => Promise.resolve( { queued: true } ),
		} );
		const result = await sendInterpretedCommand(
			{ type: 'ping', to: '' },
			ctx
		);
		expect( result ).toEqual( { queued: true } );
	} );
} );
