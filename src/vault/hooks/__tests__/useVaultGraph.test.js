/**
 * useVaultGraph tests — the Vault server-credential admin graph.
 *
 *   _http (HttpOut)
 *   vault:listIn (Tee) → vault:list (VaultListView)   — the credential table
 *   vault:add | vault:update | vault:delete | vault:test (Request)
 *
 * What every test here leans on: nothing correlates. Each verb is minted FROM
 * the node that wants its answer, the reply comes back TO = FROM, and it lands
 * there — so the table refresh and four awaited verbs are told apart by WHICH
 * NODE they arrive on. `message[ID]` and `message[KEY]` stay empty throughout,
 * which the mint assertions pin. `_http.client` is injected via
 * `opts.commandClient` so the hook never touches the network.
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	ID,
	KEY,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { mountExospine } from '../../../runtime/exospine';
import { useNodeState } from '../../../runtime/react';
import {
	formatCommandArgs,
	parseCommandArgs,
} from '../../../runtime/command-args';
import { useVaultGraph } from '../useVaultGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const CONSOLE_TAP = '_shell';
const LIST_RECV = 'vault:listIn';
const LIST_VIEW = 'vault:list';
const ADD = 'vault:add';
const UPDATE = 'vault:update';
const DELETE = 'vault:delete';
const TEST = 'vault:test';
const REQUEST_NAMES = [ ADD, UPDATE, DELETE, TEST ];
const ALL_GRAPH_NAMES = [ HTTP, LIST_RECV, LIST_VIEW, ...REQUEST_NAMES ];

// Fake transport: postBatch replies back along FROM, payload by verb.
function makeFakeClient( payloadByVerb = {}, opts = {} ) {
	const client = {
		batches: [],
		buildMessage( { to, verb, args = '' } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args };
			return m;
		},
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] =
					opts.errorVerbs &&
					opts.errorVerbs.includes( m[ VALUE ]?.name )
						? TM_COMMAND | TM_RESPONSE | TM_ERROR
						: TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ VALUE ] = {
					name: m[ VALUE ]?.name,
					payload:
						payloadByVerb[ m[ VALUE ]?.name ] ??
						payloadByVerb._default ??
						null,
				};
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return client;
}

beforeEach( () => {
	Core.reset();
} );

describe( 'useVaultGraph — exospine + per-concern view wiring', () => {
	test( 'routes Vault commands through the _shell Tap so they are observable via `connect _shell`', async () => {
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		// The mount list waits on the session; flush the /auth microtask.
		await act( async () => {} );
		// The mount-time list goes through _shell, so the Tap counts it.
		expect( Core.node( CONSOLE_TAP ).counter ).toBeGreaterThan( 0 );
	} );

	test( 'mounts the backbone + _http + the table edge + one node per awaited verb', () => {
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		for ( const name of ALL_GRAPH_NAMES ) {
			expect( Core.node( name ) ).toBeTruthy();
		}
		// The table edge sinks into the interpreter; a Request node routes
		// through `_shell` so `connect _shell` sees it.
		expect( Core.node( LIST_RECV ).sink ).toBe( interpreter );
		expect( Core.node( LIST_VIEW ).sink ).toBe( interpreter );
		for ( const name of REQUEST_NAMES ) {
			expect( Core.node( name ).sink ).toBe( Core.node( CONSOLE_TAP ) );
			expect( Core.node( name ).target ).toBe( `${ HTTP }/vault` );
		}
	} );

	test( 'the receiver Tee fans to exactly the list view', () => {
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		expect( Core.node( LIST_RECV ).target ).toEqual( [ LIST_VIEW ] );
	} );

	test( 'does NOT mount the old god vault:view or the REPL-only nodes', () => {
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		for ( const name of [
			'vault:view',
			'vault:testIn',
			'_output',
			'_completion',
			'_uptime',
			'_cwd',
		] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );

	test( '_http has the injected transport as its client', () => {
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'fires one immediate list() on mount, FROM the list receiver', async () => {
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		// The mount list waits on the session; flush the /auth microtask.
		await act( async () => {} );
		expect( client.batches.length ).toBeGreaterThanOrEqual( 1 );
		const msg = client.batches[ 0 ][ 0 ];
		expect( msg[ TO ] ).toBe( 'vault' );
		expect( msg[ FROM ] ).toBe( LIST_RECV );
		expect( msg[ VALUE ].name ).toBe( 'list' );
	} );

	test( 'returns the four CRUD callbacks', () => {
		const client = makeFakeClient();
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		expect( typeof result.current.addServer ).toBe( 'function' );
		expect( typeof result.current.updateServer ).toBe( 'function' );
		expect( typeof result.current.removeServer ).toBe( 'function' );
		expect( typeof result.current.testServer ).toBe( 'function' );
	} );
} );

describe( 'useVaultGraph — list lands in the list view', () => {
	test( 'an immediate list reply routes _http → interpreter → router → listIn → vault:list', async () => {
		const servers = {
			'spoke-01': { id: 'spoke-01', url: 'https://a' },
			'spoke-02': { id: 'spoke-02', url: 'https://b' },
		};
		const client = makeFakeClient( { list: servers } );
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		await act( async () => {} );

		const view = Core.node( LIST_VIEW );
		expect( view.setStateCache.view.servers ).toHaveLength( 2 );
		expect( view.setStateCache.view.servers.map( ( s ) => s.id ) ).toEqual(
			[ 'spoke-01', 'spoke-02' ]
		);
		expect( view.setStateCache.view.loading ).toBe( false );
		expect( view.setStateCache.view.error ).toBeNull();
	} );
} );

describe( 'useVaultGraph — each CRUD verb mints from its own node, then re-lists', () => {
	test( 'addServer dispatches an add command then re-lists', async () => {
		const client = makeFakeClient( {
			list: {},
			add: { id: 'spoke-01' },
		} );
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const listsBefore = countVerbs( client.batches, 'list' );

		let returned;
		await act( async () => {
			returned = await result.current.addServer( {
				id: 'spoke-01',
				url: 'https://x',
				auth_username: 'u',
				auth_password: 'p',
			} );
		} );

		expect( returned ).toEqual( { id: 'spoke-01' } );

		const add = findVerb( client.batches, 'add' );
		expect( add ).toBeTruthy();
		expect( add[ TO ] ).toBe( 'vault' );
		expect( add[ FROM ] ).toBe( ADD );
		expect( add[ ID ] ).toBe( '' );
		expect( add[ KEY ] ).toBe( '' );
		expect( add[ VALUE ].payload ).toBeUndefined();
		expect( add[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ], {
				url: 'https://x',
				auth_username: 'u',
				auth_password: 'p',
			} )
		);
		const addArgs = parseCommandArgs( add[ VALUE ].arguments );
		expect( addArgs.positional[ 0 ] ).toBe( 'spoke-01' );
		expect( addArgs.options.url ).toBe( 'https://x' );
		expect( addArgs.options.enabled ).toBeUndefined();

		const listsAfter = countVerbs( client.batches, 'list' );
		expect( listsAfter ).toBeGreaterThan( listsBefore );
	} );

	test( 'updateServer dispatches an update command then re-lists', async () => {
		const client = makeFakeClient( {
			list: {},
			update: { id: 'spoke-01' },
		} );
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const listsBefore = countVerbs( client.batches, 'list' );

		await act( async () => {
			await result.current.updateServer( 'spoke-01', {
				url: 'https://y',
			} );
		} );

		const update = findVerb( client.batches, 'update' );
		expect( update ).toBeTruthy();
		expect( update[ FROM ] ).toBe( UPDATE );
		expect( update[ ID ] ).toBe( '' );
		expect( update[ VALUE ].payload ).toBeUndefined();
		expect( update[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ], { url: 'https://y' } )
		);
		expect( countVerbs( client.batches, 'list' ) ).toBeGreaterThan(
			listsBefore
		);
	} );

	test( 'removeServer dispatches a delete command then re-lists', async () => {
		const client = makeFakeClient( {
			list: {},
			delete: { id: 'spoke-01' },
		} );
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const listsBefore = countVerbs( client.batches, 'list' );

		await act( async () => {
			await result.current.removeServer( 'spoke-01' );
		} );

		const del = findVerb( client.batches, 'delete' );
		expect( del ).toBeTruthy();
		expect( del[ FROM ] ).toBe( DELETE );
		expect( del[ ID ] ).toBe( '' );
		expect( del[ VALUE ].payload ).toBeUndefined();
		expect( del[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ] )
		);
		expect( countVerbs( client.batches, 'list' ) ).toBeGreaterThan(
			listsBefore
		);
	} );
} );

describe( 'useVaultGraph — the probe is its own node', () => {
	test( 'testServer mints FROM vault:test, resolves to the probe, and does not re-list', async () => {
		const probe = { id: 'spoke-01', status: 'connected', response: {} };
		const client = makeFakeClient( {
			list: {},
			test: probe,
		} );
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const listsBefore = countVerbs( client.batches, 'list' );

		let returned;
		await act( async () => {
			returned = await result.current.testServer( 'spoke-01' );
		} );

		const t = findVerb( client.batches, 'test' );
		expect( t ).toBeTruthy();
		expect( t[ FROM ] ).toBe( TEST );
		expect( t[ ID ] ).toBe( '' );
		expect( t[ KEY ] ).toBe( '' );
		expect( t[ VALUE ].payload ).toBeUndefined();
		expect( t[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ] )
		);
		expect( returned ).toEqual( probe );

		// test is read-only — no re-list, and the list view never saw it.
		expect( countVerbs( client.batches, 'list' ) ).toBe( listsBefore );
	} );
} );

describe( 'useVaultGraph — errors reject to the caller per concern', () => {
	test( 'a failed addServer rejects without polluting the list-view banner', async () => {
		const client = makeFakeClient(
			{ list: {}, add: 'duplicate id' },
			{ errorVerbs: [ 'add' ] }
		);
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		await act( async () => {} );

		await act( async () => {
			await expect(
				result.current.addServer( {
					id: 'dup',
					url: 'https://x',
					auth_username: 'u',
					auth_password: 'p',
				} )
			).rejects.toThrow( 'duplicate id' );
		} );
		expect( Core.node( LIST_VIEW ).setStateCache.view.error ).toBeNull();
	} );

	test( 'a failed testServer rejects, and the table banner stays clean', async () => {
		const client = makeFakeClient(
			{ list: {}, test: 'unauthorized' },
			{ errorVerbs: [ 'test' ] }
		);
		const { result } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		await act( async () => {} );

		await act( async () => {
			await expect(
				result.current.testServer( 'spoke-01' )
			).rejects.toThrow( 'unauthorized' );
		} );
		expect( Core.node( LIST_VIEW ).setStateCache.view.error ).toBeNull();
	} );
} );

describe( 'useVaultGraph — teardown', () => {
	test( 'unmount unregisters every graph node + the backbone', () => {
		const client = makeFakeClient();
		const { unmount } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		unmount();
		for ( const name of [ ...ALL_GRAPH_NAMES, INTERPRETER, ROUTER ] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );

	test( 'a reply resolving after unmount does not throw (sink may be gone)', async () => {
		let resolveReply;
		const client = {
			batches: [],
			buildMessage: ( { to, verb } ) => {
				const m = newMessage();
				m[ TYPE ] = TM_COMMAND;
				m[ TO ] = to;
				m[ VALUE ] = { name: verb, arguments: '' };
				return m;
			},
			postBatch( messages ) {
				client.batches.push( messages );
				return new Promise( ( res ) => {
					resolveReply = ( replies ) => res( replies );
				} );
			},
		};
		const { unmount } = renderHook( () =>
			useVaultGraph( { commandClient: client } )
		);
		// The mount list waits on the session; let it POST before unmounting.
		await act( async () => {} );
		unmount();
		expect( () => {
			const reply = newMessage();
			reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			reply[ VALUE ] = { name: 'list', payload: {} };
			resolveReply( [ reply ] );
		} ).not.toThrow();
		await Promise.resolve();
	} );
} );

describe( 'useVaultGraph — graphGeneration Reset Graph', () => {
	test( 'a graphGeneration bump rebuilds the per-concern nodes fresh (backbone preserved)', async () => {
		// Overlay owns the backbone; this dashboard is a reused mount. A bump (the
		// real Reset Graph trigger) fires its spine.reinit — soft nodes only.
		mountExospine();
		const client = makeFakeClient();
		renderHook( () => useVaultGraph( { commandClient: client } ) );
		await act( async () => {} );
		const firstList = Core.node( LIST_VIEW );
		const firstHttp = Core.node( HTTP );
		const backbone = Core.node( INTERPRETER );
		expect( firstList ).not.toBeNull();

		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		expect( Core.node( LIST_VIEW ) ).not.toBe( firstList );
		// _http is a backbone singleton: kept across rebuild, client reset.
		expect( Core.node( HTTP ) ).toBe( firstHttp );
		expect( Core.node( HTTP ).client ).toBe( client );
		expect( Core.node( LIST_VIEW ).sink ).toBe( Core.node( INTERPRETER ) );
		expect( Core.node( INTERPRETER ) ).toBe( backbone );
	} );

	test( 'a graphGeneration bump re-renders the consumer so useNodeState re-subscribes to the fresh list view', async () => {
		mountExospine();
		const client = makeFakeClient();
		const { result } = renderHook( () => {
			useVaultGraph( { commandClient: client } );
			return useNodeState( LIST_VIEW, 'view' );
		} );
		await act( async () => {} );
		const firstView = Core.node( LIST_VIEW );

		await act( async () => {
			Core.bumpGraphGeneration();
		} );
		const freshView = Core.node( LIST_VIEW );
		expect( freshView ).not.toBe( firstView );

		act( () => {
			freshView.setState( 'view', { servers: [ 'sentinel' ] } );
		} );
		expect( result.current ).toEqual( { servers: [ 'sentinel' ] } );
	} );
} );

// Helpers — iterate the recorded batches for a verb-bearing message.
function findVerb( batches, verb ) {
	for ( const batch of batches ) {
		for ( const m of batch ) {
			if ( m[ VALUE ]?.name === verb ) {
				return m;
			}
		}
	}
	return null;
}

function countVerbs( batches, verb ) {
	let count = 0;
	for ( const batch of batches ) {
		for ( const m of batch ) {
			if ( m[ VALUE ]?.name === verb ) {
				count += 1;
			}
		}
	}
	return count;
}
