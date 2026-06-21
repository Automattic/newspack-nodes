/**
 * Roll the TopicProbe view's per-`reader` series up to per-`source` (the
 * partition a consumer tails) backlog + rate series for the Overview sparklines.
 *
 * Readers of one source all sweep on the same 15s tick (one shared `ts` per
 * sweep), so summing by `ts` aligns cleanly: backlog = total bytes behind that
 * source, rate = total msgs/sec across its readers. The series is then
 * downsampled to a fixed sparkline width.
 */

/**
 * Downsample to at most `width` points, taking the MAX per bucket so a backlog
 * (or throughput) spike survives the reduction rather than being averaged away.
 *
 * @param {number[]} values Oldest-first samples.
 * @param {number}   width  Target point count.
 * @return {number[]} At most `width` points.
 */
export function downsample( values, width ) {
	const n = values.length;
	if ( n <= width ) {
		return values;
	}
	const out = [];
	for ( let i = 0; i < width; i++ ) {
		const start = Math.floor( ( i * n ) / width );
		const end = Math.floor( ( ( i + 1 ) * n ) / width );
		let max = 0;
		for ( let j = start; j < end; j++ ) {
			if ( values[ j ] > max ) {
				max = values[ j ];
			}
		}
		out.push( max );
	}
	return out;
}

/**
 * @param {Object<string,{source:string,series:Array<{ts:number,rate:number,backlog:number}>}>} consumers
 *                                                                                                        The `topicprobe:view` consumers map.
 * @param {number}                                                                              [width]   Sparkline point count (default 48).
 * @return {Object<string,{backlog:number[],rate:number[],latestBacklog:number,latestRate:number}>}
 *   Per source: downsampled backlog + rate series and the latest values.
 */
export function topologySeries( consumers, width = 48 ) {
	const bySource = {};
	for ( const c of Object.values( consumers || {} ) ) {
		const source = c.source || '';
		if ( '' === source ) {
			continue;
		}
		( bySource[ source ] ||= [] ).push( c );
	}

	const out = {};
	for ( const [ source, list ] of Object.entries( bySource ) ) {
		const backlogByTs = new Map();
		const rateByTs = new Map();
		for ( const c of list ) {
			for ( const s of c.series || [] ) {
				backlogByTs.set(
					s.ts,
					( backlogByTs.get( s.ts ) || 0 ) + ( s.backlog || 0 )
				);
				rateByTs.set(
					s.ts,
					( rateByTs.get( s.ts ) || 0 ) + ( s.rate || 0 )
				);
			}
		}
		const tss = [ ...backlogByTs.keys() ].sort( ( a, b ) => a - b );
		const backlog = tss.map( ( ts ) => backlogByTs.get( ts ) );
		const rate = tss.map( ( ts ) => rateByTs.get( ts ) );
		out[ source ] = {
			backlog: downsample( backlog, width ),
			rate: downsample( rate, width ),
			latestBacklog: backlog.length ? backlog[ backlog.length - 1 ] : 0,
			latestRate: rate.length ? rate[ rate.length - 1 ] : 0,
		};
	}
	return out;
}
