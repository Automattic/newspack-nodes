/* eslint-env jest */
/**
 * The reader half of the composition layer loads on a reader's page, which
 * carries no editor script: none of its modules may reach for
 * `@wordpress/block-editor` or `@wordpress/blocks`, even transitively.
 */

import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';

jest.mock( '@wordpress/block-editor', () => {
	throw new Error( 'a reader loaded @wordpress/block-editor' );
} );
jest.mock( '@wordpress/blocks', () => {
	throw new Error( 'a reader loaded @wordpress/blocks' );
} );

const CompositionView = require( '../CompositionView' ).default;
const CompositionEditSlot = require( '../CompositionEditSlot' ).default;
const { useComposition } = require( '../useComposition' );

const LAYOUT = {
	context: 'acme-desk/board',
	source: 'default',
	blocks: [],
	saved_ts: null,
	actor: null,
};

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	installFakeCommandWire( () => LAYOUT );
} );

it( 'imports and renders with the editor packages unloadable', async () => {
	render(
		<>
			<CompositionView
				blocks={ [
					{
						name: 'acme-desk/tally',
						attributes: { label: 'Harbor tally' },
						inner: [],
					},
				] }
				views={ {
					'acme-desk/tally': {
						View: ( { attributes } ) => (
							<p data-testid="tally">{ attributes.label }</p>
						),
					},
				} }
				renderError={ () => null }
			/>
			<CompositionEditSlot context="acme-desk/board" />
		</>
	);
	expect( screen.getByTestId( 'tally' ).textContent ).toBe( 'Harbor tally' );

	const { result } = renderHook( () =>
		useComposition( 'quayside', 'acme-desk/board' )
	);
	await waitFor( () => expect( result.current.answer ).toEqual( LAYOUT ), {
		timeout: 4000,
	} );
} );
