/**
 * useVisibilityGatedLink tests — the shared SSE-connection lifecycle: own a
 * mountExospine'd RemoteLink, close it while inactive, and on refocus RECONNECT
 * the same link (isReconnect=true) so the caller can resume from the last offset
 * instead of tail-dropping the hidden gap. The link is a plain spy object — the
 * hook only calls connect/close/removeNode on it, never inspects its internals.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { useVisibilityGatedLink } from '../useVisibilityGatedLink';

function fakeLink() {
	return {
		connect: jest.fn(),
		close: jest.fn(),
		removeNode: jest.fn(),
		resumePositions: jest.fn( () => ( { 'x.p0': { seg: 1, off: 2 } } ) ),
	};
}

beforeEach( () => {
	Core.reset();
} );

function mount( { link, isActive, onConnect, view } ) {
	return renderHook(
		( props ) =>
			useVisibilityGatedLink( {
				mountNodes: () => ( { link, view } ),
				isActive: props.isActive,
				onConnect,
			} ),
		{ initialProps: { isActive } }
	);
}

test( 'the FIRST connect of a link opens at its default seek (isReconnect false)', () => {
	const link = fakeLink();
	const onConnect = jest.fn();
	mount( { link, isActive: true, onConnect } );
	expect( onConnect ).toHaveBeenCalledTimes( 1 );
	expect( onConnect.mock.calls[ 0 ][ 0 ] ).toBe( link );
	expect( onConnect.mock.calls[ 0 ][ 1 ].isReconnect ).toBe( false );
} );

test( 'does not open while inactive; closes instead', () => {
	const link = fakeLink();
	const onConnect = jest.fn();
	mount( { link, isActive: false, onConnect } );
	expect( onConnect ).not.toHaveBeenCalled();
	expect( link.close ).toHaveBeenCalled();
} );

test( 'a RECONNECT of the same link (inactive→active) opens with isReconnect true', () => {
	const link = fakeLink();
	const onConnect = jest.fn();
	const { rerender } = mount( { link, isActive: true, onConnect } );
	expect( onConnect ).toHaveBeenCalledTimes( 1 ); // first connect
	act( () => rerender( { isActive: false } ) ); // hide → close
	expect( link.close ).toHaveBeenCalled();
	act( () => rerender( { isActive: true } ) ); // show → reconnect
	expect( onConnect ).toHaveBeenCalledTimes( 2 );
	expect( onConnect.mock.calls[ 1 ][ 1 ].isReconnect ).toBe( true );
} );

test( 'passes the view handle to onConnect (for a pre-connect clear)', () => {
	const link = fakeLink();
	const view = { fill: jest.fn() };
	const onConnect = jest.fn();
	mount( { link, view, isActive: true, onConnect } );
	expect( onConnect.mock.calls[ 0 ][ 1 ].view ).toBe( view );
} );

test( 'a redundant re-render while streaming the same link does NOT reconnect', () => {
	const link = fakeLink();
	const onConnect = jest.fn();
	const { rerender } = mount( { link, isActive: true, onConnect } );
	expect( onConnect ).toHaveBeenCalledTimes( 1 );
	act( () => rerender( { isActive: true } ) ); // same isActive, same link
	expect( onConnect ).toHaveBeenCalledTimes( 1 ); // guard held
} );

test( 'teardown removes the link', () => {
	const link = fakeLink();
	const { unmount } = mount( { link, isActive: true, onConnect: jest.fn() } );
	act( () => unmount() );
	expect( link.removeNode ).toHaveBeenCalled();
} );
