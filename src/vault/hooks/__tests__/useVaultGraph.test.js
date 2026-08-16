/**
 * useVaultGraph tests — the Vault server-credential admin graph.
 *
 *   _http (HttpOut)
 *   vault:list:fetch → :in → :view (VaultListView)    — the credential table,
 *                                                       polled as a slice
 *   vault:{add,delete,test}:in → :result              — one one-shot per verb
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
import { TO, FROM, VALUE } from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { mountExospine } from '../../../runtime/exospine';
import { useNodeState } from '../../../runtime/react';
import { useVaultGraph } from '../useVaultGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const CONSOLE_TAP = '_shell';
const LIST_RECV = 'vault:list:in';
const LIST_VIEW = 'vault:list:view';
const ADD = 'vault:add:in';
const DELETE = 'vault:delete:in';
const TEST = 'vault:test:in';
const VERB_RECEIVERS = [ ADD, DELETE, TEST ];
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

	// ONE node per verb serves every row: the subject rides in the reply
	// PATH, not in the node name.
	test( 'mounts the backbone + _http + the table slice + one node per verb', async () => {
		installWire();
		renderHook( () => useVaultGraph() );
		await act( async () => {} );
		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
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

	test( 'returns the table plus the three CRUD callbacks', async () => {
		installWire();
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );
		expect( typeof result.current.addServer ).toBe( 'function' );
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

// @longform The subject rides in the ADDRESS. A test of `spoke-01` is minted
// FROM `vault:test:in/spoke-01`, the server echoes TO = FROM, the Router peels
// `vault:test:in` off, and the answer arrives there carrying `spoke-01`. So
// ONE node answers about every row — no id in the message, no table, and no
// node per row.
describe( 'useVaultGraph — the reply names the row it is about', () => {
	test( 'two servers tested at once each get their own answer', async () => {
		const answers = [];
		const wire = installWire( { list: {}, test: { ok: 1 } } );
		const { result } = renderHook( () =>
			useVaultGraph( {
				onAnswer: ( a ) => answers.push( a ),
			} )
		);
		await act( async () => {} );

		act( () => {
			result.current.testServer( 'spoke-01' );
			result.current.testServer( 'spoke-02' );
		} );

		await waitFor( () => expect( answers.length ).toBe( 2 ), {
			timeout: 8000,
		} );
		expect( answers.map( ( a ) => a.subject ).sort() ).toEqual( [
			'spoke-01',
			'spoke-02',
		] );
		expect( answers.every( ( a ) => 'test' === a.verb ) ).toBe( true );

		// Each command carried its own reply path; the ADDRESS is the whole
		// of the correlation.
		const from = wire.batches
			.flat()
			.filter( ( m ) => 'test' === m[ VALUE ]?.name )
			.map( ( m ) => m[ FROM ] );
		expect( from ).toEqual( [
			'vault:test:in/spoke-01',
			'vault:test:in/spoke-02',
		] );
	}, 30000 );
} );

// The screen asks WHICH verb a row waits on rather than keeping a flag beside
// every click: the outbox is the only thing that knows, and a flag goes stale
// the moment one path forgets to clear it.
describe( 'useVaultGraph — what a row is waiting on', () => {
	test( 'names the outstanding verb per subject, and nothing once answered', async () => {
		const held = [];
		installFakeCommandWire( ( m ) =>
			'list' === m[ VALUE ]?.name
				? {}
				: new Promise( ( resolve ) => held.push( resolve ) )
		);
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );

		expect( result.current.pendingVerb( 'spoke-01' ) ).toBeNull();

		act( () => result.current.testServer( 'spoke-01' ) );
		await waitFor( () =>
			expect( result.current.pendingVerb( 'spoke-01' ) ).toBe( 'test' )
		);
		// A different row is not waiting on anything.
		expect( result.current.pendingVerb( 'spoke-02' ) ).toBeNull();

		act( () => result.current.removeServer( 'spoke-02' ) );
		await waitFor( () =>
			expect( result.current.pendingVerb( 'spoke-02' ) ).toBe( 'delete' )
		);

		await act( async () => held.forEach( ( resolve ) => resolve( {} ) ) );
		await waitFor( () =>
			expect( result.current.pendingVerb( 'spoke-01' ) ).toBeNull()
		);
	}, 30000 );

	test( 'addServer sends the id positionally and the credentials as named args', async () => {
		const wire = installWire( { list: {}, add: { ok: 1 } } );
		const { result } = renderHook( () => useVaultGraph() );
		await act( async () => {} );

		act( () =>
			result.current.addServer( {
				id: 'spoke-04',
				url: 'https://d.example.test',
				auth_username: 'reader',
				auth_password: 'hunter2',
			} )
		);

		await waitForVerb( wire, 'add' );
		const add = findVerb( wire.batches, 'add' );
		expect( add[ VALUE ].arguments ).toEqual( [
			'spoke-04',
			'--url=https://d.example.test',
			'--auth_username=reader',
			'--auth_password=hunter2',
		] );
		expect( add[ FROM ] ).toBe( 'vault:add:in/spoke-04' );
	}, 30000 );
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
