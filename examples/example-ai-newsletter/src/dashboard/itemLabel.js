import { __ } from '@wordpress/i18n';

/**
 * Normalize a ranked item to its display strings, applying the shared
 * empty-field fallbacks ONCE. Returns RAW text — callers escape (HTML) or
 * format (markdown) as their target requires. Used by the on-screen preview,
 * the markdown draft, and the draft-post HTML so all three agree.
 *
 * @param {{title?: string, source?: string}} [item] A ranked item.
 * @return {{title: string, source: string}} Display title + source.
 */
export function itemLabel( item = {} ) {
	return {
		title: item.title || __( '(untitled)', 'newspack-ai-newsletter' ),
		source: item.source || '?',
	};
}
