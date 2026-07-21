<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The shared log-source registry `cmd_taillog` and `/log/stream` both consume.
 *
 * Locks the {name => {path, mode}} entry shape and the three-family merge:
 * built-ins (file mode) → config `log_sources` (file mode) → active-topology
 * Log nodes (segmented mode), first name wins, realpath-deduped. A caller
 * always addresses a source by registry NAME — never a path.
 */
#[CoversClass( Log_Sources::class )]
class LogSourcesTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'log-sources-' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		parent::tearDown();
	}

	/** Register $tsl under a stock dir and activate it via the config overlay. */
	private function activate_topology( string $name, string $tsl, array $extras = [] ): void {
		$dir = "{$this->tmp}/topologies";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$name}.tsl", $tsl );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, \array_merge( [ 'topologies' => [ $name ] ], $extras ) );
	}

	// ── built-ins ──────────────────────────────────────────────────────────

	public function test_builtin_seam_entries_are_file_mode(): void {
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => '/x/custom-error-9713.log' ];

		$registry = Log_Sources::registry();

		$this->assertSame(
			[
				'path' => '/x/custom-error-9713.log',
				'mode' => Tail_Node::MODE_FILE,
			],
			$registry['php']
		);
	}

	// ── config log_sources ─────────────────────────────────────────────────

	public function test_config_entries_parse_name_equals_path_as_file_mode(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->use_base_dir( $this->tmp, [ 'log_sources' => [ 'gyro=/var/log/gyro-8841.log' ] ] );

		$registry = Log_Sources::registry();

		$this->assertSame(
			[
				'path' => '/var/log/gyro-8841.log',
				'mode' => Tail_Node::MODE_FILE,
			],
			$registry['gyro']
		);
	}

	public function test_malformed_config_entries_are_skipped(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->use_base_dir( $this->tmp, [
			'log_sources' => [
				'noequals',
				'Bad Name=/var/log/x.log',
				'rel=not/absolute',
				'dots=/a/../b.log',
				'sources=/var/log/reserved.log',
				'keeper=/var/log/keeper-4471.log',
			],
		] );

		$registry = Log_Sources::registry();

		$this->assertSame( [ 'keeper' ], \array_keys( $registry ) );
	}

	public function test_builtin_name_wins_over_a_config_entry_with_the_same_name(): void {
		Log_Sources::$builtin_sources = static fn (): array => [ 'gate' => '/builtin/gate-first.log' ];
		$this->use_base_dir( $this->tmp, [ 'log_sources' => [ 'gate=/config/gate-second.log' ] ] );

		$this->assertSame( '/builtin/gate-first.log', Log_Sources::registry()['gate']['path'] );
	}

	public function test_realpath_dedupe_drops_a_config_alias_of_a_builtin_file(): void {
		$real = "{$this->tmp}/real-7e2.log";
		\file_put_contents( $real, "x\n" );
		$link = "{$this->tmp}/alias-7e2.log";
		\symlink( $real, $link );

		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $real ];
		$this->use_base_dir( $this->tmp, [ 'log_sources' => [ "phpalias={$link}" ] ] );

		$this->assertSame( [ 'php' ], \array_keys( Log_Sources::registry() ) );
	}

	// ── topology inference ─────────────────────────────────────────────────

	public function test_topology_log_without_partition_token_yields_one_segmented_source(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-single',
			"var num_partitions = 2\n"
			. "make_node Log gate:log <config:logs_dir>/Gate-Decisions.jsonl 1 2 7\n"
		);

		$registry = Log_Sources::registry();

		// Lowercased writes-basename; identical across partitions → ONE entry.
		$this->assertSame(
			[
				'path' => "{$this->tmp}/logs/Gate-Decisions.jsonl",
				'mode' => Tail_Node::MODE_SEGMENTED,
			],
			$registry['gate-decisions.jsonl']
		);
		$this->assertSame( [ 'gate-decisions.jsonl' ], \array_keys( $registry ) );
	}

	public function test_topology_log_with_partition_token_yields_one_source_per_partition(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-fleet',
			"var num_partitions = 2\n"
			. "make_node Log beacon:log <config:logs_dir>/beacon-7e.p<partition>/beacon-7e 1 2 7\n"
		);

		$registry = Log_Sources::registry();

		$this->assertSame( [ 'beacon-7e.p0', 'beacon-7e.p1' ], \array_keys( $registry ) );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p0/beacon-7e", $registry['beacon-7e.p0']['path'] );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p1/beacon-7e", $registry['beacon-7e.p1']['path'] );
		$this->assertSame( Tail_Node::MODE_SEGMENTED, $registry['beacon-7e.p1']['mode'] );
	}

	public function test_a_broken_topology_is_skipped_not_fatal(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'lsboom',
			static function ( string $key ): ?string {
				throw new \RuntimeException( 'resolver exploded' );
			}
		);
		Log_Sources::$builtin_sources = static fn (): array => [];
		$dir = "{$this->tmp}/topologies";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/lsbroken.tsl", "make_node Log b:log <lsboom:x>/boom.log 1 2 7\n" );
		\file_put_contents( "{$dir}/lsgood.tsl", "make_node Log g:log <config:logs_dir>/still-here.md 1 2 7\n" );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lsbroken', 'lsgood' ] ] );

		$registry = Log_Sources::registry();

		$this->assertSame( [ 'still-here.md' ], \array_keys( $registry ) );
	}

	public function test_an_unresolvable_config_token_skips_that_topology(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		// `<nope:x>` is unregistered: strict token validation throws, and the
		// catch degrades to skipping the topology (never a '/dangling.log' ghost).
		$this->activate_topology( 'lsrel', "make_node Log r:log <nope:x>/dangling.log 1 2 7\n" );

		$this->assertSame( [], Log_Sources::registry() );
	}

	// ── availability ───────────────────────────────────────────────────────

	public function test_is_available_checks_the_file_for_file_mode(): void {
		$path = "{$this->tmp}/live-31.log";
		\file_put_contents( $path, "x\n" );

		$this->assertTrue( Log_Sources::is_available( $path, Tail_Node::MODE_FILE ) );
		$this->assertFalse( Log_Sources::is_available( "{$this->tmp}/absent-31.log", Tail_Node::MODE_FILE ) );
	}

	public function test_is_available_checks_for_any_segment_in_segmented_mode(): void {
		// Segments are {file}.{seg}; retention may leave only a later segment.
		\file_put_contents( "{$this->tmp}/seg-base.7", "x\n" );

		$this->assertTrue( Log_Sources::is_available( "{$this->tmp}/seg-base", Tail_Node::MODE_SEGMENTED ) );
		$this->assertFalse( Log_Sources::is_available( "{$this->tmp}/no-segments", Tail_Node::MODE_SEGMENTED ) );
	}

	public function test_tail_path_resolves_the_newest_segment_for_segmented_mode(): void {
		// `taillog` tails a single FILE; for a segmented source that is the
		// NEWEST {file}.{seg} (numeric, not lexical: 10 > 9).
		\file_put_contents( "{$this->tmp}/seg-base.9", "old\n" );
		\file_put_contents( "{$this->tmp}/seg-base.10", "new\n" );

		$this->assertSame(
			"{$this->tmp}/seg-base.10",
			Log_Sources::tail_path( [ 'path' => "{$this->tmp}/seg-base", 'mode' => Tail_Node::MODE_SEGMENTED ] )
		);
	}

	public function test_tail_path_passes_a_file_mode_path_through_and_nulls_a_bare_segmented_base(): void {
		$this->assertSame(
			'/var/log/direct-6120.log',
			Log_Sources::tail_path( [ 'path' => '/var/log/direct-6120.log', 'mode' => Tail_Node::MODE_FILE ] )
		);
		$this->assertNull(
			Log_Sources::tail_path( [ 'path' => "{$this->tmp}/no-segments", 'mode' => Tail_Node::MODE_SEGMENTED ] ),
			'a segmented source with no segments on disk has nothing to tail'
		);
	}
}
