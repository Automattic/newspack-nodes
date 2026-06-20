// The display/storage scope for a cwd: a worker (its topology+partition), the
// request scope (`_sse`), or any other top-level cwd. Worker sub-nodes resolve
// to their worker. Each unique cwd gets its own storage key so canvas layouts
// don't bleed across scopes (`/`, `/_http`, `/_sse`, workers all distinct).
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
	// Any other top-level cwd (`_http`, `_completion`, etc.) gets its own
	// storage key so its canvas layout doesn't fight with `/`. Strip the
	// leading underscore for display since CanvasFrame interpolates label
	// as `topologies/${label}.tsl` and `_http.tsl` is a misleading non-file.
	const label = cwd.startsWith( '_' ) ? cwd.slice( 1 ) : cwd;
	return { key: cwd, label, partition: null, isWorker: false };
}
