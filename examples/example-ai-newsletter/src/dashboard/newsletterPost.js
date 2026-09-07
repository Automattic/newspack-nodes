/**
 * Payload builder for the "Create draft post" action: the score-ranked items
 * become a WordPress post. The markup is built in the browser — the only
 * server call is the caller's POST.
 *
 * Escaping belongs here rather than to WordPress. `add_menu_page()` registers
 * the Publisher Insights page under `manage_options`, and a single-site
 * administrator also holds `unfiltered_html`, which exempts the post from
 * kses — so markup an item title carried would be stored verbatim.
 */

import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

/**
 * The five HTML-significant characters mapped to their entities. This module
 * interpolates element text, which needs `&`, `<` and `>`; the two quote
 * characters ride along so one escape also covers an attribute value. `'`
 * maps to the numeric `&#039;` because HTML 4 defines no `&apos;`.
 *
 * @type {Object<string,string>}
 */
const HTML_ENTITIES = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#039;',
};

/**
 * Escape the five HTML-significant characters so a title or a source cannot
 * break out of the markup this module builds.
 *
 * The `String()` coercion is load-bearing: `itemLabel` passes an item's own
 * `title` or `source` through whenever it is truthy, so a numeric title hands
 * this a number, which has no `replace()`.
 *
 * @param {*} value Display text from `itemLabel`, not necessarily a string.
 * @return {string} HTML-safe text.
 */
function escapeHtml( value ) {
	return String( value ).replace(
		/[&<>"']/g,
		( char ) => HTML_ENTITIES[ char ]
	);
}

/**
 * Build the draft post: the translated "Publisher Newsletter" title and a
 * `<ul>` holding one `<li>` per ranked item, each reading
 * `<strong>title</strong> — source`. The `top-table:view` slice arrives
 * ordered by descending score, so the list keeps the order it is given
 * instead of sorting again.
 *
 * The two returned fields are what the "Create draft post" action sends to
 * `POST /wp/v2/posts`; the caller adds `status: 'draft'`.
 *
 * @param {Array<{source?:string,title?:string,score?:number}>} [items] Ranked items.
 * @return {{title:string,content:string}} Draft-post title and HTML content.
 */
export function newsletterPost( items = [] ) {
	const rows = items
		.map( ( item ) => {
			const { title, source } = itemLabel( item );
			return `<li><strong>${ escapeHtml(
				title
			) }</strong> — ${ escapeHtml( source ) }</li>`;
		} )
		.join( '' );

	return {
		title: __( 'Publisher Newsletter', 'example-ai-newsletter' ),
		content: `<ul>${ rows }</ul>`,
	};
}
