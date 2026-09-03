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
 * A first segment of `<topology>.p<N>` is a worker, and a node path beneath it
 * collapses onto that same worker, so `cd`-ing into a node keeps the layout the
 * worker already has. The empty cwd is the browser-local graph. Every other cwd
 * is a scope of its own, keyed by the cwd itself.
 *
 * The worker pattern is anchored, so only the FIRST segment can name a worker.
 * `_http/foo.p3` is a view boundary with a worker-shaped node under it; reading
 * it as a worker would key the layout and the topology lookup on a worker the
 * cwd does not name.
 *
 * @param {string} cwd Shell cwd — `''`, `'digest.p0'`, `'digest.p0/summarizer'`, or a node name such as `'_http'`.
 * @return {ConsoleScope} The scope the cwd names.
 */
export function scopeFromCwd( cwd ) {
	const m = String( cwd ).match( /^([^/]+)\.p(\d+)(?:\/|$)/ );
	if ( m ) {
		return {
			key: `${ m[ 1 ] }.p${ m[ 2 ] }`,
			label: m[ 1 ],
			partition: Number( m[ 2 ] ),
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
