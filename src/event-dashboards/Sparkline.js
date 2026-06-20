/**
 * Sparkline — a tiny inline SVG trend line for a recent sample window (e.g. a
 * topology's consumer lag over the last ~2 min of polls). Deliberately
 * dependency-free: the hub has no time-series store, so this draws only what the
 * dashboard accumulates live. <2 points draws a flat baseline (nothing to trend
 * yet).
 */

/**
 * Append `value` to `arr`, keeping at most `cap` most-recent entries.
 *
 * @param {number[]} arr   Prior samples (oldest first).
 * @param {number}   value New sample.
 * @param {number}   cap   Max retained samples.
 * @return {number[]} A new array, oldest-trimmed to `cap`.
 */
export function appendCapped( arr, value, cap ) {
	const next = [ ...( arr || [] ), value ];
	return next.length > cap ? next.slice( next.length - cap ) : next;
}

/**
 * @param {Object}   props
 * @param {number[]} props.values      Samples, oldest first.
 * @param {number}   [props.width]     SVG width px (default 88).
 * @param {number}   [props.height]    SVG height px (default 22).
 * @param {string}   [props.className] Extra class on the <svg>.
 * @return {import('react').ReactElement} The sparkline SVG.
 */
export function Sparkline( {
	values = [],
	width = 88,
	height = 22,
	className = '',
} ) {
	const pts = ( values || [] ).filter( ( v ) => Number.isFinite( v ) );
	const cls = `nodes-spark${ className ? ` ${ className }` : '' }`;
	// Nothing to trend yet — a flat mid-baseline keeps the row height stable.
	if ( pts.length < 2 ) {
		const mid = height / 2;
		return (
			<svg
				className={ cls }
				width={ width }
				height={ height }
				viewBox={ `0 0 ${ width } ${ height }` }
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<line
					className="nodes-spark__baseline"
					x1="0"
					y1={ mid }
					x2={ width }
					y2={ mid }
				/>
			</svg>
		);
	}
	const max = Math.max( ...pts );
	const min = Math.min( ...pts );
	const span = max - min || 1;
	const stepX = width / ( pts.length - 1 );
	const pad = 1; // keep the stroke off the top/bottom edge
	const points = pts
		.map( ( v, i ) => {
			const x = i * stepX;
			const y =
				height - pad - ( ( v - min ) / span ) * ( height - 2 * pad );
			return `${ x.toFixed( 1 ) },${ y.toFixed( 1 ) }`;
		} )
		.join( ' ' );
	// Rising (latest ≥ first) reads as "growing backlog" — color it as such.
	const rising = pts[ pts.length - 1 ] > pts[ 0 ];
	return (
		<svg
			className={ `${ cls } nodes-spark--${
				rising ? 'rising' : 'falling'
			}` }
			width={ width }
			height={ height }
			viewBox={ `0 0 ${ width } ${ height }` }
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<polyline
				className="nodes-spark__line"
				fill="none"
				points={ points }
			/>
		</svg>
	);
}
