/* eslint-env jest */
/**
 * AccumulatedCard widget — reads ONLY the `accumulated:view` node's slice via
 * useNodeState and renders the accumulated-items KPI.
 */

import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { Core } from '@newspack-nodes/runtime';
import { AccumulatedViewNode } from '../../nodes/accumulated-view-node';
import { AccumulatedCard } from '../AccumulatedCard';

beforeEach( () => Core.reset() );

function mountView( slice ) {
	const node = new AccumulatedViewNode();
	node.name = 'accumulated:view';
	if ( slice ) {
		node.setState( 'view', slice );
	}
	return node;
}

describe( 'AccumulatedCard', () => {
	it( 'renders the accumulated count', () => {
		mountView( { accumulated: 42 } );
		const { container } = render( <AccumulatedCard /> );
		expect(
			container.querySelector( '.eai-insights__stat-num' ).textContent
		).toBe( '42' );
		expect( screen.getByText( /total items/i ) ).toBeInTheDocument();
	} );

	it( 're-renders when its view node publishes a new slice', () => {
		const node = mountView( { accumulated: 0 } );
		const { container } = render( <AccumulatedCard /> );
		act( () => node.setState( 'view', { accumulated: 9 } ) );
		expect(
			container.querySelector( '.eai-insights__stat-num' ).textContent
		).toBe( '9' );
	} );

	it( 'surfaces a slice error as a notice', () => {
		mountView( { accumulated: 0, error: 'acc read failed' } );
		render( <AccumulatedCard /> );
		expect( screen.getByRole( 'alert' ).textContent ).toMatch(
			/acc read failed/
		);
	} );
} );
