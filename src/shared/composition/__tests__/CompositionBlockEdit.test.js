/* eslint-env jest */
/**
 * A block in the layout editor renders its own View live, marked as editing,
 * with its Controls in the block inspector and, for a container, its
 * children through `InnerBlocks`.
 *
 * `@wordpress/block-editor` is a stand-in: the real one needs the single
 * `wp.privateApis` copy WordPress hands every package.
 */

import { render, screen, within } from '@testing-library/react';
import CompositionBlockEdit from '../CompositionBlockEdit';

jest.mock( '@wordpress/block-editor', () => ( {
	useBlockProps: () => ( { 'data-testid': 'block', className: 'is-block' } ),
	InspectorControls: ( { children } ) => (
		<aside data-testid="inspector">{ children }</aside>
	),
	InnerBlocks: ( { allowedBlocks } ) => (
		<div data-testid="inner" data-allowed={ allowedBlocks.join( ' ' ) } />
	),
} ) );

const View = ( { attributes, editing, children } ) => (
	<div data-testid="view" data-editing={ String( editing ) }>
		{ attributes.heading }
		{ children }
	</div>
);
const Controls = ( { attributes, setAttributes } ) => (
	<button
		type="button"
		data-testid="controls"
		onClick={ () => setAttributes( { heading: 'Moorings' } ) }
	>
		{ attributes.heading }
	</button>
);

describe( 'CompositionBlockEdit', () => {
	it( 'renders the View live, editing, inside the block wrapper', () => {
		render(
			<CompositionBlockEdit
				attributes={ { heading: 'Tide table' } }
				setAttributes={ () => {} }
				view={ { View, Controls } }
			/>
		);
		const view = screen.getByTestId( 'view' );
		expect( view.dataset.editing ).toBe( 'true' );
		expect( view.textContent ).toBe( 'Tide table' );
		expect( screen.getByTestId( 'block' ).contains( view ) ).toBe( true );
		expect( screen.queryByTestId( 'inner' ) ).toBeNull();
	} );

	it( 'renders the Controls inside the inspector, writing through setAttributes', () => {
		const setAttributes = jest.fn();
		render(
			<CompositionBlockEdit
				attributes={ { heading: 'Tide table' } }
				setAttributes={ setAttributes }
				view={ { View, Controls } }
			/>
		);
		const controls = within(
			screen.getByTestId( 'inspector' )
		).getByTestId( 'controls' );
		controls.click();
		expect( setAttributes ).toHaveBeenCalledWith( { heading: 'Moorings' } );
	} );

	it( 'renders no inspector for a block with no Controls', () => {
		render(
			<CompositionBlockEdit
				attributes={ { heading: 'Slipway' } }
				setAttributes={ () => {} }
				view={ { View } }
			/>
		);
		expect( screen.queryByTestId( 'inspector' ) ).toBeNull();
	} );

	it( 'renders a container’s children through InnerBlocks inside its View', () => {
		render(
			<CompositionBlockEdit
				attributes={ {} }
				setAttributes={ () => {} }
				view={ { View } }
				allowedBlocks={ [ 'acme-desk/tally' ] }
			/>
		);
		const inner = screen.getByTestId( 'inner' );
		expect( inner.dataset.allowed ).toBe( 'acme-desk/tally' );
		expect( screen.getByTestId( 'view' ).contains( inner ) ).toBe( true );
	} );
} );
