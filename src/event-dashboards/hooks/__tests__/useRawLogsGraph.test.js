/**
 * useRawLogsGraph tests — the Raw Logs dashboard graph clipped onto the
 * exospine (`mountExospine`: _command_interpreter → _router). The four graph
 * nodes (`rawlogs:stream`, `rawlogs:route`, `rawlogs:transform`, `rawlogs:view`)
 * are REAL; only the stream's connector and the `list_logs` command client are
 * injected so the hook never touches a real EventSource or the network. The
 * canonical-wiring tests assert every node sinks into the CI and steers via
 * target; the end-to-end tests deliver an envelope through the fake connector
 * and assert it actually routes stream → route → transform → view through the
 * real router.
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	TM_BYTESTREAM,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { useRawLogsGraph } from '../useRawLogsGraph';

beforeEach( () => Core.reset() );

const CI = '_command_interpreter';

// A fake connector matching the stream node's seam (connect/close); records the
// subscription + the envelope/status handlers so a test can deliver them, plus
// closeCount for the teardown assertion.
function makeFakeConnector() {
	return {
		closeCount: 0,
		lastSubscription: null,
		_onEnvelope: null,
		_onStatus: null,
		connect( subscription, onEnvelope, onStatus ) {
			this.lastSubscription = subscription;
			this._onEnvelope = onEnvelope;
			this._onStatus = onStatus;
		},
		close() {
			this.closeCount += 1;
			this._onEnvelope = null;
		},
		deliverMessage( envelope ) {
			if ( this._onEnvelope ) {
				this._onEnvelope( envelope );
			}
		},
		emitStatus( status ) {
			if ( this._onStatus ) {
				this._onStatus( status );
			}
		},
	};
}

// A command reply Message: VALUE rides as { name, payload }; payload is the
// list_logs [{key,label}] array.
function commandReply( payload ) {
	const m = newMessage();
	m[ VALUE ] = { name: 'list_logs', payload };
	return m;
}
const emptyReply = () => commandReply( [] );
const oneLogReply = () =>
	commandReply( [ { key: 'firehose', label: 'firehose.log' } ] );

function mountGraph( fake, client ) {
	return renderHook( () =>
		useRawLogsGraph( { connector: fake, commandClient: client } )
	);
}

describe( 'useRawLogsGraph — exospine wiring', () => {
	test( 'mounts the backbone + four nodes, each sinking into the CI', async () => {
		const fake = makeFakeConnector();
		mountGraph( fake, { send: async () => oneLogReply() } );
		await act( async () => {} );

		const ci = Core.node( CI );
		expect( ci ).toBeTruthy();
		expect( Core.node( '_router' ) ).toBeTruthy();
		for ( const n of [
			'rawlogs:stream',
			'rawlogs:route',
			'rawlogs:transform',
			'rawlogs:view',
		] ) {
			expect( Core.node( n ) ).toBeTruthy();
			expect( Core.node( n ).sink ).toBe( ci );
		}
	} );

	test( 'steers flow with targets, not bespoke sinks (no controlSink)', async () => {
		const fake = makeFakeConnector();
		mountGraph( fake, { send: async () => oneLogReply() } );
		await act( async () => {} );

		expect( Core.node( 'rawlogs:stream' ).target ).toBe( 'rawlogs:route' );
		expect( Core.node( 'rawlogs:route' ).target ).toBe(
			'rawlogs:transform'
		);
		expect( Core.node( 'rawlogs:transform' ).target ).toBe(
			'rawlogs:view'
		);
		expect( Core.node( 'rawlogs:stream' ).controlSink ).toBeUndefined();
	} );

	test( 'subscribes the stream to the default-selected log after list_logs', async () => {
		const fake = makeFakeConnector();
		mountGraph( fake, { send: async () => oneLogReply() } );
		await act( async () => {} );
		expect( fake.lastSubscription ).toBe( 'firehose' );
	} );
} );

describe( 'useRawLogsGraph — end-to-end routing through the exospine', () => {
	test( 'a delivered log envelope routes stream → route → transform → view', async () => {
		const fake = makeFakeConnector();
		mountGraph( fake, { send: async () => oneLogReply() } );
		await act( async () => {} );

		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = 'p0';
		env[ VALUE ] = 'a real log line';
		act( () => fake.deliverMessage( env ) );

		const view = Core.node( 'rawlogs:view' );
		expect( view.lines ).toHaveLength( 1 );
		expect( view.lines[ 0 ].content ).toBe( 'p0: a real log line' );
	} );

	test( 'a connection-status control routes stream → route → view (skips transform)', async () => {
		const fake = makeFakeConnector();
		mountGraph( fake, { send: async () => oneLogReply() } );
		await act( async () => {} );

		act( () => fake.emitStatus( { connectionError: true } ) );

		expect(
			Core.node( 'rawlogs:view' ).setStateCache.view.connectionError
		).toBe( true );
		// A control is NOT a log row — the buffer stays empty.
		expect( Core.node( 'rawlogs:view' ).lines ).toHaveLength( 0 );
	} );

	test( 'list_logs flows into the view (the dropdown catalog)', async () => {
		const fake = makeFakeConnector();
		mountGraph( fake, { send: async () => oneLogReply() } );
		await act( async () => {} );
		expect(
			Core.node( 'rawlogs:view' ).setStateCache.view.logs
		).toHaveLength( 1 );
	} );
} );

describe( 'useRawLogsGraph — teardown', () => {
	test( 'unmount unregisters the graph + the backbone and closes the stream', () => {
		const fake = makeFakeConnector();
		const { unmount } = mountGraph( fake, {
			send: async () => emptyReply(),
		} );
		unmount();
		for ( const n of [
			'rawlogs:stream',
			'rawlogs:route',
			'rawlogs:transform',
			'rawlogs:view',
			'_command_interpreter',
			'_router',
		] ) {
			expect( Core.node( n ) ).toBeNull();
		}
		expect( fake.closeCount ).toBeGreaterThanOrEqual( 1 );
	} );
} );

describe( 'useRawLogsGraph — control callbacks', () => {
	test( 'selectLog re-subscribes the stream and selects in the view', async () => {
		const fake = makeFakeConnector();
		const { result } = mountGraph( fake, {
			send: async () => oneLogReply(),
		} );
		await act( async () => {} );
		act( () => result.current.selectLog( 'errors' ) );
		expect( fake.lastSubscription ).toBe( 'errors' );
		expect( Core.node( 'rawlogs:view' ).setStateCache.view.selected ).toBe(
			'errors'
		);
	} );

	test( 'setPaused toggles the view paused flag', async () => {
		const fake = makeFakeConnector();
		const { result } = mountGraph( fake, {
			send: async () => emptyReply(),
		} );
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		expect( Core.node( 'rawlogs:view' ).setStateCache.view.paused ).toBe(
			true
		);
	} );
} );
