/* eslint-env jest */
/**
 * A composed page's layout as a reader reads it: each block by its view
 * under the page it stands on, the aside in a column of its own, a block
 * that cannot render in its own place, and nothing for an empty layout. A
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
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { ASIDE, ComposedLayout, usePage } from '..';

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
	it( 'stands the aside in a column of its own, the other blocks in main', () => {
		const { container } = render(
			<ComposedLayout
				layout={ {
					context: CONTEXT,
					blocks: [
						node( 'weka-7711/tally', { label: 'Ferry count' } ),
						node( ASIDE, {}, [
							node( 'weka-7711/tally', { label: 'Dock count' } ),
						] ),
						node( 'weka-7711/tally', { label: 'Pier count' } ),
					],
				} }
				views={ VIEWS }
				page={ page() }
			/>
		);

		const layout = container.querySelector(
			'.newspack-nodes-composed-layout'
		);
		const main = layout.querySelector(
			':scope > .newspack-nodes-composed-layout-main'
		);
		const aside = layout.querySelector(
			':scope > aside.newspack-nodes-composed-aside'
		);
		expect(
			within( main )
				.getAllByTestId( 'tally' )
				.map( ( p ) => p.textContent )
		).toEqual( [ 'Ferry count at Kestrel', 'Pier count at Kestrel' ] );
		expect(
			within( aside )
				.getAllByTestId( 'tally' )
				.map( ( p ) => p.textContent )
		).toEqual( [ 'Dock count at Kestrel' ] );
	} );

	it( 'renders a block that cannot render by the renderError given', () => {
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
				page={ page() }
				renderError={ ( error ) => (
					<p data-testid="refused">{ error.message }</p>
				) }
			/>
		);

		expect( screen.getByTestId( 'refused' ).textContent ).toBe(
			'weka-7711/heron-gone has no view'
		);
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
