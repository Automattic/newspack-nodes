<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Tests\TestCase;

/**
 * A stamp has one reader, `split()`, and a dir stamp one resolver, `dir_of()`:
 * the stream's guard, then a direct path. Nothing scans a catalog to invert a
 * stamp, so a dir the stamp writer refuses cannot break a lookup of another.
 */
#[CoversClass( Log_Discovery::class )]
final class LogDiscoveryResolveTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'log-discovery-resolve-' );
		Log_Discovery::reset();
	}

	protected function tearDown(): void {
		Log_Discovery::$glob = null;
		Log_Discovery::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** @return array<string,array{string,array{string,string}}> Label => stamp, then its group and name. */
	public static function stamps(): array {
		return [
			'bare'       => [ 'kea-7713.p3', [ 'logs', 'kea-7713.p3' ] ],
			'offsets'    => [ 'offsets/hub.kea-7713.p3', [ 'offsets', 'hub.kea-7713.p3' ] ],
			'deadletter' => [ 'deadletter/jobs.p5', [ 'deadletter', 'jobs.p5' ] ],
			'sources'    => [ 'sources/gate-4194.jsonl', [ 'sources', 'gate-4194.jsonl' ] ],
			'glob'       => [ 'offsets/kea.*', [ 'offsets', 'kea.*' ] ],
			'deep'       => [ 'sources/a/../b', [ 'sources', 'a/../b' ] ],
			'reader'     => [ 'offsets:hub.tucson-41:sources:php', [ 'offsets', 'hub.tucson-41/sources:php' ] ],
		];
	}

	/**
	 * @param string               $stamp    A stamp or subscription.
	 * @param array{string,string} $expected Its group, then the rest.
	 */
	#[DataProvider( 'stamps' )]
	public function test_split_reads_the_group_and_the_rest( string $stamp, array $expected ): void {
		$this->assertSame( $expected, Log_Discovery::split( $stamp ) );
	}

	/** @return array<string,array{string}> Label => a prefix the grammar refuses. */
	public static function refused_prefixes(): array {
		return [
			'explicit logs' => [ 'logs/kea-7713.p3' ],
			'unknown'       => [ 'secrets/kea-7713.p3' ],
			'traversal'     => [ '../etc/passwd' ],
		];
	}

	#[DataProvider( 'refused_prefixes' )]
	public function test_split_refuses_an_explicit_logs_or_unknown_prefix( string $stamp ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "invalid subscription: {$stamp}" );
		Log_Discovery::split( $stamp );
	}

	public function test_stamp_for_writes_a_registry_stamp(): void {
		$this->assertSame( 'sources/gate-4194.jsonl', Log_Discovery::stamp_for( 'sources', 'gate-4194.jsonl' ) );
	}

	public function test_dir_of_resolves_a_bare_and_a_grouped_stamp_by_direct_path(): void {
		\mkdir( "{$this->tmp}/logs/kea-7713.p3", 0755, true );
		\mkdir( "{$this->tmp}/offsets/hub.kea-7713.p3", 0755, true );

		$this->assertSame( "{$this->tmp}/logs/kea-7713.p3", Log_Discovery::dir_of( 'kea-7713.p3', $this->tmp ) );
		$this->assertSame(
			"{$this->tmp}/offsets/hub.kea-7713.p3",
			Log_Discovery::dir_of( 'offsets/hub.kea-7713.p3', $this->tmp )
		);
	}

	/** A broker's root holds no segments, so a kind it lacks opens nothing. */
	public function test_dir_of_answers_null_for_a_reader_no_dir_carries(): void {
		\mkdir( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3", 0755, true );

		$this->assertNull( Log_Discovery::dir_of( 'offsets:hub.tucson-41:firehose.p9', $this->tmp ) );
	}

	public function test_dir_of_answers_null_for_a_stamp_no_dir_carries(): void {
		\mkdir( "{$this->tmp}/logs/kea-7713.p3", 0755, true );

		$this->assertNull( Log_Discovery::dir_of( 'kea-7713.p9', $this->tmp ) );
	}

	public function test_a_logs_dir_named_like_a_group_does_not_break_another_lookup(): void {
		\mkdir( "{$this->tmp}/logs/sources", 0755, true );
		\mkdir( "{$this->tmp}/logs/kea-7713.p3", 0755, true );

		$this->assertSame( "{$this->tmp}/logs/kea-7713.p3", Log_Discovery::dir_of( 'kea-7713.p3', $this->tmp ) );
	}

	public function test_dir_of_refuses_the_dir_named_like_a_group_by_name(): void {
		\mkdir( "{$this->tmp}/logs/sources", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir sources is named like a group; rename it' );
		Log_Discovery::dir_of( 'sources', $this->tmp );
	}

	/** @return array<string,array{string}> Label => a stamp the stream's guard refuses. */
	public static function guarded(): array {
		return [
			'uppercase'   => [ 'Kea-7713.p3' ],
			'glob'        => [ 'kea-7713.*' ],
			'empty'       => [ '' ],
			'empty group' => [ 'offsets/' ],
			'deep'        => [ 'offsets/a/b' ],
			'registry'    => [ 'sources/gate-4194.jsonl' ],
			'reader root climbs'   => [ 'offsets:..:kea-7713.p3' ],
			'reader kind climbs'   => [ 'offsets:hub.tucson-41:..' ],
			'reader under logs'    => [ 'logs:kea-7713.p3:x' ],
			'reader under sources' => [ 'sources:gate-4194.jsonl:x' ],
			'reader with no kind'  => [ 'offsets:hub.tucson-41' ],
			'a reader dir by path' => [ 'offsets/hub.tucson-41/firehose.p3' ],
			'a kind with a slash'  => [ 'offsets:hub.tucson-41:sources/php' ],
		];
	}

	#[DataProvider( 'guarded' )]
	public function test_dir_of_refuses_what_the_streams_guard_refuses( string $stamp ): void {
		\mkdir( "{$this->tmp}/logs/Kea-7713.p3", 0755, true );
		\mkdir( "{$this->tmp}/offsets/a/b", 0755, true );
		\mkdir( "{$this->tmp}/sources/gate-4194.jsonl", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "invalid subscription: {$stamp}" );
		Log_Discovery::dir_of( $stamp, $this->tmp );
	}

	public function test_dirs_matching_refuses_a_glob_over_a_brokers_readers(): void {
		Log_Discovery::$glob = fn (): array|false => $this->fail( 'a refused glob reads no dir' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'invalid subscription: offsets:hub.tucson-41:fire*' );
		Log_Discovery::dirs_matching( 'offsets:hub.tucson-41:fire*', $this->tmp );
	}

	/** A glob skips a broker's root, as the catalog does, and reaches none of its readers. */
	public function test_dirs_matching_skips_a_brokers_root(): void {
		\mkdir( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3", 0755, true );
		\file_put_contents( "{$this->tmp}/offsets/hub.tucson-41/firehose.p3/4.log", '' );
		\mkdir( "{$this->tmp}/offsets/hub.plain.p0", 0755, true );
		\file_put_contents( "{$this->tmp}/offsets/hub.plain.p0/3.log", '' );
		\mkdir( "{$this->tmp}/offsets/hub.fresh.p0", 0755, true );

		$this->assertSame(
			[
				'offsets/hub.fresh.p0' => "{$this->tmp}/offsets/hub.fresh.p0",
				'offsets/hub.plain.p0' => "{$this->tmp}/offsets/hub.plain.p0",
			],
			Log_Discovery::dirs_matching( 'offsets/hub*', $this->tmp )
		);
	}

	public function test_dirs_matching_answers_null_when_a_dir_under_the_glob_will_not_read(): void {
		\mkdir( "{$this->tmp}/deadletter/hub.tucson-41/firehose.p3", 0755, true );
		\chmod( "{$this->tmp}/deadletter/hub.tucson-41", 0 );
		try {
			$this->assertNull( Log_Discovery::dirs_matching( 'deadletter/hub*', $this->tmp ) );
		} finally {
			\chmod( "{$this->tmp}/deadletter/hub.tucson-41", 0755 );
		}
	}

	/** An exact reader stamp keys its one match by itself, never by the kind alone. */
	public function test_dirs_matching_keys_an_exact_reader_stamp_by_that_stamp(): void {
		\mkdir( "{$this->tmp}/deadletter/hub.coast-73/sources:php", 0755, true );

		$this->assertSame(
			[ 'deadletter:hub.coast-73:sources:php' => "{$this->tmp}/deadletter/hub.coast-73/sources:php" ],
			Log_Discovery::dirs_matching( 'deadletter:hub.coast-73:sources:php', $this->tmp )
		);
	}

	public function test_dirs_matching_maps_each_stamp_a_glob_matches_to_its_dir(): void {
		\mkdir( "{$this->tmp}/offsets/kea-7713.p3", 0755, true );
		\mkdir( "{$this->tmp}/offsets/kea-7713.p8", 0755, true );
		\mkdir( "{$this->tmp}/offsets/emu-7713.p3", 0755, true );
		\mkdir( "{$this->tmp}/logs/kea-7713.p5", 0755, true );

		$this->assertSame(
			[
				'offsets/kea-7713.p3' => "{$this->tmp}/offsets/kea-7713.p3",
				'offsets/kea-7713.p8' => "{$this->tmp}/offsets/kea-7713.p8",
			],
			Log_Discovery::dirs_matching( 'offsets/kea-7713.*', $this->tmp )
		);
	}

	public function test_dirs_matching_leaves_out_a_dir_no_stamp_can_name(): void {
		\mkdir( "{$this->tmp}/offsets/kea-5512.p4", 0755, true );
		\mkdir( "{$this->tmp}/offsets/kea-5512.P4", 0755, true );
		\mkdir( "{$this->tmp}/offsets/kea-5512.p4 copy", 0755, true );

		$this->assertSame(
			[ 'offsets/kea-5512.p4' => "{$this->tmp}/offsets/kea-5512.p4" ],
			Log_Discovery::dirs_matching( 'offsets/kea-5512.*', $this->tmp )
		);
	}

	public function test_dirs_matching_answers_an_empty_map_when_nothing_matches(): void {
		$this->assertSame( [], Log_Discovery::dirs_matching( 'kea-7713.*', $this->tmp ) );
	}

	public function test_dirs_matching_answers_null_on_a_glob_fault(): void {
		$seen                = [];
		Log_Discovery::$glob = static function ( string $pattern, int $flags ) use ( &$seen ): array|false {
			$seen[] = $pattern;
			return false;
		};

		$this->assertNull( Log_Discovery::dirs_matching( 'deadletter/jobs-61*', $this->tmp ) );
		$this->assertSame( [ "{$this->tmp}/deadletter/jobs-61*" ], $seen, 'one glob, through the seam' );
	}

	public function test_dirs_matching_refuses_a_log_dir_named_like_a_group(): void {
		\mkdir( "{$this->tmp}/logs/offsets", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir offsets is named like a group; rename it' );
		Log_Discovery::dirs_matching( 'of*', $this->tmp );
	}

	/** @return array<string,array{string}> Label => a glob the stream's guard refuses. */
	public static function guarded_globs(): array {
		return [
			'leading star' => [ '*.p3' ],
			'uppercase'    => [ 'Kea-*' ],
			'registry'     => [ 'sources/gate-*' ],
			'deep'         => [ 'offsets/a/*' ],
		];
	}

	#[DataProvider( 'guarded_globs' )]
	public function test_dirs_matching_refuses_what_the_streams_guard_refuses( string $sub ): void {
		Log_Discovery::$glob = fn (): array|false => $this->fail( 'a refused glob reads no dir' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "invalid subscription: {$sub}" );
		Log_Discovery::dirs_matching( $sub, $this->tmp );
	}
}
