/**
 * scope — resolve a shell cwd to the scope the console displays and stores
 * under, so the canvas follows `cd`.
 *
 * The key is the bucket every per-scope surface persists under: the layout and
 * viewport in localStorage, the canvas reset key, the METADATA cache. Deriving
 * it from the cwd is what stops a layout saved at one worker from being read
 * back at the next — the topology and partition sitting in React state still
 * describe whichever worker was attached before the `cd`.
 */

import { parseWorkerId, workerId } from '@newspack-nodes/shared/utils/workerId';
import names from '../../runtime/reserved-node-names.json';

/** @typedef {import('@newspack-nodes/shared/utils/workerId').AttachedWorker} AttachedWorker */

/**
 * A cwd resolved to one console scope.
 *
 * @typedef {Object} ConsoleScope
 * @property {string}      key       Storage bucket: `local` for the browser graph, `<topology>.p<N>` for a worker, otherwise the cwd verbatim.
 * @property {string}      label     Title the canvas meta line shows, and at a worker scope the topology name the console matches its catalog entry and its server-saved layout against. A leading `_` is stripped.
 * @property {number|null} partition The worker's partition index; null off a worker.
 * @property {boolean}     isWorker  The cwd addresses a live worker, which is what admits the server-saved layout and the `topologies/<label>.tsl` line.
 */

/**
 * Resolves a shell cwd to its console scope.
 *
 * A cwd `workerOfPath()` mounts on a worker is that worker, so `cd`-ing into a
 * node keeps the layout the worker already has. The empty cwd is the
 * browser-local graph. Every other cwd is a scope of its own, keyed by the cwd
 * itself.
 *
 * @param {string} cwd Shell cwd — `''`, `'digest.p0'`, `'digest.p0/summarizer'`, or a node name such as `'_http'`.
 * @return {ConsoleScope} The scope the cwd names.
 */
export function scopeFromCwd( cwd ) {
	const worker = workerOfPath( cwd );
	if ( worker ) {
		return {
			key: workerId( worker.topology, worker.partition ),
			label: worker.topology,
			partition: worker.partition,
			isWorker: true,
		};
	}
	if ( '' === cwd ) {
		return {
			key: 'local',
			label: 'local',
			partition: null,
			isWorker: false,
		};
	}
	// Reserved names lead with `_`; the meta line reads better without it.
	const label = cwd.startsWith( '_' ) ? cwd.slice( 1 ) : cwd;
	return { key: cwd, label, partition: null, isWorker: false };
}

/**
 * The worker a TO path or shell cwd is mounted on, read off its first
 * segment. A worker id holds no `/`, so no later segment of a TO path names
 * one: `_http/foo.p3` is a node under a view boundary, never a worker. A FROM
 * trail carries its worker mid-path; `workerOfFrom()` reads that.
 *
 * @param {?string} path Node path or shell cwd.
 * @return {?AttachedWorker} The worker, or null when the path mounts none.
 */
export function workerOfPath( path ) {
	return parseWorkerId( String( path ?? '' ).split( '/' )[ 0 ] );
}

/**
 * Whether a TO path addresses the browser's own graph: it mounts no worker
 * and passes no `_http` boundary, which posts what it receives to the server.
 *
 * @param {?string} path Node path or shell cwd.
 * @return {boolean} True when the browser's own interpreter answers it.
 */
export function addressesBrowser( path ) {
	const segments = String( path ?? '' ).split( '/' );
	return null === workerOfPath( path ) && ! segments.includes( names.HTTP );
}
