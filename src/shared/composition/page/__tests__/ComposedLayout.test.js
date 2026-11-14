/* eslint-env jest */
/**
 * A composed page's layout as a reader reads it: each block by its view
 * under the page it stands on, each core block in core's own element, a
 * block that cannot render in its own place, and nothing for an empty layout. A
 * stored layout that no longer reads shows the read error, and offers a
 * curator Restore default, which asks first and hands the page the default
 * the server answers.
 */

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import { useEffect } from '@wordpress/element';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import {
	ComposedLayout,
	definePageState,
	Editing,
	usePage,
	usePageState,
	useWriteControl,
} from '..';
import { registerSource, SourcesProvider, useSource } from '../../../sources';

const CONTEXT = 'weka-7711/board';

/** What the page data answers for a stored layout a later version refuses. */
const REFUSED = {
	context: CONTEXT,
	error: `composition ${ CONTEXT }: weka-7711/heron-gone is not a declared block`,
};

/** The default `compositions restore` answers. */
const RESTORED = {
	context: CONTEXT,
	source: 'default',
	blocks: [],
	saved_ts: 1912345678.5,
	actor: 'lakeside-editor',
};

/**
 * A tally reading its label and the page's harbor.
 *
 * @param {Object} props
 * @param {Object} props.attributes Its attributes.
 * @return {import('react').ReactElement} The tally.
 */
function Tally( { attributes } ) {
	const { harbor } = usePage();
	return (
		<p data-testid="tally">{ `${ attributes.label } at ${ harbor }` }</p>
	);
}

const VIEWS = { 'weka-7711/tally': { View: Tally } };

registerSource( 'weka-7725', {
	kind: 'command',
	group: 'kestrel-desk',
	ci: 'harbor-7725',
	command: 'sound',
	args: ( { berth } ) => [ berth ],
} );

/**
 * A gauge reading the depth at its berth through a source.
 *
 * @param {Object} props
 * @param {Object} props.attributes Its attributes.
 * @return {import('react').ReactElement} The gauge.
 */
function Gauge( { attributes } ) {
	const { loading } = useSource( 'weka-7725', { berth: attributes.berth } );
	return <p data-testid="gauge">{ loading ? 'sounding' : 'sounded' }</p>;
}

definePageState( { 'weka-7728': { default: 'slack-7728', query: 'tide' } } );

/**
 * A tide board reading the page's tide.
 *
 * @return {import('react').ReactElement} The board.
 */
function TideBoard() {
	const [ tide ] = usePageState( 'weka-7728' );
	return <p data-testid="tide">{ tide }</p>;
}

const node = ( name, attributes = {}, inner = [] ) => ( {
	name,
	attributes,
	inner,
} );

const page = ( overrides = {} ) => ( {
	group: 'kestrel-desk',
	canTune: false,
	onRestored: jest.fn(),
	harbor: 'Kestrel',
	...overrides,
} );

let replyFor;

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( ( m ) =>
		'restore' === m[ VALUE ].name ? RESTORED : new Error( REFUSED.error )
	);
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

const sent = ( name ) =>
	replyFor.mock.calls
		.map( ( [ m ] ) => m[ VALUE ] )
		.filter( ( value ) => name === value.name );

const WAIT = { timeout: 4000 };

describe( 'ComposedLayout', () => {
	it( 'serves its blocks’ page state with no provider of the consumer’s own', () => {
		window.history.replaceState( null, '', '/wp-admin/?tide=flood-7728' );
		render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [ node( 'weka-7711/tide' ) ],
				} }
				views={ { 'weka-7711/tide': { View: TideBoard } } }
				page={ page() }
			/>
		);

		expect( screen.getByTestId( 'tide' ).textContent ).toBe( 'flood-7728' );
	} );

	it( 'shares the sources of a provider above it, one ask for two layouts reading one key', async () => {
		const layout = {
			context: CONTEXT,
			blocks: [ node( 'weka-7711/gauge', { berth: 'south-7726' } ) ],
		};
		const views = { ...VIEWS, 'weka-7711/gauge': { View: Gauge } };
		render(
			<SourcesProvider>
				<ComposedLayout
					layout={ layout }
					views={ views }
					page={ page() }
				/>
				<div hidden>
					<ComposedLayout
						layout={ layout }
						views={ views }
						page={ page() }
					/>
				</div>
			</SourcesProvider>
		);

		await waitFor(
			() => expect( sent( 'sound' ) ).toHaveLength( 1 ),
			WAIT
		);
		await waitFor(
			() =>
				expect(
					screen
						.getAllByTestId( 'gauge' )
						.map( ( gauge ) => gauge.textContent )
				).toEqual( [ 'sounded', 'sounded' ] ),
			WAIT
		);
		expect( sent( 'sound' ) ).toHaveLength( 1 );
		expect( sent( 'sound' )[ 0 ].arguments ).toEqual( [ 'south-7726' ] );
	} );

	it( 'serves its blocks’ sources, one ask for a block at the top and one in a column sharing one', async () => {
		render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'weka-7711/gauge', { berth: 'north-7725' } ),
						node( 'core/columns', {}, [
							node( 'core/column', {}, [
								node( 'weka-7711/gauge', {
									berth: 'north-7725',
								} ),
							] ),
						] ),
					],
				} }
				views={ { ...VIEWS, 'weka-7711/gauge': { View: Gauge } } }
				page={ page() }
			/>
		);

		expect( screen.getAllByTestId( 'gauge' ) ).toHaveLength( 2 );
		await waitFor(
			() => expect( sent( 'sound' ) ).toHaveLength( 1 ),
			WAIT
		);
		expect( sent( 'sound' )[ 0 ].arguments ).toEqual( [ 'north-7725' ] );
	} );

	it( 'stands core columns, each column at its width, the blocks in each', () => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'core/columns', {}, [
							node( 'core/column', { width: '62.5%' }, [
								node( 'weka-7711/tally', {
									label: 'Ferry count',
								} ),
								node( 'weka-7711/tally', {
									label: 'Pier count',
								} ),
							] ),
							node( 'core/column', {}, [
								node( 'weka-7711/tally', {
									label: 'Dock count',
								} ),
							] ),
						] ),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		const columns = container.querySelectorAll(
			'.newspack-nodes-composed-layout > div.wp-block-columns > div.wp-block-column'
		);
		expect( columns ).toHaveLength( 2 );
		expect( columns[ 0 ].style.flexBasis ).toBe( '62.5%' );
		expect( columns[ 1 ].style.flexBasis ).toBe( '' );
		expect(
			[ ...columns ].map( ( column ) =>
				within( column )
					.getAllByTestId( 'tally' )
					.map( ( p ) => p.textContent )
			)
		).toEqual( [
			[ 'Ferry count at Kestrel', 'Pier count at Kestrel' ],
			[ 'Dock count at Kestrel' ],
		] );
	} );

	it( 'writes each core text block’s text, filtered by the server, in core’s own element', () => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'core/heading', {
							level: 3,
							content: 'Tide <em>7930</em>',
						} ),
						node( 'core/paragraph', {
							content: 'Moor <strong>7931</strong>',
						} ),
						node( 'core/list', { ordered: true }, [
							node( 'core/list-item', {
								content: 'Buoy <code>7932</code>',
							} ),
						] ),
						node( 'core/separator', { tagName: 'hr' } ),
						node( 'core/spacer', { height: '48px' } ),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		const layout = container.querySelector(
			'.newspack-nodes-composed-layout'
		);
		expect(
			layout.querySelector( ':scope > h3.wp-block-heading' ).innerHTML
		).toBe( 'Tide <em>7930</em>' );
		expect( layout.querySelector( ':scope > p' ).innerHTML ).toBe(
			'Moor <strong>7931</strong>'
		);
		expect(
			layout.querySelector( ':scope > ol.wp-block-list > li' ).innerHTML
		).toBe( 'Buoy <code>7932</code>' );
		expect(
			layout.querySelector( ':scope > hr.wp-block-separator' )
		).not.toBeNull();
		const spacer = layout.querySelector( ':scope > div.wp-block-spacer' );
		expect( spacer.style.height ).toBe( '48px' );
		expect( spacer.getAttribute( 'aria-hidden' ) ).toBe( 'true' );
	} );

	it( 'writes each core attribute a layout keeps as core’s own class or style', () => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node(
							'core/columns',
							{
								isStackedOnMobile: false,
								verticalAlignment: 'center',
							},
							[
								node(
									'core/column',
									{ verticalAlignment: 'bottom' },
									[
										node( 'core/spacer', {
											height: '18px',
											width: '7942px',
										} ),
									]
								),
							]
						),
						node(
							'core/list',
							{
								ordered: true,
								reversed: true,
								start: 7943,
								type: 'upper-roman',
							},
							[
								node( 'core/list-item', {
									content: 'Dory 7943',
								} ),
							]
						),
						node( 'core/group', {
							tagName: 'div',
							layout: { type: 'default' },
						} ),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		const layout = container.querySelector(
			'.newspack-nodes-composed-layout'
		);
		expect(
			layout.querySelector( ':scope > .wp-block-columns' ).className
		).toBe(
			'wp-block-columns are-vertically-aligned-center is-not-stacked-on-mobile'
		);
		expect( layout.querySelector( '.wp-block-column' ).className ).toBe(
			'wp-block-column is-vertically-aligned-bottom'
		);
		expect( layout.querySelector( '.wp-block-spacer' ).style.width ).toBe(
			'7942px'
		);
		const list = layout.querySelector( ':scope > ol.wp-block-list' );
		expect( list.getAttribute( 'start' ) ).toBe( '7943' );
		expect( list.hasAttribute( 'reversed' ) ).toBe( true );
		expect( list.style.listStyleType ).toBe( 'upper-roman' );
		expect(
			layout.querySelector( ':scope > .wp-block-group' ).className
		).toBe( 'wp-block-group is-layout-flow wp-block-group-is-layout-flow' );
	} );

	it( 'writes each element, direction and flex size a layout keeps', () => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'core/paragraph', {
							direction: 'rtl',
							content: 'Kotare 7960',
						} ),
						node(
							'core/group',
							{ tagName: 'aside', layout: { type: 'flex' } },
							[
								node( 'core/spacer', {
									height: '0px',
									style: {
										layout: {
											flexSize: '7961px',
											selfStretch: 'fixed',
										},
									},
								} ),
								node( 'core/spacer', {
									height: '100px',
									style: { layout: { selfStretch: 'fill' } },
								} ),
								node( 'core/spacer', {
									height: '100px',
									style: { layout: { selfStretch: 'fit' } },
								} ),
							]
						),
						node( 'core/separator', { tagName: 'div' } ),
						node( 'core/columns', { isStackedOnMobile: true }, [
							node( 'core/column', {
								width: '40%',
								layout: {
									type: 'flex',
									orientation: 'vertical',
								},
							} ),
						] ),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		const layout = container.querySelector(
			'.newspack-nodes-composed-layout'
		);
		expect(
			layout.querySelector( ':scope > p' ).getAttribute( 'dir' )
		).toBe( 'rtl' );
		const [ fixed, fill, fit ] = layout.querySelectorAll(
			':scope > aside.wp-block-group > .wp-block-spacer'
		);
		expect( [ fixed.style.flexBasis, fixed.style.flexGrow ] ).toEqual( [
			'7961px',
			'',
		] );
		expect( fill.style.flexGrow ).toBe( '1' );
		expect( [ fill.style.height, fit.style.height ] ).toEqual( [ '', '' ] );
		expect(
			layout.querySelector( ':scope > div.wp-block-separator' )
		).not.toBeNull();
		const column = layout.querySelector( '.wp-block-column' );
		expect( column.className ).toBe(
			'wp-block-column is-layout-flex wp-block-column-is-layout-flex'
		);
		expect( [
			column.style.display,
			column.style.flexDirection,
			column.style.flexBasis,
		] ).toEqual( [ 'flex', 'column', '40%' ] );
	} );

	it( 'stacks core columns on a phone unless the layout says otherwise', () => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'core/columns', { isStackedOnMobile: true } ),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		expect( container.querySelector( '.wp-block-columns' ).className ).toBe(
			'wp-block-columns'
		);
	} );

	it.each( [
		[
			'a vertical flex',
			{ type: 'flex', orientation: 'vertical', justifyContent: 'center' },
			{ display: 'flex', flexDirection: 'column', alignItems: 'center' },
		],
		[
			'a row that does not wrap',
			{ type: 'flex', flexWrap: 'nowrap', justifyContent: 'right' },
			{
				display: 'flex',
				flexDirection: 'row',
				flexWrap: 'nowrap',
				justifyContent: 'flex-end',
				alignItems: 'center',
			},
		],
		[
			'a grid of three',
			{ type: 'grid', columnCount: 3 },
			{
				display: 'grid',
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			},
		],
		[ 'no layout', undefined, { display: '' } ],
	] )( 'lays out a group as %s', ( _name, layout, style ) => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node(
							'core/group',
							layout
								? { tagName: 'div', layout }
								: { tagName: 'div' },
							[
								node( 'weka-7711/tally', {
									label: 'Weir 7933',
								} ),
							]
						),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		const group = container.querySelector(
			'.newspack-nodes-composed-layout > div.wp-block-group'
		);
		expect( group.textContent ).toBe( 'Weir 7933 at Kestrel' );
		for ( const [ property, value ] of Object.entries( style ) ) {
			expect( [ property, group.style[ property ] ] ).toEqual( [
				property,
				value,
			] );
		}
	} );

	it( 'keeps each block mounted across renders handed a fresh views map', () => {
		const mounts = jest.fn();
		const Buoy = () => {
			useEffect( () => mounts(), [] );
			return <p data-testid="buoy">Buoy 7714</p>;
		};
		const Page = ( { tide } ) => (
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [ node( 'weka-7711/buoy' ) ],
				} }
				views={ { 'weka-7711/buoy': { View: Buoy } } }
				page={ page( { harbor: tide } ) }
			/>
		);
		const { rerender } = render( <Page tide="Ebb" /> );

		rerender( <Page tide="Flood" /> );
		rerender( <Page tide="Slack" /> );

		expect( mounts ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'provides each View’s editing to the write controls it holds', () => {
		const onMoor = jest.fn();
		const Moor = () => (
			<button type="button" { ...useWriteControl( onMoor ) }>
				Moor at B-7713
			</button>
		);
		const Berth = () => <Moor />;
		// An edited frame above the layout, which its read blocks must not inherit.
		render(
			<Editing.Provider value={ true }>
				<ComposedLayout
					layout={ {
						context: CONTEXT,
						blocks: [ node( 'weka-7711/berth' ) ],
					} }
					views={ { 'weka-7711/berth': { View: Berth } } }
					page={ page() }
				/>
			</Editing.Provider>
		);
		const button = screen.getByRole( 'button', { name: 'Moor at B-7713' } );

		fireEvent.click( button );

		expect( onMoor ).toHaveBeenCalledTimes( 1 );
		expect( button.hasAttribute( 'aria-disabled' ) ).toBe( false );
	} );

	it( 'names why a block could not render to an operator the page names', () => {
		render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'weka-7711/heron-gone' ),
						node( 'weka-7711/tally', { label: 'Ferry count' } ),
					],
				} }
				views={ VIEWS }
				page={ page( { operator: true } ) }
			/>
		);

		expect(
			screen
				.getByText( 'weka-7711/heron-gone has no view' )
				.classList.contains( 'is-muted' )
		).toBe( true );
		expect( screen.getByTestId( 'tally' ).textContent ).toBe(
			'Ferry count at Kestrel'
		);
	} );

	it( 'renders a block that cannot render as the shared read error by default', () => {
		render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [ node( 'weka-7711/heron-gone' ) ],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		expect( screen.getByRole( 'status' ).textContent ).toContain(
			'This could not be read just now.'
		);
		expect(
			screen.getByRole( 'button', { name: 'Try again' } )
		).toBeTruthy();
	} );

	it( 'renders a refused layout as the read error with no Restore for a reader', () => {
		render(
			<ComposedLayout
				layout={ REFUSED }
				views={ VIEWS }
				page={ page() }
			/>
		);

		expect( screen.getByRole( 'status' ).textContent ).toBe(
			'This could not be read just now.'
		);
		expect(
			screen.queryByRole( 'button', { name: 'Restore default' } )
		).toBeNull();
	} );

	it( 'words a refused declaration for an operator and offers no Restore default', () => {
		render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					error: 'composition declaration heron-9034: refused',
					declaration: true,
				} }
				views={ VIEWS }
				page={ page( { canTune: true, operator: true } ) }
			/>
		);

		expect(
			screen.getByText(
				'A plugin\u2019s composition declaration was refused. The server log says why.'
			)
		).toBeTruthy();
		expect(
			screen.queryByRole( 'button', { name: 'Restore default' } )
		).toBeNull();
		expect(
			screen.queryByText(
				'This layout names a block or a setting this version does not have.'
			)
		).toBeNull();
	} );

	it( 'names why a layout was refused to an operator the page names alone', () => {
		const { rerender } = render(
			<ComposedLayout
				layout={ REFUSED }
				views={ VIEWS }
				page={ page( { operator: true } ) }
			/>
		);
		expect(
			screen.getByText( REFUSED.error ).classList.contains( 'is-muted' )
		).toBe( true );

		rerender(
			<ComposedLayout
				layout={ REFUSED }
				views={ VIEWS }
				page={ page() }
			/>
		);
		expect( screen.queryByText( REFUSED.error ) ).toBeNull();
		expect( screen.getByRole( 'status' ).textContent ).toBe(
			'This could not be read just now.'
		);
	} );

	it( 'asks a curator first, then restores the context and hands back the default', async () => {
		const onRestored = jest.fn();
		render(
			<ComposedLayout
				layout={ REFUSED }
				views={ VIEWS }
				page={ page( { canTune: true, onRestored } ) }
			/>
		);

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Restore default' } )
		);
		const dialog = screen.getByRole( 'dialog' );
		expect( dialog.textContent ).toContain( 'Restore the default layout?' );
		expect( sent( 'restore' ) ).toEqual( [] );

		fireEvent.click(
			within( dialog ).getByRole( 'button', { name: 'Restore default' } )
		);
		await waitFor(
			() => expect( onRestored ).toHaveBeenCalledTimes( 1 ),
			WAIT
		);

		expect( onRestored ).toHaveBeenCalledWith( RESTORED );
		expect( sent( 'restore' ) ).toEqual( [
			expect.objectContaining( { arguments: [ CONTEXT ] } ),
		] );
		expect(
			Core.node( 'compositions:weka-7711:board:restore:fetch' ).target
		).toBe( 'kestrel-desk:shell/_http/compositions' );
		expect( screen.queryByRole( 'dialog' ) ).toBeNull();
	} );

	it( 'restores nothing when the curator cancels', async () => {
		render(
			<ComposedLayout
				layout={ REFUSED }
				views={ VIEWS }
				page={ page( { canTune: true } ) }
			/>
		);

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Restore default' } )
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'Cancel' } ) );
		// The hook's own read of the context settles before the test ends.
		await waitFor( () => {
			expect( sent( 'get' ) ).toHaveLength( 1 );
			expect(
				Core.node( 'compositions:weka-7711:board:get:fetch' ).outbox
			).toEqual( [] );
		}, WAIT );

		expect( screen.queryByRole( 'dialog' ) ).toBeNull();
		expect( sent( 'restore' ) ).toEqual( [] );
	} );

	it( 'shows a refused restore', async () => {
		replyFor.mockImplementation(
			() => new Error( `composition ${ CONTEXT }: tune required` )
		);
		const onRestored = jest.fn();
		render(
			<ComposedLayout
				layout={ REFUSED }
				views={ VIEWS }
				page={ page( { canTune: true, onRestored } ) }
			/>
		);

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Restore default' } )
		);
		fireEvent.click(
			within( screen.getByRole( 'dialog' ) ).getByRole( 'button', {
				name: 'Restore default',
			} )
		);

		await waitFor(
			() =>
				expect( screen.getByRole( 'alert' ).textContent ).toBe(
					`composition ${ CONTEXT }: tune required`
				),
			WAIT
		);
		expect( onRestored ).not.toHaveBeenCalled();
	} );

	it( 'renders nothing for a layout with no blocks', () => {
		const { container } = render(
			<ComposedLayout
				layout={ { context: CONTEXT, blocks: [] } }
				views={ VIEWS }
				page={ page() }
			/>
		);

		expect( container.innerHTML ).toBe( '' );
	} );
} );
