import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

/**
 * Render the score-ranked items into a markdown draft, entirely in the
 * browser — the copy-and-edit starting point for the publisher's newsletter.
 * The "Copy markdown" button hands the result straight to the clipboard. The
 * `top-table:view` slice arrives score-ordered, so the bullets keep that order
 * rather than sorting again. Titles and sources come from the shared
 * `itemLabel`, so the on-screen preview, this draft and the draft post apply
 * one set of empty-field fallbacks; a local fallback here would let the three
 * disagree. Nothing is escaped, so a title carrying markdown syntax reaches
 * the draft as syntax; the `newsletterPost` sibling escapes for the HTML it
 * builds.
 *
 * @param {Array<{source?:string,title?:string,score?:number}>} [items] Ranked items.
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
