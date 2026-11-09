/**
 * A series as one inline line, with no axis, legend or frame, its latest
 * value marked: the shape a reader takes in at a glance beside the words
 * that say what it means. It is drawn on the shared sparkline geometry, and
 * the `newspack-nodes-sparkline` role paints it: the line in Graphite, the
 * latest value in the accent, and the band in the accent's wash.
 *
 * A null value is unmeasured, so the line breaks there rather than dipping
 * to zero, and a measured value between two gaps is drawn as a dot. The band
 * is the usual range, `[ low, high ]`, drawn behind the line on its scale.
 *
 * A dashboard that needs axes, a legend or a tooltip draws `AreaTimeChart`.
 */

import { linePath, sparklinePoints } from '../utils/sparkline';

/** The inset keeping the latest value's mark, and the stroke, in the box. */
const INSET = 3;

/** The latest value's mark radius in pixels. */
const MARK_RADIUS = 2.5;

/**
 * The measured points as runs between gaps, each run one subpath; a lone
 * point retraces itself, so the round line cap draws it as a dot.
 *
 * @param {Array<?number>}          values The series, oldest first.
 * @param {Array<[number, number]>} points Each value's point.
 * @return {string} The path's `d`.
 */
const gappedPath = ( values, points ) => {
	const runs = [ [] ];
	values.forEach( ( value, i ) => {
		if ( null === value ) {
			runs.push( [] );
		} else {
			runs[ runs.length - 1 ].push( points[ i ] );
		}
	} );
	return runs
		.filter( ( run ) => run.length )
		.map( ( run ) =>
			linePath( 1 === run.length ? [ run[ 0 ], run[ 0 ] ] : run )
		)
		.join( ' ' );
};

/**
 * @param {Object}           props
 * @param {Array<?number>}   props.values The series, oldest first, null where unmeasured; none measured draws nothing.
 * @param {[number, number]} [props.band] The usual range, low then high, drawn behind the line.
 * @param {number}           props.width  The box's width in pixels.
 * @param {number}           props.height The box's height in pixels.
 * @param {string}           props.label  Translated words naming what the line shows, its accessible name.
 * @return {?import('react').ReactElement} The sparkline.
 */
export default function Sparkline( { values, band, width, height, label } ) {
	const measured = values.filter( ( value ) => null !== value );
	if ( 0 === measured.length ) {
		return null;
	}
	const box = {
		width: width - 2 * INSET,
		height: height - 2 * INSET,
		left: INSET,
		top: INSET,
		peak: Math.max( ...measured, ...( band || [] ) ),
	};
	const points = sparklinePoints( values, { ...box, slots: values.length } );
	const latest = values.reduce(
		( last, value, i ) => ( null === value ? last : i ),
		-1
	);
	const [ x, y ] = points[ latest ];
	const line = 1 < measured.length ? gappedPath( values, points ) : null;
	const [ [ , bottom ], [ , top ] ] = band
		? sparklinePoints( band, box )
		: [ [], [] ];
	return (
		<svg
			className="newspack-nodes-sparkline"
			role="img"
			aria-label={ label }
			width={ width }
			height={ height }
			viewBox={ `0 0 ${ width } ${ height }` }
		>
			{ band && (
				<rect
					className="newspack-nodes-sparkline__band"
					x={ 0 }
					y={ top }
					width={ width }
					height={ bottom - top }
				/>
			) }
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
