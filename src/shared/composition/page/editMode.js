/**
 * Which layout a link edits. **Edit layout** reloads the page with
 * `edit=<page>`, its view, and for a page that takes one the subject it was
 * opened from, because only a load naming the edit, for a `tune` caller,
 * loads the block editor. The consumer hands in its map of composed pages.
 */

import { __ } from '@wordpress/i18n';
import { setQueryParams } from '../../utils/queryParams';

/**
 * Each composed page => the tab showing it and the param naming its
 * subject; a page with no `view` stands over whichever view opened it.
 *
 * @typedef {Object<string,{view: ?string, subject: ?string}>} ComposedPages
 */

/**
 * The layout a page edits: `page`, plus `<subject>_key` where it was opened
 * from a subject.
 *
 * @typedef {{page: string} & Object<string,string>} EditTarget
 */

/**
 * Every param naming a page's subject.
 *
 * @param {ComposedPages} pages The composed pages.
 * @return {string[]} The params.
 */
const subjects = ( pages ) =>
	Object.values( pages )
		.map( ( { subject } ) => subject )
		.filter( ( subject ) => null !== subject );

/**
 * The layout a query string edits, or null where it names none.
 *
 * @param {string}        search A query string.
 * @param {ComposedPages} pages  The composed pages.
 * @return {?EditTarget} The page and its subject.
 */
export function editTarget( search, pages ) {
	const query = new URLSearchParams( search );
	const page = query.get( 'edit' );
	if ( null === page || ! Object.hasOwn( pages, page ) ) {
		return null;
	}
	const param = pages[ page ].subject;
	const subject = null === param ? '' : query.get( param ) ?? '';
	return '' === subject ? { page } : { page, [ `${ param }_key` ]: subject };
}

/**
 * A query string editing `target` on its tab, or for a page with no tab on
 * the view it stands over, every other param kept.
 *
 * @param {string}        search The page's query string.
 * @param {EditTarget}    target The layout to edit.
 * @param {ComposedPages} pages  The composed pages.
 * @return {string} The query string, `?` first.
 */
export function editSearch( search, target, pages ) {
	const query = new URLSearchParams( search );
	subjects( pages ).forEach( ( param ) => query.delete( param ) );
	const { view, subject } = pages[ target.page ];
	if ( null !== view ) {
		query.set( 'view', view );
	}
	query.set( 'edit', target.page );
	if ( null !== subject && target[ `${ subject }_key` ] ) {
		query.set( subject, target[ `${ subject }_key` ] );
	}
	return `?${ query.toString() }`;
}

/**
 * Drop the edit and every subject from the page's URL, so a reload reads.
 *
 * @param {ComposedPages} pages The composed pages.
 */
export function leaveEdit( pages ) {
	setQueryParams( {
		edit: null,
		...Object.fromEntries(
			subjects( pages ).map( ( param ) => [ param, null ] )
		),
	} );
}

/**
 * The menu entry that opens a page's layout editor, for a view's own menu.
 *
 * @param {EditTarget}    target The page and its subject.
 * @param {ComposedPages} pages  The composed pages.
 * @return {{title: string, onClick: () => void}} The entry.
 */
export const editLayoutControl = ( target, pages ) => ( {
	title: __( 'Edit layout', 'newspack-nodes' ),
	onClick: () =>
		window.location.assign(
			editSearch( window.location.search, target, pages )
		),
} );
