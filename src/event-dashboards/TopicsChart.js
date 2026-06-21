/**
 * TopicsChart — one Tachikoma-style topics panel: a multi-series filled-area
 * time chart (one series per topic/source, overlaid, time on X) beside a ranked
 * legend (max + avg per series, sorted by max desc). Modeled on Grafana's Topics
 * Message Rate / Byte Rate / Backlog panels. Fed by `topicChartSeries`.
 *
 * Dependency-free SVG: the series are evenly-spaced 15s probe samples; X is the
 * shared time domain, Y is 0..global-max. Strokes are non-scaling so the
 * full-width stretch stays crisp.
 */

import { memo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

// Distinct, muted series colors (cycled by ranked order — busiest topic first).
const PALETTE = [
	'#e2a0a0',
	'#d8c489',
	'#8fb8d8',
	'#9bd3a4',
	'#c2a3da',
	'#dba97f',
	'#84d2c6',
	'#d98ba6',
	'#b6c98a',
	'#9aa0db',
];

const VIEW_W = 600;
const PAD = { l: 4, r: 4, t: 6, b: 16 };

function hhmm( ts ) {
	const d = new Date( ts * 1000 );
	const p = ( n ) => String( n ).padStart( 2, '0' );
	return `${ p( d.getHours() ) }:${ p( d.getMinutes() ) }`;
}

/**
 * @param {Object}   props
 * @param {string}   props.title       Panel title.
 * @param {Object}   props.series      `topicChartSeries` output: key → {points,max,avg}.
 * @param {Function} props.formatValue Value → display string (rate/bytes).
 * @param {number}   [props.height]    SVG viewBox height (default 200).
 * @return {import('react').ReactElement} The panel.
 */
export const TopicsChart = memo( function TopicsChart( {
	title,
	series,
	formatValue,
	height = 200,
} ) {
	const ranked = Object.keys( series || {} )
		.map( ( key ) => ( { key, ...series[ key ] } ) )
		.sort( ( a, b ) => b.max - a.max );

	let tMin = Infinity;
	let tMax = -Infinity;
	let vMax = 0;
	ranked.forEach( ( s ) =>
		s.points.forEach( ( p ) => {
			if ( p.ts < tMin ) {
				tMin = p.ts;
			}
			if ( p.ts > tMax ) {
				tMax = p.ts;
			}
			if ( p.value > vMax ) {
				vMax = p.value;
			}
		} )
	);
	const hasData = ranked.some( ( s ) => s.points.length > 0 ) && tMax >= tMin;

	const innerW = VIEW_W - PAD.l - PAD.r;
	const innerH = height - PAD.t - PAD.b;
	const tSpan = tMax - tMin || 1;
	const vSpan = vMax || 1;
	const xOf = ( ts ) => PAD.l + ( ( ts - tMin ) / tSpan ) * innerW;
	const yOf = ( v ) => PAD.t + innerH - ( v / vSpan ) * innerH;
	const baseY = yOf( 0 );

	return (
		<div className="nodes-topics">
			<div className="nodes-topics__title">{ title }</div>
			<div className="nodes-topics__body">
				<svg
					className="nodes-topics__chart"
					viewBox={ `0 0 ${ VIEW_W } ${ height }` }
					preserveAspectRatio="none"
					role="img"
					aria-label={ title }
				>
					{ hasData &&
						ranked.map( ( s, i ) => {
							if ( ! s.points.length ) {
								return null;
							}
							const color = PALETTE[ i % PALETTE.length ];
							const line = s.points
								.map(
									( p ) =>
										`${ xOf( p.ts ).toFixed( 1 ) },${ yOf(
											p.value
										).toFixed( 1 ) }`
								)
								.join( ' ' );
							const area = `${ xOf( s.points[ 0 ].ts ).toFixed(
								1
							) },${ baseY.toFixed( 1 ) } ${ line } ${ xOf(
								s.points[ s.points.length - 1 ].ts
							).toFixed( 1 ) },${ baseY.toFixed( 1 ) }`;
							return (
								<g key={ s.key }>
									<polygon
										className="nodes-topics__area"
										points={ area }
										fill={ color }
									/>
									<polyline
										className="nodes-topics__line"
										points={ line }
										fill="none"
										stroke={ color }
										vectorEffect="non-scaling-stroke"
									/>
								</g>
							);
						} ) }
				</svg>
				<table className="nodes-topics__legend">
					<thead>
						<tr>
							<th className="nodes-topics__series">
								{ __( 'topic', 'newspack-nodes' ) }
							</th>
							<th>{ __( 'max', 'newspack-nodes' ) }</th>
							<th>{ __( 'avg', 'newspack-nodes' ) }</th>
						</tr>
					</thead>
					<tbody>
						{ ranked.map( ( s, i ) => (
							<tr key={ s.key }>
								<td className="nodes-topics__series">
									<span
										className="nodes-topics__swatch"
										style={ {
											background:
												PALETTE[ i % PALETTE.length ],
										} }
									/>
									{ s.key }
								</td>
								<td>{ formatValue( s.max ) }</td>
								<td>{ formatValue( s.avg ) }</td>
							</tr>
						) ) }
					</tbody>
				</table>
			</div>
			{ hasData && (
				<div className="nodes-topics__xaxis">
					<span>{ hhmm( tMin ) }</span>
					<span>{ hhmm( tMax ) }</span>
				</div>
			) }
		</div>
	);
} );
