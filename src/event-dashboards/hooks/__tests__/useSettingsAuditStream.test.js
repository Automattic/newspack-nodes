/**
 * useSettingsAuditStream tests — one RemoteLink tailing settings.p0 into a
 * SettingsAuditView, on the canonical backbone. EventSource is faked; we drive a
 * settings-change frame through it and assert it routes link → view, and that the
 * stream always seeks from start (full replay of the retained history).
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';

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

import { useSettingsAuditStream } from '../useSettingsAuditStream';

const LINK = 'settingsaudit:link';
const TEE = 'settingsaudit:stream';
const VIEW = 'settingsaudit:view';

const fakeClient = () => ( { postBatch: () => Promise.resolve( [] ) } );

function settingsFrame( {
	ts = 1700000042,
	option = 'newspack_flame_colors',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = 'settings.p0';
	// A replayed record carries a server-side TO; RemoteLink must re-home it.
	m[ TO ] = 'settings';
	m[ TIMESTAMP ] = ts;
	m[ VALUE ] = { option };
	return m;
}

describe( 'useSettingsAuditStream', () => {
	it( 'mounts the backbone + a RemoteLink to settings.p0 + the view', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( LINK ) ).toBeTruthy();
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( LINK ).sseIn.subscribe ).toEqual( [
			'settings.p0',
		] );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=settings.p0' );
	} );

	it( 'makes the RemoteLink with a token-free (subscribe-only) argument string', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		expect( Core.node( LINK ).arguments ).toEqual( [ 'settings.p0' ] );
	} );

	it( 'seeks from start (full replay of the retained history)', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { 'settings.p0': 'start' } ) )
		);
	} );

	it( 'inserts an inspectable Tee on the stream edge: link → tee → view', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		const interpreter = Core.node( '_command_interpreter' );
		const tee = Core.node( TEE );
		expect( tee.constructor.name ).toBe( 'TeeNode' );
		expect( tee.sink ).toBe( interpreter );
		expect( Core.node( LINK ).sseIn.target ).toBe( TEE );
		expect( tee.target ).toEqual( [ VIEW ] );
	} );

	it( 'routes a settings frame through the link into the view', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					settingsFrame( {
						ts: 1700000099,
						option: 'newspack_theme',
					} )
				)
			);
		} );
		const entries = Core.node( VIEW ).snapshot();
		expect( entries[ 0 ].option ).toBe( 'newspack_theme' );
		expect( entries[ 0 ].ts ).toBe( 1700000099 );
	} );

	it( 'fans the live stream to a debug-overlay watcher without disturbing the view', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		const watcher = new Node();
		watcher.name = 'watcher';
		const seen = [];
		watcher.fill = ( m ) => seen.push( m[ VALUE ].option );
		Core.node( TEE ).connectNode( 'watcher' );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					settingsFrame( { option: 'newspack_watched' } )
				)
			);
		} );
		expect( seen ).toContain( 'newspack_watched' );
		expect( Core.node( VIEW ).snapshot() ).toHaveLength( 1 );
	} );

	it( 're-seeks history after a graph rebuild drops + recreates the link', async () => {
		renderHook( () =>
			useSettingsAuditStream( { commandClient: fakeClient() } )
		);
		await act( async () => {} );
		const firstLink = Core.node( LINK );
		const before = FakeEventSource.instances.length;

		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		expect( Core.node( LINK ) ).not.toBe( firstLink ); // rebuilt
		expect( FakeEventSource.instances.length ).toBeGreaterThan( before );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { 'settings.p0': 'start' } ) )
		);
	} );
} );
