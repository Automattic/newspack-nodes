/* eslint-env jest */
/**
 * The Aggregator tab against the wire: its two sources ask `summary` and
 * `list_servers` in one POST and land each reply on its own model, both
 * ask again at the cadence the reader picked, the cadence a first visit
 * reads is the one the browser kept, and two spokes probed at once each
 * show their own answer.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Core, FROM, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { steppedClock } from '@newspack-nodes/shared/test-utils/steppedClock';
import { AggregatorTab } from '../AggregatorTab';
import { localizeStationPages } from '../../station/__tests__/localizeStationPages';

const SERVERS = [ 'kea-7950', 'kaka-7950' ].map( ( id ) => ( {
	id,
	vault_id: `${ id }-vault`,
	url: `https://${ id }.example.test`,
	partitions: { 0: { connected: true, last_response: 1790000400 } },
	readers: [],
} ) );

let wire;
let clock;

/**
 * Every command of one verb the wire carried.
 *
 * @param {string} verb The verb.
 * @return {Array} The commands.
 */
const sent = ( verb ) =>
	wire.batches.flat().filter( ( m ) => verb === m[ VALUE ]?.name );

beforeEach( () => {
	Core.reset();
	clock = steppedClock();
	window.localStorage.clear();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	localizeStationPages();
	wire = installFakeCommandWire( ( m ) => {
		const name = m[ VALUE ].name;
		if ( 'probe' === name ) {
			const [ vault ] = m[ VALUE ].arguments;
			return { worst_distance: 'kea-7950-vault' === vault ? 7 : 9 };
		}
		return 'summary' === name
			? { connected: 2, idle: 0, total: 2, server_now: 1790000500 }
			: SERVERS;
	} );
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

it( 'asks summary and list_servers in one POST, each reply on its own model', async () => {
	render( <AggregatorTab /> );
	expect( await screen.findByText( 'kaka-7950' ) ).toBeTruthy();
	expect( sent( 'summary' ) ).toHaveLength( 1 );
	expect( sent( 'list_servers' ) ).toHaveLength( 1 );
	const first = wire.batches.find( ( batch ) =>
		batch.some( ( m ) => 'summary' === m[ VALUE ]?.name )
	);
	expect( first.map( ( m ) => m[ VALUE ].name ).sort() ).toEqual( [
		'list_servers',
		'summary',
	] );
	expect( screen.getByText( '2' ) ).toBeTruthy();
} );

it( 'asks again at the cadence the reader picks', async () => {
	render( <AggregatorTab /> );
	await screen.findByText( 'kaka-7950' );
	fireEvent.change(
		screen.getByRole( 'combobox', { name: 'Refresh interval' } ),
		{ target: { value: '10000' } }
	);
	await screen.findByText( 'kaka-7950' );
	const asked = sent( 'list_servers' ).length;
	await clock.tick( 3 );
	expect( sent( 'list_servers' ) ).toHaveLength( asked );
	await clock.tick( 10 );
	expect( sent( 'list_servers' ).length ).toBeGreaterThan( asked );
} );

it( 'keeps the cards on screen when the cadence changes, the poll re-armed in place', async () => {
	render( <AggregatorTab /> );
	await screen.findByText( 'kaka-7950' );
	const asked = sent( 'list_servers' ).length;
	fireEvent.change(
		screen.getByRole( 'combobox', { name: 'Refresh interval' } ),
		{ target: { value: '5000' } }
	);
	expect( screen.getByText( 'kaka-7950' ) ).toBeTruthy();
	expect( sent( 'list_servers' ) ).toHaveLength( asked );
} );

it( 'probes two spokes at once, each card showing its own answer', async () => {
	const { container } = render( <AggregatorTab /> );
	await screen.findByText( 'kaka-7950' );
	const [ first, second ] = container.querySelectorAll(
		'.aggregator-fleet-probe-button'
	);
	act( () => {
		fireEvent.click( first );
		fireEvent.click( second );
	} );
	expect( await screen.findByText( 'Worst lag 9 B' ) ).toBeTruthy();
	expect( screen.getByText( 'Worst lag 7 B' ) ).toBeTruthy();
	expect( sent( 'probe' ).map( ( m ) => m[ FROM ] ) ).toEqual( [
		'aggregator:probe:in/kea-7950-vault',
		'aggregator:probe:in/kaka-7950-vault',
	] );
} );

it( 'opens a first visit on the cadence the browser kept', () => {
	window.localStorage.setItem( 'aggregator-status-refresh', '5000' );
	const host = document.createElement( 'div' );
	document.body.appendChild( host );
	let root;
	jest.isolateModules( () => {
		const { AggregatorTab: Fresh } = require( '../AggregatorTab' );
		const { createElement } = require( '@wordpress/element' );
		const { act: freshAct } = require( 'react' );
		const { createRoot } = require( 'react-dom/client' );
		freshAct( () => {
			root = createRoot( host );
			root.render( createElement( Fresh ) );
		} );
		expect( host.querySelector( 'select' ).value ).toBe( '5000' );
		freshAct( () => root.unmount() );
	} );
	host.remove();
} );
