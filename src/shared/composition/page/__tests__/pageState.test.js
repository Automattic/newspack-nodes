/* eslint-env jest */
/**
 * Declared page state: keys a page's blocks read and write through
 * `usePageState( key )`. A key with a `query` is what the address bar holds,
 * whatever blocks or providers are mounted and whoever wrote the bar: it is
 * read on load and on Back for a key that pushes, and cleaned on load. A key without one holds what its writers set only
 * while a mounted block declares it writes it, and its default otherwise.
 * Every block reading a key sees one value, an
 * undeclared key throws, and a key a block writes while a source's fetch is
 * owed makes the source ask again, the late answer never painting.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import { StrictMode, useEffect, useRef } from '@wordpress/element';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import { definePageState, usePageState } from '..';
import { setQueryParams } from '../../../utils/queryParams';
import { registerSource, SourcesProvider, useSource } from '../../../sources';

/** Every view the `view` key offers. */
const VIEWS = [ 'all-7922', 'slow-7922', 'failing-7922' ];

const PageStateProvider = definePageState( {
	'shag-7901': { default: '', query: 'url' },
	'tui-7902': {
		default: 1,
		query: 'paged',
		parse: Number,
		format: String,
	},
	'pipit-7903': { default: [], query: 'chip' },
	'fantail-7904': { default: 'all-7904' },
	'kokako-7909': { default: 'rimu-7909', query: 'perch' },
	'kaka-7920': {
		default: '',
		query: 'tag',
		format: ( tag ) => tag.toLowerCase(),
	},
	'kereru-7922': {
		default: 'all-7922',
		query: 'view',
		parse: ( raw ) => ( VIEWS.includes( raw ) ? raw : 'all-7922' ),
	},
	'huia-7923': { default: '', query: 'request', push: true },
} );

registerSource( 'karearea-7910', {
	kind: 'command',
	group: 'alpine-7910',
	ci: 'tern-7910',
	command: 'roost',
	args: ( { perch } ) => [ perch ],
} );

/**
 * A block showing one key's value as JSON.
 *
 * @param {Object} props
 * @param {string} props.name  The key.
 * @param {string} props.label Its test id.
 * @return {import('react').ReactElement} The value.
 */
function Show( { name, label } ) {
	const [ value ] = usePageState( name );
	return <p data-testid={ label }>{ JSON.stringify( value ) }</p>;
}

/**
 * A block that writes one key on a click.
 *
 * @param {Object} props
 * @param {string} props.name    The key.
 * @param {*}      props.to      What it writes.
 * @param {string} [props.label] Its button's name.
 * @return {import('react').ReactElement} The button.
 */
function Write( { name, to, label = 'Write' } ) {
	const [ , set ] = usePageState( name, { writes: true } );
	return (
		<button type="button" onClick={ () => set( to ) }>
			{ label }
		</button>
	);
}

/**
 * Hold the address bar at `search` on the admin page.
 *
 * @param {string} search The query string, `?` included.
 */
const atUrl = ( search ) =>
	window.history.replaceState( null, '', `/wp-admin/admin.php${ search }` );

/** What the bar holds now, past the path. */
const bar = () => window.location.search;

/**
 * The shown value of the block with test id `label`.
 *
 * @param {string} label The block's test id.
 * @return {string} What it shows.
 */
const shown = ( label ) => screen.getByTestId( label ).textContent;

beforeEach( () => {
	atUrl( '?page=nodes-station-7900' );
} );

describe( 'usePageState on a key with a query', () => {
	it( 'reads the bar on load, and its set writes the bar', () => {
		atUrl( '?page=nodes-station-7900&url=%2Fkea-7901' );
		render(
			<PageStateProvider>
				<Show name="shag-7901" label="url" />
				<Write name="shag-7901" to="/weka-7901" />
			</PageStateProvider>
		);
		expect( shown( 'url' ) ).toBe( '"/kea-7901"' );

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( shown( 'url' ) ).toBe( '"/weka-7901"' );
		expect( bar() ).toBe( '?page=nodes-station-7900&url=%2Fweka-7901' );
	} );

	it( 'holds the bar’s value with no writer mounted', () => {
		atUrl( '?url=%2Fkea-7901' );
		render(
			<PageStateProvider>
				<Show name="shag-7901" label="url" />
			</PageStateProvider>
		);

		expect( shown( 'url' ) ).toBe( '"/kea-7901"' );
	} );

	it( 'parses the bar’s value, and leaves the default off the bar', () => {
		atUrl( '?paged=4&page=nodes-station-7900' );
		render(
			<PageStateProvider>
				<Show name="tui-7902" label="paged" />
				<Write name="tui-7902" to={ 1 } />
			</PageStateProvider>
		);
		expect( shown( 'paged' ) ).toBe( '4' );

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( shown( 'paged' ) ).toBe( '1' );
		expect( bar() ).toBe( '?page=nodes-station-7900' );
	} );

	it( 'reads and writes a list key as one param per item', () => {
		atUrl( '?chip=status%3D5&chip=server%3Dweb-7903' );
		render(
			<PageStateProvider>
				<Show name="pipit-7903" label="chips" />
				<Write name="pipit-7903" to={ [ 'owner=kea-7903' ] } />
			</PageStateProvider>
		);
		expect( shown( 'chips' ) ).toBe( '["status=5","server=web-7903"]' );

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( shown( 'chips' ) ).toBe( '["owner=kea-7903"]' );
		expect( bar() ).toBe( '?chip=owner%3Dkea-7903' );
	} );

	it( 'restores a key that pushes on Back, and keeps a key that does not', () => {
		atUrl( '?url=%2Fkea-7901&request=rid-7923' );
		render(
			<PageStateProvider>
				<Show name="shag-7901" label="url" />
				<Show name="huia-7923" label="request" />
				<Write name="shag-7901" to="/weka-7901" label="Url" />
				<Write name="huia-7923" to="rid-7924" label="Request" />
			</PageStateProvider>
		);
		const push = jest.spyOn( window.history, 'pushState' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Url' } ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Request' } ) );
		expect( push ).toHaveBeenCalledTimes( 1 );
		push.mockRestore();

		act( () => {
			atUrl( '?url=%2Fkea-7901&request=rid-7923' );
			window.dispatchEvent( new window.PopStateEvent( 'popstate' ) );
		} );

		expect( shown( 'request' ) ).toBe( '"rid-7923"' );
		expect( shown( 'url' ) ).toBe( '"/weka-7901"' );
		expect( bar() ).toBe( '?url=%2Fweka-7901&request=rid-7923' );
	} );

	it( 'shows what the bar holds after a set, when format does not invert', () => {
		render(
			<PageStateProvider>
				<Show name="kaka-7920" label="tag" />
				<Write name="kaka-7920" to="Kea-Ridge-7920" />
			</PageStateProvider>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( bar() ).toBe( '?page=nodes-station-7900&tag=kea-ridge-7920' );
		expect( shown( 'tag' ) ).toBe( '"kea-ridge-7920"' );
	} );

	it( 'cleans a value parse rejects from the bar on load', () => {
		atUrl( '?view=bogus-7922&page=nodes-station-7900' );
		render(
			<PageStateProvider>
				<Show name="kereru-7922" label="view" />
			</PageStateProvider>
		);

		expect( shown( 'view' ) ).toBe( '"all-7922"' );
		expect( bar() ).toBe( '?page=nodes-station-7900' );
	} );

	it( 'cleans a default spelled out in the bar on load', () => {
		atUrl( '?page=nodes-station-7900&view=all-7922&url=%2Fkea-7901' );
		render(
			<PageStateProvider>
				<Show name="kereru-7922" label="view" />
			</PageStateProvider>
		);

		expect( bar() ).toBe( '?page=nodes-station-7900&url=%2Fkea-7901' );
	} );

	it( 'shows a mounted reader a direct setQueryParams', () => {
		render(
			<PageStateProvider>
				<Show name="shag-7901" label="url" />
			</PageStateProvider>
		);

		act( () => setQueryParams( { url: '/huia-7921' } ) );

		expect( shown( 'url' ) ).toBe( '"/huia-7921"' );
	} );

	it( 'lands a set whose writer leaves in the same commit', () => {
		let set;
		function Leaving() {
			[ , set ] = usePageState( 'shag-7901', { writes: true } );
			return null;
		}
		const { rerender } = render(
			<PageStateProvider>
				<Show name="shag-7901" label="url" />
				<Leaving />
			</PageStateProvider>
		);

		act( () => {
			set( '/kotare-7942' );
			rerender(
				<PageStateProvider>
					<Show name="shag-7901" label="url" />
				</PageStateProvider>
			);
		} );

		expect( bar() ).toBe( '?page=nodes-station-7900&url=%2Fkotare-7942' );
		expect( shown( 'url' ) ).toBe( '"/kotare-7942"' );
	} );

	it( 'agrees across sibling providers after a set', () => {
		render(
			<>
				<PageStateProvider>
					<Write name="shag-7901" to="/tieke-7925" />
				</PageStateProvider>
				<PageStateProvider>
					<Show name="shag-7901" label="url" />
				</PageStateProvider>
			</>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( shown( 'url' ) ).toBe( '"/tieke-7925"' );
	} );

	it( 'takes a function of the value it holds', () => {
		atUrl( '?paged=4' );
		function Next() {
			const [ , set ] = usePageState( 'tui-7902', { writes: true } );
			return (
				<button type="button" onClick={ () => set( ( n ) => n + 3 ) }>
					Next
				</button>
			);
		}
		render(
			<PageStateProvider>
				<Show name="tui-7902" label="paged" />
				<Next />
			</PageStateProvider>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Next' } ) );

		expect( shown( 'paged' ) ).toBe( '7' );
		expect( bar() ).toBe( '?paged=7' );
	} );
} );

describe( 'usePageState on a key without a query', () => {
	it( 'holds what its writer set while the writer stands, then its default', () => {
		const { rerender } = render(
			<PageStateProvider>
				<Show name="fantail-7904" label="filter" />
				<Write name="fantail-7904" to="slow-7906" />
			</PageStateProvider>
		);
		expect( shown( 'filter' ) ).toBe( '"all-7904"' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );
		expect( shown( 'filter' ) ).toBe( '"slow-7906"' );

		rerender(
			<PageStateProvider>
				<Show name="fantail-7904" label="filter" />
			</PageStateProvider>
		);

		expect( shown( 'filter' ) ).toBe( '"all-7904"' );
		expect( bar() ).toBe( '?page=nodes-station-7900' );
	} );

	it( 'starts a returning writer from the default', async () => {
		const withWriter = (
			<PageStateProvider>
				<Show name="fantail-7904" label="filter" />
				<Write name="fantail-7904" to="slow-7906" />
			</PageStateProvider>
		);
		const { rerender } = render( withWriter );
		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );
		rerender(
			<PageStateProvider>
				<Show name="fantail-7904" label="filter" />
			</PageStateProvider>
		);
		await act( async () => {} );

		rerender( withWriter );

		expect( shown( 'filter' ) ).toBe( '"all-7904"' );
	} );

	it( 'keeps a value written as its writer mounts through StrictMode’s remount', async () => {
		function SetOnMount() {
			const [ , set ] = usePageState( 'fantail-7904', { writes: true } );
			const done = useRef( false );
			useEffect( () => {
				if ( ! done.current ) {
					done.current = true;
					set( 'mount-7907' );
				}
			}, [ set ] );
			return null;
		}
		render(
			<StrictMode>
				<PageStateProvider>
					<Show name="fantail-7904" label="filter" />
					<SetOnMount />
				</PageStateProvider>
			</StrictMode>
		);
		await act( async () => {} );

		expect( shown( 'filter' ) ).toBe( '"mount-7907"' );
	} );
} );

describe( 'usePageState', () => {
	it( 'shows one value to two blocks reading one key', () => {
		render(
			<PageStateProvider>
				<Show name="fantail-7904" label="first" />
				<Show name="fantail-7904" label="second" />
				<Write name="fantail-7904" to="busy-7908" />
			</PageStateProvider>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( shown( 'first' ) ).toBe( '"busy-7908"' );
		expect( shown( 'second' ) ).toBe( '"busy-7908"' );
	} );

	it( 'shares one provider’s state with a provider inside it', () => {
		render(
			<PageStateProvider>
				<Write name="fantail-7904" to="busy-7908" />
				<PageStateProvider>
					<Show name="fantail-7904" label="inner" />
				</PageStateProvider>
			</PageStateProvider>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );

		expect( shown( 'inner' ) ).toBe( '"busy-7908"' );
	} );

	it( 'refuses an undeclared key, naming where to declare it', () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );

		expect( () =>
			render(
				<PageStateProvider>
					<Show name="moa-7999" label="gone" />
				</PageStateProvider>
			)
		).toThrow(
			/page state 'moa-7999' is not declared: declare it in definePageState\(/
		);
	} );

	it( 'refuses a read outside every provider, naming the provider', () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );

		expect( () =>
			render( <Show name="fantail-7904" label="outside" /> )
		).toThrow( /usePageState\( 'fantail-7904' \) reads through a/ );
	} );

	it( 'refuses a write from a block that did not declare it writes the key', () => {
		let set;
		function Sneak() {
			[ , set ] = usePageState( 'shag-7901' );
			return null;
		}
		render(
			<PageStateProvider>
				<Sneak />
			</PageStateProvider>
		);

		expect( () => set( '/kea-7901' ) ).toThrow(
			/usePageState\( 'shag-7901', \{ writes: true \} \)/
		);
	} );
} );

describe( 'definePageState', () => {
	it( 'takes the same declaration twice', () => {
		const decl = { default: 'calm-7911' };
		definePageState( { 'kaki-7911': decl } );

		expect( () =>
			definePageState( { 'kaki-7911': { default: 'calm-7911' } } )
		).not.toThrow();
	} );

	it( 'refuses a second, different declaration under one key', () => {
		definePageState( { 'kaki-7912': { default: 'calm-7912' } } );

		expect( () =>
			definePageState( { 'kaki-7912': { default: 'gale-7912' } } )
		).toThrow( /page state 'kaki-7912' is already declared/ );
	} );

	it( 'refuses a key that declares no default', () => {
		expect( () =>
			definePageState( { 'kaki-7913': { query: 'kaki' } } )
		).toThrow( /page state 'kaki-7913' declares no default/ );
	} );

	it( 'refuses a second key reflecting to one param', () => {
		expect( () =>
			definePageState( { 'kaki-7914': { default: '', query: 'url' } } )
		).toThrow( /'kaki-7914' reflects to \?url=, which 'shag-7901' holds/ );
	} );
} );

describe( 'usePageState with a source', () => {
	let replyFor;

	beforeEach( () => {
		Core.reset();
		steppedClock();
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
		replyFor = ( m ) => ( {
			height: `${ m[ VALUE ].arguments[ 0 ] } 41m`,
		} );
		installFakeCommandWire( ( m ) => replyFor( m ) );
	} );

	/**
	 * A gauge whose source reads the perch the page holds.
	 *
	 * @return {import('react').ReactElement} The gauge.
	 */
	function Gauge() {
		const [ perch ] = usePageState( 'kokako-7909' );
		const { model, loading } = useSource( 'karearea-7910', { perch } );
		return (
			<p data-testid="gauge">
				{ loading ? `${ perch } loading` : model.height }
			</p>
		);
	}

	it( 'asks again with the key a block wrote while a fetch was owed, never painting the late answer', async () => {
		let land;
		replyFor = ( m ) => {
			const [ perch ] = m[ VALUE ].arguments;
			if ( 'matai-7909' === perch ) {
				return new Promise( ( resolve ) => {
					land = () => resolve( { height: 'late 9m' } );
				} );
			}
			return { height: `${ perch } 41m` };
		};
		atUrl( '?perch=matai-7909' );
		render(
			<PageStateProvider>
				<SourcesProvider>
					<Gauge />
					<Write name="kokako-7909" to="totara-7909" />
				</SourcesProvider>
			</PageStateProvider>
		);
		await waitFor( () => expect( land ).toBeDefined() );

		fireEvent.click( screen.getByRole( 'button', { name: 'Write' } ) );
		expect( await screen.findByText( 'totara-7909 41m' ) ).toBeTruthy();

		await act( async () => land() );

		expect( screen.queryByText( /late 9m/ ) ).toBeNull();
		expect( shown( 'gauge' ) ).toBe( 'totara-7909 41m' );
		expect( bar() ).toBe( '?perch=totara-7909' );
	} );
} );
