/**
 * The station's composed pages: each tab's page slug, the context it lays
 * out, and the page data a station load localizes as
 * `NewspackNodesStationPages` (`Station_Pages::page_data()`). A station
 * page stands over whichever tab opened it, so its edit link keeps the
 * `tab` param and names no view.
 */

/** The surface every station page's layout commands are sent for. */
export const STATION_GROUP = 'station';

/**
 * Each composed station page => the edit-mode entry the substrate's edit
 * links read.
 *
 * @type {import('@newspack-nodes/shared/composition/page/editMode').ComposedPages}
 */
export const STATION_PAGES = {
	'station-overview': { view: null, subject: null },
	'station-jobs': { view: null, subject: null },
	'station-tables': { view: null, subject: null },
	'station-aggregator': { view: null, subject: null },
};

/**
 * The context a station page lays out.
 *
 * @param {string} page A STATION_PAGES key.
 * @return {string} Its context.
 */
export const stationContext = ( page ) => `newspack-nodes/${ page }`;

/**
 * What a station load localized: whether the reader may curate and read a
 * refusal's own words, and each context's layout or its refusal.
 *
 * @typedef {Object} StationPageData
 * @property {boolean}               canTune      Whether the reader may curate.
 * @property {boolean}               canManage    Whether the reader is an operator.
 * @property {Object<string,Object>} compositions Context => its layout or refusal.
 */

/**
 * The page data a station load localized.
 *
 * @return {StationPageData} It.
 * @throws {Error} On a page that localized none.
 */
export function stationPages() {
	const data = /** @type {{NewspackNodesStationPages?: StationPageData}} */ (
		/** @type {unknown} */ ( window )
	).NewspackNodesStationPages;
	if ( ! data ) {
		throw new Error(
			'a station page reads NewspackNodesStationPages, which the station load localizes'
		);
	}
	return data;
}
