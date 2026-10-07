/**
 * LogStreamViewer tests — the extension surface adopter dashboards use
 * (ELN's Request Log / Error Log): title, toolbar extras, below-toolbar
 * panel, list header, matchRow passthrough, label overrides, and optional
 * step/jump (hidden until the consumer provides handlers). The core chrome
 * is pinned through the PartitionViewer suite.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { publishSkippedLines } from '../../test-utils/skippedLines';
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
	// Two: the picker renders only where there is a choice to make.
	pickerOptions: [
		{ key: 'a', label: 'A' },
		{ key: 'b', label: 'B' },
	],
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

it( 'shows how many lines its link reports skipped as unparseable', () => {
	Core.reset();
	publishSkippedLines( 'viewer-3316:link', 12 );
	const { container } = render(
		<LogStreamViewer { ...BASE } linkNode="viewer-3316:link" />
	);

	expect(
		container.querySelector( '.newspack-nodes-banner.is-warning' )
			.textContent
	).toBe( '12 lines would not parse and were skipped.' );
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
	const input = container.querySelector(
		'.newspack-nodes-search-input input'
	);

	fireEvent.change( input, { target: { value: 'oops' } } );

	// The consumer forwards it to the view node's ingest gate; the list is
	// never told, because the ring already holds only what is displayed.
	expect( onFilter ).toHaveBeenLastCalledWith( 'oops' );
	expect( logRowListProps.filter ).toBeUndefined();
	expect( input.placeholder ).toBe( 'Filter by URL…' );
} );

it( "the filter's reset button empties it and sends the empty term", () => {
	const onFilter = jest.fn();
	const { container, getByRole } = render(
		<LogStreamViewer { ...BASE } onFilter={ onFilter } />
	);
	const input = container.querySelector(
		'.newspack-nodes-search-input input'
	);
	fireEvent.change( input, { target: { value: 'kakapo-58' } } );
	expect( onFilter ).toHaveBeenLastCalledWith( 'kakapo-58' );

	fireEvent.click( getByRole( 'button', { name: 'Reset search' } ) );

	expect( input.value ).toBe( '' );
	expect( onFilter ).toHaveBeenLastCalledWith( '' );
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

// `aria-label` alone. The sibling buttons are named by their CONTENT, so their
// `title` is a description; a select has no content, so a `title` beside an
// aria-label is read as a second, duplicate announcement — and `title` alone is
// the weakest source, surfaced on neither keyboard focus nor touch.
it( 'the picker carries the accessible name its caller declares', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } pickerLabel="Browse a partition" />
	);
	const select = container.querySelector( '.newspack-nodes-select' );
	expect( select.getAttribute( 'aria-label' ) ).toBe( 'Browse a partition' );
	expect( select.getAttribute( 'title' ) ).toBeNull();
} );

// A caller that renders a picker and forgets the name is the defect this prop
// exists to close, so the component names it rather than trusting four callers.
it( 'the picker is named even when the caller declares nothing', () => {
	const { container } = render( <LogStreamViewer { ...BASE } /> );
	expect(
		container
			.querySelector( '.newspack-nodes-select' )
			.getAttribute( 'aria-label' )
	).toBeTruthy();
} );

// @longform
// One policy for the whole strip: `aria-label` NAMES every control, and
// `title` survives only where it says something the name does not. A glyph is
// content, so accname reads "⏭" as the name of an unlabelled step button, and
// a `title` repeating the name is announced a second time as its description.
it( 'names every toolbar control, and repeats none of them', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } onJump={ () => {} } />
	);
	const named = [
		'.newspack-nodes-select',
		'.newspack-nodes-offset-input',
	].map( ( sel ) => container.querySelector( sel ) );
	// The search control names its field with a label, so no aria-label.
	const filter = container.querySelector(
		'.newspack-nodes-search-input input'
	);
	expect( filter.labels[ 0 ].textContent ).toBe( 'Filter the stream' );
	expect( filter.getAttribute( 'title' ) ).toBeNull();
	const glyphs = [ ...container.querySelectorAll( 'button' ) ].filter(
		( b ) => /^[▶⏸⏭‹›]$/.test( b.textContent )
	);
	expect( glyphs.length ).toBeGreaterThan( 0 );
	for ( const el of [ ...named, ...glyphs ] ) {
		const label = el.getAttribute( 'aria-label' );
		expect( label ).toBeTruthy();
		expect( el.getAttribute( 'title' ) ).not.toBe( label );
	}
} );

// An empty catalog says nothing unless the caller supplies the words for it.
it( 'an empty catalog with no label renders neither picker nor status', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			pickerOptions={ [] }
			pickerEmptyLabel={ undefined }
		/>
	);
	expect( container.querySelector( '.newspack-nodes-select' ) ).toBeNull();
	expect(
		container.querySelector( '.newspack-nodes-toolbar-status' )
	).toBeNull();
} );

it( 'a lone source names itself instead of drawing a picker', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			pickerOptions={ [ { key: 'only', label: 'only.p0' } ] }
		/>
	);
	// No choice to make, but the page must still say which log is open — and
	// never the empty label, which would deny the source it is streaming.
	expect( container.querySelector( '.newspack-nodes-select' ) ).toBeNull();
	expect( container.textContent ).toContain( 'only.p0' );
	expect( container.textContent ).not.toContain( BASE.pickerEmptyLabel );
} );

it( 'two sources render the picker', () => {
	const { container } = render(
		<LogStreamViewer
			{ ...BASE }
			pickerOptions={ [
				{ key: 'one', label: 'one.p0' },
				{ key: 'two', label: 'two.p0' },
			] }
		/>
	);
	expect(
		container.querySelector( '.newspack-nodes-select' )
	).not.toBeNull();
} );

it( 'no rows renders no picker; the empty label is what speaks for them', () => {
	const { container } = render(
		<LogStreamViewer { ...BASE } pickerOptions={ null } />
	);
	expect( container.querySelector( '.newspack-nodes-select' ) ).toBeNull();
	expect( container.textContent ).toContain( BASE.pickerEmptyLabel );
} );

describe( 'rail toggle', () => {
	beforeEach( () => {
		window.localStorage.clear();
	} );

	it( 'starts collapsed when nothing is stored', () => {
		const { container } = render(
			<LogStreamViewer
				{ ...BASE }
				sidebar={ <div className="the-rail">rail</div> }
			/>
		);
		expect( container.querySelector( '.the-rail' ) ).toBeNull();
		expect(
			container
				.querySelector( '.newspack-nodes-rail-toggle' )
				.getAttribute( 'aria-expanded' )
		).toBe( 'false' );
	} );

	it( 'opens and recollapses the sidebar, remembering the choice', () => {
		const { container } = render(
			<LogStreamViewer
				{ ...BASE }
				sidebar={ <div className="the-rail">rail</div> }
			/>
		);
		const toggle = container.querySelector( '.newspack-nodes-rail-toggle' );
		expect( toggle.getAttribute( 'aria-label' ) ).toBe(
			'Show the browse rail'
		);

		fireEvent.click( toggle );
		expect( container.querySelector( '.the-rail' ) ).not.toBeNull();
		expect(
			window.localStorage.getItem( 'newspack-nodes-rail:test-viewer' )
		).toBe( 'open' );

		const reclose = container.querySelector(
			'.newspack-nodes-rail-toggle'
		);
		expect( reclose.getAttribute( 'aria-label' ) ).toBe(
			'Hide the browse rail'
		);
		expect( reclose.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		fireEvent.click( reclose );
		expect( container.querySelector( '.the-rail' ) ).toBeNull();
		expect(
			window.localStorage.getItem( 'newspack-nodes-rail:test-viewer' )
		).toBe( 'closed' );
	} );

	it( 'starts open when the stored preference says open', () => {
		window.localStorage.setItem(
			'newspack-nodes-rail:test-viewer',
			'open'
		);
		const { container } = render(
			<LogStreamViewer
				{ ...BASE }
				sidebar={ <div className="the-rail">rail</div> }
			/>
		);
		expect( container.querySelector( '.the-rail' ) ).not.toBeNull();
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
	// Without a stable wrapper, a headerless viewer (live mode)
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
		container.querySelector( '.newspack-nodes-search-input input' ),
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
			container.querySelector( '.newspack-nodes-search-input input' ),
			{ target: { value: 'x' } }
		)
	).not.toThrow();
} );

describe( 'the jump box', () => {
	const jumpBox = ( onJump ) => {
		const { container } = render(
			<LogStreamViewer { ...BASE } onJump={ onJump } />
		);
		return {
			container,
			input: container.querySelector( '.newspack-nodes-offset-input' ),
			refusal: () => container.querySelector( '[role="alert"]' ),
		};
	};
	const type = ( input, text ) =>
		fireEvent.change( input, { target: { value: text } } );

	it( 'refuses an unparseable offset where it was typed, and jumps nowhere', () => {
		const onJump = jest.fn();
		const { input, refusal } = jumpBox( onJump );
		type( input, 'quartz-9x' );
		expect( refusal() ).toBeNull();
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onJump ).not.toHaveBeenCalled();
		expect( input.value ).toBe( 'quartz-9x' );
		expect( refusal().textContent ).toBe(
			'Paste a message ID (seg:offset:len) or a bare offset.'
		);
	} );

	it( 'jumps to a parseable offset on Enter, then clears for the next', () => {
		const onJump = jest.fn();
		const { input, refusal } = jumpBox( onJump );
		type( input, ' 41:8191:12 ' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onJump ).toHaveBeenCalledWith( '41:8191:12' );
		expect( input.value ).toBe( '' );
		expect( refusal() ).toBeNull();
	} );

	it( 'jumps on Enter alone, never on blur', () => {
		const onJump = jest.fn();
		const { input } = jumpBox( onJump );
		type( input, '8191' );
		fireEvent.blur( input );
		expect( onJump ).not.toHaveBeenCalled();
		expect( input.value ).toBe( '8191' );
	} );

	it( 'keeps a refused jump in the box, and asks again on Enter', () => {
		const onJump = jest
			.fn()
			.mockReturnValueOnce( 'Pick a source to jump within.' )
			.mockReturnValueOnce( null );
		const { input, refusal } = jumpBox( onJump );
		type( input, '12:3456:200' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( input.value ).toBe( '12:3456:200' );
		expect( refusal().textContent ).toBe( 'Pick a source to jump within.' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onJump.mock.calls ).toEqual( [
			[ '12:3456:200' ],
			[ '12:3456:200' ],
		] );
		expect( input.value ).toBe( '' );
		expect( refusal() ).toBeNull();
	} );

	it( 'shows why its owner refuses a jump', () => {
		const { input, refusal } = jumpBox(
			() => 'Quartz has no segment for 8191.'
		);
		type( input, '8191' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( refusal().textContent ).toBe(
			'Quartz has no segment for 8191.'
		);
	} );
} );
