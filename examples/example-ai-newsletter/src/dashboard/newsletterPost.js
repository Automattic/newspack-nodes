/**
 * Payload builder for the "Create draft post" action: score-ranked items become
 * a WordPress post title and an HTML list. The markup is built in the browser —
 * the only server call is the caller's POST.
 *
 * Escaping belongs here rather than to WordPress. A user holding
 * `unfiltered_html`, which an administrator on a single site does, is exempt
 * from kses, so the stored post keeps whatever markup an item title carried.
 */

import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

/**
 * HTML-significant characters mapped to their entities. Element text needs `&`,
 * `<` and `>`; the two quote characters ride along so the same escape holds
 * wherever a value lands in an attribute. `'` maps to the numeric `&#039;`
 * rather than `&apos;`, which HTML 4 does not define.
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
 * The `String()` coercion carries weight: `itemLabel` passes an item's own
 * `title` through whenever it is truthy, so an item carrying a numeric title
 * hands this a number, which has no `replace()`.
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
 * Render the score-ranked items as a draft post's title and an HTML list of
 * bolded `title — source` pairs. The `top-table:view` slice arrives
 * score-ordered, so the list keeps the order it is given instead of sorting
 * again.
 *
 * The two returned fields are what the "Create draft post" action sends to
 * `POST /wp/v2/posts`; the caller adds `status: 'draft'`.
 *
 * @param {Array<{source?:string,title?:string,score?:number}>} items Ranked items.
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
