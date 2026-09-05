/**
 * alias-map — the ONE resolver for the `@newspack-nodes/*` consumption surface.
 *
 * Every consumer of the substrate's shared code resolves the same three import
 * specifiers, and each toolchain wants them in a different shape: esbuild takes
 * plain prefix keys, jest takes anchored regexes with a `$1` subpath capture.
 * Both are DERIVED here from a single base directory — the substrate's `src`.
 * The build kit itself carries no alias: a consumer reaches it by joining
 * `build-kit/index.mjs` onto that same base.
 *
 * Four `NEWSPACK_NODES_*` env vars once configured those paths independently,
 * one per alias plus one for the kit, while `jest.cjs` built its regex map from
 * literals of its own. Omitting any one of the four fell back to a nonexistent
 * sibling path and died deep inside esbuild, naming nothing. One base means one
 * override.
 *
 * The `.cjs` extension is load-bearing, not stylistic: `jest.cjs` must
 * `require()` it synchronously while `build.mjs` imports it as an ES module. A
 * bare `.js` is CommonJS only while this package.json has no `"type"` field —
 * adding one would break the require, the `require( 'node:path' )` inside, and
 * `module.exports`, all at once, from an edit that never touches this file.
 */

const path = require( 'node:path' );

/**
 * Where each alias points, relative to the substrate `src` directory. The single
 * place a path is written down; both shapes below are projections of this.
 */
const TARGETS = {
	runtime: 'runtime/index.js',
	'debug-overlay': 'debug-overlay/DebugOverlay.js',
	shared: 'shared',
};

/**
 * Fail loud rather than guessing a base. A wrong-but-plausible default is how a
 * build silently resolves the substrate to the wrong checkout.
 *
 * @param {string} base Absolute path to the substrate `src` directory.
 */
function assertBase( base ) {
	if ( ! base || 'string' !== typeof base || ! path.isAbsolute( base ) ) {
		throw new Error(
			'alias-map: an absolute base path to the substrate `src` directory ' +
				'is required (jest: pass aliasBase; build: set ' +
				`NEWSPACK_NODES_SRC); got: ${ JSON.stringify( base ) }`
		);
	}
}

/**
 * esbuild `alias` map — plain prefix keys.
 *
 * @param {string} base Absolute path to the substrate `src` directory.
 * @return {Object<string,string>} Alias specifier → absolute path.
 */
function esbuildAlias( base ) {
	assertBase( base );
	const alias = {};
	for ( const [ name, target ] of Object.entries( TARGETS ) ) {
		alias[ `@newspack-nodes/${ name }` ] = path.join( base, target );
	}
	return alias;
}

/**
 * jest `moduleNameMapper` entries — anchored regexes.
 *
 * The shared SUBPATH mapper is emitted before the bare `shared` one, and both
 * before jest.cjs appends the css/scss style mock: jest takes the first match,
 * so a `@newspack-nodes/shared/styles/x.scss` import would otherwise resolve
 * past the mock and hand SCSS to babel.
 *
 * @param {string} base Absolute path to the substrate `src` directory.
 * @return {Object<string,string>} Regex → absolute path (insertion-ordered).
 */
function jestModuleNameMapper( base ) {
	assertBase( base );
	return {
		'^@newspack-nodes/runtime$': path.join( base, TARGETS.runtime ),
		'^@newspack-nodes/debug-overlay$': path.join(
			base,
			TARGETS[ 'debug-overlay' ]
		),
		'^@newspack-nodes/shared/(.*)$': path.join(
			base,
			`${ TARGETS.shared }/$1`
		),
		'^@newspack-nodes/shared$': path.join( base, TARGETS.shared ),
	};
}

/**
 * The four overrides `NEWSPACK_NODES_SRC` replaced: one per alias, plus one for
 * the build kit, which has no alias. Refused, never ignored — a stale export
 * left beside a correct SRC does nothing, and the build still goes green.
 */
const RETIRED = [
	'NEWSPACK_NODES_RUNTIME',
	'NEWSPACK_NODES_DEBUG_OVERLAY',
	'NEWSPACK_NODES_SHARED',
	'NEWSPACK_NODES_BUILD_KIT',
];

/**
 * @param {Object<string,string>} env Environment to check, normally process.env.
 */
function assertNoRetiredOverrides( env ) {
	const set = RETIRED.filter( ( name ) => env[ name ] );
	if ( set.length ) {
		throw new Error(
			`${ set.join(
				', '
			) } retired; set NEWSPACK_NODES_SRC to the substrate src dir`
		);
	}
}

module.exports = {
	esbuildAlias,
	jestModuleNameMapper,
	assertNoRetiredOverrides,
};
