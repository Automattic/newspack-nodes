/**
 * ConfigAudit — the hub's config-audit timeline over the durable settings.p0 log.
 * useSettingsAuditStream (link) is stubbed; the view model is fed via useNodeState.
 */

import { render, fireEvent } from '@testing-library/react';
import ConfigAudit from '../ConfigAudit';

jest.mock( '../hooks/useSettingsAuditStream', () => ( {
	useSettingsAuditStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeState: jest.fn(),
} ) );

import { useNodeState } from '../../runtime/react';

// 1700000042 → 2023-11-14T22:14:02Z (a fixed, not-today UTC instant).
const FIXED_TS = 1700000042;
const TODAY_TS = Math.floor( Date.now() / 1000 );

function model() {
	return {
		entries: [
			{ id: 2, ts: TODAY_TS, option: 'newspack_theme_mods' },
			{ id: 1, ts: FIXED_TS, option: 'newspack_flame_colors' },
		],
	};
}

describe( 'ConfigAudit', () => {
	it( 'renders a row per change with the option name, newest-first', () => {
		useNodeState.mockReturnValue( model() );
		const { getByText, container } = render( <ConfigAudit /> );
		expect( getByText( 'newspack_theme_mods' ) ).toBeTruthy();
		expect( getByText( 'newspack_flame_colors' ) ).toBeTruthy();
		const options = [
			...container.querySelectorAll( '.nodes-config-audit__option' ),
		].map( ( el ) => el.textContent );
		expect( options ).toEqual( [
			'newspack_theme_mods',
			'newspack_flame_colors',
		] );
	} );

	it( 'formats every row as local date + time + timezone', () => {
		useNodeState.mockReturnValue( model() );
		const { container } = render( <ConfigAudit /> );
		const times = [
			...container.querySelectorAll( '.nodes-config-audit__time' ),
		].map( ( el ) => el.textContent );
		// Both rows carry the full local date + zone — audit rows span days,
		// and a bare clock time (formerly UTC, unlabeled) was ambiguous.
		const d = new Date( FIXED_TS * 1000 );
		const expected = `${ d.toLocaleDateString(
			'en-CA'
		) } ${ d.toLocaleTimeString( 'en-US', {
			hour12: false,
			timeZoneName: 'short',
		} ) }`;
		expect( times[ 0 ] ).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/
		);
		expect( times[ 1 ] ).toBe( expected );
	} );

	it( 'renders an em dash for an entry with no timestamp', () => {
		useNodeState.mockReturnValue( {
			entries: [ { id: 1, ts: 0, option: 'newspack_untimed' } ],
		} );
		const { container } = render( <ConfigAudit /> );
		expect(
			container.querySelector( '.nodes-config-audit__time' ).textContent
		).toBe( '—' );
	} );

	it( 'states that values are recorded only for allowlisted options', () => {
		useNodeState.mockReturnValue( model() );
		const { getByText } = render( <ConfigAudit /> );
		expect(
			getByText(
				'Values are recorded only for allowlisted options; other changes record the option name only.'
			)
		).toBeTruthy();
	} );

	it( 'uses the canonical themed table class, not wp-list-table', () => {
		useNodeState.mockReturnValue( model() );
		const { container } = render( <ConfigAudit /> );
		const table = container.querySelector( 'table' );
		expect( table.classList.contains( 'newspack-nodes-table' ) ).toBe(
			true
		);
		expect( table.classList.contains( 'wp-list-table' ) ).toBe( false );
	} );

	it( 'renders Old and New value cells, an em dash when a side is absent', () => {
		useNodeState.mockReturnValue( {
			entries: [
				{
					id: 2,
					ts: TODAY_TS,
					option: 'newspack_nodes_num_partitions',
					old: '4',
					new: '16',
				},
				// An add carries NEW only — Old shows the em dash.
				{ id: 1, ts: FIXED_TS, option: 'newspack_added', new: '"hi"' },
			],
		} );
		const { container } = render( <ConfigAudit /> );
		const olds = [
			...container.querySelectorAll( '.nodes-config-audit__old' ),
		].map( ( el ) => el.textContent );
		const news = [
			...container.querySelectorAll( '.nodes-config-audit__new' ),
		].map( ( el ) => el.textContent );
		expect( olds ).toEqual( [ '4', '—' ] );
		expect( news ).toEqual( [ '16', '"hi"' ] );
	} );

	it( 'exposes the full excerpt as a title on a value cell (none when absent)', () => {
		useNodeState.mockReturnValue( {
			entries: [
				{ id: 1, ts: TODAY_TS, option: 'newspack_x', new: 'defval' },
			],
		} );
		const { container } = render( <ConfigAudit /> );
		expect(
			container
				.querySelector( '.nodes-config-audit__new' )
				.getAttribute( 'title' )
		).toBe( 'defval' );
		expect(
			container
				.querySelector( '.nodes-config-audit__old' )
				.getAttribute( 'title' )
		).toBeNull();
	} );

	it( 'filters by option name and shows a matched / total count', () => {
		useNodeState.mockReturnValue( model() );
		const { container, getByText, queryByText } = render( <ConfigAudit /> );
		fireEvent.change(
			container.querySelector( '.newspack-nodes-search-input' ),
			{
				target: { value: 'flame' },
			}
		);
		expect( getByText( 'newspack_flame_colors' ) ).toBeTruthy();
		expect( queryByText( 'newspack_theme_mods' ) ).toBeNull();
		expect( getByText( /1 \/ 2/ ) ).toBeTruthy();
	} );

	it( 'shows the total count when no filter is active', () => {
		useNodeState.mockReturnValue( model() );
		const { getByText } = render( <ConfigAudit /> );
		expect( getByText( /2 changes/ ) ).toBeTruthy();
	} );

	it( 'shows a no-match message when the filter excludes everything', () => {
		useNodeState.mockReturnValue( model() );
		const { container, getByText } = render( <ConfigAudit /> );
		fireEvent.change(
			container.querySelector( '.newspack-nodes-search-input' ),
			{
				target: { value: 'zzz-nomatch' },
			}
		);
		expect( getByText( 'No option names match the filter.' ) ).toBeTruthy();
	} );

	it( 'shows an empty state when nothing has been recorded', () => {
		useNodeState.mockReturnValue( { entries: [] } );
		const { getByText, queryByRole } = render( <ConfigAudit /> );
		expect( queryByRole( 'table' ) ).toBeNull();
		expect(
			getByText( 'No configuration changes recorded yet.' )
		).toBeTruthy();
	} );

	it( 'tolerates an unready view model (no crash, empty state)', () => {
		useNodeState.mockReturnValue( undefined );
		const { getByText } = render( <ConfigAudit /> );
		expect(
			getByText( 'No configuration changes recorded yet.' )
		).toBeTruthy();
	} );
} );
