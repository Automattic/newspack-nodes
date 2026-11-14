/* eslint-env jest */
/**
 * The substrate's shared blocks: each source block reads the source its
 * `source` attribute names, with the page-state params the source declares,
 * and shows its model through the shared components, every field labelled
 * as the source declares it; a section heads the blocks it holds; and while
 * a layout is edited no block writes.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import { registerSource, SourcesProvider } from '../../sources';
import { definePageState } from '../../composition/page/pageState';
import {
	ComposedPage,
	providedViews,
} from '../../composition/page/pageContext';
import { LogStreamViewNode } from '../../nodes/log-stream-view-node';
import CompositionView from '../../composition/CompositionView';
import { SUBSTRATE_VIEWS } from '..';
import { namedFields } from '../sourceBlock';
import { logRow } from '../log-stream';

/** The poll's cadence, distinct from every default. */
const PUKEKO_MS = 7000;

const PageState = definePageState( {
	swamp: { default: 'raupo-7840' },
} );

registerSource( 'pukeko-7840', {
	label: 'Pukeko Swamp 7862',
	kind: 'poll',
	group: 'alpine-7840',
	ci: 'tern-7840',
	command: 'graze',
	args: ( { swamp } ) => [ swamp ],
	intervalMs: PUKEKO_MS,
	params: [ 'swamp' ],
	fields: {
		height: {
			label: 'Height 7840',
			kind: 'value',
			format: ( v ) => `${ v } m`,
		},
		wings: { label: 'Wings 7840', kind: 'value' },
		climb: {
			label: 'Climb 7841',
			kind: 'series',
			formatFor: () => ( value ) => `${ value } kea`,
		},
		pulse: { label: 'Pulse 7843', kind: 'line' },
	},
} );

registerSource( 'moana-7861', {
	kind: 'command',
	group: 'alpine-7861',
	ci: 'tern-7861',
	command: 'ebb',
	args: () => [],
	fields: {
		tide: { label: 'Tide Height 7861', kind: 'value' },
		swell: { label: 'Swell 7861', kind: 'value' },
	},
} );

registerSource( 'kiwi-7990', {
	kind: 'command',
	group: 'alpine-7990',
	ci: 'tern-7990',
	command: 'roost',
	args: () => [],
	rowKey: 'band',
	fields: {
		name: { label: 'Name 7990', kind: 'rows' },
	},
} );

registerSource( 'ruru-7992', {
	kind: 'command',
	group: 'alpine-7992',
	ci: 'tern-7992',
	command: 'hoot',
	args: () => [],
	fields: {
		calls: { label: 'Calls 7992', kind: 'value' },
		perch: { label: 'Perch 7992', kind: 'rows' },
	},
} );

registerSource( 'kaka-7842', {
	kind: 'command',
	group: 'alpine-7842',
	ci: 'tern-7842',
	command: 'perch',
	args: () => [],
	fields: {
		name: { label: 'Name 7842', kind: 'rows' },
		age: { label: 'Age 7842', kind: 'rows', format: ( v ) => `${ v } yr` },
	},
} );

/** A log view whose row is the record's VALUE as text. */
class TuiViewNode extends LogStreamViewNode {
	shapeRow( message ) {
		return { text: String( message[ VALUE ] ) };
	}
}

registerSource( 'tui-7844', {
	kind: 'stream',
	subscribe: () => 'tui.p2',
	viewClass: TuiViewNode,
	mode: 'follow',
	fields: { text: { label: 'Line 7844', kind: 'rows' } },
} );

/**
 * The count the hoiho's toolbar names, as its declaration words it.
 *
 * @param {{total: number}} stats The ring's stats.
 * @return {string} The count.
 */
const hoihoCount = ( { total } ) => `${ total } penguins 7970`;

/**
 * The rate the hoiho's toolbar names.
 *
 * @param {number} lps Lines per second.
 * @return {string} The rate.
 */
const hoihoRate = ( lps ) => `${ lps.toFixed( 2 ) } dives/s 7970`;

/**
 * A hoiho's tag cell, its tag linked, as its declared cell draws it.
 *
 * @param {{tag: string}} row The row.
 * @return {import('react').ReactElement} The cell.
 */
const tagCell = ( row ) => (
	<span role="cell" data-band="7970">
		<a href={ `#tag-${ row.tag }` }>{ row.tag }</a>
	</span>
);

registerSource( 'hoiho-7970', {
	label: 'Hoiho colony 7970',
	kind: 'stream',
	subscribe: () => 'hoiho.p4',
	viewClass: TuiViewNode,
	mode: 'follow',
	count: hoihoCount,
	rate: hoihoRate,
	placeholder: 'Filter penguins 7970…',
	empty: 'No penguins ashore 7970.',
	columnsKey: 'hoiho-columns-7970',
	fields: {
		tag: {
			label: 'Tag 7970',
			tooltip: 'Band number 7970',
			width: '91px',
			kind: 'rows',
			cell: tagCell,
		},
		text: { label: 'Call 7970', kind: 'rows', width: '173px' },
		nest: { label: 'Nest 7970', kind: 'rows' },
	},
} );

registerSource( 'tawaki-7971', {
	kind: 'stream',
	group: 'alpine-7971',
	subscribe: () => 'tawaki.*',
	viewClass: TuiViewNode,
	mode: 'follow',
	browse: true,
	fields: { text: { label: 'Call 7971', kind: 'rows' } },
} );

/** How often the karoro's span was derived, to show it is derived once a model. */
let spans = 0;

registerSource( 'karoro-7880', {
	kind: 'poll',
	group: 'alpine-7880',
	ci: 'tern-7880',
	command: 'graze',
	args: () => [ 'karoro' ],
	intervalMs: PUKEKO_MS,
	fields: {
		span: {
			label: 'Span 7880',
			kind: 'value',
			value: ( model ) => {
				spans += 1;
				return model.wings * 3;
			},
			format: ( v ) => `${ v } m`,
			modifier: ( v ) => `span-${ v }`,
		},
		reach: {
			label: 'Reach 7880',
			kind: 'value',
			value: ( model ) => model.height + 1,
		},
		gust: {
			label: 'Gust 7880',
			kind: 'series',
			axis: 'Knots 7880',
			value: ( model ) => model.climb,
		},
	},
} );

registerSource( 'kotare-7882', {
	kind: 'poll',
	group: 'alpine-7882',
	ci: 'tern-7882',
	command: 'graze',
	args: () => [ 'kotare' ],
	intervalMs: PUKEKO_MS,
	caption: ( model ) => `Over ${ model.height } m 7882`,
	fields: {
		wings: {
			label: 'Wings 7882',
			kind: 'value',
			shown: ( wings ) => wings > 5,
		},
		height: { label: 'Height 7882', kind: 'value' },
	},
} );

let wire;
let replyFor;
let clock;

class FakeEventSource {
	addEventListener() {}
	close() {}
}

beforeEach( () => {
	Core.reset();
	clock = steppedClock();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	global.EventSource = FakeEventSource;
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => 'visible',
	} );
	const answers = {
		hoot: null,
		roost: [
			{ band: 41, name: 'Roroa 7990' },
			{ band: 57, name: 'Tokoeka 7990' },
		],
		perch: [
			{ id: 'k1', name: 'Kea', age: 7 },
			{ id: 'k2', name: 'Kaka', age: 3 },
		],
	};
	replyFor = ( m ) =>
		Object.hasOwn( answers, m[ VALUE ].name )
			? answers[ m[ VALUE ].name ]
			: {
					height: 41,
					wings: 2,
					climb: {
						Kea: {
							points: [
								{ ts: 1767225600, value: 4 },
								{ ts: 1767225615, value: 9 },
							],
							max: 9,
						},
					},
					pulse: [ 3, null, 5, 8 ],
			  };
	wire = installFakeCommandWire( ( m ) => replyFor( m ) );
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

/** The substrate's views as a composed page renders them. */
const VIEWS = providedViews( SUBSTRATE_VIEWS );

/**
 * One block by its view, on a page holding page state and sources.
 *
 * @param {string}  name       The block.
 * @param {Object}  attributes Its attributes.
 * @param {boolean} [editing]  Whether its layout is edited.
 * @return {Object} What `render` answers.
 */
function renderBlock( name, attributes, editing = false ) {
	const { View } = VIEWS[ name ];
	return render(
		<PageState>
			<SourcesProvider>
				<View attributes={ attributes } editing={ editing } />
			</SourcesProvider>
		</PageState>
	);
}

/**
 * One block by its view, standing on a page that offers a header slot and
 * the controls it hands each source's block.
 *
 * @param {string} name       The block.
 * @param {Object} attributes Its attributes.
 * @param {Object} page       The page's own fields beside the frame's.
 * @return {Object} What `render` answers.
 */
function renderOnPage( name, attributes, page ) {
	const { View } = VIEWS[ name ];
	return render(
		<ComposedPage.Provider
			value={ {
				group: 'alpine-7973',
				canTune: false,
				onRestored: () => {},
				...page,
			} }
		>
			<PageState>
				<SourcesProvider>
					<View attributes={ attributes } editing={ false } />
				</SourcesProvider>
			</PageState>
		</ComposedPage.Provider>
	);
}

/**
 * What a block refuses with, in its own place on a composed page.
 *
 * @param {string} name       The block.
 * @param {Object} attributes Its attributes.
 * @return {Promise<string>} The refusal's words.
 */
async function refusal( name, attributes ) {
	jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	render(
		<PageState>
			<SourcesProvider>
				<CompositionView
					blocks={ [ { name, attributes, inner: [] } ] }
					views={ VIEWS }
					renderError={ ( error ) => (
						<p data-refusal="">{ error.message }</p>
					) }
				/>
			</SourcesProvider>
		</PageState>
	);
	await screen.findByText( ( _, node ) => node?.dataset?.refusal === '' );
	return document.querySelector( '[data-refusal]' ).textContent;
}

/**
 * Every command of one verb the wire carried, as its tokens.
 *
 * @param {string} verb The verb.
 * @return {string[][]} One entry per command.
 */
const sent = ( verb ) =>
	wire.batches
		.flat()
		.filter( ( m ) => verb === m[ VALUE ]?.name )
		.map( ( m ) => m[ VALUE ].arguments ?? [] );

describe( 'the substrate views map', () => {
	it( 'holds the six shared blocks', () => {
		expect( Object.keys( SUBSTRATE_VIEWS ).sort() ).toEqual( [
			'newspack-nodes/log-stream',
			'newspack-nodes/section',
			'newspack-nodes/sparkline',
			'newspack-nodes/stats',
			'newspack-nodes/table',
			'newspack-nodes/time-chart',
		] );
	} );
} );

describe( 'a field derived from the model', () => {
	it( 'shows each derived figure, deriving it once a model', async () => {
		spans = 0;
		renderBlock( 'newspack-nodes/stats', {
			source: 'karoro-7880',
			fields: [ 'span', 'reach', 'span' ],
			columns: 0,
		} );
		expect( await screen.findByText( '42' ) ).toBeTruthy();
		expect( screen.getAllByText( '6 m' ) ).toHaveLength( 2 );
		expect( spans ).toBe( 1 );
	} );

	it( 'gives a tile the modifier its figure names', async () => {
		renderBlock( 'newspack-nodes/stats', {
			source: 'karoro-7880',
			fields: [ 'span' ],
			columns: 0,
		} );
		await screen.findByText( '6 m' );
		expect(
			document.querySelector( '.nodes-card--span' ).classList
		).toContain( 'nodes-card--span-6' );
	} );

	it( 'titles a chart’s axis by the words its field declares', async () => {
		renderBlock( 'newspack-nodes/time-chart', {
			source: 'karoro-7880',
			metrics: [ 'gust' ],
			stacked: false,
			title: 'Gale 7880',
		} );
		expect( await screen.findByText( 'Knots 7880' ) ).toBeTruthy();
		expect( screen.queryByText( 'Gust 7880' ) ).toBeNull();
	} );
} );

describe( 'the stats block', () => {
	it( 'shows each named field by its declared label, read with the page state the source declares', async () => {
		renderBlock( 'newspack-nodes/stats', {
			source: 'pukeko-7840',
			fields: [ 'wings', 'height' ],
			columns: 0,
		} );
		expect( await screen.findByText( '41 m' ) ).toBeTruthy();
		const tiles = [ ...document.querySelectorAll( '.nodes-card' ) ];
		expect(
			tiles.map( ( tile ) => [
				tile.querySelector( '.newspack-nodes-stat-label' ).textContent,
				tile.querySelector( '.newspack-nodes-stat-value' ).textContent,
			] )
		).toEqual( [
			[ 'Wings 7840', '2' ],
			[ 'Height 7840', '41 m' ],
		] );
		expect( sent( 'graze' ) ).toEqual( [ [ 'raupo-7840' ] ] );
	} );

	it( 'shows every declared figure when it names none, and lays them on a grid of its columns', async () => {
		renderBlock( 'newspack-nodes/stats', {
			source: 'pukeko-7840',
			fields: [],
			columns: 5,
		} );
		await screen.findByText( '41 m' );
		expect(
			[
				...document.querySelectorAll( '.newspack-nodes-stat-label' ),
			].map( ( label ) => label.textContent )
		).toEqual( [ 'Height 7840', 'Wings 7840' ] );
		const grid = document.querySelector( '.newspack-nodes-stats-grid' );
		expect(
			grid.style.getPropertyValue( '--newspack-nodes-stat-columns' )
		).toBe( '5' );
		expect( grid.classList.contains( 'is-flow' ) ).toBe( false );
	} );

	it( 'shows no tile for a figure its field declares not shown', async () => {
		renderBlock( 'newspack-nodes/stats', {
			source: 'kotare-7882',
			fields: [],
			columns: 0,
		} );
		await screen.findByText( 'Height 7882' );
		expect( screen.queryByText( 'Wings 7882' ) ).toBeNull();
	} );

	it( 'captions its row as the source names it for the model', async () => {
		renderBlock( 'newspack-nodes/stats', {
			source: 'kotare-7882',
			fields: [],
			columns: 0,
		} );
		await screen.findByText( 'Height 7882' );
		expect(
			document.querySelector( '.newspack-nodes-stats-grid' ).title
		).toBe( 'Over 41 m 7882' );
	} );

	it( 'names the fields a model shows, leaving out one declared not shown', () => {
		expect(
			namedFields( 'kotare-7882', [], 'value', {
				wings: 2,
				height: 41,
			} ).map( ( field ) => field.key )
		).toEqual( [ 'height' ] );
		expect(
			namedFields( 'kotare-7882', [], 'value' ).map(
				( field ) => field.key
			)
		).toEqual( [ 'wings', 'height' ] );
	} );

	it( 'lets tiles flow as they fit with no columns named', async () => {
		renderBlock( 'newspack-nodes/stats', {
			source: 'pukeko-7840',
			fields: [ 'wings' ],
			columns: 0,
		} );
		await screen.findByText( 'Wings 7840' );
		const grid = document.querySelector( '.newspack-nodes-stats-grid' );
		expect( grid.classList.contains( 'is-flow' ) ).toBe( true );
		expect(
			grid.style.getPropertyValue( '--newspack-nodes-stat-columns' )
		).toBe( '' );
	} );

	it( 'refuses a field the source does not declare, in its own place', async () => {
		expect(
			await refusal( 'newspack-nodes/stats', {
				source: 'pukeko-7840',
				fields: [ 'beak' ],
				columns: 0,
			} )
		).toBe( "pukeko-7840 declares no field 'beak'" );
	} );

	it( 'refuses a field of another kind, naming both', async () => {
		expect(
			await refusal( 'newspack-nodes/stats', {
				source: 'pukeko-7840',
				fields: [ 'pulse' ],
				columns: 0,
			} )
		).toBe( "pukeko-7840 field 'pulse' is a line, not a value" );
	} );

	it( 'asks for a source while none is set', () => {
		renderBlock( 'newspack-nodes/stats', {
			source: '',
			fields: [],
			columns: 0,
		} );
		expect(
			screen.getByText( 'Choose a source in the block settings.' )
		).toBeTruthy();
		expect( wire.batches ).toEqual( [] );
	} );
} );

describe( 'the time-chart block', () => {
	it( 'draws each metric’s series under its title, the axis named by the metric’s label', async () => {
		renderBlock( 'newspack-nodes/time-chart', {
			source: 'pukeko-7840',
			metrics: [ 'climb' ],
			stacked: true,
			title: 'Ascent 7841',
		} );
		await screen.findByText( 'Ascent 7841' );
		expect(
			document
				.querySelector( '.newspack-nodes-chart__stack' )
				.getAttribute( 'aria-pressed' )
		).toBe( 'true' );
		expect(
			document.querySelector( '.newspack-nodes-chart__title' ).textContent
		).toBe( 'Ascent 7841' );
		expect( document.querySelector( '.y-label' ).textContent ).toBe(
			'Climb 7841'
		);
		expect( screen.getByRole( 'button', { name: /Kea/ } ) ).toBeTruthy();
		expect(
			[ ...document.querySelectorAll( '.tick text' ) ].some( ( tick ) =>
				tick.textContent.endsWith( ' kea' )
			)
		).toBe( true );
	} );
} );

describe( 'the table block', () => {
	it( 'heads each column with its declared label and sorts as its attributes say', async () => {
		renderBlock( 'newspack-nodes/table', {
			source: 'kaka-7842',
			columns: [],
			sort: { field: 'age', direction: 'asc' },
			perPage: 1,
			title: 'Flock 7842',
		} );
		await screen.findByText( '3 yr' );
		expect( screen.getByText( 'Page 1 of 2' ) ).toBeTruthy();
		expect(
			screen
				.getAllByRole( 'columnheader' )
				.map( ( head ) => head.textContent.replace( '↑', '' ).trim() )
		).toEqual( [ 'Name 7842', 'Age 7842' ] );
		const rows = screen.getAllByRole( 'row' ).slice( 1 );
		expect(
			rows.map( ( row ) =>
				[ ...row.querySelectorAll( 'td' ) ].map( ( td ) =>
					td.textContent.trim()
				)
			)
		).toEqual( [ [ 'Kaka', '3 yr' ] ] );
		expect(
			screen.getByRole( 'heading', { name: 'Flock 7842' } )
		).toBeTruthy();
	} );
} );

describe( 'a source that answers nothing', () => {
	it( 'shows the stats as an empty model, not as a skeleton', async () => {
		const { container } = renderBlock( 'newspack-nodes/stats', {
			source: 'ruru-7992',
			fields: [],
			columns: 0,
		} );
		await screen.findByText( 'Calls 7992' );
		expect(
			container.querySelector( '.newspack-nodes-stat-value' ).textContent
		).toBe( '' );
		expect(
			container.querySelector( '.newspack-nodes-skeleton' )
		).toBeNull();
	} );

	it( 'shows the table’s empty state', async () => {
		renderBlock( 'newspack-nodes/table', {
			source: 'ruru-7992',
			columns: [],
			sort: { field: '', direction: 'desc' },
			perPage: 20,
			title: '',
		} );
		expect(
			await screen.findByText( 'Nothing to show yet.' )
		).toBeTruthy();
	} );

	it( 'shows a skeleton while its answer is owed', async () => {
		replyFor = () => new Promise( () => {} );
		const { container } = renderBlock( 'newspack-nodes/stats', {
			source: 'ruru-7992',
			fields: [],
			columns: 0,
		} );
		await clock.tick( 1 );
		expect( sent( 'hoot' ) ).toEqual( [ [] ] );
		expect(
			container.querySelector( '.newspack-nodes-skeleton' )
		).not.toBeNull();
		expect( screen.queryByText( 'Calls 7992' ) ).toBeNull();
	} );
} );

describe( 'a table over a source naming its row key', () => {
	it( 'keys each row by that field', async () => {
		renderBlock( 'newspack-nodes/table', {
			source: 'kiwi-7990',
			columns: [],
			sort: { field: '', direction: 'desc' },
			perPage: 20,
			title: '',
		} );
		await screen.findByText( 'Tokoeka 7990' );
		expect(
			screen
				.getAllByRole( 'row' )
				.slice( 1 )
				.map( ( row ) => row.textContent.trim() )
		).toEqual( [ 'Roroa 7990', 'Tokoeka 7990' ] );
	} );
} );

describe( 'a table whose settings change', () => {
	it( 'takes its new page size at once', async () => {
		const attributes = {
			source: 'kaka-7842',
			columns: [],
			sort: { field: 'age', direction: 'asc' },
			perPage: 1,
			title: '',
		};
		const { View } = VIEWS[ 'newspack-nodes/table' ];
		const page = ( next ) => (
			<PageState>
				<SourcesProvider>
					<View attributes={ next } editing={ false } />
				</SourcesProvider>
			</PageState>
		);
		const { rerender } = render( page( attributes ) );
		await screen.findByText( '3 yr' );
		expect( screen.queryByText( '7 yr' ) ).toBeNull();

		rerender( page( { ...attributes, perPage: 2 } ) );

		expect( await screen.findByText( '7 yr' ) ).toBeTruthy();
	} );
} );

describe( 'a table over a source with no columns', () => {
	it( 'refuses in its own place', async () => {
		expect(
			await refusal( 'newspack-nodes/table', {
				source: 'pukeko-7840',
				columns: [],
				sort: { field: '', direction: 'desc' },
				perPage: 4,
				title: '',
			} )
		).toBe( 'pukeko-7840 declares no field to show' );
	} );
} );

describe( 'the sparkline block', () => {
	it( 'draws its field’s series, named by the field’s label', async () => {
		renderBlock( 'newspack-nodes/sparkline', {
			source: 'pukeko-7840',
			field: 'pulse',
			title: 'Beat 7843',
		} );
		const line = await screen.findByRole( 'img', { name: 'Pulse 7843' } );
		expect( line.classList.contains( 'newspack-nodes-sparkline' ) ).toBe(
			true
		);
		expect( screen.getByText( 'Beat 7843' ) ).toBeTruthy();
	} );
} );

describe( 'the log-stream block', () => {
	it( 'heads its columns by their declared labels and pauses the stream it reads', async () => {
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'tui-7844',
			columns: [],
			title: 'Tail 7844',
		} );
		await act( async () => {} );
		expect(
			screen.getByRole( 'region', { name: 'Tail 7844' } )
		).toBeTruthy();
		expect( screen.getByText( 'Line 7844' ) ).toBeTruthy();

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Pause streaming' } )
		);
		expect(
			await screen.findByRole( 'button', { name: 'Resume streaming' } )
		).toBeTruthy();
	} );

	it( 'heads each column by its label and tooltip, and draws each row as its fields declare', async () => {
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'hoiho-7970',
			columns: [],
			title: '',
		} );
		await act( async () => {} );
		const header = screen.getByRole( 'columnheader', { name: 'Tag 7970' } );
		expect( header.getAttribute( 'title' ) ).toBe( 'Band number 7970' );
		expect(
			header
				.closest( '.newspack-nodes-log-stream-block__columns' )
				.style.getPropertyValue( '--log-columns' )
		).toBe( '91px 173px auto' );

		const renderRow = logRow( namedFields( 'hoiho-7970', [], 'rows' ) );
		render( renderRow( { id: 3, tag: 'yellow-7970', text: 'trill' } ) );
		const row = screen.getAllByRole( 'row' ).at( -1 );
		expect( row.style.gridTemplateColumns ).toBe( '91px 173px auto' );
		expect(
			within( row ).getByRole( 'link', { name: 'yellow-7970' } )
		).toBeTruthy();
		const cells = within( row ).getAllByRole( 'cell' );
		expect( cells ).toHaveLength( 3 );
		expect( cells[ 0 ].dataset.band ).toBe( '7970' );
	} );

	it( 'names its region, its counts, its filter and its empty list as its source declares', async () => {
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'hoiho-7970',
			columns: [],
			title: '',
		} );
		await act( async () => {} );
		expect(
			screen.getByRole( 'region', { name: 'Hoiho colony 7970' } )
		).toBeTruthy();
		expect( screen.getByText( '0 penguins 7970' ) ).toBeTruthy();
		expect( screen.getByText( '0.00 dives/s 7970' ) ).toBeTruthy();
		expect(
			screen.getByPlaceholderText( 'Filter penguins 7970…' )
		).toBeTruthy();
		expect( screen.getByText( 'No penguins ashore 7970.' ) ).toBeTruthy();
	} );

	it( 'offers the columns it does not name through Cols, kept under its source’s key', async () => {
		window.localStorage.clear();
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'hoiho-7970',
			columns: [ 'tag', 'text' ],
			title: '',
		} );
		await act( async () => {} );
		expect(
			screen.queryByRole( 'columnheader', { name: 'Nest 7970' } )
		).toBeNull();

		fireEvent.click( screen.getByRole( 'button', { name: 'Cols' } ) );
		fireEvent.click(
			screen.getByRole( 'checkbox', { name: 'Nest 7970' } )
		);

		expect(
			screen.getByRole( 'columnheader', { name: 'Nest 7970' } )
		).toBeTruthy();
		expect(
			JSON.parse( window.localStorage.getItem( 'hoiho-columns-7970' ) )
		).toEqual( [ 'tag', 'text', 'nest' ] );
	} );

	it( 'offers no Cols when it names every column', async () => {
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'hoiho-7970',
			columns: [],
			title: '',
		} );
		await act( async () => {} );
		expect( screen.queryByRole( 'button', { name: 'Cols' } ) ).toBeNull();
	} );

	it( 'browses its source’s glob: the partition picker, then the rail and the step', async () => {
		replyFor = ( m ) =>
			'list_logs' === m[ VALUE ].name
				? [
						{ key: 'tawaki.p1', label: 'tawaki.p1' },
						{ key: 'tawaki.p6', label: 'tawaki.p6' },
				  ]
				: { segments: [ { id: 7971, size: 77 } ] };
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'tawaki-7971',
			columns: [],
			title: 'Tawaki 7971',
		} );
		await clock.tick( 1 );
		const picker = await screen.findByRole( 'combobox', {
			name: 'Browse a partition',
		} );
		expect(
			within( picker )
				.getAllByRole( 'option' )
				.map( ( option ) => option.value )
		).toEqual( [ '', 'tawaki.p1', 'tawaki.p6' ] );
		expect(
			screen.queryByRole( 'button', { name: 'Step one message' } )
		).toBeNull();

		fireEvent.change( picker, { target: { value: 'tawaki.p6' } } );

		expect(
			await screen.findByRole( 'button', { name: 'Step one message' } )
		).toBeTruthy();
		expect(
			screen.getByRole( 'button', { name: 'Show the browse rail' } )
		).toBeTruthy();
		expect(
			screen.getByRole( 'textbox', { name: 'Jump to an offset' } )
		).toBeTruthy();
	} );

	it( 'puts its toolbar in the page’s header slot when it says so, and keeps it otherwise', async () => {
		const slot = document.createElement( 'div' );
		document.body.appendChild( slot );
		const { container } = renderOnPage(
			'newspack-nodes/log-stream',
			{ source: 'hoiho-7970', columns: [], title: '', toolbar: 'header' },
			{ headerSlot: slot }
		);
		await act( async () => {} );
		expect( slot.textContent ).toContain( '0 penguins 7970' );
		expect( container.textContent ).not.toContain( '0 penguins 7970' );
		expect(
			within( container ).getByRole( 'table', {
				name: 'Hoiho colony 7970',
			} )
		).toBeTruthy();
		slot.remove();
	} );

	it( 'keeps its toolbar inline when its toolbar is not the header’s', async () => {
		const slot = document.createElement( 'div' );
		const { container } = renderOnPage(
			'newspack-nodes/log-stream',
			{ source: 'hoiho-7970', columns: [], title: '', toolbar: 'inline' },
			{ headerSlot: slot }
		);
		await act( async () => {} );
		expect( slot.textContent ).toBe( '' );
		expect( container.textContent ).toContain( '0 penguins 7970' );
	} );

	it( 'draws the control its page hands its source, just ahead of Cols', async () => {
		renderOnPage(
			'newspack-nodes/log-stream',
			{ source: 'hoiho-7970', columns: [ 'tag' ], title: '' },
			{
				sourceControls: {
					'hoiho-7970': <button type="button">Tide 7972</button>,
				},
			}
		);
		await act( async () => {} );
		const labels = screen
			.getAllByRole( 'button' )
			.map( ( button ) => button.textContent );
		expect( labels.indexOf( 'Tide 7972' ) ).toBe(
			labels.indexOf( 'Cols' ) - 1
		);
	} );

	it( 'filters only a source that names its filter', async () => {
		renderBlock( 'newspack-nodes/log-stream', {
			source: 'tui-7844',
			columns: [],
			title: 'Tail 7974',
		} );
		await act( async () => {} );
		expect( screen.queryByRole( 'searchbox' ) ).toBeNull();
	} );

	it( 'draws an existing row once as new rows arrive above it', () => {
		const drawn = [];
		const renderRow = logRow( [
			{
				key: 'tag',
				label: 'Tag 7975',
				cell: ( row ) => {
					drawn.push( row.tag );
					return <span role="cell">{ row.tag }</span>;
				},
			},
		] );
		const kea = { id: 1, isEven: false, tag: 'kea-7975' };
		const weka = { id: 2, isEven: true, tag: 'weka-7975' };
		const { rerender } = render( <>{ [ kea ].map( renderRow ) }</> );
		rerender( <>{ [ weka, kea ].map( renderRow ) }</> );
		expect( drawn ).toEqual( [ 'kea-7975', 'weka-7975' ] );
	} );

	it( 'draws a row’s named fields, each formatted as declared', () => {
		const renderRow = logRow( [
			{ key: 'text', label: 'Line 7844', format: ( v ) => `«${ v }»` },
		] );
		render( renderRow( { id: 4, isEven: true, text: 'kokako-7844' } ) );
		expect( screen.getByText( '«kokako-7844»' ) ).toBeTruthy();
	} );
} );

describe( 'the section block', () => {
	it( 'heads the blocks it holds with its title and description', () => {
		const { View } = VIEWS[ 'newspack-nodes/section' ];
		render(
			<View
				attributes={ {
					title: 'Roost 7845',
					description: 'Where the flock sleeps 7845',
				} }
				editing={ false }
			>
				<p>Inner 7845</p>
			</View>
		);
		const region = screen.getByRole( 'region', { name: 'Roost 7845' } );
		expect(
			within( region ).getByText( 'Where the flock sleeps 7845' )
		).toBeTruthy();
		expect( within( region ).getByText( 'Inner 7845' ) ).toBeTruthy();
	} );
} );

describe( 'a block on a layout being edited', () => {
	it( 'writes nothing: it reads its source, and its controls send nothing', async () => {
		renderBlock(
			'newspack-nodes/log-stream',
			{ source: 'tui-7844', columns: [], title: 'Tail 7845' },
			true
		);
		renderBlock(
			'newspack-nodes/stats',
			{ source: 'pukeko-7840', fields: [], columns: 0 },
			true
		);
		await screen.findByText( '41 m' );
		const view = Core.node(
			[ ...Core.nodes.keys() ].find( ( name ) =>
				/^tui-7844:\d+:view$/.test( name )
			)
		);
		const fill = jest.spyOn( view, 'fill' );

		fireEvent.click(
			screen.getByRole( 'button', { name: 'Pause streaming' } )
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'Clear' } ) );

		expect( fill ).not.toHaveBeenCalled();
		expect( view.paused ).toBeFalsy();
		expect( wire.batches.flat().map( ( m ) => m[ VALUE ]?.name ) ).toEqual(
			[ 'graze' ]
		);
	} );
} );

describe( 'a block’s settings', () => {
	const TEXT = { type: 'string', default: '' };
	const NAMES = { type: 'array', items: { type: 'string' }, default: [] };

	/** The attribute schemas the substrate declares, as the editor holds them. */
	const SCHEMAS = {
		'newspack-nodes/stats': {
			source: TEXT,
			fields: NAMES,
			columns: { type: 'integer', minimum: 0, maximum: 12, default: 0 },
		},
		'newspack-nodes/table': {
			source: TEXT,
			columns: NAMES,
			sort: { type: 'object', default: { field: '', direction: 'desc' } },
			perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
			title: TEXT,
		},
		'newspack-nodes/sparkline': { source: TEXT, field: TEXT, title: TEXT },
		'newspack-nodes/section': { title: TEXT, description: TEXT },
		'newspack-nodes/log-stream': {
			source: TEXT,
			columns: NAMES,
			title: TEXT,
			toolbar: {
				type: 'string',
				enum: [ 'inline', 'header' ],
				default: 'inline',
			},
		},
	};

	/**
	 * One block's controls, its attribute writes recorded.
	 *
	 * @param {string} name       The block.
	 * @param {Object} attributes Its attributes.
	 * @return {jest.Mock} The writes.
	 */
	function renderControls( name, attributes ) {
		const setAttributes = jest.fn();
		const { Controls } = SUBSTRATE_VIEWS[ name ];
		render(
			<Controls
				attributes={ attributes }
				setAttributes={ setAttributes }
				schema={ SCHEMAS[ name ] }
			/>
		);
		return setAttributes;
	}

	it( 'offers the log stream’s toolbar places by name, writing the one picked', () => {
		const set = renderControls( 'newspack-nodes/log-stream', {
			source: 'hoiho-7970',
			columns: [],
			title: '',
			toolbar: 'inline',
		} );
		const toolbar = screen.getByRole( 'combobox', { name: 'Toolbar' } );
		expect(
			[ ...toolbar.options ].map( ( one ) => one.textContent )
		).toEqual( [ 'In the block', 'In the page header' ] );
		fireEvent.change( toolbar, { target: { value: 'header' } } );
		expect( set ).toHaveBeenCalledWith( { toolbar: 'header' } );
	} );

	it( 'names a source by its declared label, and one with none by its name', () => {
		renderControls( 'newspack-nodes/stats', {
			source: '',
			fields: [],
			columns: 0,
		} );
		const offered = Object.fromEntries(
			[
				...screen.getByRole( 'combobox', { name: 'Source' } ).options,
			].map( ( one ) => [ one.value, one.textContent ] )
		);
		expect( offered[ 'pukeko-7840' ] ).toBe( 'Pukeko Swamp 7862' );
		expect( offered[ 'moana-7861' ] ).toBe( 'moana-7861' );
	} );

	it( 'holds a number to its declared bounds, and writes nothing for an empty box', () => {
		const set = renderControls( 'newspack-nodes/table', {
			source: 'kaka-7842',
			columns: [],
			sort: { field: '', direction: 'desc' },
			perPage: 37,
			title: '',
		} );
		const box = screen.getByRole( 'spinbutton', { name: 'Rows per page' } );
		expect( box.getAttribute( 'max' ) ).toBe( '100' );
		expect( box.getAttribute( 'min' ) ).toBe( '1' );

		fireEvent.change( box, { target: { value: '250' } } );
		expect( set ).toHaveBeenLastCalledWith( { perPage: 100 } );
		fireEvent.change( box, { target: { value: '0' } } );
		expect( set ).toHaveBeenLastCalledWith( { perPage: 1 } );
		set.mockClear();
		fireEvent.change( box, { target: { value: '' } } );
		expect( set ).not.toHaveBeenCalled();
	} );

	it( 'offers only sources holding a field of its kind, and a new source clears its fields', () => {
		const set = renderControls( 'newspack-nodes/stats', {
			source: '',
			fields: [ 'height' ],
			columns: 0,
		} );
		const source = screen.getByRole( 'combobox', { name: 'Source' } );
		const offered = [ ...source.options ].map( ( one ) => one.value );
		expect( offered ).toContain( 'pukeko-7840' );
		expect( offered ).not.toContain( 'kaka-7842' );
		expect( offered ).not.toContain( 'tui-7844' );

		fireEvent.change( source, { target: { value: 'pukeko-7840' } } );

		expect( set ).toHaveBeenCalledWith( {
			source: 'pukeko-7840',
			fields: [],
		} );
	} );

	it( 'writes the fields picked from the source’s fields of its kind', () => {
		const set = renderControls( 'newspack-nodes/stats', {
			source: 'pukeko-7840',
			fields: [ 'height' ],
			columns: 0,
		} );
		const input = screen.getByRole( 'combobox', { name: 'Fields' } );
		fireEvent.change( input, { target: { value: 'Wings 7840' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );

		expect( set ).toHaveBeenLastCalledWith( {
			fields: [ 'height', 'wings' ],
		} );
	} );

	it( 'finds a field by its label as typed, and stores its key', () => {
		const set = renderControls( 'newspack-nodes/stats', {
			source: 'moana-7861',
			fields: [ 'swell' ],
			columns: 0,
		} );
		expect( screen.getByText( 'Swell 7861' ) ).toBeTruthy();
		const input = screen.getByRole( 'combobox', { name: 'Fields' } );
		fireEvent.change( input, { target: { value: 'Tide Height 7861' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );

		expect( set ).toHaveBeenLastCalledWith( {
			fields: [ 'swell', 'tide' ],
		} );
	} );

	it( 'refuses a key typed in place of a label', () => {
		const set = renderControls( 'newspack-nodes/stats', {
			source: 'moana-7861',
			fields: [],
			columns: 0,
		} );
		const input = screen.getByRole( 'combobox', { name: 'Fields' } );
		fireEvent.change( input, { target: { value: 'tide' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );

		expect( set ).not.toHaveBeenCalled();
	} );

	it( 'writes its own settings, a number as a number', () => {
		const set = renderControls( 'newspack-nodes/stats', {
			source: 'pukeko-7840',
			fields: [],
			columns: 0,
		} );
		fireEvent.change(
			screen.getByRole( 'spinbutton', { name: 'Tiles per row' } ),
			{ target: { value: '3' } }
		);
		expect( set ).toHaveBeenCalledWith( { columns: 3 } );
	} );

	it( 'picks a sparkline’s one field from the source’s lines', () => {
		const set = renderControls( 'newspack-nodes/sparkline', {
			source: 'pukeko-7840',
			field: '',
			title: '',
		} );
		const field = screen.getByRole( 'combobox', { name: 'Field' } );
		expect( [ ...field.options ].map( ( one ) => one.value ) ).toEqual( [
			'',
			'pulse',
		] );
		fireEvent.change( field, { target: { value: 'pulse' } } );
		expect( set ).toHaveBeenCalledWith( { field: 'pulse' } );
	} );

	it( 'titles a section', () => {
		const set = renderControls( 'newspack-nodes/section', {
			title: '',
			description: '',
		} );
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Title' } ), {
			target: { value: 'Roost 7846' },
		} );
		expect( set ).toHaveBeenCalledWith( { title: 'Roost 7846' } );
	} );
} );
