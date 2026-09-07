import { __ } from '@wordpress/i18n';

/**
 * Resolve a ranked item's title and source for display, applying the shared
 * empty-field fallbacks ONCE, so the on-screen preview, the markdown draft
 * and the draft-post HTML agree on what an empty field reads as. The text is
 * RAW — whatever renders it escapes or formats for its own target.
 *
 * A truthy field passes straight through, so an item whose title is a number
 * hands the caller a number, which is why `newsletterPost` coerces before
 * escaping.
 *
 * The `'?'` source fallback repeats what `Insights_CI_Demo_Node::shape_top()`
 * writes for an item with no `source` key; here it catches the empty string
 * that key can still hold.
 *
 * @param {{title?:*,source?:*}} [item] A ranked item.
 * @return {{title:*,source:*}} Display title and source.
 */
export function itemLabel( item = {} ) {
	return {
		title: item.title || __( '(untitled)', 'example-ai-newsletter' ),
		source: item.source || '?',
	};
}
