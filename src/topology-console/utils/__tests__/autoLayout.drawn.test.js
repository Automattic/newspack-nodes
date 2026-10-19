/**
 * The Performance dashboard's two station groups, the overview group feeding
 * `overview:shell` and the url group feeding `url:shell`, laid out by hand as
 * autolayout should draw them.
 *
 * Each card's place is its column and row in grid steps, `X_STEP` and
 * `Y_STEP`, measured from its group's top-left card, so the test holds each
 * group's shape and not where the two groups sit beside each other.
 */

import { autoLayout, X_PAD, X_STEP, Y_PAD, Y_STEP } from '../autoLayout';

/**
 * The graph the station draws: per slice, a receiver Tee feeding its
 * Current, the Current its view, and the receiver and the group's tee its
 * Fetcher, whose answers the group's Tap carries.
 *
 * @return {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} The graph.
 */
function performanceGraph() {
	const edges = [];
	const edge = ( from, to ) => edges.push( { from, to } );
	const slice = ( subject, tee, shell, view = 'view' ) => {
		edge( `${ subject }:in`, `${ subject }:in:current` );
		edge( `${ subject }:in:current`, `${ subject }:${ view }` );
		edge( `${ subject }:in`, `${ subject }:fetch` );
		edge( tee, `${ subject }:fetch` );
		edge( `${ subject }:fetch`, shell );
	};
	edge( 'performance:timer', 'performance:tee' );
	for ( const subject of [ 'categories', 'chart', 'overview', 'urls' ] ) {
		slice( subject, 'performance:tee', 'overview:shell' );
	}
	edge( 'url-detail:timer', 'url-detail:tee' );
	for ( const subject of [ 'url-categories', 'url-chart', 'url-detail' ] ) {
		slice( subject, 'url-detail:tee', 'url:shell' );
	}
	for ( const subject of [ 'url-deeplink', 'url-lookup' ] ) {
		edge( `${ subject }:timer`, `${ subject }:tee` );
		slice( subject, `${ subject }:tee`, 'url:shell', 'result' );
	}
	const ids = [ ...new Set( edges.flatMap( ( e ) => [ e.from, e.to ] ) ) ];
	return { nodes: ids.map( ( id ) => ( { id } ) ), edges };
}

/** The overview group as drawn by hand: [ column, row ] per card. */
const OVERVIEW = {
	'categories:in': [ 0, 0.5 ],
	'performance:timer': [ 0, 1.5 ],
	'chart:in': [ 0, 2.5 ],
	'overview:in': [ 0, 3.5 ],
	'urls:in': [ 0, 4.5 ],
	'performance:tee': [ 1, 1.5 ],
	'categories:in:current': [ 1.5, 0 ],
	'chart:in:current': [ 1.5, 5 ],
	'overview:in:current': [ 1.5, 6 ],
	'urls:in:current': [ 1.5, 7 ],
	'categories:view': [ 2.5, 0 ],
	'categories:fetch': [ 2.5, 1 ],
	'chart:fetch': [ 2.5, 2 ],
	'overview:fetch': [ 2.5, 3 ],
	'urls:fetch': [ 2.5, 4 ],
	'chart:view': [ 2.5, 5 ],
	'overview:view': [ 2.5, 6 ],
	'urls:view': [ 2.5, 7 ],
	'overview:shell': [ 4, 2.5 ],
};

/** The url group as drawn by hand: [ column, row ] per card. */
const URL = {
	'url-categories:in': [ 0, 0.5 ],
	'url-detail:timer': [ 0, 1.5 ],
	'url-chart:in': [ 0, 2.5 ],
	'url-detail:in': [ 0, 3.5 ],
	'url-deeplink:timer': [ 0, 6 ],
	'url-deeplink:in': [ 0, 7 ],
	'url-lookup:timer': [ 0, 8.5 ],
	'url-lookup:in': [ 0, 9.5 ],
	'url-detail:tee': [ 1, 1.5 ],
	'url-deeplink:tee': [ 1, 6 ],
	'url-lookup:tee': [ 1, 8.5 ],
	'url-categories:in:current': [ 1.5, 0 ],
	'url-chart:in:current': [ 1.5, 4 ],
	'url-detail:in:current': [ 1.5, 5 ],
	'url-deeplink:in:current': [ 1.5, 7.5 ],
	'url-lookup:in:current': [ 1.5, 10 ],
	'url-categories:view': [ 2.5, 0 ],
	'url-categories:fetch': [ 2.5, 1 ],
	'url-chart:fetch': [ 2.5, 2 ],
	'url-detail:fetch': [ 2.5, 3 ],
	'url-chart:view': [ 2.5, 4 ],
	'url-detail:view': [ 2.5, 5 ],
	'url-deeplink:fetch': [ 2.5, 6.5 ],
	'url-deeplink:result': [ 2.5, 7.5 ],
	'url-lookup:fetch': [ 2.5, 9 ],
	'url-lookup:result': [ 2.5, 10 ],
	'url:shell': [ 4, 5 ],
};

/**
 * Where autolayout put each of a group's cards, in grid steps from the
 * group's top-left card.
 *
 * @param {Object<string, {x: number, y: number}>} at    Every card's position.
 * @param {Array<string>}                          group The group's card ids.
 * @return {Object<string, Array<number>>} [ column, row ] per card.
 */
function placesOf( at, group ) {
	const cells = group.map( ( id ) => [
		id,
		( at[ id ].x - X_PAD ) / X_STEP,
		( at[ id ].y - Y_PAD ) / Y_STEP,
	] );
	const left = Math.min( ...cells.map( ( [ , col ] ) => col ) );
	const top = Math.min( ...cells.map( ( [ , , row ] ) => row ) );
	return Object.fromEntries(
		cells.map( ( [ id, col, row ] ) => [ id, [ col - left, row - top ] ] )
	);
}

describe( 'autoLayout — the Performance dashboard as drawn by hand', () => {
	const at = Object.fromEntries(
		autoLayout( performanceGraph() ).nodes.map( ( n ) => [
			n.id,
			n.position,
		] )
	);

	it( 'lays out the overview group as drawn', () => {
		expect( placesOf( at, Object.keys( OVERVIEW ) ) ).toEqual( OVERVIEW );
	} );

	it( 'lays out the url group as drawn', () => {
		expect( placesOf( at, Object.keys( URL ) ) ).toEqual( URL );
	} );
} );
