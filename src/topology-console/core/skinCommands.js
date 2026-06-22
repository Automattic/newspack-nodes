/**
 * Helpers for the undocumented `set_skin` / `list_skins` REPL builtins — the
 * skin switch the Header picker used to own. Pure name→slug resolution + list
 * formatting against the THEMES registry, kept out of dispatchLocalCommand so
 * both stay unit-testable without a transcript. The builtins are absent from
 * `help` by design: they parse to `{ kind: 'local' }` signals and never reach
 * the interpreter verb table.
 */

/**
 * Resolve a user-typed skin name to a registered slug, case-insensitively.
 * Tries, in order: exact slug, exact label, label-prefix, slug-prefix — so the
 * spaced forms the user types ("CRT Phosphor", "Newspack") land on the right
 * label, while "Newspack" still prefers the exact `newspack` slug over the
 * `newspack-brand` prefix match.
 *
 * @param {string} name  Raw name typed after `set_skin`.
 * @param {Array}  skins THEMES registry ({ slug, label }[]).
 * @return {?string} The matched slug, or null when nothing matches.
 */
export function resolveSkin( name, skins ) {
	const q = String( name || '' )
		.trim()
		.toLowerCase();
	if ( '' === q ) {
		return null;
	}
	const match =
		skins.find( ( s ) => s.slug.toLowerCase() === q ) ||
		skins.find( ( s ) => s.label.toLowerCase() === q ) ||
		skins.find( ( s ) => s.label.toLowerCase().startsWith( q ) ) ||
		skins.find( ( s ) => s.slug.toLowerCase().startsWith( q ) );
	return match ? match.slug : null;
}

/**
 * Format the skin registry for the `list_skins` transcript: one `slug — Label`
 * line per skin, the active slug marked with a leading `*`.
 *
 * @param {Array}  skins       THEMES registry ({ slug, label }[]).
 * @param {string} currentSkin The active skin slug.
 * @return {string[]} One transcript line per skin.
 */
export function formatSkinList( skins, currentSkin ) {
	return skins.map(
		( s ) =>
			`${ s.slug === currentSkin ? '* ' : '  ' }${ s.slug } — ${
				s.label
			}`
	);
}
