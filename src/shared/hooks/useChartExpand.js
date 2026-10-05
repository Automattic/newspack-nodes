/**
 * The expand toggle every fixed-height time chart shares.
 *
 * A chart draws at `height`; its corner expand button doubles that, and the
 * same again restores it. A shift+click on the plot is the mouse shortcut for
 * the same toggle, while a plain click there belongs to the chart, which may
 * report the slot under the pointer. The plot is never itself a button: a
 * screen reader activates one by dispatching a plain click, which the plot
 * hands to the chart. The hook returns the effective height for the draw, the
 * plot's minimum height and the legend, the plot's shortcut handlers, and the
 * props for the native button.
 */

import { useCallback, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

/** The height factor of an expanded chart. */
const EXPANDED_FACTOR = 2;

/**
 * Whether a click ends a drag-selection, as one over the tick labels does.
 * Every chart click handler skips such a click.
 *
 * @param {{currentTarget: Element}} event The click, on the element it bound.
 * @return {boolean} True when the document holds a non-collapsed selection.
 */
export function isDragSelection( event ) {
	const selection =
		event.currentTarget.ownerDocument.defaultView.getSelection();
	return Boolean( selection && ! selection.isCollapsed );
}

/**
 * @param {number} height The chart's collapsed height in pixels.
 * @param {string} title  The chart's translated title, which names the button.
 * @return {{height: number, plotProps: Object, buttonProps: Object}} The effective height, the shortcut handlers to spread on the plot, and the props to spread on the expand button.
 */
export function useChartExpand( height, title ) {
	const [ expanded, setExpanded ] = useState( false );
	const toggle = useCallback( () => setExpanded( ( on ) => ! on ), [] );
	const onClick = useCallback(
		( event ) => {
			if ( event.shiftKey && ! isDragSelection( event ) ) {
				toggle();
			}
		},
		[ toggle ]
	);
	// Shift+press extends the page's selection, which would cancel the click.
	const onMouseDown = useCallback( ( event ) => {
		if ( event.shiftKey ) {
			event.preventDefault();
		}
	}, [] );
	const label = expanded
		? // translators: %s: the chart's title.
		  sprintf( __( 'Shrink %s', 'newspack-nodes' ), title )
		: // translators: %s: the chart's title.
		  sprintf( __( 'Expand %s', 'newspack-nodes' ), title );

	return {
		height: expanded ? EXPANDED_FACTOR * height : height,
		plotProps: { onClick, onMouseDown },
		buttonProps: {
			'aria-expanded': expanded,
			'aria-label': label,
			title: label,
			onClick: toggle,
		},
	};
}
