/**
 * makeFakeCommandClient tests — the shared HttpOut-seam double the dashboard
 * hook tests duplicate: buildMessage mints a TM_COMMAND, postBatch echoes a
 * reply routed back along FROM carrying replyFor()'s payload + the correlation ID.
 */

import {
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
} from '@newspack-nodes/runtime';
import { makeFakeCommandClient } from '../fakeCommandClient';

describe( 'makeFakeCommandClient', () => {
	test( 'buildMessage mints a TM_COMMAND with the verb envelope', () => {
		const client = makeFakeCommandClient( () => null );
		const m = client.buildMessage( {
			to: '_http/restart',
			verb: 'restart',
			args: 'workers',
			payload: { a: 1 },
		} );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '_http/restart' );
		expect( m[ VALUE ] ).toEqual( {
			name: 'restart',
			arguments: 'workers',
			to: '_http/restart',
			payload: { a: 1 },
		} );
	} );

	test( "postBatch echoes a reply carrying replyFor()'s payload + correlation ID, routed along FROM", async () => {
		const replyFor = ( msg ) => ( { echoed: msg[ VALUE ].name } );
		const client = makeFakeCommandClient( replyFor );
		const m = client.buildMessage( { to: '_http/list', verb: 'list' } );
		m[ ID ] = 'op-7';
		m[ FROM ] = 'servers:view';

		const replies = await client.postBatch( [ m ] );
		expect( replies ).toHaveLength( 1 );
		const reply = replies[ 0 ];
		expect( reply[ TYPE ] ).toBe( TM_COMMAND | TM_RESPONSE );
		expect( reply[ TO ] ).toBe( 'servers:view' );
		expect( reply[ ID ] ).toBe( 'op-7' );
		expect( reply[ VALUE ] ).toEqual( {
			name: 'list',
			payload: { echoed: 'list' },
		} );
	} );
} );
