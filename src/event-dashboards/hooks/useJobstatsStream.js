/**
 * The Jobs dashboard's `jobstats.p0` declaration: which log to tail, which view
 * model to fold it into, and the `jobstats:` names its readers address.
 *
 * `Job_Probe_Node` sweeps one record per job identity into `jobstats.p0` every
 * 15 seconds (`topologies/job-worker.tsl`). The tail is the shared
 * `useLogTailStream` backbone: `jobstats:link` opens the SSE, `jobstats:stream`
 * copies each frame to the view and to a debug overlay's tap, and
 * `jobstats:view` accumulates the per-identity rate series and the last-run
 * detail. What this file adds is the two strings and the class that make that
 * backbone a jobstats stream.
 *
 * React reads the model with `useNodeState( 'jobstats:view', 'view' )`.
 */

import { useLogTailStream } from './useLogTailStream';
import { views } from '../nodes/register';

/**
 * Mount the jobstats stream graph for the calling component's lifetime. The SSE
 * connection itself opens only while the tab is visible.
 *
 * The view arrives as a CLASS from `register.js` rather than as the name
 * `JobstatsView`: the hub mounts this tab against whichever bundle's
 * interpreter it was handed, and that name table is a per-bundle static
 * (ADR-16).
 *
 * @param {Object} [opts]      Stream options.
 * @param {string} [opts.mode] 'history' replays the retained log (a day, as
 *                             `job-worker.tsl` sizes it); 'follow' tails the
 *                             live end. The mode picks the seek at connect.
 */
export function useJobstatsStream( { mode = 'follow' } = {} ) {
	useLogTailStream( {
		name: 'jobstats',
		// The subscription IS the log's dir name; this log has one partition.
		subscribe: 'jobstats.p0',
		viewClass: views.JobstatsView,
		mode,
	} );
}
