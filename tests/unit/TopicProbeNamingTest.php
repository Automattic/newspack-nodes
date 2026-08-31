<?php
/**
 * The topic probe follows ADR-10 (`Word_Word` + `_Node`), like its sibling
 * `Job_Probe_Node`; nothing may still spell it `TopicProbe`.
 *
 * @package Newspack_Nodes\Tests\Unit
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/**
 * Medium: this reads every file in eight trees, so its cost is the repo's size and not any
 * unit's. It sat just under the 1s default and aborted mid-suite on a loaded machine, which
 * reports as a risky test that asserted nothing — a repo-wide guard that silently stops
 * guarding. Its sibling `SpawnCoordinatorNamingTest` carries the same mark for the same
 * reason.
 */
#[Medium]
class TopicProbeNamingTest extends TestCase {

	/** Trees the rename must have reached; CHANGELOG history is checked separately. */
	private const SCANNED = [ 'includes', 'src', 'tests', 'docs', 'topologies', 'examples', 'scripts', '.claude' ];

	/** Docs whose job is to name retired surfaces so a consumer can rewrite them. */
	private const HISTORY = [ 'CHANGELOG.md', 'docs/upgrading.md' ];

	/**
	 * `TopicProbe` survives only in these continuations: `.pm` / `ToGraphite` name
	 * Tachikoma's Perl modules, `View` / `Stream` are JS identifiers (JS renders
	 * `Topic_Probe` as `TopicProbe`), and `Test` is the class name in
	 * `tests/unit/TopicProbeTest.php` — a DIFFERENT file, so the `__FILE__`
	 * guard in `scan()` does not cover it. Drop `Test` and that file trips this.
	 */
	private const RETIRED = '/TopicProbe(?!ToGraphite|\.pm|View|Stream|Test)/';

	public function test_no_source_file_still_names_the_retired_class(): void {
		$root  = \dirname( __DIR__, 2 );
		$found = [];
		foreach ( self::SCANNED as $dir ) {
			foreach ( $this->scan( "{$root}/{$dir}" ) as $file ) {
				$relative = \substr( $file, \strlen( $root ) + 1 );
				if ( ! \in_array( $relative, self::HISTORY, true )
					&& $this->names_the_retired_class( (string) \file_get_contents( $file ) ) ) {
					$found[] = $relative;
				}
			}
		}
		foreach ( \glob( "{$root}/*.{php,md,json,tsl}", \GLOB_BRACE ) ?: [] as $file ) {
			if ( \in_array( \basename( $file ), self::HISTORY, true ) ) {
				continue;
			}
			if ( $this->names_the_retired_class( (string) \file_get_contents( $file ) ) ) {
				$found[] = \basename( $file );
			}
		}
		$this->assertSame( [], $found, "the retired TopicProbe name survives:\n" . \implode( "\n", $found ) );
	}

	public function test_the_changelog_documents_the_rename(): void {
		$root = \dirname( __DIR__, 2 );
		$log  = (string) \file_get_contents( $root . '/CHANGELOG.md' );

		// @longform Anchored to the RELEASED changelog, not to whatever version
		// is current: pinning it to the current section made every later patch
		// fail for not re-announcing a rename it did not make.
		$released = \strpos( $log, "\n## [" );
		$this->assertIsInt( $released, 'no released CHANGELOG section' );
		$log = \substr( $log, $released );

		$this->assertStringContainsString( 'Topic_Probe_Node', $log );
	}

	private function names_the_retired_class( string $haystack ): bool {
		return 1 === \preg_match( self::RETIRED, $haystack );
	}

	/** @return list<string> Readable files under $dir, minus build artifacts. */
	private function scan( string $dir ): array {
		if ( ! \is_dir( $dir ) ) {
			return [];
		}
		$skip     = [ 'node_modules', 'vendor', 'build', 'release', '.phpstan', '.git' ];
		$filtered = new \RecursiveCallbackFilterIterator(
			new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ),
			static fn ( \SplFileInfo $f ) => ! \in_array( $f->getFilename(), $skip, true )
		);
		$files = [];
		foreach ( new \RecursiveIteratorIterator( $filtered ) as $file ) {
			// This file spells the retired name on purpose.
			if ( $file->isFile() && __FILE__ !== $file->getPathname() ) {
				$files[] = $file->getPathname();
			}
		}
		return $files;
	}
}
