/* eslint-env jest */
/**
 * ComposedPageFrame — a composed page with no tabs around it: its layout,
 * Edit layout for a curator, and on its edit load the editor in the
 * layout's place.
 */

import { act, render, screen } from '@testing-library/react';
import { createPortal, useEffect, useState } from '@wordpress/element';
import { registerCompositionEditor } from '../../editorRegistry';
import ComposedPageFrame from '../ComposedPageFrame';
import { usePage } from '../pageContext';

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

it( 'offers its blocks a box inside the header slot its controls go to', () => {
	const slot = document.createElement( 'div' );
	let offered;
	const views = {
		'acme-7950/kaka': {
			View: function Kaka() {
				offered = usePage().headerSlot;
				return null;
			},
		},
	};
	render(
		<ComposedPageFrame
			context="acme-7950/roost"
			page="roost-7950"
			pages={ PAGES }
			group="roost-7950"
			canTune={ false }
			canManage={ false }
			layout={ LAYOUT }
			views={ views }
			headerControlsSlot={ slot }
		/>
	);
	expect( offered ).not.toBe( slot );
	expect( slot.contains( offered ) ).toBe( true );
} );

it( 'orders its header: its controls, then its blocks’ toolbars, then the layout menu', async () => {
	const slot = document.createElement( 'div' );
	document.body.appendChild( slot );
	/** A block whose toolbar arrives a render after it mounts, as a stream's does. */
	function Late() {
		const [ ready, setReady ] = useState( false );
		const { headerSlot } = usePage();
		useEffect( () => setReady( true ), [] );
		return ready && headerSlot
			? createPortal( <span>toolbar 7976</span>, headerSlot )
			: null;
	}
	render(
		<ComposedPageFrame
			context="acme-7950/roost"
			page="roost-7950"
			pages={ PAGES }
			group="roost-7950"
			canTune
			canManage={ false }
			layout={ LAYOUT }
			views={ { 'acme-7950/kaka': { View: Late } } }
			headerControlsSlot={ slot }
			controls={ <span>controls 7976</span> }
		/>
	);
	await act( async () => {} );
	const order = [ 'controls 7976', 'toolbar 7976', 'Layout actions' ].map(
		( text ) =>
			slot.querySelector( `[aria-label="${ text }"]` ) ??
			[ ...slot.querySelectorAll( 'span' ) ].find(
				( one ) => text === one.textContent
			)
	);
	expect( order.every( Boolean ) ).toBe( true );
	expect(
		order[ 0 ].compareDocumentPosition( order[ 1 ] ) &
			window.Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	expect(
		order[ 1 ].compareDocumentPosition( order[ 2 ] ) &
			window.Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	slot.remove();
} );
