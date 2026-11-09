/* eslint-env jest */
/**
 * A layout's tree renders node by node through each block's View, every node
 * inside a boundary of its own, so one block that cannot render costs its own
 * place and nothing else.
 */

import { render, screen } from '@testing-library/react';
import CompositionView from '../CompositionView';

const tally = ( { attributes, editing } ) => (
	<p data-testid="tally" data-editing={ String( editing ) }>
		{ attributes.label }
	</p>
);
const column = ( { children } ) => (
	<section data-testid="column">{ children }</section>
);
const broken = () => {
	throw new Error( 'the harbor gauge is offline' );
};

const VIEWS = {
	'acme-desk/tally': { View: tally },
	'acme-desk/column': { View: column },
	'acme-desk/broken': { View: broken },
};

const node = ( name, attributes = {}, inner = [] ) => ( {
	name,
	attributes,
	inner,
} );

const renderError = ( error ) => (
	<p data-testid="refused">{ `refused: ${ error.message }` }</p>
);

describe( 'CompositionView', () => {
	it( 'renders each node by its View, a container holding its children', () => {
		render(
			<CompositionView
				blocks={ [
					node( 'acme-desk/tally', { label: 'Ferry count' } ),
					node( 'acme-desk/column', {}, [
						node( 'acme-desk/tally', { label: 'Dock count' } ),
					] ),
				] }
				views={ VIEWS }
				renderError={ renderError }
			/>
		);
		const tallies = screen.getAllByTestId( 'tally' );
		expect( tallies.map( ( one ) => one.textContent ) ).toEqual( [
			'Ferry count',
			'Dock count',
		] );
		const columnView = screen.getByTestId( 'column' );
		expect( columnView.contains( tallies[ 0 ] ) ).toBe( false );
		expect( columnView.contains( tallies[ 1 ] ) ).toBe( true );
		expect(
			tallies[ 0 ].compareDocumentPosition( columnView ) &
				window.Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// A reader's page never edits.
		expect( tallies[ 0 ].dataset.editing ).toBe( 'false' );
	} );

	it( 'renders renderError in place of a View that throws, and its sibling still renders', () => {
		const spy = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		render(
			<CompositionView
				blocks={ [
					node( 'acme-desk/broken' ),
					node( 'acme-desk/tally', { label: 'Pier count' } ),
				] }
				views={ VIEWS }
				renderError={ renderError }
			/>
		);
		spy.mockRestore();
		expect( screen.getByTestId( 'refused' ).textContent ).toBe(
			'refused: the harbor gauge is offline'
		);
		expect( screen.getByTestId( 'tally' ).textContent ).toBe(
			'Pier count'
		);
	} );

	it( 'renders renderError for a name without a view', () => {
		render(
			<CompositionView
				blocks={ [
					node( 'acme-desk/lighthouse' ),
					node( 'acme-desk/tally', { label: 'Buoy count' } ),
				] }
				views={ VIEWS }
				renderError={ renderError }
			/>
		);
		expect( screen.getByTestId( 'refused' ).textContent ).toBe(
			'refused: acme-desk/lighthouse has no view'
		);
		expect( screen.getByTestId( 'tally' ).textContent ).toBe(
			'Buoy count'
		);
	} );

	it( 'never looks a name up on the prototype', () => {
		render(
			<CompositionView
				blocks={ [ node( 'toString' ) ] }
				views={ VIEWS }
				renderError={ renderError }
			/>
		);
		expect( screen.getByTestId( 'refused' ).textContent ).toBe(
			'refused: toString has no view'
		);
	} );

	it( 'renders a View again once its node is replaced', () => {
		const spy = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		const gauge = [ node( 'acme-desk/broken' ) ];
		const { rerender } = render(
			<CompositionView
				blocks={ gauge }
				views={ VIEWS }
				renderError={ renderError }
			/>
		);
		spy.mockRestore();
		rerender(
			<CompositionView
				blocks={ gauge }
				views={ { ...VIEWS, 'acme-desk/broken': { View: tally } } }
				renderError={ renderError }
			/>
		);
		// The same node object keeps its boundary's verdict.
		expect( screen.queryByTestId( 'refused' ) ).not.toBeNull();
		rerender(
			<CompositionView
				blocks={ [
					node( 'acme-desk/broken', { label: 'Gauge mended' } ),
				] }
				views={ { ...VIEWS, 'acme-desk/broken': { View: tally } } }
				renderError={ renderError }
			/>
		);
		expect( screen.getByTestId( 'tally' ).textContent ).toBe(
			'Gauge mended'
		);
	} );
} );
