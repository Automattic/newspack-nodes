/* eslint-env jest */
/**
 * StationLayout — a station tab as a composed page: its chrome over the
 * layout its context reads, Edit layout in its ⋯ menu for a `tune` reader
 * alone, and on an edit load for its page the context's editor in the
 * layout's place, whose answer the tab then reads; while the editor holds a
 * change, a tab switch asks before it discards it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { registerCompositionEditor } from '@newspack-nodes/shared/composition/editorRegistry';
import { editSearch } from '@newspack-nodes/shared/composition/page';
import TabHost from '@newspack-nodes/shared/tabs/TabHost';
import {
	registerTab,
	resetTabs,
} from '@newspack-nodes/shared/tabs/tabRegistry';
import StationLayout from '../StationLayout';
import { beforeStationLeave } from '../leaveGuard';
import { STATION_PAGES } from '../stationPages';

/** A block that shows its one attribute. */
const VIEWS = {
	'newspack-nodes/weka-7920': {
		View: ( { attributes } ) => <p>{ `weka ${ attributes.call }` }</p>,
	},
};

/**
 * A layout answer holding one block.
 *
 * @param {string} context The context.
 * @param {string} call    The block's attribute.
 * @return {Object} The answer.
 */
const layout = ( context, call ) => ( {
	context,
	source: 'default',
	blocks: [
		{
			name: 'newspack-nodes/weka-7920',
			attributes: { call },
			inner: [],
		},
	],
	saved_ts: null,
	actor: null,
} );

/**
 * Hand the tab the page data a station load localizes.
 *
 * @param {boolean} canTune Whether the reader may curate.
 */
function localize( canTune ) {
	window.NewspackNodesStationPages = {
		canTune,
		canManage: false,
		compositions: {
			'newspack-nodes/station-jobs': layout(
				'newspack-nodes/station-jobs',
				'kia-ora-7920'
			),
		},
	};
}

/**
 * Point the address bar at a query string.
 *
 * @param {string} search The query string.
 */
const at = ( search ) =>
	window.history.replaceState( null, '', `/wp-admin/admin.php${ search }` );

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	at( '?page=newspack-nodes-station&tab=jobs' );
} );

afterEach( () => {
	delete window.NewspackNodesStationPages;
	jest.restoreAllMocks();
} );

it( 'renders its chrome over the layout its context reads', () => {
	localize( false );
	const { container } = render(
		<StationLayout page="station-jobs" views={ VIEWS }>
			<p>chrome 7920</p>
		</StationLayout>
	);
	const lines = [ ...container.querySelectorAll( 'p' ) ].map(
		( p ) => p.textContent
	);
	expect( lines ).toEqual( [ 'chrome 7920', 'weka kia-ora-7920' ] );
} );

it( 'offers no layout menu to a reader who may not tune', () => {
	localize( false );
	render( <StationLayout page="station-jobs" views={ VIEWS } /> );
	expect(
		screen.queryByRole( 'button', { name: 'Layout actions' } )
	).toBeNull();
} );

it( 'offers Edit layout to a tune reader', async () => {
	localize( true );
	render( <StationLayout page="station-jobs" views={ VIEWS } /> );
	fireEvent.click( screen.getByRole( 'button', { name: 'Layout actions' } ) );
	expect(
		await screen.findByRole( 'menuitem', { name: 'Edit layout' } )
	).toBeTruthy();
} );

it( 'edits a station page on the tab it stands over', () => {
	expect(
		editSearch(
			'?page=newspack-nodes-station&tab=jobs',
			{ page: 'station-jobs' },
			STATION_PAGES
		)
	).toBe( '?page=newspack-nodes-station&tab=jobs&edit=station-jobs' );
} );

it( 'puts its controls in the header slot it is handed', () => {
	localize( false );
	const slot = document.createElement( 'div' );
	document.body.appendChild( slot );
	render(
		<StationLayout
			page="station-jobs"
			views={ VIEWS }
			headerControlsSlot={ slot }
			controls={ <a href="#tui-7920">tui 7920</a> }
		/>
	);
	expect( slot.textContent ).toBe( 'tui 7920' );
	slot.remove();
} );

it( 'on its page’s edit, shows the editor in the layout’s place and reads its answer', () => {
	localize( true );
	at( '?page=newspack-nodes-station&tab=jobs&edit=station-jobs' );
	let done;
	registerCompositionEditor( 'newspack-nodes/station-jobs', ( slot ) => {
		done = slot.onDone;
		return <p>editor 7920</p>;
	} );
	render( <StationLayout page="station-jobs" views={ VIEWS } /> );
	expect( screen.getByText( 'editor 7920' ) ).toBeTruthy();
	expect( screen.queryByText( 'weka kia-ora-7920' ) ).toBeNull();

	act( () =>
		done( layout( 'newspack-nodes/station-jobs', 'haere-ra-7920' ), 'save' )
	);

	expect( screen.getByText( 'weka haere-ra-7920' ) ).toBeTruthy();
	expect( window.location.search ).toBe(
		'?page=newspack-nodes-station&tab=jobs'
	);
} );

it( 'leaves the edit when it unmounts mid-edit, so the next tab reads its layout', () => {
	localize( true );
	at( '?page=newspack-nodes-station&tab=jobs&edit=station-jobs' );
	registerCompositionEditor( 'newspack-nodes/station-jobs', () => (
		<p>editor 7920</p>
	) );
	const { unmount } = render(
		<StationLayout page="station-jobs" views={ VIEWS } />
	);
	unmount();
	expect( window.location.search ).toBe(
		'?page=newspack-nodes-station&tab=jobs'
	);
} );

it( 'reads the layout on another page’s edit', () => {
	localize( true );
	at( '?page=newspack-nodes-station&tab=jobs&edit=station-overview' );
	render( <StationLayout page="station-jobs" views={ VIEWS } /> );
	expect( screen.getByText( 'weka kia-ora-7920' ) ).toBeTruthy();
} );

it( 'refuses to render without the page data a station load localizes', () => {
	jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	expect( () =>
		render( <StationLayout page="station-jobs" views={ VIEWS } /> )
	).toThrow( /NewspackNodesStationPages/ );
} );

describe( 'a tab switch away from the layout editor', () => {
	let dirty;

	/**
	 * Render the station's Jobs tab mid-edit beside a Kea tab, the editor
	 * reporting through `dirty` whether it holds a change.
	 *
	 * @return {Object} The render.
	 */
	const station = () => {
		resetTabs();
		localize( true );
		at( '?page=newspack-nodes-station&tab=jobs&edit=station-jobs' );
		registerCompositionEditor( 'newspack-nodes/station-jobs', ( slot ) => {
			dirty = slot.onDirty;
			return <p>editor 7920</p>;
		} );
		registerTab( {
			id: 'jobs',
			label: 'Jobs',
			host: 'station',
			slug: 'jobs',
			params: [ 'edit' ],
			order: 0,
			beforeLeave: beforeStationLeave,
			component: () => (
				<StationLayout page="station-jobs" views={ VIEWS } />
			),
		} );
		registerTab( {
			id: 'kea',
			label: 'Kea',
			host: 'station',
			slug: 'kea',
			order: 10,
			component: () => <p>kea 7920</p>,
		} );
		return render( <TabHost host="station" syncUrl /> );
	};

	/** Land Back on the Kea tab's entry. */
	const backToKea = () =>
		act( () => {
			at( '?page=newspack-nodes-station&tab=kea' );
			window.dispatchEvent( new window.PopStateEvent( 'popstate' ) );
		} );

	it( 'asks before a pick discards the change, and keeps the edit on Keep editing', () => {
		station();
		act( () => dirty( true ) );
		fireEvent.click( screen.getByRole( 'tab', { name: 'Kea' } ) );
		expect(
			screen.getByText( 'Discard your changes to this layout?' )
		).toBeTruthy();
		expect( screen.queryByText( 'kea 7920' ) ).toBeNull();

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Keep editing' } )
		);
		expect(
			screen.queryByText( 'Discard your changes to this layout?' )
		).toBeNull();
		expect( screen.getByText( 'editor 7920' ) ).toBeTruthy();
		expect( window.location.search ).toBe(
			'?page=newspack-nodes-station&tab=jobs&edit=station-jobs'
		);
	} );

	it( 'switches on Discard changes, leaving the edit', () => {
		station();
		act( () => dirty( true ) );
		fireEvent.click( screen.getByRole( 'tab', { name: 'Kea' } ) );
		fireEvent.click(
			screen.getByRole( 'button', { name: 'Discard changes' } )
		);
		expect( screen.getByText( 'kea 7920' ) ).toBeTruthy();
		expect( window.location.search ).toBe(
			'?page=newspack-nodes-station&tab=kea'
		);
	} );

	it( 'switches with no question when the editor holds no change', () => {
		station();
		act( () => dirty( false ) );
		fireEvent.click( screen.getByRole( 'tab', { name: 'Kea' } ) );
		expect(
			screen.queryByText( 'Discard your changes to this layout?' )
		).toBeNull();
		expect( screen.getByText( 'kea 7920' ) ).toBeTruthy();
	} );

	it( 'asks before a Back discards the change, and restores the edit on Keep editing', () => {
		station();
		act( () => dirty( true ) );
		backToKea();
		expect(
			screen.getByText( 'Discard your changes to this layout?' )
		).toBeTruthy();
		expect( window.location.search ).toBe(
			'?page=newspack-nodes-station&tab=jobs&edit=station-jobs'
		);

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Keep editing' } )
		);
		expect( screen.getByText( 'editor 7920' ) ).toBeTruthy();
	} );

	it( 'shows the Back’s tab on Discard changes', () => {
		station();
		act( () => dirty( true ) );
		backToKea();
		fireEvent.click(
			screen.getByRole( 'button', { name: 'Discard changes' } )
		);
		expect( screen.getByText( 'kea 7920' ) ).toBeTruthy();
		expect( window.location.search ).toBe(
			'?page=newspack-nodes-station&tab=kea'
		);
	} );

	it( 'lets a Back go with no question when the editor holds no change', () => {
		station();
		backToKea();
		expect(
			screen.queryByText( 'Discard your changes to this layout?' )
		).toBeNull();
		expect( screen.getByText( 'kea 7920' ) ).toBeTruthy();
	} );
} );
