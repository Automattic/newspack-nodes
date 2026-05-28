/**
 * workerstatus:poll tests — the ingest node that owns the `dump_metadata` poll
 * and the `restart` command, behind an injectable command-client seam
 * (`opts.commandClient`). The interval timer + page-visibility live in the hook,
 * NOT this node; the node just exposes `poll()` / `restart(type)`.
 *
 * The fake client records every `send()` and resolves a `{ name, payload }`
 * Message so the REAL unwrapCommandResponse extracts the payload — no network,
 * no getCommandClient. Mirrors the rawLogsStream connector-seam tests.
 */

import {
	VALUE,
	TO,
	TYPE,
	TM_STRUCT,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { createWorkerStatusPoll } from '../workerStatusPoll';

// setName registers in the per-process Core registry; clear it between tests so
// re-creating the same-named node doesn't collide (matches the sibling tests).
beforeEach( () => Core.reset() );

// A fake command client: records each send() and resolves a reply whose VALUE is
// the { name, payload } shape unwrapCommandResponse reads (message[VALUE].payload).
function makeFakeClient( payload ) {
	return {
		calls: [],
		send( req ) {
			this.calls.push( req );
			const m = newMessage();
			m[ VALUE ] = { name: req.verb, payload };
			return Promise.resolve( m );
		},
	};
}

// A fake client whose send() always rejects (transport down / restart failure).
function makeRejectingClient( err ) {
	return {
		calls: [],
		send( req ) {
			this.calls.push( req );
			return Promise.reject( err );
		},
	};
}

// A fake client whose send() returns a manually-resolvable promise, so a test can
// drive a reply that lands AFTER close() — the in-flight cancel scenario.
function makeDeferredClient( payload ) {
	let resolveSend;
	return {
		calls: [],
		resolve: () => resolveSend(),
		send( req ) {
			this.calls.push( req );
			return new Promise( ( resolve ) => {
				resolveSend = () => {
					const m = newMessage();
					m[ VALUE ] = { name: req.verb, payload };
					resolve( m );
				};
			} );
		},
	};
}

// Capture sink.
function capture() {
	const got = [];
	return { node: { fill: ( m ) => got.push( m ) }, got };
}

describe( 'workerstatus:poll — poll()', () => {
	test( 'sends dump_metadata to workers', async () => {
		const client = makeFakeClient( { workers: [] } );
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		await p.poll();
		expect( client.calls ).toEqual( [
			{ to: 'workers', verb: 'dump_metadata' },
		] );
	} );

	test( 'emits the unwrapped metadata as a TM_STRUCT { action:"metadata", metadata }', async () => {
		const meta = { workers: [ { type: 'firehose-workers' } ], logs: [] };
		const client = makeFakeClient( meta );
		const sink = capture();
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		p.sink = sink.node;
		p.target = 'workerstatus:transform';
		await p.poll();
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		// Rule #2: the emit stamps TO=target so the router can route it.
		expect( sink.got[ 0 ][ TO ] ).toBe( 'workerstatus:transform' );
		expect( sink.got[ 0 ][ VALUE ] ).toEqual( {
			action: 'metadata',
			metadata: meta,
		} );
	} );

	test( 'emits an error control when the poll send rejects', async () => {
		const client = makeRejectingClient( new Error( 'boom' ) );
		const sink = capture();
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		p.sink = sink.node;
		p.target = 'workerstatus:transform';
		await p.poll();
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		// The error control is stamped to the same target as metadata.
		expect( sink.got[ 0 ][ TO ] ).toBe( 'workerstatus:transform' );
		expect( sink.got[ 0 ][ VALUE ].action ).toBe( 'error' );
		expect( sink.got[ 0 ][ VALUE ].error ).toMatch( /disconnect/i );
	} );

	test( 'does not throw with no sink', async () => {
		const client = makeFakeClient( { workers: [] } );
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		await expect( p.poll() ).resolves.not.toThrow();
	} );
} );

describe( 'workerstatus:poll — restart()', () => {
	test( 'sends restart with the type and partition -1', async () => {
		const client = makeFakeClient( {} );
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		await p.restart( 'firehose-workers' );
		expect( client.calls ).toEqual( [
			{
				to: 'workers',
				verb: 'restart',
				payload: { types: [ 'firehose-workers' ], partition: -1 },
			},
		] );
	} );

	test( 'emits an error control when the restart send rejects', async () => {
		const client = makeRejectingClient( new Error( 'nope' ) );
		const sink = capture();
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		p.sink = sink.node;
		await p.restart( 'firehose-workers' );
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ VALUE ].action ).toBe( 'error' );
		expect( sink.got[ 0 ][ VALUE ].error ).toMatch( /restart/i );
	} );
} );

describe( 'workerstatus:poll — close() in-flight cancel guard', () => {
	test( 'poll() does not emit when close() runs before the send resolves', async () => {
		const client = makeDeferredClient( { workers: [] } );
		const sink = capture();
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		p.sink = sink.node;
		const pending = p.poll();
		// Teardown while the send is still in flight, then let it resolve.
		p.close();
		client.resolve();
		await pending;
		expect( sink.got ).toHaveLength( 0 );
	} );

	test( 'restart() does not emit when close() runs before the send rejects', async () => {
		const client = makeRejectingClient( new Error( 'nope' ) );
		const sink = capture();
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: client,
		} );
		p.sink = sink.node;
		p.close();
		await p.restart( 'firehose-workers' );
		expect( sink.got ).toHaveLength( 0 );
	} );

	test( 'close() is idempotent / safe to call without a sink', () => {
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: makeFakeClient( {} ),
		} );
		expect( () => {
			p.close();
			p.close();
		} ).not.toThrow();
	} );
} );

describe( 'workerstatus:poll — node wiring', () => {
	test( 'names the node', () => {
		const p = createWorkerStatusPoll( 'workerstatus:poll', {
			commandClient: makeFakeClient( {} ),
		} );
		expect( p.name ).toBe( 'workerstatus:poll' );
	} );
} );
