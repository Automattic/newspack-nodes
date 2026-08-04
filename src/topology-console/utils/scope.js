/**
 * Derives the console's display and storage scope from a shell cwd, so canvas
 * layouts persisted under one scope don't bleed into another.
 *
 * A cwd of `<worker>.p<N>` (optionally followed by a node path) is a worker
 * scope; the empty cwd is the browser-local graph; anything else is an
 * attached view named after the cwd itself.
 *
 * @param {string} cwd Shell cwd — `''`, `'digest.p0'`, `'digest.p0/summarizer'`, or a node name such as `'_http'`.
 * @return {{key: string, label: string, partition: number|null, isWorker: boolean}} `key` names the storage bucket, `label` is what the UI shows (leading `_` stripped), `partition` is the worker's partition index or null off-worker, and `isWorker` says whether the cwd addresses a live worker.
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
	// Strip leading underscore for display (CanvasFrame builds `${label}.tsl`).
	const label = cwd.startsWith( '_' ) ? cwd.slice( 1 ) : cwd;
	return { key: cwd, label, partition: null, isWorker: false };
}
