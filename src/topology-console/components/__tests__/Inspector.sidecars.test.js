/**
 * An owned node's Inspector, shown in its owner's place from the row the
 * console's sidecar poller asks `dump_metadata -o <name>` for, the name riding
 * on FROM: it renders the row's Time Travel, Triage and verbs, names its owner as
 * a link back. Its own sidecars open from the "…" on its grid card, so its
 * title offers none.
 */

import { act, fireEvent, screen } from '@testing-library/react';
import { Profiler } from 'react';
import Inspector from '../Inspector';
import { Core } from '../../../runtime/core';
import {
	newMessage,
	FROM,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';
import { SIDECAR_POLLER, useSidecarRows } from '../../hooks/useSidecarRows';

const READER = 'remote-tulsa:firehose.p0';

/** The broker as the canvas holds it. */
const broker = {
	id: 'remote-tulsa',
	class: 'Remote_Source',
	count: 0,
	sidecars: [ { name: 'remote-tulsa:http-out', class: 'HTTP_Out' } ],
};

/** The class catalog the sidecars' Constructor, Triage and Verbs read. */
const catalog = [
	{
		shell_name: 'Remote_Consumer',
		category: 'Hidden',
		arguments: [
			{ name: 'stamp' },
			{ name: 'offsetlog_dir' },
			{ name: 'deadletter_dir' },
		],
		commands: [ { name: 'set_line_mode', args: [] } ],
	},
];

/**
 * The reader's row as `dump_metadata <name>` answers it.
 *
 * @param {Object} [over] Fields to override.
 * @return {Object} The one-row reply map.
 */
const readerReply = ( over = {} ) => ( {
	[ READER ]: {
		class: 'Remote_Consumer',
		counter: 4471,
		owner: 'remote-tulsa',
		frames: [ { id: 6110, size: 90 } ],
		cursor: { segment: 3, offset: 41 },
		arguments: [
			'firehose.p0',
			'/offsets/remote-tulsa',
			'/deadletter/remote-tulsa',
		],
		deadletter_segments: 4,
		has_config: true,
		...over,
	},
} );

/**
 * Answer the sidecar poller as the Router hands it a reply: the name the poll
 * rode on FROM left as the remaining TO.
 *
 * @param {Object} map  The `dump_metadata` reply map.
 * @param {string} name The sidecar the reply answers about.
 */
function answer( map, name ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ TO ] = encodeURIComponent( name );
	m[ VALUE ] = { payload: map };
	act( () => Core.node( SIDECAR_POLLER ).fill( m ) );
}

/**
 * The Inspector fed the shown sidecar's row, as GraphView feeds it.
 *
 * @param {Object} props Inspector props.
 * @return {import('react').ReactElement} The element.
 */
function Polled( props ) {
	const { graph, answered } = useSidecarRows(
		props.sidecar ? [ props.sidecar ] : []
	);
	const shown = answered.includes( props.sidecar ) ? graph : null;
	return <Inspector { ...props } sidecarGraph={ shown } />;
}

/**
 * The Inspector with the broker selected and `sidecar` shown in its place.
 *
 * @param {Object} props Extra Inspector props.
 * @return {import('react').ReactElement} The element.
 */
const inspector = ( props = {} ) => (
	<Polled
		selectedId="remote-tulsa"
		parsed={ { nodes: [ broker ], edges: [] } }
		streamStatus="open"
		rateInfo={ null }
		onAction={ () => {} }
		onSelect={ () => {} }
		onHover={ () => {} }
		nodeIds={ new Set( [ 'remote-tulsa' ] ) }
		{ ...props }
	/>
);

const title = ( container ) =>
	container.querySelector( '.topology-insp__title' ).textContent;

describe( 'Inspector sidecars', () => {
	/** What reached the scope `_cwd` stands for, here a capture. */
	let sent;

	beforeEach( () => {
		jest.useFakeTimers();
		Core.reset();
		sent = [];
		Core.registerNode( '_cwd', {
			name: '_cwd',
			fill: ( m ) => sent.push( m ),
		} );
	} );

	afterEach( () => {
		jest.useRealTimers();
	} );

	it( 'polls `dump_metadata -o <name>` at the current scope, the name riding on FROM', async () => {
		const { container } = renderWithCatalog(
			inspector( { sidecar: READER } ),
			{ classes: catalog }
		);
		await act( async () => {} );
		const poller = Core.node( SIDECAR_POLLER );
		expect( poller.pollArgs ).toEqual( [ '-o', READER ] );
		expect( poller.target ).toBe( '_cwd' );
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'dump_metadata',
			arguments: [ '-o', READER ],
		} );
		expect( sent[ 0 ][ FROM ] ).toBe(
			`${ SIDECAR_POLLER }/${ encodeURIComponent( READER ) }`
		);
		expect( container.textContent ).toMatch( /Loading/ );
	} );

	it( "shows the reader's Inspector with Time Travel and Triage", () => {
		const { container } = renderWithCatalog(
			inspector( { sidecar: READER } ),
			{ classes: catalog }
		);
		answer( readerReply(), READER );
		expect( title( container ) ).toBe( READER );
		expect(
			container.querySelector( '.topology-insp__type' ).textContent
		).toMatch( /Remote_Consumer/ );
		expect( screen.queryByText( 'Time Travel' ) ).not.toBeNull();
		expect( screen.queryByText( 'Triage (4)' ) ).not.toBeNull();
	} );

	it( 'shows the Activity a canvas node gets, from the rate it is handed', () => {
		const { container } = renderWithCatalog(
			inspector( {
				sidecar: READER,
				rateInfo: {
					rate: 17,
					history: [ 9, 17 ],
					hasMessages: true,
					lastChangedTs: 1_700_000_000,
				},
			} ),
			{ classes: catalog }
		);
		answer( readerReply(), READER );
		expect( screen.queryByText( 'Activity' ) ).not.toBeNull();
		expect( container.textContent ).toMatch( /messages \/s/ );
		expect( container.textContent ).toMatch( /17(\.0)?\s*\/s/ );
	} );

	it( 'sends its verbs to the sidecar, not to its owner', () => {
		const onAction = jest.fn();
		renderWithCatalog( inspector( { sidecar: READER, onAction } ), {
			classes: catalog,
		} );
		answer( readerReply(), READER );
		fireEvent.click( screen.getByText( 'set_line_mode' ) );
		fireEvent.click( screen.getByLabelText( /pause/i ) );
		expect( onAction ).toHaveBeenCalledWith(
			'invoke',
			READER,
			expect.objectContaining( { verb: 'set_line_mode' } )
		);
		expect( onAction ).toHaveBeenCalledWith(
			'invoke',
			READER,
			expect.objectContaining( { verb: 'pause' } )
		);
		expect(
			onAction.mock.calls.some( ( [ , id ] ) => 'remote-tulsa' === id )
		).toBe( false );
	} );

	it( 'names its owner as a link back to it', () => {
		const onOpenNode = jest.fn();
		const { container } = renderWithCatalog(
			inspector( { sidecar: READER, onOpenNode } ),
			{ classes: catalog }
		);
		answer( readerReply(), READER );
		expect(
			container.querySelector( '.topology-insp__owned' ).textContent
		).toMatch( /owned by remote-tulsa/i );
		fireEvent.click(
			container.querySelector( '.topology-insp__owned button' )
		);
		expect( onOpenNode ).toHaveBeenCalledWith( 'remote-tulsa' );
	} );

	it( "offers no \u201c\u2026\u201d in a sidecar's title, its grid card carrying it", () => {
		const nested = [
			{ name: `${ READER }:offsetlog`, class: 'Partition' },
		];
		const { container } = renderWithCatalog(
			inspector( { sidecar: READER } ),
			{ classes: catalog }
		);
		answer( readerReply( { sidecars: nested } ), READER );
		expect( title( container ) ).toBe( READER );
		expect(
			container.querySelector( '[aria-haspopup="dialog"]' )
		).toBeNull();
	} );

	it( 'says a sidecar is gone when its name answers no row, linking back', () => {
		const onOpenNode = jest.fn();
		const { container } = renderWithCatalog(
			inspector( { sidecar: READER, onOpenNode } ),
			{ classes: catalog }
		);
		answer( {}, READER );
		expect( container.textContent ).toMatch(
			new RegExp( `${ READER } no longer present` )
		);
		fireEvent.click(
			container.querySelector( '.topology-insp__breadcrumb button' )
		);
		expect( onOpenNode ).toHaveBeenCalledWith( 'remote-tulsa' );
	} );

	it( 'commits no "no longer present" frame between a switch and the new answer', () => {
		const other = 'remote-tulsa:http-out';
		const frames = [];
		let root = null;
		const record = () => frames.push( root?.textContent ?? '' );
		const tree = ( sidecar ) => (
			<Profiler id="sidecars" onRender={ record }>
				<div
					ref={ ( el ) => {
						root = el;
					} }
				>
					{ inspector( { sidecar } ) }
				</div>
			</Profiler>
		);
		const { rerenderWithCatalog } = renderWithCatalog( tree( READER ), {
			classes: catalog,
		} );
		answer( readerReply(), READER );
		frames.length = 0;
		rerenderWithCatalog( tree( other ), { classes: catalog } );
		act( () => {} );
		answer(
			{ [ other ]: { class: 'HTTP_Out', owner: 'remote-tulsa' } },
			other
		);
		expect( frames.length ).toBeGreaterThan( 1 );
		expect(
			frames.filter( ( f ) => /no longer present/.test( f ) )
		).toEqual( [] );
		expect( frames[ frames.length - 1 ] ).toMatch( other );
	} );

	it( "never paints one sidecar's answer, or its absence, for another", () => {
		const other = 'remote-tulsa:http-out';
		const { container, rerenderWithCatalog } = renderWithCatalog(
			inspector( { sidecar: READER } ),
			{ classes: catalog }
		);
		answer( readerReply(), READER );
		rerenderWithCatalog( inspector( { sidecar: other } ), {
			classes: catalog,
		} );
		expect( container.textContent ).toMatch( /Loading/ );
		expect( container.textContent ).not.toMatch( /no longer present/ );
		answer( readerReply(), READER );
		expect( container.textContent ).toMatch( /Loading/ );
		answer(
			{ [ other ]: { class: 'HTTP_Out', owner: 'remote-tulsa' } },
			other
		);
		expect( title( container ) ).toBe( other );
	} );

	it( 'offers no verbs for a sidecar built without a :config', () => {
		const source = 'reader-7720:source';
		const classes = [
			...catalog,
			{
				shell_name: 'Partition',
				category: 'Storage',
				arguments: [ { name: 'dir' } ],
				commands: [ { name: 'allow_large_writes', args: [] } ],
			},
		];
		const { container } = renderWithCatalog(
			inspector( { sidecar: source } ),
			{ classes }
		);
		answer(
			{
				[ source ]: {
					class: 'Partition',
					counter: 5148,
					owner: 'reader-7720',
					has_config: false,
				},
			},
			source
		);
		expect( title( container ) ).toBe( source );
		expect( screen.queryByText( 'allow_large_writes' ) ).toBeNull();
		expect( screen.queryByText( 'Verbs' ) ).toBeNull();
	} );
} );
