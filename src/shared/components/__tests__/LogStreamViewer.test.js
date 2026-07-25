/**
 * LogStreamViewer tests — the extension surface adopter dashboards use
 * (ELN's Request Log / Error Log): title, toolbar extras, below-toolbar
 * panel, list header, matchRow passthrough, label overrides, and optional
 * step/jump (hidden until the consumer provides handlers). The core chrome
 * is pinned through the PartitionViewer / LogViewer suites.
 */

import { render } from '@testing-library/react';
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
	getLastEventTime: () => null,
	sidebar: null,
	renderRow: () => null,
	rowHeight: 18,
};

beforeEach( () => {
	logRowListProps = undefined;
} );

it( 'renders a title heading when given one', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } title="Request Log" />
	);
	expect( container.querySelector( 'h1' ).textContent ).toBe( 'Request Log' );
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

it( 'passes matchRow and filterPlaceholder through', () => {
	const matchRow = () => true;
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			matchRow={ matchRow }
			filterPlaceholder="Filter by URL…"
		/>
	);
	expect( logRowListProps.matchRow ).toBe( matchRow );
	expect(
		container.querySelector( '.newspack-nodes-search-input' ).placeholder
	).toBe( 'Filter by URL…' );
} );

it( 'label overrides: renderCount and renderRate replace the defaults', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			renderCount={ ( stats ) => `${ stats.visible } requests` }
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

it( 'pickerOptions null renders neither a picker nor the empty status', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } pickerOptions={ null } />
	);
	expect( container.querySelector( '.newspack-nodes-select' ) ).toBeNull();
	expect( container.textContent ).not.toContain( 'None' );
} );
