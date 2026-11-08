/**
 * A series as one inline line, with no axis, legend or frame, its latest
 * value marked: the shape a reader takes in at a glance beside the words
 * that say what it means. It is drawn on the shared sparkline geometry, and
 * the `newspack-nodes-sparkline` role paints it in the first chart colour,
 * so it re-skins with the page.
 *
 * A dashboard that needs axes, a legend or a tooltip draws `AreaTimeChart`.
 */

import { linePath, sparklinePoints } from '../utils/sparkline';

/** The inset keeping the latest value's mark, and the stroke, in the box. */
const INSET = 3;

/** The latest value's mark radius in pixels. */
const MARK_RADIUS = 2.5;

/**
 * @param {Object}   props
 * @param {number[]} props.values The series, oldest first; none draws nothing.
 * @param {number}   props.width  The box's width in pixels.
 * @param {number}   props.height The box's height in pixels.
 * @param {string}   props.label  Translated words naming what the line shows, its accessible name.
 * @return {?import('react').ReactElement} The sparkline.
 */
export default function Sparkline( { values, width, height, label } ) {
	if ( 0 === values.length ) {
		return null;
	}
	const points = sparklinePoints( values, {
		width: width - 2 * INSET,
		height: height - 2 * INSET,
		left: INSET,
		top: INSET,
	} );
	const line = linePath( points );
	const [ x, y ] = points[ points.length - 1 ];
	return (
		<svg
			className="newspack-nodes-sparkline"
			role="img"
			aria-label={ label }
			width={ width }
			height={ height }
			viewBox={ `0 0 ${ width } ${ height }` }
		>
			{ line && <path d={ line } /> }
			<circle
				className="newspack-nodes-sparkline__latest"
				cx={ x }
				cy={ y }
				r={ MARK_RADIUS }
			/>
		</svg>
	);
}
