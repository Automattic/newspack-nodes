import { __ } from '@wordpress/i18n';
import { itemLabel } from './itemLabel';

/**
 * Render the score-ranked items into a markdown draft, CLIENT-SIDE (no server
 * call). The model's `top` is already score-ordered, so the bullets keep its
 * order. A copy/edit starting point for the publisher's newsletter.
 *
 * @param {Array<{source?: string, title?: string, score?: number}>} items Ranked items.
 * @return {string} A markdown document (heading + one bullet per item).
 */
export function draftNewsletter( items = [] ) {
	const lines = [
		`# ${ __( 'Publisher Newsletter', 'newspack-ai-newsletter' ) }`,
		'',
	];
	for ( const item of items ) {
		const { title, source } = itemLabel( item );
		lines.push( `- **${ title }** — ${ source }` );
	}
	return lines.join( '\n' );
}
