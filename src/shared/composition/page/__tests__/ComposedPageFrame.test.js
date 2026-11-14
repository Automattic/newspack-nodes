/* eslint-env jest */
/**
 * ComposedPageFrame — a composed page with no tabs around it: its layout,
 * Edit layout for a curator, and on its edit load the editor in the
 * layout's place.
 */

import { render, screen } from '@testing-library/react';
import { registerCompositionEditor } from '../../editorRegistry';
import ComposedPageFrame from '../ComposedPageFrame';

/** The page's one composed page. */
const PAGES = { 'roost-7950': { view: null, subject: null } };

/** A block that shows its one attribute. */
const VIEWS = {
	'acme-7950/kaka': {
		View: ( { attributes } ) => <p>{ `kaka ${ attributes.call }` }</p>,
	},
};

/** The layout the page reads. */
const LAYOUT = {
	context: 'acme-7950/roost',
	source: 'default',
	blocks: [
		{ name: 'acme-7950/kaka', attributes: { call: 'ka-7950' }, inner: [] },
	],
	saved_ts: null,
	actor: null,
};

/**
 * The frame on the page's layout.
 *
 * @param {boolean} canTune Whether the reader may curate.
 * @return {import('react').ReactElement} The frame.
 */
const frame = ( canTune ) => (
	<ComposedPageFrame
		context="acme-7950/roost"
		page="roost-7950"
		pages={ PAGES }
		group="roost-7950"
		canTune={ canTune }
		canManage={ false }
		layout={ LAYOUT }
		views={ VIEWS }
	/>
);

beforeEach( () => {
	window.history.replaceState( null, '', '/wp-admin/admin.php?page=x' );
} );

it( 'reads its layout', () => {
	render( frame( false ) );
	expect( screen.getByText( 'kaka ka-7950' ) ).toBeTruthy();
	expect( screen.queryByLabelText( 'Layout actions' ) ).toBeNull();
} );

it( "puts the context's editor in the layout's place on its edit load", () => {
	window.history.replaceState(
		null,
		'',
		'/wp-admin/admin.php?page=x&edit=roost-7950'
	);
	registerCompositionEditor( 'acme-7950/roost', () => (
		<p>roost editor 7950</p>
	) );
	render( frame( true ) );
	expect( screen.getByText( 'roost editor 7950' ) ).toBeTruthy();
	expect( screen.queryByText( 'kaka ka-7950' ) ).toBeNull();
} );
