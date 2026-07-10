// Per-cwd storage scope so canvas layouts don't bleed across scopes.
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
