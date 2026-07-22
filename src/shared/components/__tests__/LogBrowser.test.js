/**
 * LogBrowser tests — the shared browse sidebar: a Live/Replay control pair over a
 * selectable item list, generic across the Partition Viewer's segments and the
 * Log Viewer's sources (render-prop item shaping).
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
	expect( items.length ).toBe( 3 );
	expect( container.textContent ).toMatch( /segment 8/ );
	expect( container.textContent ).toMatch( /50 B/ );
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

it( 'keeps the selected source lit even while live (source picker)', () => {
	const { container } = renderSegments( { mode: 'live', selectedKey: 5 } );
	const active = container.querySelector(
		'.newspack-nodes-log-browser__item.is-active'
	);
	expect( active.textContent ).toMatch( /segment 5/ );
} );

it( 'disables an item flagged unavailable so it cannot be picked', () => {
	const onSelectItem = jest.fn();
	const { container } = renderSegments( {
		items: [
			{ id: 4, size: 1 },
			{ id: 5, size: 2 },
		],
		itemDisabled: ( s ) => s.id === 5,
		onSelectItem,
	} );
	const buttons = container.querySelectorAll(
		'.newspack-nodes-log-browser__item'
	);
	expect( buttons[ 1 ].disabled ).toBe( true );
	fireEvent.click( buttons[ 1 ] );
	expect( onSelectItem ).not.toHaveBeenCalled();
} );

it( 'shows the empty label when there are no items', () => {
	const { container } = renderSegments( { items: [] } );
	expect( container.textContent ).toMatch( /No segments/ );
} );
