/**
 * useGatedSubscription tests — the pause/visibility gating shared by the
 * Partition Viewer + Log Viewer hooks: a stream is open only while visible AND
 * unpaused; a control (select/seek) records the intended subscription and only
 * touches the live stream while active, and Play/refocus re-applies the recorded
 * target (never the old selection) — so changing the log or seeking WHILE PAUSED
 * can never revive the closed EventSource and burn a bounded server slot.
 *
 * `reopenSeed` (the reopen-positions decision) is pure and tested directly.
 */

import { renderHook, act } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useGatedSubscription, reopenSeed } from '../useGatedSubscription';

let mockPageVisible = true;
jest.mock( '@newspack-nodes/shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => mockPageVisible,
} ) );

function fakeLink( resume = null ) {
	return {
		setSubscribe: jest.fn(),
		close: jest.fn(),
		resumePositions: jest.fn( () => resume ),
	};
}

beforeEach( () => {
	mockPageVisible = true;
} );

function mount( link, view ) {
	return renderHook( () => {
		const linkRef = useRef( link );
		const viewRef = useRef( view );
		return useGatedSubscription( { linkRef, viewRef } );
	} );
}

describe( 'reopenSeed', () => {
	test( 'an explicit seek target wins over the resume offset', () => {
		const link = {
			resumePositions: () => ( { 'x.p0': { segment: 9, offset: 1 } } ),
		};
		expect(
			reopenSeed( link, {
				subscribe: [ 'x.p0' ],
				positions: { 'x.p0': { segment: 2, offset: 3 } },
			} )
		).toEqual( { 'x.p0': { segment: 2, offset: 3 } } );
	} );

	test( 'a live tail resumes the SAME dir from its last offset', () => {
		const link = {
			resumePositions: () => ( { 'x.p0': { segment: 5, offset: 7 } } ),
		};
		expect(
			reopenSeed( link, { subscribe: [ 'x.p0' ], positions: null } )
		).toEqual( { 'x.p0': { segment: 5, offset: 7 } } );
	} );

	test( 'a CHANGED dir has no resume point, so it tails (null)', () => {
		const link = {
			resumePositions: () => ( { 'x.p0': { segment: 5, offset: 7 } } ),
		};
		expect(
			reopenSeed( link, { subscribe: [ 'y.p0' ], positions: null } )
		).toBeNull();
	} );
} );

describe( 'useGatedSubscription', () => {
	test( 'resubscribe while active setSubscribes immediately', () => {
		const link = fakeLink();
		const { result } = mount( link, { fill: jest.fn() } );
		act( () => result.current.resubscribe( [ 'a' ], null ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a' ], null );
	} );

	test( 'resubscribe while paused only records; Play applies the recorded target', () => {
		const link = fakeLink();
		const { result } = mount( link, { fill: jest.fn() } );
		act( () => result.current.setPaused( true ) );
		link.setSubscribe.mockClear();
		// Changing selection while paused must NOT reopen the closed stream.
		act( () => result.current.resubscribe( [ 'b' ], null ) );
		expect( link.setSubscribe ).not.toHaveBeenCalled();
		// Play re-applies the recorded selection, not the old one.
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'b' ], null );
	} );

	test( 'setPaused(true) closes the link and publishes the pause control', () => {
		const link = fakeLink();
		const view = { fill: jest.fn() };
		const { result } = mount( link, view );
		act( () => result.current.setPaused( true ) );
		expect( link.close ).toHaveBeenCalled();
		expect( view.fill ).toHaveBeenCalled();
	} );
} );
