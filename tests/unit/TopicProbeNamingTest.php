<?php
/**
 * The topic probe follows ADR-10 (`Word_Word` + `_Node`), like its sibling
 * `Job_Probe_Node`; nothing may still spell it `TopicProbe`.
 *
 * @package Newspack_Nodes\Tests\Unit
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\TestCase;

class TopicProbeNamingTest extends TestCase {

	/** Trees the rename must have reached; CHANGELOG history is checked separately. */
	private const SCANNED = [ 'includes', 'src', 'tests', 'docs', 'topologies', 'examples', 'scripts', '.claude' ];

	/** Docs whose job is to name retired surfaces so a consumer can rewrite them. */
	private const HISTORY = [ 'CHANGELOG.md', 'docs/upgrading.md' ];

	/**
	 * `TopicProbe` survives only in these continuations: `.pm` / `ToGraphite` name
	 * Tachikoma's Perl modules, `View` / `Stream` are JS identifiers (JS renders
	 * `Topic_Probe` as `TopicProbe`), `Test` is a PHPUnit class name.
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

	public function test_the_current_changelog_section_names_the_new_class(): void {
		$root    = \dirname( __DIR__, 2 );
		$log     = (string) \file_get_contents( $root . '/CHANGELOG.md' );
		$version = (string) \file_get_contents( $root . '/package.json' );
		$this->assertSame( 1, \preg_match( '/"version"\s*:\s*"([^"]+)"/', $version, $m ) );

		$start = \strpos( $log, "## [{$m[1]}]" );
		$this->assertIsInt( $start, "no CHANGELOG section for {$m[1]}" );
		$end     = \strpos( $log, "\n## [", $start + 1 );
		$section = \substr( $log, $start, false === $end ? null : $end - $start );

		$this->assertStringContainsString( 'Topic_Probe_Node', $section );
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
