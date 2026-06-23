import { render } from '@testing-library/react';
import { Core } from '../../runtime/core';
import DebugOverlay from '../DebugOverlay';
import * as sampler from '../overviewSampler';

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
} );

it( 'does NOT start the sampler when debug is disabled', () => {
	const start = jest.spyOn( sampler, 'startOverviewSampler' );
	render( <DebugOverlay search="" /> );
	expect( start ).not.toHaveBeenCalled();
	start.mockRestore();
} );

it( 'starts the always-on sampler while enabled and stops it on unmount', () => {
	const start = jest.spyOn( sampler, 'startOverviewSampler' );
	const stop = jest.spyOn( sampler, 'stopOverviewSampler' );
	const { unmount } = render( <DebugOverlay search="?nodes-debug=1" /> );
	expect( start ).toHaveBeenCalledTimes( 1 );
	expect( stop ).not.toHaveBeenCalled();
	unmount();
	expect( stop ).toHaveBeenCalledTimes( 1 );
	start.mockRestore();
	stop.mockRestore();
} );
