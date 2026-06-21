/**
 * Sum the worker model's per-reader read-rate map and per-log write-rate map into
 * the fleet-global R / W byte rates the SummaryCards show. Both maps are
 * `{ rateKey: bytesPerSec }`; read rates sum across all readers (concurrent
 * consumers each draw the full stream), write rates across all logs.
 *
 * @param {Object<string,number>} byteRates  Per-reader read rates (model.byteRates).
 * @param {Object<string,number>} writeRates Per-log write rates (model.writeRates).
 * @return {{ readRate: number, writeRate: number }} Summed bytes/sec.
 */
export function globalRates( byteRates, writeRates ) {
	const sum = ( map ) =>
		Object.values( map || {} ).reduce(
			( acc, v ) => acc + ( Number.isFinite( v ) ? v : 0 ),
			0
		);
	return { readRate: sum( byteRates ), writeRate: sum( writeRates ) };
}
