/**
 * buildAlignedSeries — turn `topicChartSeries` output into the draw-ready model
 * for the d3 Topics charts: rank topics by peak, align them onto ONE shared,
 * sorted date axis (the union of every topic's sample instants; gaps → 0), and
 * DOWNSAMPLE that axis when it's denser than the chart can show.
 *
 * Why downsample: the probe retains ~24h of samples — tens of thousands of
 * points per topic. Aligned across ~13 topics that is hundreds of thousands of
 * vertices, and the d3 area paths (curveMonotoneX) then carry ~1MB of `d` data
 * EACH, ~100ms to redraw, three charts — the whole reason the Overview thrashed
 * at single-digit FPS. A chart is ~1800px wide, so anything past ~1k points is
 * sub-pixel anyway. We bucket the union by index into at most `maxPoints` slots
 * and take the MAX value per bucket per topic, so spikes survive the squeeze.
 *
 * @param {?Object} series    `{ [topic]: { points:[{ts,value}], max, avg } }` (ts in seconds).
 * @param {number}  maxPoints Hard cap on the rendered axis length.
 * @return {{ series: Array<{label:string, values:Array<{date:Date,value:number}>}>, dates: Date[] }}
 *   Ranked, axis-aligned (and capped) topics plus the shared date axis.
 */
export function buildAlignedSeries( series, maxPoints ) {
	const ranked = Object.keys( series || {} )
		.map( ( key ) => ( { key, ...series[ key ] } ) )
		.filter( ( s ) => ( s.points || [] ).length > 0 )
		.sort( ( a, b ) => b.max - a.max );

	if ( 0 === ranked.length ) {
		return { series: [], dates: [] };
	}

	const tsSet = new Set();
	ranked.forEach( ( s ) => s.points.forEach( ( p ) => tsSet.add( p.ts ) ) );
	const tsList = [ ...tsSet ].sort( ( a, b ) => a - b );
	const maps = ranked.map(
		( s ) => new Map( s.points.map( ( p ) => [ p.ts, p.value ] ) )
	);

	// Contiguous index buckets over the sorted union; 1 → no downsampling.
	const bucketSize =
		maxPoints > 0 ? Math.ceil( tsList.length / maxPoints ) : 1;

	if ( bucketSize <= 1 ) {
		const dates = tsList.map( ( ts ) => new Date( ts * 1000 ) );
		const aligned = ranked.map( ( s, si ) => ( {
			label: s.key,
			values: tsList.map( ( ts, i ) => ( {
				date: dates[ i ],
				value: maps[ si ].get( ts ) ?? 0,
			} ) ),
		} ) );
		return { series: aligned, dates };
	}

	// Each bucket keeps its latest instant as the x position; its y is the topic's
	// peak across the bucket (rates/backlog are non-negative, so 0 is the floor).
	const bounds = [];
	const dates = [];
	for ( let start = 0; start < tsList.length; start += bucketSize ) {
		const end = Math.min( start + bucketSize, tsList.length );
		bounds.push( [ start, end ] );
		dates.push( new Date( tsList[ end - 1 ] * 1000 ) );
	}
	const aligned = ranked.map( ( s, si ) => ( {
		label: s.key,
		values: bounds.map( ( [ start, end ], bi ) => {
			let peak = 0;
			for ( let i = start; i < end; i++ ) {
				const v = maps[ si ].get( tsList[ i ] ) ?? 0;
				if ( v > peak ) {
					peak = v;
				}
			}
			return { date: dates[ bi ], value: peak };
		} ),
	} ) );
	return { series: aligned, dates };
}
