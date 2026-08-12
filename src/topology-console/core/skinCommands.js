/**
 * Helpers for the undocumented `set_skin` / `list_skins` REPL builtins — the
 * skin switch the Header picker used to own. Name→slug resolution and list
 * formatting against the THEMES registry, plus the `shell.host` pair both REPLs
 * hand the Shell. The builtins are absent from `help` by design: the Shell acts
 * on them locally and they never reach the interpreter verb table.
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
 * @testonly Exported for its own unit tests; makeSkinHost is the caller.
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
 * @testonly Exported for its own unit tests; makeSkinHost is the caller.
 */
export function formatSkinList( skins, currentSkin ) {
	return skins.map(
		( s ) =>
			`${ s.slug === currentSkin ? '* ' : '  ' }${ s.slug } — ${
				s.label
			}`
	);
}

/**
 * Build the `shell.host` skin pair both REPLs hand the Shell. The stylesheet
 * and its storage belong to the host, so name→slug resolution and the reply
 * line live here rather than in the Shell, which only forwards the raw name.
 *
 * @param {Object}   args
 * @param {Array}    args.skins       THEMES registry ({ slug, label }[]).
 * @param {Function} args.currentSkin Returns the active slug.
 * @param {Function} args.applySkin   Applies a resolved slug.
 * @param {Function} args.print       Emits one line of REPL output.
 * @return {{ setSkin: Function, listSkins: Function }} The host pair.
 */
export function makeSkinHost( { skins, currentSkin, applySkin, print } ) {
	return {
		setSkin: ( name ) => {
			const slug = resolveSkin( name, skins );
			if ( null === slug ) {
				print(
					`set_skin: unknown skin '${ name }' (try list_skins)\n`
				);
				return;
			}
			applySkin( slug );
			const label = skins.find( ( s ) => s.slug === slug )?.label ?? slug;
			print( `skin: ${ label }\n` );
		},
		listSkins: () =>
			formatSkinList( skins, currentSkin() ).forEach( ( line ) =>
				print( `${ line }\n` )
			),
	};
}
