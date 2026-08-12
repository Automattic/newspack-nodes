/**
 * useJobstatsStream — the shared `jobstats.p0` tail (per-identity rate series +
 * last-run detail) as one `useLogTailStream`: `jobstats:link` →
 * `jobstats:stream` → `jobstats:view` (JobstatsView).
 *
 * React reads the model via `useNodeState('jobstats:view','view')`.
 */

import { useLogTailStream } from './useLogTailStream';

/**
 * @param {Object} [opts]
 * @param {string} [opts.mode] 'history' (24h replay) or 'follow' (tail).
 */
export function useJobstatsStream( { mode = 'follow' } = {} ) {
	useLogTailStream( {
		name: 'jobstats',
		// Explicit .p0 hits the no-worker log-feed fallback (1-partition).
		subscribe: 'jobstats.p0',
		viewType: 'JobstatsView',
		mode,
	} );
}
