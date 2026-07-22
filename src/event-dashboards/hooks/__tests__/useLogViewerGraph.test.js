/**
 * useLogViewerGraph tests — the Log Viewer dashboard graph. Same RemoteLink →
 * Tee → view backbone as the Partition Viewer, but the link opens the substrate's
 * `GET /log/stream` (endpoint override) and the catalog is the interpreter
 * builtin `taillog sources` (empty TO), replying with `{ name, path, mode,
 * available }` source rows that feed the picker.
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	TYPE,
	VALUE,
	TIMESTAMP,
	TO,
	FROM,
	ID,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import names from '../../../runtime/reserved-node-names.json';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.last = this;
		FakeEventSource.instances.push( this );
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
	}
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

beforeEach( () => {
	Core.reset();
	FakeEventSource.last = null;
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

import { useLogViewerGraph } from '../useLogViewerGraph';

const LINK = 'logviewer:link';
const VIEW = 'logviewer:view';
const HTTP = names.HTTP;

// CommandClient double: postBatch echoes a reply per verb name along FROM.
function makeFakeClient( payloadByVerb = {} ) {
	const client = {
		batches: [],
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ TIMESTAMP ] = 0;
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

// debug listed first but unavailable; access is the first AVAILABLE source.
const sourcesReply = () => [
	{ name: 'debug', path: '/d', mode: 'file', available: false },
	{ name: 'access', path: '/a', mode: 'file', available: true },
];

function mountGraph( client ) {
	return renderHook( () => useLogViewerGraph( { commandClient: client } ) );
}

describe( 'useLogViewerGraph', () => {
	test( 'mounts a RemoteLink pointed at /log/stream and the raw-line view', async () => {
		mountGraph( makeFakeClient( { taillog: sourcesReply() } ) );
		await act( async () => {} );
		const link = Core.node( LINK );
		expect( link ).toBeTruthy();
		expect( link.endpoint ).toBe( 'newspack-nodes/v1/log/stream' );
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( VIEW ).sink ).toBe(
			Core.node( '_command_interpreter' )
		);
		expect( Core.node( HTTP ).client ).toBeTruthy();
	} );

	test( 'catalogs via the taillog-sources interpreter builtin (empty TO)', async () => {
		const client = makeFakeClient( { taillog: sourcesReply() } );
		mountGraph( client );
		await act( async () => {} );
		const cmd = client.batches
			.flat()
			.find( ( m ) => 'taillog' === m[ VALUE ]?.name );
		expect( cmd ).toBeTruthy();
		expect( cmd[ TO ] ).toBe( '' );
		expect( cmd[ VALUE ].arguments ).toEqual( [ 'sources' ] );
	} );

	test( 'opens the stream on the first AVAILABLE source over /log/stream', async () => {
		mountGraph( makeFakeClient( { taillog: sourcesReply() } ) );
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/log/stream'
		);
		expect( FakeEventSource.last.url ).toContain( 'subscribe=access' );
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
			'access'
		);
	} );

	test( 'returns the source catalog for the picker', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		expect( result.current.sources ).toEqual( sourcesReply() );
	} );

	test( 'an empty catalog leaves the picker empty and opens nothing new', async () => {
		const { result } = mountGraph( makeFakeClient( { taillog: [] } ) );
		await act( async () => {} );
		expect( result.current.sources ).toEqual( [] );
	} );

	test( 'selectSource re-subscribes the stream and records the pick', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		const before = FakeEventSource.last;
		act( () => result.current.selectSource( 'debug' ) );
		expect( before.closed ).toBe( true );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe( 'debug' );
	} );

	test( 'seek repositions the current source with a positions seed', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		act( () => result.current.seek( 'access', { access: 'start' } ) );
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'positions=' );
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( { access: 'start' } );
	} );

	test( 'setPaused toggles the view paused flag', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
	} );

	test( 'unmount tears down the link, view, and closes the EventSource', async () => {
		const { unmount } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		const es = FakeEventSource.last;
		unmount();
		expect( es.closed ).toBe( true );
		expect( Core.node( LINK ) ).toBeNull();
		expect( Core.node( VIEW ) ).toBeNull();
	} );

	describe( 'visibility gating', () => {
		const setVisibility = ( state ) => {
			Object.defineProperty( document, 'visibilityState', {
				value: state,
				configurable: true,
			} );
			act( () => {
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
		};
		afterEach( () => setVisibility( 'visible' ) );

		test( 'closes the stream when hidden and reopens the source when visible', async () => {
			mountGraph( makeFakeClient( { taillog: sourcesReply() } ) );
			await act( async () => {} );
			const open = FakeEventSource.last;
			act( () => setVisibility( 'hidden' ) );
			expect( open.closed ).toBe( true );
			const before = FakeEventSource.instances.length;
			act( () => setVisibility( 'visible' ) );
			expect( FakeEventSource.instances.length ).toBe( before + 1 );
			expect( FakeEventSource.last.url ).toContain( 'subscribe=access' );
		} );
	} );
} );
