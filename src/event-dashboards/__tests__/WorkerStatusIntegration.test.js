/**
 * WorkerStatus integration test — the REAL workerstatus graph driving the REAL
 * thin view. Only the I/O boundary is faked (a CommandClient double assigned to
 * `_http.client` via the hook's `commandClient` opt); the transform, view, hook
 * and the React surface are all real.
 *
 * This is the regression guard for the useNodeState-after-mount timing: the view
 * node is created in the hook's mount effect (after the first render), and the
 * async poll publishes its model before any React render has subscribed. Unless
 * the hook forces a re-render once the graph is mounted, React never picks up
 * the first model and the dashboard stays stuck on the loading placeholder.
 * Worker Status has no rAF to mask this (unlike Raw Logs), so it must be
 * handled here.
 *
 * Post-migration to substrate `_http`, the dashboard's I/O surface is a
 * CommandClient (postBatch returns reply Messages with TO=FROM, VALUE.payload =
 * the metadata snapshot); there's no `getCommandClient` / `unwrapCommandResponse`
 * to mock — the substrate's HttpOut → router → transform → view does it all.
 */

import { render, act } from '@testing-library/react';
import {
	newMessage,
	TYPE,
	TO,
	ID,
	FROM,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../../runtime/message';
import { Core } from '../../runtime/core';

jest.mock( '../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

// WorkerStatus reads opts.commandClient through useWorkerStatusGraph; route the
// production WorkerStatus component's `useWorkerStatusGraph()` call through one
// hook-instance with the fake client by mocking the wrapper.
// `mock*` prefix is the only outer-scope variable jest.mock factory may
// reference (the precaution against uninitialized mocks).
let mockActiveClient = null;
jest.mock( '../hooks/useWorkerStatusGraph', () => {
	const actual = jest.requireActual( '../hooks/useWorkerStatusGraph' );
	return {
		__esModule: true,
		initialRefresh: actual.initialRefresh,
		REFRESH_OPTIONS: actual.REFRESH_OPTIONS,
		useWorkerStatusGraph: ( opts = {} ) =>
			actual.useWorkerStatusGraph( {
				...opts,
				commandClient: mockActiveClient,
			} ),
	};
} );

// CommandClient double mirroring HttpOut's seam: postBatch returns reply
// Messages addressed back along FROM. Pulled to module scope so individual
// tests can override per-verb payloads / errors.
function makeFakeClient( payloadByVerb = {}, opts = {} ) {
	const client = {
		buildMessage( { to, verb, args = '' } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args };
			return m;
		},
		postBatch( messages ) {
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

import WorkerStatus from '../WorkerStatus';

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
	mockActiveClient = null;
} );

describe( 'WorkerStatus integration (real graph)', () => {
	it( 'leaves the loading gate once the first dump_graph model is published', async () => {
		mockActiveClient = makeFakeClient( {
			dump_graph: {
				workers: [],
				supervisor: null,
				logs: [],
				segment_size: 1024,
				timestamp: 0,
			},
		} );

		const { container } = render( <WorkerStatus fullPage /> );
		// Let the mount poll resolve and the model flow _http → transform → view.
		await act( async () => {} );

		// The real graph delivered the model to React: no loading placeholder, and
		// the rendered chrome is present.
		expect( container.textContent ).not.toMatch( /Loading worker status/ );
		expect(
			container.querySelector( '.worker-status-header' )
		).not.toBeNull();
		expect(
			container.querySelector( '.topology-sections' )
		).not.toBeNull();
	} );

	it( 'renders worker rows from a real dump_graph response', async () => {
		mockActiveClient = makeFakeClient( {
			dump_graph: {
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [],
						inputs_status: [],
						outputs_status: [],
					},
				],
				supervisor: null,
				logs: [],
				graph: {
					'firehose-workers': {
						nodes: [ { name: 'firehose-workers', kind: 'logic' } ],
						edges: [],
					},
				},
			},
		} );

		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Firehose Workers/ );
	} );

	it( 'surfaces a disconnect error when the real poll reply carries TM_ERROR', async () => {
		mockActiveClient = makeFakeClient(
			{ dump_graph: 'Server disconnected' },
			{ errorVerbs: [ 'dump_graph' ] }
		);

		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Server disconnected/ );
	} );

	it( 'renders one section per topology, keeps the supervisor, and preserves a seeded behind/segment datum', async () => {
		mockActiveClient = makeFakeClient( {
			dump_graph: {
				supervisor: {
					type: 'supervisor',
					status: 'running',
					started_at: 1000,
					heartbeat_age: 2,
					restart_pending: false,
				},
				workers: [
					{
						type: 'firehose-workers',
						handler: 'firehose-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						behind: 2 * 1024 * 1024,
						inputs: [],
						outputs: [ 'firehose.log' ],
						inputs_status: [],
						outputs_status: [],
					},
					{
						type: 'request-workers',
						handler: 'request-workers',
						partition: 0,
						started_at: 1000,
						status: 'running',
						inputs: [],
						outputs: [ 'requests.log' ],
						inputs_status: [],
						outputs_status: [],
					},
				],
				logs: [
					{
						name: 'firehose.log',
						partitions: [
							{
								partition: 0,
								segments: [ { id: 1, size: 100 } ],
								total_size: 100,
							},
						],
					},
					{
						name: 'requests.log',
						partitions: [
							{ partition: 0, segments: [], total_size: 0 },
						],
					},
				],
				// Two topologies, each a realistic consumer → logic → partition
				// chain. Structure now comes from the graph; the consumer/partition
				// vertices collapse to their logs (their node-names must NOT survive).
				graph: {
					'firehose-workers': {
						nodes: [
							{
								name: 'fh-source',
								kind: 'consumer',
								reads: 'source.log',
							},
							{ name: 'firehose-workers', kind: 'logic' },
							{
								name: 'fh-partition',
								kind: 'partition',
								writes: 'firehose.log',
							},
						],
						edges: [
							[ 'fh-source', 'firehose-workers' ],
							[ 'firehose-workers', 'fh-partition' ],
						],
					},
					'request-workers': {
						nodes: [
							{
								name: 'rq-consumer',
								kind: 'consumer',
								reads: 'firehose.log',
							},
							{ name: 'request-workers', kind: 'logic' },
							{
								name: 'rq-partition',
								kind: 'partition',
								writes: 'requests.log',
							},
						],
						edges: [
							[ 'rq-consumer', 'request-workers' ],
							[ 'request-workers', 'rq-partition' ],
						],
					},
				},
			},
		} );

		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );

		// Two topologies → two sections; supervisor card intact.
		expect( container.querySelectorAll( '.topology-section' ).length ).toBe(
			2
		);
		expect(
			container.querySelector( '.supervisor-section' )
		).not.toBeNull();
		// The producer's log + its segment survived the transform → view → render path.
		expect( container.textContent ).toMatch( /firehose\.log/ );
		expect( container.querySelector( '.worker-segment-h' ) ).not.toBeNull();
		// The seeded behind datum is rendered on the firehose node row.
		expect( container.querySelector( '.connector-behind' ) ).not.toBeNull();
		// The consumer/partition vertices collapsed to their logs — their raw
		// node-names never reach the DOM.
		expect( container.textContent ).not.toMatch( /fh-partition/ );
		expect( container.textContent ).not.toMatch( /rq-consumer/ );
	} );
} );
