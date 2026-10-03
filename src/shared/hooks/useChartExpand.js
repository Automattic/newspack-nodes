/**
 * The click-to-expand behaviour every fixed-height time chart shares.
 *
 * A chart draws at `height`; clicking its plot area, or pressing Enter or
 * Space on it, doubles that, and the same again restores it. The hook hands
 * back the effective height for the draw, the plot's minimum height and the
 * legend, plus the props that make the plot a keyboard button.
 */

import { useCallback, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

/** The height factor of an expanded chart. */
const EXPANDED_FACTOR = 2;

/**
 * @param {number} height The chart's collapsed height in pixels.
 * @param {string} title  The chart's translated title, which names the button.
 * @return {{height: number, plotProps: Object}} The effective height, and the props to spread on the plot element.
 */
export function useChartExpand( height, title ) {
	const [ expanded, setExpanded ] = useState( false );
	const toggle = useCallback( () => setExpanded( ( on ) => ! on ), [] );
	// A drag-selection over the tick labels ends in a click; leave it be.
	const onClick = useCallback(
		( event ) => {
			const selection =
				event.currentTarget.ownerDocument.defaultView.getSelection();
			if ( selection && ! selection.isCollapsed ) {
				return;
			}
			toggle();
		},
		[ toggle ]
	);
	const onKeyDown = useCallback(
		( event ) => {
			if ( 'Enter' === event.key || ' ' === event.key ) {
				event.preventDefault();
				toggle();
			}
		},
		[ toggle ]
	);
	const label = expanded
		? // translators: %s: the chart's title.
		  sprintf( __( 'Shrink %s', 'newspack-nodes' ), title )
		: // translators: %s: the chart's title.
		  sprintf( __( 'Expand %s', 'newspack-nodes' ), title );

	return {
		height: expanded ? EXPANDED_FACTOR * height : height,
		plotProps: {
			role: 'button',
			tabIndex: 0,
			'aria-expanded': expanded,
			'aria-label': label,
			onClick,
			onKeyDown,
		},
	};
}
