/**
 * Helpers for the `set_skin` and `list_skins` REPL builtins: name-to-slug
 * resolution and list formatting against the shared THEMES registry, plus the
 * `shell.host` callback pair that the topology console and the debug overlay
 * each hand their Shell.
 *
 * The Shell acts on both verbs locally and mints no Message, so neither ever
 * reaches an interpreter verb table and `help`, which lists that table, never
 * names them. The same locality is why the host side is a pair of plain
 * callbacks rather than a node: the stylesheet and the `localStorage` key
 * behind it belong to the browser host, and the Shell forwards the raw name
 * the user typed and nothing else.
 */

/**
 * Resolve a user-typed skin name to a registered slug, case-insensitively.
 *
 * Four passes run in order: exact slug, exact label, label prefix, slug
 * prefix. The exact passes come first so `set_skin Newspack` lands on the
 * `newspack` slug rather than on the `newspack-brand` prefix match. The prefix
 * passes exist so the spaced label form the user reaches for ("CRT Phosphor")
 * resolves without spelling out "CRT Phosphor Terminal".
 *
 * @param {string}                            name  Raw name typed after `set_skin`.
 * @param {Array<{slug:string,label:string}>} skins The THEMES registry.
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
 * line per skin, the active slug marked with a leading `*` and every other
 * line indented by the same two columns, so the slugs stay aligned.
 *
 * @param {Array<{slug:string,label:string}>} skins       The THEMES registry.
 * @param {string}                            currentSkin The active skin slug.
 * @return {string[]} One transcript line per skin, in registry order.
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
 * Build the `shell.host` skin pair both REPLs hand their Shell. `setSkin`
 * applies the resolved slug and echoes that skin's label; an unmatched name is
 * refused and the live skin is left alone. `listSkins` prints one registry
 * line per skin.
 *
 * Resolution and the reply lines live here rather than in the Shell because
 * the host owns the stylesheet and its storage, and knows the registry the
 * name has to resolve against.
 *
 * @param {Object}                            args
 * @param {Array<{slug:string,label:string}>} args.skins       The THEMES registry.
 * @param {() => string}                      args.currentSkin Returns the active slug.
 * @param {(slug: string) => void}            args.applySkin   Applies a resolved slug.
 * @param {(text: string) => void}            args.print       Emits one line of REPL output.
 * @return {{setSkin: (name: string) => void, listSkins: () => void}} The host pair.
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
