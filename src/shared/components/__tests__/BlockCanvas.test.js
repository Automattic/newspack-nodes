/* eslint-env jest */
/**
 * The block canvas hands its blocks, its two change handlers and its
 * settings to one block-editor provider, and renders the block list, the
 * popover slot and its own children inside that provider, so a block
 * inspector placed beside the list reads the same editor store.
 *
 * The WordPress packages are stand-ins that record what they receive: the
 * real provider needs the one `wp.privateApis` copy WordPress hands every
 * package, which a test tree holding several copies cannot give it.
 */

import { render, screen, within } from '@testing-library/react';
import BlockCanvas from '../BlockCanvas';

const mockProviderProps = [];

jest.mock( '@wordpress/block-editor', () => {
	const pass =
		( testId ) =>
		( { children } ) => <div data-testid={ testId }>{ children }</div>;
	return {
		BlockEditorProvider: ( props ) => {
			mockProviderProps.push( props );
			return <div data-testid="provider">{ props.children }</div>;
		},
		BlockTools: pass( 'tools' ),
		WritingFlow: pass( 'writing-flow' ),
		ObserveTyping: pass( 'observe-typing' ),
		BlockList: () => <div data-testid="block-list" />,
	};
} );

jest.mock( '@wordpress/components', () => ( {
	SlotFillProvider: ( { children } ) => (
		<div data-testid="slot-fill">{ children }</div>
	),
	Popover: { Slot: () => <div data-testid="popover-slot" /> },
} ) );

beforeEach( () => {
	mockProviderProps.length = 0;
} );

describe( 'BlockCanvas', () => {
	it( 'hands its blocks, handlers and settings to the provider', () => {
		const blocks = [ { clientId: 'harbor-1', name: 'test/one' } ];
		const onInput = jest.fn();
		const onChange = jest.fn();
		const settings = { allowedBlockTypes: [ 'test/one' ] };
		render(
			<BlockCanvas
				blocks={ blocks }
				onInput={ onInput }
				onChange={ onChange }
				settings={ settings }
			/>
		);
		expect( mockProviderProps ).toHaveLength( 1 );
		const [ props ] = mockProviderProps;
		expect( props.value ).toBe( blocks );
		expect( props.onInput ).toBe( onInput );
		expect( props.onChange ).toBe( onChange );
		expect( props.settings ).toEqual( {
			allowedBlockTypes: [ 'test/one' ],
		} );
	} );

	it( 'hands the provider one settings object across renders when given none', () => {
		const canvas = ( blocks ) => (
			<BlockCanvas
				blocks={ blocks }
				onInput={ () => {} }
				onChange={ () => {} }
			/>
		);
		const { rerender } = render(
			canvas( [ { clientId: 'heron-1', name: 'test/one' } ] )
		);
		rerender( canvas( [ { clientId: 'heron-2', name: 'test/two' } ] ) );

		expect( mockProviderProps ).toHaveLength( 2 );
		expect( mockProviderProps[ 1 ].settings ).toBe(
			mockProviderProps[ 0 ].settings
		);
		expect( mockProviderProps[ 0 ].settings ).toEqual( {} );
		expect( Object.isFrozen( mockProviderProps[ 0 ].settings ) ).toBe(
			true
		);
	} );

	it( 'hands the provider the selection it is given, and none without one', () => {
		const selection = {
			selectionStart: { clientId: 'harbor-1' },
			selectionEnd: { clientId: 'harbor-1' },
		};
		const { rerender } = render(
			<BlockCanvas
				blocks={ [] }
				onInput={ () => {} }
				onChange={ () => {} }
				selection={ selection }
			/>
		);
		expect( mockProviderProps[ 0 ].selection ).toBe( selection );
		rerender(
			<BlockCanvas
				blocks={ [] }
				onInput={ () => {} }
				onChange={ () => {} }
			/>
		);
		expect( mockProviderProps[ 1 ].selection ).toBeUndefined();
	} );

	it( 'renders the list, the popover slot and its children inside the provider', () => {
		render(
			<BlockCanvas
				blocks={ [] }
				onInput={ () => {} }
				onChange={ () => {} }
				settings={ {} }
			>
				<aside data-testid="inspector" />
			</BlockCanvas>
		);
		const slotFill = screen.getByTestId( 'slot-fill' );
		const provider = within( slotFill ).getByTestId( 'provider' );
		const flow = within( provider ).getByTestId( 'writing-flow' );
		expect(
			within(
				within( flow ).getByTestId( 'observe-typing' )
			).getByTestId( 'block-list' )
		).toBeTruthy();
		expect(
			within( provider ).getByTestId( 'tools' ).contains( flow )
		).toBe( true );
		expect( within( provider ).getByTestId( 'inspector' ) ).toBeTruthy();
		expect( within( provider ).getByTestId( 'popover-slot' ) ).toBeTruthy();
	} );
} );
