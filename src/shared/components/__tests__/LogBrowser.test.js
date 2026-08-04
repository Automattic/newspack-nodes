/**
 * LogBrowser tests — the shared browse sidebar: a Live/Replay control pair over
 * a selectable item list (render-prop item shaping), the segment browser both
 * log-stream dashboards render.
 */

import { render, fireEvent } from '@testing-library/react';
import LogBrowser from '../LogBrowser';

const segments = [
	{ id: 4, size: 100 },
	{ id: 5, size: 200 },
	{ id: 8, size: 50 },
];

function renderSegments( overrides = {} ) {
	const props = {
		mode: 'live',
		onFollow: jest.fn(),
		onReplay: jest.fn(),
		items: segments,
		selectedKey: null,
		onSelectItem: jest.fn(),
		itemKey: ( s ) => s.id,
		itemLabel: ( s ) => `segment ${ s.id }`,
		itemMeta: ( s ) => `${ s.size } B`,
		title: 'Segments',
		emptyLabel: 'No segments',
		...overrides,
	};
	return { props, ...render( <LogBrowser { ...props } /> ) };
}

it( 'lists each item with its label and meta', () => {
	const { container } = renderSegments();
	const items = container.querySelectorAll(
		'.newspack-nodes-log-browser__item'
	);
	const meta = container.querySelector(
		'.newspack-nodes-log-browser__item-meta'
	);
	expect( items.length ).toBe( 3 );
	expect( container.textContent ).toMatch( /segment 8/ );
	expect( container.textContent ).toMatch( /50 B/ );
	expect( meta.classList.contains( 'newspack-nodes-status' ) ).toBe( true );
} );

it( 'marks Live active and calls onFollow when clicked', () => {
	const { props, getByText } = renderSegments( { mode: 'live' } );
	const live = getByText( 'Live' );
	expect( live.className ).toMatch( /is-active/ );
	fireEvent.click( live );
	expect( props.onFollow ).toHaveBeenCalled();
} );

it( 'Live is inactive while browsing', () => {
	const { getByText } = renderSegments( { mode: 'browse', selectedKey: 5 } );
	expect( getByText( 'Live' ).className ).not.toMatch( /is-active/ );
} );

it( 'Replay calls onReplay', () => {
	const { props, getByText } = renderSegments();
	fireEvent.click( getByText( 'Replay' ) );
	expect( props.onReplay ).toHaveBeenCalled();
} );

it( 'selecting an item calls onSelectItem with that item', () => {
	const { props, getByText } = renderSegments();
	fireEvent.click( getByText( 'segment 5' ) );
	expect( props.onSelectItem ).toHaveBeenCalledWith( segments[ 1 ] );
} );

it( 'highlights the item matching selectedKey', () => {
	const { container } = renderSegments( { mode: 'browse', selectedKey: 8 } );
	const active = container.querySelector(
		'.newspack-nodes-log-browser__item.is-active'
	);
	expect( active.textContent ).toMatch( /segment 8/ );
} );

it( 'highlights nothing when selectedKey is null (live segments)', () => {
	const { container } = renderSegments( { mode: 'live', selectedKey: null } );
	expect(
		container.querySelector( '.newspack-nodes-log-browser__item.is-active' )
	).toBeNull();
} );

it( 'keeps the selected item lit even while live', () => {
	const { container } = renderSegments( { mode: 'live', selectedKey: 5 } );
	const active = container.querySelector(
		'.newspack-nodes-log-browser__item.is-active'
	);
	expect( active.textContent ).toMatch( /segment 5/ );
} );

it( 'shows the empty label when there are no items', () => {
	const { container } = renderSegments( { items: [] } );
	expect( container.textContent ).toMatch( /No segments/ );
} );

// --- Seek/live feedback: Replay highlight + last-received (activeKey) (Part B). ---

it( 'marks Replay active while replaying (mode not live)', () => {
	const { getByText } = renderSegments( { mode: 'replay' } );
	expect( getByText( 'Replay' ).className ).toMatch( /is-active/ );
	expect( getByText( 'Live' ).className ).not.toMatch( /is-active/ );
} );

it( 'leaves Replay inactive while live', () => {
	const { getByText } = renderSegments( { mode: 'live' } );
	expect( getByText( 'Replay' ).className ).not.toMatch( /is-active/ );
} );

it( 'highlights activeKey (the last-received segment) over selectedKey', () => {
	const { container } = renderSegments( {
		mode: 'replay',
		selectedKey: 4,
		activeKey: 8,
	} );
	const active = container.querySelector(
		'.newspack-nodes-log-browser__item.is-active'
	);
	expect( active.textContent ).toMatch( /segment 8/ );
} );

it( 'falls back to selectedKey when activeKey is null', () => {
	const { container } = renderSegments( {
		mode: 'replay',
		selectedKey: 5,
		activeKey: null,
	} );
	const active = container.querySelector(
		'.newspack-nodes-log-browser__item.is-active'
	);
	expect( active.textContent ).toMatch( /segment 5/ );
} );

// `selectedKey` is not always an item key. Replay-from-start sets the literal
// 'start' token, which matches no segment id — activeKey carries the highlight.
it( "highlights the received segment when selectedKey is the 'start' token", () => {
	const { container } = renderSegments( {
		mode: 'replay',
		selectedKey: 'start',
		activeKey: 5,
	} );
	const active = container.querySelector(
		'.newspack-nodes-log-browser__item.is-active'
	);
	expect( active.textContent ).toMatch( /segment 5/ );
} );

it( "highlights nothing when 'start' has not yet received a record", () => {
	const { container } = renderSegments( {
		mode: 'replay',
		selectedKey: 'start',
		activeKey: null,
	} );
	expect(
		container.querySelector( '.newspack-nodes-log-browser__item.is-active' )
	).toBeNull();
} );
