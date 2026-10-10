/**
 * Test utility: fold plain samples into the buckets a probe view publishes,
 * so a dashboard test can state its model as samples.
 */

import { foldInto } from '../nodes/probe-stream-view-node';

/**
 * Fold samples into per-worker buckets as the view does, each worker's in
 * turn.
 *
 * @param {Array<Object>} samples `{ ts, worker?, …numeric fields }`.
 * @return {Array<import('../nodes/probe-stream-view-node').Bucket>} The buckets.
 */
export function bucketsFrom( samples ) {
	const rows = new Map();
	for ( const s of samples ) {
		foldInto( rows, s.worker ?? '', s );
	}
	return [ ...rows.values() ].flatMap( ( row ) => [ ...row.values() ] );
}
