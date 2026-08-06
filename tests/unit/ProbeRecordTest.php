<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\TestCase;

/**
 * Probe_Record is a positional layout shared with the browser. The indices MUST
 * match src/runtime/probe-record.js byte-for-byte, or the browser misreads the
 * topicprobe stream. This pins both the PHP values and the PHP↔JS parity.
 */
#[CoversClass( Probe_Record::class )]
class ProbeRecordTest extends TestCase {

	/** The canonical layout — dense 0..N. */
	public function test_php_indices_are_dense_and_ordered(): void {
		$this->assertSame(
			[ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 ],
			[
				Probe_Record::SOURCE,
				Probe_Record::READER,
				Probe_Record::CURSOR_SEGMENT,
				Probe_Record::CURSOR_OFF,
				Probe_Record::END_SEGMENT,
				Probe_Record::END_SIZE,
				Probe_Record::DISTANCE,
				Probe_Record::MSGS_DELTA,
				Probe_Record::END_BYTES,
				Probe_Record::CACHE_SIZE,
				Probe_Record::BYTES_READ_DELTA,
				Probe_Record::ELAPSED_MS,
			]
		);
	}

	public function test_js_mirror_matches_php(): void {
		$js = \file_get_contents(
			\dirname( __DIR__, 2 ) . '/src/runtime/probe-record.js'
		);
		$this->assertIsString( $js, 'probe-record.js must exist' );

		// Indices 2..5 (cursor/end) and 8 (END_BYTES) are PHP-write-only — the
		// JS mirror omits them. The remaining values still pin the shared
		// layout: a renumber on either side breaks this.
		$expected = [
			'SOURCE'           => Probe_Record::SOURCE,
			'READER'           => Probe_Record::READER,
			'DISTANCE'         => Probe_Record::DISTANCE,
			'MSGS_DELTA'       => Probe_Record::MSGS_DELTA,
			'CACHE_SIZE'       => Probe_Record::CACHE_SIZE,
			'BYTES_READ_DELTA' => Probe_Record::BYTES_READ_DELTA,
			'ELAPSED_MS'       => Probe_Record::ELAPSED_MS,
		];
		foreach ( $expected as $name => $value ) {
			$this->assertSame(
				1,
				\preg_match( '/export const ' . $name . ' = ' . $value . ';/', $js ),
				"probe-record.js must define `export const {$name} = {$value};`"
			);
		}
	}
}
