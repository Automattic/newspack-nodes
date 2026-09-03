import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

/**
 * Render the score-ranked items into a markdown draft, CLIENT-SIDE (no server
 * call), as the copy/edit starting point for the publisher's newsletter. The
 * "Copy markdown" button hands the result straight to the clipboard. The
 * model's `top` is already score-ordered, so the bullets keep its order rather
 * than sorting again. Titles and sources come from the shared `itemLabel`, so
 * the on-screen preview, this draft and the draft post apply one set of
 * empty-field fallbacks; a local fallback here would let the three disagree.
 * Nothing is escaped, because the destination is the clipboard rather than
 * markup — the `newsletterPost` sibling escapes for the HTML it builds.
 *
 * @param {Array<{source?: string, title?: string, score?: number}>} items Ranked items.
 * @return {string} A markdown document: an H1 heading, a blank line, then one
 *                  `- **title** — source` bullet per item.
 */
export function draftNewsletter( items = [] ) {
	const lines = [
		`# ${ __( 'Publisher Newsletter', 'example-ai-newsletter' ) }`,
		'',
	];
	for ( const item of items ) {
		const { title, source } = itemLabel( item );
		lines.push( `- **${ title }** — ${ source }` );
	}
	return lines.join( '\n' );
}
