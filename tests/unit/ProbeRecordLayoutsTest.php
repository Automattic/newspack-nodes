<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Jobstats_Record;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tablestats_Record;
use Newspack_Nodes\Tests\TestCase;

/**
 * Every probe record is a positional layout shared with the browser: its PHP
 * slots run dense from 0, and every slot its JS mirror exports carries the
 * PHP value, or the browser misreads every field after the first one off.
 * A `ROW_` constant indexes a nested row and runs dense from 0 on its own.
 */
#[CoversClass( Probe_Record::class )]
#[CoversClass( Jobstats_Record::class )]
#[CoversClass( Tablestats_Record::class )]
final class ProbeRecordLayoutsTest extends TestCase {

	/**
	 * Each layout, its JS mirror, and the names the mirror must export: null
	 * when it mirrors every slot. `probe-record.js` declares only the nine
	 * slots a browser reads, and `tablestats-record.js` every slot but the
	 * row's bytes, which no browser view reads.
	 *
	 * @return array<string,array{class-string,string,list<string>|null}>
	 */
	public static function layouts(): array {
		return [
			'topicprobe' => [ Probe_Record::class, 'src/runtime/probe-record.js', [ 'SOURCE', 'READER', 'DISTANCE', 'MSGS_DELTA', 'END_BYTES', 'CACHE_SIZE', 'BYTES_READ_DELTA', 'ELAPSED_MS', 'END_DISK_BYTES' ] ],
			'jobstats'   => [ Jobstats_Record::class, 'src/runtime/jobstats-record.js', null ],
			'tablestats' => [ Tablestats_Record::class, 'src/runtime/tablestats-record.js', [ 'IDENTITY', 'BACKEND', 'VERBS', 'PURGE_BEHIND', 'WAL_STALLED', 'FILE_BYTES', 'ELAPSED_MS', 'FILE_DISK_BYTES', 'ROW_CALLS', 'ROW_ASKED', 'ROW_ANSWERED', 'ROW_MS', 'ROW_MAX_MS', 'ROW_ERRORS' ] ],
		];
	}

	/** @return array<string,array{class-string}> */
	public static function layout_classes(): array {
		return \array_map( static fn ( array $layout ): array => [ $layout[0] ], self::layouts() );
	}

	/** @param class-string $layout */
	#[DataProvider( 'layout_classes' )]
	public function test_php_slots_run_dense_from_zero( string $layout ): void {
		$constants = \array_filter( ( new \ReflectionClass( $layout ) )->getConstants(), '\is_int' );
		$rows      = \array_filter( $constants, static fn ( string $name ): bool => \str_starts_with( $name, 'ROW_' ), \ARRAY_FILTER_USE_KEY );
		$slots     = \array_diff_key( $constants, $rows );
		$this->assertSame( \range( 0, \count( $slots ) - 1 ), \array_values( $slots ) );
		if ( [] !== $rows ) {
			$this->assertSame( \range( 0, \count( $rows ) - 1 ), \array_values( $rows ) );
		}
	}

	/**
	 * The record both `probe_stats()` builders start from: one slot per
	 * index in layout order, blank for the two names and 0 for every count,
	 * so each builder states only the slots its kind fills.
	 */
	public function test_a_blank_probe_record_fills_every_slot_in_order(): void {
		$slots    = \array_filter( ( new \ReflectionClass( Probe_Record::class ) )->getConstants(), '\is_int' );
		$expected = \array_fill( 0, \count( $slots ), 0 );
		$expected[ Probe_Record::SOURCE ] = '';
		$expected[ Probe_Record::READER ] = '';

		$this->assertSame( $expected, Probe_Record::BLANK );
	}

	/**
	 * @param class-string       $layout
	 * @param list<string>|null  $names
	 */
	#[DataProvider( 'layouts' )]
	public function test_the_js_mirror_matches_php( string $layout, string $js, ?array $names ): void {
		$source = (string) \file_get_contents( \dirname( __DIR__, 2 ) . "/{$js}" );
		\preg_match_all( '/^export const ([A-Z_]+) = (\d+);$/m', $source, $m, \PREG_SET_ORDER );
		$exported = [];
		foreach ( $m as [ , $name, $value ] ) {
			$exported[ $name ] = (int) $value;
		}
		$constants = ( new \ReflectionClass( $layout ) )->getConstants();
		$this->assertNotSame( [], $exported, "{$js} exports no slot" );
		foreach ( $exported as $name => $value ) {
			$this->assertSame( $constants[ $name ] ?? null, $value, "{$js} {$name}" );
		}
		if ( null === $names ) {
			$this->assertSame( $constants, $exported, "{$js} must mirror every slot" );
		} else {
			$this->assertSame( $names, \array_keys( $exported ), "{$js} must export its read slots" );
		}
	}
}
