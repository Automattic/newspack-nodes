/**
 * The one directory walk the lint gates share.
 *
 * `lint-contract`, `lint-comments` and `lint-styles` each read a different set
 * of files but prune the same trees: `node_modules` holds tens of thousands of
 * files against a checkout's few hundred sources, and the rest are generated
 * or vendored, so a hit there would name an artefact instead of its source;
 * `.superpowers` is the git-ignored agent workspace.
 * A caller passes only what differs, the extensions it reads and the paths it
 * exempts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directories no gate descends into. */
const SKIP_DIRS = new Set( [
	'node_modules',
	'vendor',
	'.git',
	'.superpowers',
	'build',
	'release',
] );

/**
 * Every file under a directory that matches and is not exempt, depth-first.
 * A directory that does not exist yields nothing.
 *
 * @param {string}                   dir              Directory to walk.
 * @param {Object}                   options          What this gate reads.
 * @param {RegExp}                   options.match    Pattern a file path must satisfy.
 * @param {function(string):boolean} [options.exempt] True for a path to skip.
 * @return {IterableIterator<string>} Paths of the files found.
 */
export function* walkFiles( dir, { match, exempt = () => false } ) {
	if ( ! existsSync( dir ) ) {
		return;
	}
	for ( const entry of readdirSync( dir, { withFileTypes: true } ) ) {
		const full = join( dir, entry.name );
		if ( entry.isDirectory() ) {
			if ( ! SKIP_DIRS.has( entry.name ) ) {
				yield* walkFiles( full, { match, exempt } );
			}
		} else if ( entry.isFile() && match.test( full ) && ! exempt( full ) ) {
			yield full;
		}
	}
}
