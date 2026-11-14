/* eslint-env jest */
/**
 * Registering a consumer's blocks: each schema the page localized becomes a
 * dynamic block whose edit renders its View, and a schema and a view must
 * pair up exactly.
 *
 * `@wordpress/blocks` is a stand-in recording each registration: the real
 * package ships ESM dependencies this suite's transform skips.
 */

import { render, screen } from '@testing-library/react';
import { registerCompositionBlocks } from '../registerCompositionBlocks';

const mockRegistered = new Map();

jest.mock( '@wordpress/blocks', () => ( {
	registerBlockType: ( name, settings ) =>
		mockRegistered.set( name, settings ),
} ) );

jest.mock( '@wordpress/block-editor', () => ( {
	useBlockProps: () => ( {} ),
	InspectorControls: ( { children } ) => children,
	InnerBlocks: ( { allowedBlocks } ) => (
		<div data-testid="inner" data-allowed={ allowedBlocks.join( ' ' ) } />
	),
} ) );

const MAX = { type: 'integer', default: 10, minimum: 1, maximum: 20 };

const SCHEMAS = {
	'acme-desk/tally': {
		title: 'Tally',
		attributes: { max: MAX },
		container: false,
		multiple: true,
	},
	'acme-desk/column': {
		title: 'Column',
		attributes: {},
		container: true,
		multiple: false,
	},
	'acme-desk/gauge': {
		title: 'Gauge',
		attributes: { needle: { type: 'string', default: 'north-7864' } },
		container: false,
		multiple: true,
	},
};

const VIEWS = {
	'acme-desk/tally': {
		View: ( { attributes } ) => (
			<p data-testid="tally">{ `max ${ attributes.max }` }</p>
		),
	},
	'acme-desk/column': {
		View: ( { children } ) => (
			<section data-testid="column">{ children }</section>
		),
	},
	'acme-desk/gauge': {
		View: () => null,
		Controls: ( { schema } ) => (
			<p data-testid="gauge-schema">{ Object.keys( schema ).join() }</p>
		),
	},
};

beforeEach( () => {
	mockRegistered.clear();
} );

describe( 'registerCompositionBlocks', () => {
	it( 'refuses a schema without a view, naming it, and registers nothing', () => {
		const { 'acme-desk/tally': _tally, ...views } = VIEWS;
		expect( () => registerCompositionBlocks( SCHEMAS, views ) ).toThrow(
			'acme-desk/tally has no view'
		);
		expect( mockRegistered.size ).toBe( 0 );
	} );

	it( 'refuses a view without a schema, naming it', () => {
		expect( () =>
			registerCompositionBlocks( SCHEMAS, {
				...VIEWS,
				'acme-desk/beacon': { View: () => null },
			} )
		).toThrow( 'acme-desk/beacon has no schema' );
		expect( mockRegistered.size ).toBe( 0 );
	} );

	it( 'registers each schema as a dynamic block with its title, attributes and placement', () => {
		registerCompositionBlocks( SCHEMAS, VIEWS );
		expect( [ ...mockRegistered.keys() ] ).toEqual( [
			'acme-desk/tally',
			'acme-desk/column',
			'acme-desk/gauge',
		] );
		const tally = mockRegistered.get( 'acme-desk/tally' );
		expect( tally.apiVersion ).toBe( 3 );
		expect( tally.title ).toBe( 'Tally' );
		// A core category, which the canvas's boot seeds.
		expect( tally.category ).toBe( 'widgets' );
		expect( tally.attributes ).toEqual( { max: MAX } );
		expect( tally.save() ).toBeNull();
		expect( tally.supports.html ).toBe( false );
		expect( tally.supports.multiple ).toBe( true );
		// Every feature writing an attribute the schema lacks is off, and patterns.
		expect( tally.supports ).toEqual( {
			html: false,
			multiple: true,
			customClassName: false,
			customCSS: false,
			lock: false,
			renaming: false,
			reusable: false,
			visibility: false,
		} );
		expect(
			mockRegistered.get( 'acme-desk/column' ).supports.multiple
		).toBe( false );
	} );

	it( 'edits a block through its own View', () => {
		registerCompositionBlocks( SCHEMAS, VIEWS );
		const { edit: Edit } = mockRegistered.get( 'acme-desk/tally' );
		render(
			<Edit attributes={ { max: 13 } } setAttributes={ () => {} } />
		);
		expect( screen.getByTestId( 'tally' ).textContent ).toBe( 'max 13' );
	} );

	it( 'hands a block’s Controls its attribute schemas', () => {
		registerCompositionBlocks( SCHEMAS, VIEWS );
		const { edit: Edit } = mockRegistered.get( 'acme-desk/gauge' );
		render(
			<Edit
				attributes={ { needle: 'north-7864' } }
				setAttributes={ () => {} }
			/>
		);
		expect( screen.getByTestId( 'gauge-schema' ).textContent ).toBe(
			'needle'
		);
	} );

	it( 'admits every block but a container inside a container', () => {
		registerCompositionBlocks( SCHEMAS, VIEWS );
		const { edit: Edit } = mockRegistered.get( 'acme-desk/column' );
		render( <Edit attributes={ {} } setAttributes={ () => {} } /> );
		expect( screen.getByTestId( 'inner' ).dataset.allowed ).toBe(
			'acme-desk/tally acme-desk/gauge'
		);
	} );
} );
