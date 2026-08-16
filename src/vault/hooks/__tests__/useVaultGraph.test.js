/**
 * useVaultGraph tests — the Vault server-credential admin graph.
 *
 *   _http (HttpOut)
 *   vault:list:fetch → :in → :view (VaultListView)    — the credential table,
 *                                                       polled as a slice
 *   vault:{add,update,delete,test}:in → :result       — one one-shot per verb
 *
 * What every test here leans on: nothing correlates. Each verb is minted FROM
 * the node that wants its answer, the reply comes back TO = FROM, and it lands
 * there — so the table refresh and four verbs are told apart by WHICH NODE
 * they arrive on. `message[ID]` and `message[KEY]` stay empty throughout,
 * which the mint assertions pin. Nothing is injected: the seam is `fetch`, so
 * HttpOut, pack/unpack, the router and the interpreter all run for real.
 *
 * Every verb rides the router tick, so a dispatch is a WAIT, not a flush.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { ID, KEY, TO, FROM, VALUE } from '../../../runtime/message';
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
const LIST_RECV = 'vault:list:in';
const LIST_VIEW = 'vault:list:view';
const ADD = 'vault:add:in';
const UPDATE = 'vault:update:in';
const DELETE = 'vault:delete:in';
const TEST = 'vault:test:in';
const VERB_RECEIVERS = [ ADD, UPDATE, DELETE, TEST ];
const ALL_GRAPH_NAMES = [ HTTP, LIST_RECV, LIST_VIEW, ...VERB_RECEIVERS ];

// A verb's command is on the wire within a tick of the click.
const waitForVerb = ( wire, verb ) =>
	waitFor( () => expect( findVerb( wire.batches, verb ) ).toBeTruthy(), {
		timeout: 6000,
	} );

// The seam is the WIRE: the graph packs, POSTs and unpacks for real, so
// HttpOut, the router and the interpreter all run. `wire.batches` is what was
// posted; a verb in `errorVerbs` answers TM_ERROR carrying its payload.
function installWire( payloadByVerb = {}, opts = {} ) {
	return installFakeCommandWire( ( m ) => {
		const name = m[ VALUE ]?.name;
		const payload = payloadByVerb[ name ] ?? payloadByVerb._default ?? null;
		return opts.errorVerbs?.includes( name )
			? new Error( payload ?? name )
			: payload;
	} );
}

beforeEach( () => {
	Core.reset();
} );

describe( 'useVaultGraph — exospine + per-concern view wiring', () => {
	test( 'routes Vault commands through the _shell Tap so they are observable via `connect _shell`', async () => {
		installWire();
		renderHook( () => useVaultGraph() );
		// The table's own poll goes through _shell, so the Tap counts it.
		await waitFor(
			() =>
				expect( Core.node( CONSOLE_TAP ).counter ).toBeGreaterThan( 0 ),
			{ timeout: 6000 }
		);
	} );

	test( 'mounts the backbone + _http + the table slice + one node per verb', async () => {
		installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		for ( const name of ALL_GRAPH_NAMES ) {
			expect( Core.node( name ) ).toBeTruthy();
		}
		// Everything sinks into the interpreter; every Fetcher — the table's
		// included — reaches `_shell` as a TARGET hop, so `connect _shell`
		// still sees the lot.
		expect( Core.node( LIST_RECV ).sink ).toBe( interpreter );
		expect( Core.node( LIST_VIEW ).sink ).toBe( interpreter );
		for ( const name of [ ...VERB_RECEIVERS, LIST_RECV ] ) {
			expect( Core.node( name ).sink ).toBe( interpreter );
			const fetcher = name.replace( /:in$/, ':fetch' );
			expect( Core.node( fetcher ).target ).toBe(
				`${ CONSOLE_TAP }/${ HTTP }/vault`
			);
		}
	} );

	test( 'the table receiver fans to exactly the list view', async () => {
		installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
		expect( Core.node( LIST_RECV ).target ).toEqual( [ LIST_VIEW ] );
	} );

	test( 'does NOT mount the old god vault:view or the REPL-only nodes', async () => {
		installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
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

	test( '_http reaches the wire with nothing injected', async () => {
		const wire = installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
		// HttpOut defaults its own client lazily, at the first post — so the
		// POST landing is the proof, not a client set at mount time.
		expect( wire.batches.flat() ).not.toHaveLength( 0 );
	} );

	// The table is the poll's first load, so it arrives without anyone asking
	// and keeps arriving — which is what makes a refused tick recoverable.
	test( 'lists on the first tick, FROM the table receiver', async () => {
		const wire = installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
		await waitForVerb( wire, 'list' );
		const msg = findVerb( wire.batches, 'list' );
		expect( msg[ TO ] ).toBe( 'vault' );
		expect( msg[ FROM ] ).toBe( LIST_RECV );
	} );

	test( 'returns the four CRUD callbacks', async () => {
		installWire();
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );
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
		installWire( { list: servers } );
		renderHook( () => useVaultGraph() );
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
		const wire = installWire( {
			list: {},
			add: { id: 'spoke-01' },
		} );
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const listsBefore = countVerbs( wire.batches, 'list' );

		act( () => {
			result.current.addServer( {
				id: 'spoke-01',
				url: 'https://x',
				auth_username: 'u',
				auth_password: 'p',
			} );
		} );
		await waitForVerb( wire, 'add' );

		const add = findVerb( wire.batches, 'add' );
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

		await waitFor(
			() =>
				expect( countVerbs( wire.batches, 'list' ) ).toBeGreaterThan(
					listsBefore
				),
			{ timeout: 6000 }
		);
	}, 15000 );

	test( 'updateServer dispatches an update command then re-lists', async () => {
		const wire = installWire( {
			list: {},
			update: { id: 'spoke-01' },
		} );
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const listsBefore = countVerbs( wire.batches, 'list' );

		act( () => {
			result.current.updateServer( 'spoke-01', { url: 'https://y' } );
		} );
		await waitForVerb( wire, 'update' );

		const update = findVerb( wire.batches, 'update' );
		expect( update ).toBeTruthy();
		expect( update[ FROM ] ).toBe( UPDATE );
		expect( update[ ID ] ).toBe( '' );
		expect( update[ VALUE ].payload ).toBeUndefined();
		expect( update[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ], { url: 'https://y' } )
		);
		await waitFor(
			() =>
				expect( countVerbs( wire.batches, 'list' ) ).toBeGreaterThan(
					listsBefore
				),
			{ timeout: 6000 }
		);
	}, 15000 );

	test( 'removeServer dispatches a delete command then re-lists', async () => {
		const wire = installWire( {
			list: {},
			delete: { id: 'spoke-01' },
		} );
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const listsBefore = countVerbs( wire.batches, 'list' );

		act( () => {
			result.current.removeServer( 'spoke-01' );
		} );
		await waitForVerb( wire, 'delete' );

		const del = findVerb( wire.batches, 'delete' );
		expect( del ).toBeTruthy();
		expect( del[ FROM ] ).toBe( DELETE );
		expect( del[ ID ] ).toBe( '' );
		expect( del[ VALUE ].payload ).toBeUndefined();
		expect( del[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ] )
		);
		await waitFor(
			() =>
				expect( countVerbs( wire.batches, 'list' ) ).toBeGreaterThan(
					listsBefore
				),
			{ timeout: 6000 }
		);
	}, 15000 );
} );

describe( 'useVaultGraph — the probe is its own node', () => {
	test( 'testServer mints FROM vault:test, resolves to the probe, and does not re-list', async () => {
		const probe = { id: 'spoke-01', status: 'connected', response: {} };
		const wire = installWire( {
			list: {},
			test: probe,
		} );
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const listsBefore = countVerbs( wire.batches, 'list' );

		act( () => {
			result.current.testServer( 'spoke-01' );
		} );
		await waitForVerb( wire, 'test' );

		const t = findVerb( wire.batches, 'test' );
		expect( t ).toBeTruthy();
		expect( t[ FROM ] ).toBe( TEST );
		expect( t[ ID ] ).toBe( '' );
		expect( t[ KEY ] ).toBe( '' );
		expect( t[ VALUE ].payload ).toBeUndefined();
		expect( t[ VALUE ].arguments ).toEqual(
			formatCommandArgs( [ 'spoke-01' ] )
		);
		// The answer names the server, so the row can ask whether it is its own.
		await waitFor(
			() =>
				expect( result.current.answerFor( 'spoke-01' )?.busy ).toBe(
					false
				),
			{ timeout: 6000 }
		);

		// test is read-only — no re-list, and the list view never saw it.
		expect( countVerbs( wire.batches, 'list' ) ).toBe( listsBefore );
	}, 15000 );
} );

describe( 'useVaultGraph — errors reject to the caller per concern', () => {
	test( 'a failed addServer rejects without polluting the list-view banner', async () => {
		installWire(
			{ list: {}, add: 'duplicate id' },
			{ errorVerbs: [ 'add' ] }
		);
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );

		act( () => {
			result.current.addServer( {
				id: 'dup',
				url: 'https://x',
				auth_username: 'u',
				auth_password: 'p',
			} );
		} );

		// The refusal is published on the add's own result, not thrown.
		await waitFor(
			() =>
				expect( result.current.answerFor( 'dup' )?.error ).toContain(
					'duplicate id'
				),
			{ timeout: 6000 }
		);
		expect( Core.node( LIST_VIEW ).setStateCache.view.error ).toBeNull();
	}, 15000 );

	test( 'a failed testServer rejects, and the table banner stays clean', async () => {
		installWire(
			{ list: {}, test: 'unauthorized' },
			{ errorVerbs: [ 'test' ] }
		);
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );

		act( () => {
			result.current.testServer( 'spoke-01' );
		} );

		await waitFor(
			() =>
				expect(
					result.current.answerFor( 'spoke-01' )?.error
				).toContain( 'unauthorized' ),
			{ timeout: 6000 }
		);
		expect( Core.node( LIST_VIEW ).setStateCache.view.error ).toBeNull();
	}, 15000 );
} );

// Two verbs answer about the SAME server, and the row shows one status line.
// Whichever was asked LAST is the one it must show — a fixed spread order shows
// whichever verb happens to be last in the merge instead.
describe( 'useVaultGraph — one row, four verbs, one answer', () => {
	test( 'a later verb supersedes an earlier answer about the same server', async () => {
		installWire( { list: {}, test: { id: 'spoke-01' } } );
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );

		act( () => result.current.testServer( 'spoke-01' ) );
		await waitFor(
			() =>
				expect( result.current.answerFor( 'spoke-01' )?.verb ).toBe(
					'test'
				),
			{ timeout: 6000 }
		);

		// Removing the SAME server must take the row over immediately.
		await act( async () => {
			result.current.removeServer( 'spoke-01' );
		} );
		expect( result.current.answerFor( 'spoke-01' ) ).toMatchObject( {
			verb: 'delete',
		} );
	}, 20000 );
} );

describe( 'useVaultGraph — teardown', () => {
	test( 'unmount unregisters every graph node + the backbone', () => {
		installWire();
		const { unmount } = renderHook( () => useVaultGraph() );
		unmount();
		// The ROUTER is the page's heartbeat and is never torn down.
		for ( const name of [ ...ALL_GRAPH_NAMES, INTERPRETER ] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );

	test( 'a reply resolving after unmount does not throw (sink may be gone)', async () => {
		let resolveReply;
		// replyFor may return a promise, and answerBatch awaits it — so the
		// reply lands whenever this resolves, which here is after unmount.
		installFakeCommandWire(
			() => new Promise( ( res ) => ( resolveReply = res ) )
		);
		const { unmount } = renderHook( () => useVaultGraph() );
		// The mount list waits on the session; let it POST before unmounting.
		await act( async () => {} );
		unmount();
		expect( () => resolveReply( {} ) ).not.toThrow();
		await Promise.resolve();
	} );
} );

describe( 'useVaultGraph — graphGeneration Reset Graph', () => {
	test( 'a graphGeneration bump rebuilds the per-concern nodes fresh (backbone preserved)', async () => {
		// Overlay owns the backbone; this dashboard is a reused mount. A bump (the
		// real Reset Graph trigger) fires its spine.reinit — soft nodes only.
		mountExospine();
		installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const firstList = Core.node( LIST_VIEW );
		const firstHttp = Core.node( HTTP );
		const backbone = Core.node( INTERPRETER );
		expect( firstList ).not.toBeNull();

		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		expect( Core.node( LIST_VIEW ) ).not.toBe( firstList );
		// _http is a backbone singleton: the same node across the rebuild.
		expect( Core.node( HTTP ) ).toBe( firstHttp );
		expect( Core.node( HTTP ).client ).toBeTruthy();
		expect( Core.node( LIST_VIEW ).sink ).toBe( Core.node( INTERPRETER ) );
		expect( Core.node( INTERPRETER ) ).toBe( backbone );
	} );

	test( 'a graphGeneration bump re-renders the consumer so useNodeState re-subscribes to the fresh list view', async () => {
		mountExospine();
		installWire();
		const { result } = renderHook( () => {
			useVaultGraph();
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
