/**
 * useTopicProbeStream — the shared `topicprobe.p0` tail (per-offsetlog_dir rate
 * and backlog series) as one `useLogTailStream`: `topicprobe:link` →
 * `topicprobe:stream` → `topicprobe:view` (TopicProbeView).
 *
 * React reads the model via `useNodeState('topicprobe:view','view')`.
 */

import { useLogTailStream } from './useLogTailStream';
import { views } from '../nodes/register';

/**
 * @param {Object} [opts]
 * @param {string} [opts.mode] 'history' (24h replay) or 'follow' (tail).
 */
export function useTopicProbeStream( { mode = 'follow' } = {} ) {
	useLogTailStream( {
		name: 'topicprobe',
		// Explicit .p0 hits the no-worker log-feed fallback (probe is 1-part).
		subscribe: 'topicprobe.p0',
		viewClass: views.TopicProbeView,
		mode,
	} );
}
