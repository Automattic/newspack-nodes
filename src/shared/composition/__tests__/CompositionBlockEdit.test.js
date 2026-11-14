/* eslint-env jest */
/**
 * A block in the layout editor renders its own View live, marked as editing,
 * with its Controls in the block inspector and, for a container, its
 * children through `InnerBlocks`.
 *
 * In a block preview, which core renders a second time, `Disabled`, in its
 * own iframe, the block shows its wrapper and children alone and never mounts its View,
 * whose live reads are the page's own.
 *
 * `@wordpress/block-editor` is a stand-in: the real one needs the single
 * `wp.privateApis` copy WordPress hands every package.
 */

import { render, screen, within } from '@testing-library/react';
import { Disabled } from '@wordpress/components';
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

	it( 'hands the Controls the attribute schemas it was registered with', () => {
		const seen = jest.fn( () => null );
		const schema = {
			depth: { type: 'integer', minimum: 2, maximum: 9, default: 4 },
		};
		render(
			<CompositionBlockEdit
				attributes={ { depth: 4 } }
				setAttributes={ () => {} }
				view={ { View, Controls: seen } }
				schema={ schema }
			/>
		);
		expect( seen.mock.calls[ 0 ][ 0 ].schema ).toBe( schema );
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

	it( 'mounts no View in a preview, keeping the wrapper and its children', () => {
		const Live = jest.fn( () => {
			throw new Error(
				'node name collision: briefing:since:tee already registered'
			);
		} );
		render(
			<Disabled>
				<CompositionBlockEdit
					attributes={ { heading: 'Tide table' } }
					setAttributes={ () => {} }
					view={ { View: Live, Controls } }
					allowedBlocks={ [ 'acme-desk/tally' ] }
				/>
			</Disabled>
		);
		expect( Live ).not.toHaveBeenCalled();
		const block = screen.getByTestId( 'block' );
		expect( block.contains( screen.getByTestId( 'inner' ) ) ).toBe( true );
		expect( screen.queryByTestId( 'inspector' ) ).toBeNull();
	} );
} );
