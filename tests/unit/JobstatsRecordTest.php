<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Jobstats_Record;
use Newspack_Nodes\Tests\TestCase;

/**
 * Jobstats_Record is a positional layout shared with the browser. The indices
 * MUST match src/runtime/jobstats-record.js byte-for-byte, or the browser
 * misreads the jobstats stream. This pins both the PHP values and PHP↔JS parity.
 */
#[CoversClass( Jobstats_Record::class )]
class JobstatsRecordTest extends TestCase {

	/** The canonical layout — dense 0..N. */
	public function test_php_indices_are_dense_and_ordered(): void {
		$this->assertSame(
			[ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 ],
			[
				Jobstats_Record::KEY,
				Jobstats_Record::HANDLER,
				Jobstats_Record::RUNS,
				Jobstats_Record::ERRORS,
				Jobstats_Record::DURATION_MS,
				Jobstats_Record::QUEUE_MS,
				Jobstats_Record::ITEMS_OK,
				Jobstats_Record::ITEMS_ERR,
				Jobstats_Record::LAST_TS,
				Jobstats_Record::LAST_DURATION_MS,
				Jobstats_Record::LAST_STATUS,
				Jobstats_Record::LAST_MESSAGE,
			]
		);
	}

	public function test_js_mirror_matches_php(): void {
		$js = \file_get_contents(
			\dirname( __DIR__, 2 ) . '/src/runtime/jobstats-record.js'
		);
		$this->assertIsString( $js, 'jobstats-record.js must exist' );

		$expected = [
			'KEY'              => Jobstats_Record::KEY,
			'HANDLER'          => Jobstats_Record::HANDLER,
			'RUNS'             => Jobstats_Record::RUNS,
			'ERRORS'           => Jobstats_Record::ERRORS,
			'DURATION_MS'      => Jobstats_Record::DURATION_MS,
			'QUEUE_MS'         => Jobstats_Record::QUEUE_MS,
			'ITEMS_OK'         => Jobstats_Record::ITEMS_OK,
			'ITEMS_ERR'        => Jobstats_Record::ITEMS_ERR,
			'LAST_TS'          => Jobstats_Record::LAST_TS,
			'LAST_DURATION_MS' => Jobstats_Record::LAST_DURATION_MS,
			'LAST_STATUS'      => Jobstats_Record::LAST_STATUS,
			'LAST_MESSAGE'     => Jobstats_Record::LAST_MESSAGE,
		];
		foreach ( $expected as $name => $value ) {
			$this->assertSame(
				1,
				\preg_match( '/export const ' . $name . ' = ' . $value . ';/', $js ),
				"jobstats-record.js must define `export const {$name} = {$value};`"
			);
		}
	}
}
