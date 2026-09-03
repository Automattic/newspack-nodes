/**
 * The `topicprobe.p0` declaration the Overview and Jobs dashboards both mount:
 * which log to tail, which view model to fold it into, and the `topicprobe:`
 * names their readers address.
 *
 * Every worker whose topology includes `topologies/topic-probe.tsl` sweeps its
 * READY Consumers into `topicprobe.p0` on the cadence that file declares (15
 * seconds), one `Probe_Record` each, and the Partition there keeps a day of
 * them. The tail is the shared `useLogTailStream` backbone: `topicprobe:link`
 * opens the SSE, `topicprobe:stream` copies each frame to the view and to a
 * debug overlay's tap, and `topicprobe:view` folds the records into a rate and
 * backlog series per reader — the basename of the Consumer's offsetlog dir.
 * What this file adds is the two strings and the class that make that backbone
 * a probe stream.
 *
 * The view arrives as a CLASS from `register.js` rather than as the name
 * `TopicProbeView`: the hub mounts these tabs against whichever bundle's
 * interpreter it was handed, and that name table is a per-bundle static
 * (ADR-16).
 *
 * React reads the model with `useNodeState( 'topicprobe:view', 'view' )`.
 */

import { useLogTailStream } from './useLogTailStream';
import { views } from '../nodes/register';

/**
 * Mount the probe tail for the calling component's lifetime.
 *
 * @param {Object} [opts]      Stream options.
 * @param {string} [opts.mode] 'history' replays that retained day from the
 *                             start, so the charts draw real history rather
 *                             than the thin ring a live tail accumulates;
 *                             'follow' tails the live end. The mode picks the
 *                             seek at connect.
 * @throws {TypeError} On any other mode, from `useLogTailStream`.
 */
export function useTopicProbeStream( { mode = 'follow' } = {} ) {
	useLogTailStream( {
		name: 'topicprobe',
		// One partition, and no worker owns the name: it reads from logs/.
		subscribe: 'topicprobe.p0',
		viewClass: views.TopicProbeView,
		mode,
	} );
}
