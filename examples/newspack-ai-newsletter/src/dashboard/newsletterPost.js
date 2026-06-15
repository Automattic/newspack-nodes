import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

const HTML_ENTITIES = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#039;',
};

/**
 * Escape the five HTML-significant characters so a title/source can't break out
 * of the markup we build for the draft-post body.
 *
 * @param {string} value Raw text.
 * @return {string} HTML-safe text.
 */
function escapeHtml( value ) {
	return String( value ).replace(
		/[&<>"']/g,
		( char ) => HTML_ENTITIES[ char ]
	);
}

/**
 * Render the score-ranked items into the WordPress draft-post shape, CLIENT-SIDE
 * (no server call). The model's `top` is already score-ordered, so the list
 * keeps its order. The returned `{ title, content }` is the REST
 * `POST /wp/v2/posts` body the "Create draft post" action sends.
 *
 * @param {Array<{source?: string, title?: string, score?: number}>} items Ranked items.
 * @return {{title: string, content: string}} The draft-post title + HTML content.
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
		title: __( 'Publisher Newsletter', 'newspack-ai-newsletter' ),
		content: `<ul>${ rows }</ul>`,
	};
}
