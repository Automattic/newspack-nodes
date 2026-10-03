/**
 * useProbeStream — the one hook every probe log's dashboard mounts: which log
 * to tail, which view model folds it, and the `<name>:` node names its
 * readers address, all read from one declaration per probe.
 *
 * Each probe sweeps its nodes into a shared one-partition log a day long —
 * Topic_Probe into `topicprobe.p0`, Job_Probe into `jobstats.p0` and
 * Table_Probe into `tablestats.p0` — and the
 * shared `useLogTailStream` backbone tails it: `<name>:link` opens the SSE,
 * `<name>:stream` tees each frame to the view and to a debug overlay's tap, and
 * `<name>:view` folds the records.
 *
 * The view arrives as a CLASS rather than as its name: the station mounts
 * these tabs against whichever bundle's interpreter it was handed, and that
 * name table is a per-bundle static (ADR-16).
 *
 * React reads the model with `useNodeField( '<name>:view', 'view' )`.
 */

import { useLogTailStream } from './useLogTailStream';
import { views } from '../nodes/register';

/**
 * Every probe log a dashboard tails, by stream name. The subscription IS the
 * log's dir name; each log has one partition and no worker owns the name.
 *
 * @type {Object<string,{subscribe:string,viewClass:any}>}
 */
const PROBE_STREAMS = {
	topicprobe: { subscribe: 'topicprobe.p0', viewClass: views.TopicProbeView },
	jobstats: { subscribe: 'jobstats.p0', viewClass: views.JobstatsView },
	tablestats: { subscribe: 'tablestats.p0', viewClass: views.TablestatsView },
};

/**
 * Mount one declared probe tail for the calling component's lifetime.
 *
 * @param {string} name        A PROBE_STREAMS key.
 * @param {Object} [opts]      Stream options.
 * @param {string} [opts.mode] 'history' replays the retained day; 'follow'
 *                             tails the live end. Any other throws.
 * @throws {TypeError} On a name PROBE_STREAMS does not declare.
 */
export function useProbeStream( name, { mode = 'follow' } = {} ) {
	const declared = PROBE_STREAMS[ name ];
	if ( ! declared ) {
		throw new TypeError( `useProbeStream: no probe stream '${ name }'` );
	}
	useLogTailStream( { name, ...declared, mode } );
}
