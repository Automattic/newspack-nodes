/**
 * workerId — the one JS writer and the one JS reader of a worker's id,
 * `{topology}.p{N}`, the twins of PHP `CLI::worker_id()` and
 * `CLI::parse_worker_id()` (ADR-22). The console's scopes and the event
 * dashboards' probe streams both read worker ids through here.
 */

import { splitStamp } from '../../runtime/log-stamp';

/**
 * A worker id split into its two halves.
 *
 * @typedef {{ topology: string, partition: number }} AttachedWorker
 */

/**
 * Spells a worker's id, `{topology}.p{N}`: the cwd that attaches to it, the
 * node its SSE reader is registered under, and the key its scope stores under.
 * `parseWorkerId()` is the inverse.
 *
 * @param {string} topology  Topology name, the worker type.
 * @param {number} partition Partition index.
 * @return {string} The worker id.
 */
export function workerId( topology, partition ) {
	return `${ topology }.p${ partition }`;
}

/**
 * Reads a worker id back into its topology and partition, the inverse of
 * `workerId()` and the twin of PHP `CLI::parse_worker_id()`.
 *
 * Only a spelling `workerId()` can write parses: the topology carries no `/`
 * or NUL, because the id is one segment of a node path, and the partition no
 * leading zero, because `x.p03` would stand for the worker `x.p3` while
 * naming a mount that does not exist. Only the FINAL `.p{N}` is the
 * partition, so a dotted topology keeps its dots.
 *
 * @param {?string} id Worker id, `{topology}.p{N}`.
 * @return {?AttachedWorker} The worker, or null for any other string.
 */
export function parseWorkerId( id ) {
	const m = String( id ?? '' ).match( /^([^/\0]+)\.p(0|[1-9]\d*)$/ );
	return m ? { topology: m[ 1 ], partition: Number( m[ 2 ] ) } : null;
}

/**
 * The worker a frame's FROM names, `''` when none. The reader's stamp comes
 * off first, through `splitStamp()`. What remains is `{worker-id}/{name}`, as
 * every probe stamps it (`Probe_Node::from()`, ADR-22); any other shape, a
 * malformed or foreign FROM, names no worker.
 *
 * @param {?string} from A frame's FROM, stamp included.
 * @return {string} The worker id, such as `job-worker.p2`.
 */
export function workerOfFrom( from ) {
	const { rest } = splitStamp( from );
	return 2 === rest.length && parseWorkerId( rest[ 0 ] ) ? rest[ 0 ] : '';
}
