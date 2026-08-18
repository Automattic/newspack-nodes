/**
 * LogStreamViewer tests — the extension surface adopter dashboards use
 * (ELN's Request Log / Error Log): title, toolbar extras, below-toolbar
 * panel, list header, matchRow passthrough, label overrides, and optional
 * step/jump (hidden until the consumer provides handlers). The core chrome
 * is pinned through the PartitionViewer / LogViewer suites.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import LogStreamViewer from '../LogStreamViewer';

let logRowListProps;
jest.mock( '../LogRowList', () => ( {
	__esModule: true,
	DEBUG_MAX_ROWS: 500,
	default: ( props ) => {
		logRowListProps = props;
		return <div data-testid="log-row-list" />;
	},
} ) );

const BASE = {
	className: 'test-viewer',
	ariaLabel: 'Test viewer',
	pickerOptions: [ { key: 'a', label: 'A' } ],
	selectedKey: 'a',
	onPick: () => {},
	pickerEmptyLabel: 'None',
	isPaused: false,
	connectionError: false,
	onTogglePause: () => {},
	onStep: () => {},
	getViewNode: () => null,
	sidebar: null,
	renderRow: () => null,
	rowHeight: 18,
};

beforeEach( () => {
	logRowListProps = undefined;
} );

// Every other toolbar control travels as a message through the consumer's
// graph; Clear used to poke the node's ring, which left the id stamp and the
// rate smoother loaded and was overwritten within 250ms by the next frame.
it( 'sends Clear through the consumer, not into the node', () => {
	const onClear = jest.fn();
	const node = { lines: [ { id: 1 } ] };
	const { getByText } = render(
		<LogStreamViewer
			{ ...BASE }
			getViewNode={ () => node }
			onClear={ onClear }
		/>
	);

	fireEvent.click( getByText( 'Clear' ) );

	expect( onClear ).toHaveBeenCalledTimes( 1 );
	expect( node.lines ).toEqual( [ { id: 1 } ] );
} );

it( 'renders the debug row with a KEY column, and drops it when keyless', () => {
	const row = {
		id: 9,
		msgId: '3:120:44',
		key: 'jobstats',
		content: 'jobstats: {"n":4}',
	};
	const keyed = render( <LogStreamViewer { ...BASE } /> );
	fireEvent.click( keyed.getByText( 'Debug' ) );
	const withKey = render( logRowListProps.renderRow( row ) ).container;
	keyed.unmount();

	const bare = render(
		<LogStreamViewer { ...BASE } hasKeyColumn={ false } />
	);
	fireEvent.click( bare.getByText( 'Debug' ) );
	const keyless = render( logRowListProps.renderRow( row ) ).container;

	expect(
		withKey.querySelector( '.newspack-nodes-log-row__key' ).textContent
	).toBe( 'jobstats' );
	expect(
		keyless.querySelector( '.newspack-nodes-log-row__key' )
	).toBeNull();
	expect(
		keyless.querySelector( '.newspack-nodes-log-row__id' ).textContent
	).toBe( '3:120:44' );
} );

it( 'renders a title heading when given one', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } title="Request Log" />
	);
	const header = container.querySelector( '.test-viewer__header' );
	expect( container.querySelector( 'h1' ).textContent ).toBe( 'Request Log' );
	expect(
		header.classList.contains( 'newspack-nodes-request-stream-header' )
	).toBe( true );
} );

it( 'renders toolbarExtras before Clear and belowToolbar after the banner', () => {
	const { container, getByText } = render(
		<LogStreamViewer
			{ ...BASE }
			toolbarExtras={ <button className="extra-btn">Cols</button> }
			belowToolbar={ <div className="picker-panel">panel</div> }
		/>
	);
	const buttons = [ ...container.querySelectorAll( 'button' ) ];
	const extraIdx = buttons.findIndex( ( b ) => b.textContent === 'Cols' );
	const clearIdx = buttons.findIndex( ( b ) => b.textContent === 'Clear' );
	expect( extraIdx ).toBeGreaterThan( -1 );
	expect( extraIdx ).toBeLessThan( clearIdx );
	expect( getByText( 'panel' ) ).toBeTruthy();
} );

it( 'renders a listHeader above the row list', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			listHeader={ <div className="col-headers">headers</div> }
		/>
	);
	const main = container.querySelector( '.test-viewer__main' );
	expect( main ).not.toBeNull();
	expect( main.querySelector( '.col-headers' ) ).not.toBeNull();
	expect(
		main.querySelector( '[data-testid="log-row-list"]' )
	).not.toBeNull();
} );

it( 'sends the filter term to the consumer and honours the placeholder', () => {
	const onFilter = jest.fn();
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			onFilter={ onFilter }
			filterPlaceholder="Filter by URL…"
		/>
	);
	const input = container.querySelector( '.newspack-nodes-search-input' );

	fireEvent.change( input, { target: { value: 'oops' } } );

	// The consumer forwards it to the view node's ingest gate; the list is
	// never told, because the ring already holds only what is displayed.
	expect( onFilter ).toHaveBeenLastCalledWith( 'oops' );
	expect( logRowListProps.filter ).toBeUndefined();
	expect( input.placeholder ).toBe( 'Filter by URL…' );
} );

it( 'label overrides: renderCount and renderRate replace the defaults', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			renderCount={ ( stats ) => `${ stats.total } requests` }
			renderRate={ ( lps ) => `${ lps.toFixed( 1 ) } req/s` }
		/>
	);
	// Stats start at zero; the custom count formatter still renders.
	expect( container.textContent ).toContain( '0 requests' );
} );

it( 'hides step and jump when the consumer provides no handlers', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			onStep={ undefined }
			onJump={ undefined }
		/>
	);
	expect(
		container.querySelector( '.newspack-nodes-offset-input' )
	).toBeNull();
	const titles = [ ...container.querySelectorAll( 'button' ) ].map(
		( b ) => b.textContent
	);
	expect( titles ).not.toContain( '⏭' );
} );

it( 'stats sit left of ALL inputs (picker included) — no control bounces', () => {
	const { container } = render( <LogStreamViewer { ...BASE } /> );
	const toolbar = container.querySelector( '.newspack-nodes-toolbar' );
	const children = [ ...toolbar.children ];
	const stats = children.findIndex( ( el ) =>
		el.classList.contains( 'newspack-nodes-toolbar-stats' )
	);
	expect( stats ).toBe( 0 );
} );

// Every other control in the toolbar carries a title; a bare combo box reads
// as unnamed to a screen reader.
it( 'the picker carries the accessible name its caller declares', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } pickerLabel="Browse a partition" />
	);
	const select = container.querySelector( '.newspack-nodes-select' );
	expect( select.getAttribute( 'aria-label' ) ).toBe( 'Browse a partition' );
	expect( select.getAttribute( 'title' ) ).toBe( 'Browse a partition' );
} );

it( 'pickerOptions null renders neither a picker nor the empty status', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } pickerOptions={ null } />
	);
	expect( container.querySelector( '.newspack-nodes-select' ) ).toBeNull();
	expect( container.textContent ).not.toContain( 'None' );
} );

describe( 'rail toggle', () => {
	beforeEach( () => {
		window.localStorage.clear();
	} );

	it( 'collapses and reopens the sidebar, remembering the choice', () => {
		const { container } = render(
			<LogStreamViewer
				{ ...BASE }
				sidebar={ <div className="the-rail">rail</div> }
			/>
		);
		expect( container.querySelector( '.the-rail' ) ).not.toBeNull();
		const toggle = container.querySelector( '.newspack-nodes-rail-toggle' );
		expect( toggle ).not.toBeNull();
		expect( toggle.getAttribute( 'aria-label' ) ).toBe(
			'Hide the browse rail'
		);
		expect( toggle.getAttribute( 'aria-expanded' ) ).toBe( 'true' );

		fireEvent.click( toggle );
		expect( container.querySelector( '.the-rail' ) ).toBeNull();
		expect(
			window.localStorage.getItem( 'newspack-nodes-rail:test-viewer' )
		).toBe( 'closed' );

		const reopen = container.querySelector( '.newspack-nodes-rail-toggle' );
		expect( reopen.getAttribute( 'aria-label' ) ).toBe(
			'Show the browse rail'
		);
		expect( reopen.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
		fireEvent.click( reopen );
		expect( container.querySelector( '.the-rail' ) ).not.toBeNull();
	} );

	it( 'starts collapsed when the stored preference says closed', () => {
		window.localStorage.setItem(
			'newspack-nodes-rail:test-viewer',
			'closed'
		);
		const { container } = render(
			<LogStreamViewer
				{ ...BASE }
				sidebar={ <div className="the-rail">rail</div> }
			/>
		);
		expect( container.querySelector( '.the-rail' ) ).toBeNull();
	} );

	it( 'renders no toggle when there is no sidebar', () => {
		const { container } = render(
			<LogStreamViewer { ...BASE } sidebar={ null } />
		);
		expect(
			container.querySelector( '.newspack-nodes-rail-toggle' )
		).toBeNull();
	} );
} );

it( 'the rate line always renders (0.0 included)', () => {
	const { container } = render( <LogStreamViewer { ...BASE } /> );
	// Zero rate still occupies its line, so the header height never shifts.
	expect(
		container.querySelector( '.newspack-nodes-toolbar-stats__rps' )
			.textContent
	).toContain( '0.0' );
} );

it( 'the list keeps ONE tree position across the debug toggle', () => {
	// Without a stable wrapper, a headerless viewer (Log Viewer live mode)
	// remounts LogRowList on every debug toggle — fresh refs replayed the
	// whole ring as a glide.
	const { container, getByText } = render(
		<LogStreamViewer { ...BASE } listHeader={ null } />
	);
	expect( container.querySelector( '.test-viewer__main' ) ).not.toBeNull();
	fireEvent.click( getByText( 'Debug' ) );
	expect( container.querySelector( '.test-viewer__main' ) ).not.toBeNull();
} );

it( 're-sends the filter when the graph is rebuilt', () => {
	// The gate lives on the view node, which a rebuild replaces; the input
	// would keep showing the term while the fresh node admitted everything.
	const onFilter = jest.fn();
	const { container } = render(
		<LogStreamViewer { ...BASE } onFilter={ onFilter } />
	);
	fireEvent.change(
		container.querySelector( '.newspack-nodes-search-input' ),
		{ target: { value: 'zebra' } }
	);
	onFilter.mockClear();

	act( () => {
		Core.bumpGraphGeneration();
	} );

	expect( onFilter ).toHaveBeenLastCalledWith( 'zebra' );
} );

it( 'types without an onFilter consumer rather than throwing', () => {
	// Published through @newspack-nodes/shared, where knip cannot see a
	// changed export: an unmigrated adopter must not die on a keystroke.
	const { container } = render( <LogStreamViewer { ...BASE } /> );

	expect( () =>
		fireEvent.change(
			container.querySelector( '.newspack-nodes-search-input' ),
			{ target: { value: 'x' } }
		)
	).not.toThrow();
} );
