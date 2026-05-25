/**
 * useRawLogsGraph tests — the Raw Logs dashboard graph (Task 4 of the JS-Node
 * conversion). The three nodes (`rawlogs/stream`, `rawlogs/transform`,
 * `rawlogs/view`) are REAL (their factories register them in Core); only the
 * stream's connector and the `list_logs` command client are injected so the
 * hook never touches a real EventSource or the network. Mirrors the seam
 * useConsoleGraph's tests use (real graph, faked I/O boundaries).
 */

import { renderHook, act } from '@testing-library/react';
import { newMessage, VALUE } from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { useRawLogsGraph } from '../useRawLogsGraph';

beforeEach( () => Core.reset() );

// A fake connector matching the stream node's seam (connect/close); records the
// last subscription so a test can assert the stream re-connects. Mirrors the
// rawLogsStream.test double, plus closeCount for the teardown assertion.
function makeFakeConnector() {
	return {
		closeCount: 0,
		lastSubscription: null,
		_onEnvelope: null,
		connect( subscription, onEnvelope ) {
			this.lastSubscription = subscription;
			this._onEnvelope = onEnvelope;
		},
		close() {
			this.closeCount += 1;
			this._onEnvelope = null;
		},
	};
}

// A command reply Message: VALUE rides as the { name, payload } object that
// unwrapCommandResponse reads (message[VALUE].payload). `payload` is the verb's
// return — here the `list_logs` `[{key,label}]` array.
function commandReply( payload ) {
	const m = newMessage();
	m[ VALUE ] = { name: 'list_logs', payload };
	return m;
}
const emptyReply = () => commandReply( [] );
const oneLogReply = () =>
	commandReply( [ { key: 'firehose', label: 'firehose.log' } ] );

describe( 'useRawLogsGraph — mount + wiring', () => {
	test( 'mounts the three nodes wired stream→transform→view', async () => {
		const fakeClient = { send: async () => oneLogReply() };
		const fake = makeFakeConnector();
		renderHook( () =>
			useRawLogsGraph( { connector: fake, commandClient: fakeClient } )
		);
		await act( async () => {} ); // let list_logs resolve

		expect( Core.node( 'rawlogs/stream' ) ).toBeTruthy();
		expect( Core.node( 'rawlogs/transform' ) ).toBeTruthy();
		expect( Core.node( 'rawlogs/view' ) ).toBeTruthy();
		expect( Core.node( 'rawlogs/stream' ).sink ).toBe(
			Core.node( 'rawlogs/transform' )
		);
		expect( Core.node( 'rawlogs/transform' ).sink ).toBe(
			Core.node( 'rawlogs/view' )
		);
		// list_logs flowed in: the view cached one log.
		expect(
			Core.node( 'rawlogs/view' ).setStateCache.view.logs
		).toHaveLength( 1 );
	} );

	test( 'subscribes the stream to the default-selected log after list_logs', async () => {
		const fakeClient = { send: async () => oneLogReply() };
		const fake = makeFakeConnector();
		renderHook( () =>
			useRawLogsGraph( { connector: fake, commandClient: fakeClient } )
		);
		await act( async () => {} );
		// The view defaults selection to logs[0].key; the stream subscribes to it.
		expect( fake.lastSubscription ).toBe( 'firehose' );
	} );
} );

describe( 'useRawLogsGraph — teardown', () => {
	test( 'unmount unregisters all three and closes the stream', () => {
		const fake = makeFakeConnector();
		const { unmount } = renderHook( () =>
			useRawLogsGraph( {
				connector: fake,
				commandClient: { send: async () => emptyReply() },
			} )
		);
		unmount();
		expect( Core.node( 'rawlogs/stream' ) ).toBeNull();
		expect( Core.node( 'rawlogs/view' ) ).toBeNull();
		expect( Core.node( 'rawlogs/transform' ) ).toBeNull();
		expect( fake.closeCount ).toBeGreaterThanOrEqual( 1 );
	} );
} );

describe( 'useRawLogsGraph — control callbacks', () => {
	test( 'selectLog re-subscribes the stream and selects in the view', async () => {
		const fake = makeFakeConnector();
		const { result } = renderHook( () =>
			useRawLogsGraph( {
				connector: fake,
				commandClient: { send: async () => oneLogReply() },
			} )
		);
		await act( async () => {} );
		act( () => result.current.selectLog( 'errors' ) );
		expect( fake.lastSubscription ).toBe( 'errors' );
		expect( Core.node( 'rawlogs/view' ).setStateCache.view.selected ).toBe(
			'errors'
		);
	} );

	test( 'setPaused toggles the view paused flag', async () => {
		const fake = makeFakeConnector();
		const { result } = renderHook( () =>
			useRawLogsGraph( {
				connector: fake,
				commandClient: { send: async () => emptyReply() },
			} )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		expect( Core.node( 'rawlogs/view' ).setStateCache.view.paused ).toBe(
			true
		);
	} );
} );
