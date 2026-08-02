/**
 * alias-map tests — the ONE resolver for the `@newspack-nodes/*` surface.
 *
 * The map used to exist three times: each consumer's `scripts/build.mjs` spelled
 * out absolute paths for esbuild, and `jest.cjs` built its own regex mappers. The
 * release pitfall that cost us two shipped-stale releases is a direct consequence
 * — a consumer's `release.yml` had to set FOUR independent `NEWSPACK_NODES_*` env
 * vars, and omitting one resolved to a nonexistent sibling path.
 *
 * One base in, both derivations out, so the two can no longer disagree.
 */

const path = require( 'node:path' );
const {
	esbuildAlias,
	jestModuleNameMapper,
	assertNoRetiredOverrides,
} = require( '../alias-map.cjs' );

// Distinct from BOTH real defaults — the substrate's own `src` and a consumer's
// `../newspack-nodes/src` — so a resolver that ignored its argument still fails.
const BASE = path.resolve( '/fake/substrate/src' );

describe( 'esbuildAlias', () => {
	it( 'derives every alias from the base it is given', () => {
		expect( esbuildAlias( BASE ) ).toEqual( {
			'@newspack-nodes/runtime': path.join( BASE, 'runtime/index.js' ),
			'@newspack-nodes/debug-overlay': path.join(
				BASE,
				'debug-overlay/DebugOverlay.js'
			),
			'@newspack-nodes/shared': path.join( BASE, 'shared' ),
		} );
	} );

	it( 'requires a base rather than falling back to a guess', () => {
		expect( () => esbuildAlias() ).toThrow( /base/i );
		expect( () => esbuildAlias( '' ) ).toThrow( /base/i );
	} );
} );

describe( 'jestModuleNameMapper', () => {
	it( 'derives every mapper from the base it is given', () => {
		expect( jestModuleNameMapper( BASE ) ).toEqual( {
			'^@newspack-nodes/runtime$': path.join( BASE, 'runtime/index.js' ),
			'^@newspack-nodes/debug-overlay$': path.join(
				BASE,
				'debug-overlay/DebugOverlay.js'
			),
			'^@newspack-nodes/shared/(.*)$': path.join( BASE, 'shared/$1' ),
			'^@newspack-nodes/shared$': path.join( BASE, 'shared' ),
		} );
	} );

	it( 'requires a base rather than falling back to a guess', () => {
		expect( () => jestModuleNameMapper() ).toThrow( /base/i );
	} );
} );

/**
 * The reason the resolver exists: esbuild and jest must agree on where a given
 * alias points. Before this they were independent literals, free to drift.
 */
describe( 'the two derivations agree', () => {
	it( 'resolves runtime and shared to the same targets', () => {
		const build = esbuildAlias( BASE );
		const jestMap = jestModuleNameMapper( BASE );
		expect( jestMap[ '^@newspack-nodes/runtime$' ] ).toBe(
			build[ '@newspack-nodes/runtime' ]
		);
		expect( jestMap[ '^@newspack-nodes/debug-overlay$' ] ).toBe(
			build[ '@newspack-nodes/debug-overlay' ]
		);
		expect( jestMap[ '^@newspack-nodes/shared$' ] ).toBe(
			build[ '@newspack-nodes/shared' ]
		);
	} );
} );

describe( 'assertBase', () => {
	it( 'rejects a RELATIVE base', () => {
		// path.join keeps it relative, so esbuild would resolve it against cwd
		// — right only when cwd happens to be the repo root.
		expect( () => esbuildAlias( '.newspack-nodes/src' ) ).toThrow(
			/absolute/i
		);
	} );

	it( 'names both knobs, so the message is actionable either way', () => {
		expect( () => esbuildAlias( '' ) ).toThrow( /NEWSPACK_NODES_SRC/ );
		expect( () => esbuildAlias( '' ) ).toThrow( /aliasBase/ );
	} );
} );

/**
 * The retired names must be REFUSED, not ignored. The first cut only threw when
 * NEWSPACK_NODES_SRC was absent — so a half-migrated workflow, or a leftover
 * shell export beside a correct SRC, sailed through silently. That is the exact
 * shape of the two releases that shipped green against the wrong substrate.
 */
describe( 'assertNoRetiredOverrides', () => {
	it( 'throws even when NEWSPACK_NODES_SRC is also set', () => {
		expect( () =>
			assertNoRetiredOverrides( {
				NEWSPACK_NODES_SRC: '/some/substrate/src',
				NEWSPACK_NODES_SHARED: '/stale/shared',
			} )
		).toThrow( /NEWSPACK_NODES_SHARED/ );
	} );

	it( 'names every retired variable that is set', () => {
		const run = () =>
			assertNoRetiredOverrides( {
				NEWSPACK_NODES_RUNTIME: '/a',
				NEWSPACK_NODES_BUILD_KIT: '/b',
			} );
		expect( run ).toThrow( /NEWSPACK_NODES_RUNTIME/ );
		expect( run ).toThrow( /NEWSPACK_NODES_BUILD_KIT/ );
		expect( run ).toThrow( /NEWSPACK_NODES_SRC/ );
	} );

	it( 'passes when only NEWSPACK_NODES_SRC is set', () => {
		expect( () =>
			assertNoRetiredOverrides( {
				NEWSPACK_NODES_SRC: '/some/substrate/src',
			} )
		).not.toThrow();
	} );
} );
