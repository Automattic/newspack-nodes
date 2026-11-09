<?php
/**
 * CompositionStoreTest: a context's layout in its option, read, saved,
 * restored and seeded, against the fictional consumer `acme-desk`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Composition;
use Newspack_Nodes\Composition_Store;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\Composes_Acme_Desk;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

#[CoversClass( Composition_Store::class )]
final class CompositionStoreTest extends TestCase {

	use Composes_Acme_Desk;

	private const BOARD  = 'acme-desk/board';
	private const DIGEST = 'acme-desk/digest';

	/** The clock every write in these tests is stamped with. */
	private const NOW = 1789000123.5;

	private float $saved_now;

	protected function setUp(): void {
		parent::setUp();
		$this->declare_acme_desk();
		$this->saved_now                       = Core::$now;
		Core::$now                             = self::NOW;
		$GLOBALS['_wp_test_current_user_id']   = 31;
		$GLOBALS['_wp_test_user_logins'][31]   = 'lakeside-editor';
	}

	protected function tearDown(): void {
		Core::$now = $this->saved_now;
		$this->forget_declarations();
		parent::tearDown();
	}

	/** The board's stored record, or false for none. */
	private static function stored( string $context = self::BOARD ): mixed {
		return \get_option( Composition_Store::OPTION_PREFIX . $context, false );
	}

	public function test_a_layout_never_saved_reads_as_the_default(): void {
		$read = Composition_Store::read( self::BOARD );

		$this->assertSame( 'default', $read['source'] );
		$this->assertSame( self::BOARD, $read['context'] );
		$this->assertSame( [ 'acme-desk/tally', 'acme-desk/queue' ], \array_column( $read['blocks'], 'name' ) );
		$this->assertSame( 'Desk backlog', $read['blocks'][0]['attributes']['heading'] );
		$this->assertNull( $read['saved_ts'] );
		$this->assertNull( $read['actor'] );
	}

	public function test_a_saved_layout_replaces_the_default(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );

		$this->assertSame(
			[
				'context'  => self::BOARD,
				'source'   => 'saved',
				'blocks'   => [
					[
						'name'       => 'acme-desk/lens',
						'attributes' => [ 'lens' => 'desk-q2' ],
						'inner'      => [],
					],
				],
				'saved_ts' => self::NOW,
				'actor'    => 'lakeside-editor',
			],
			Composition_Store::read( self::BOARD )
		);
	}

	public function test_a_request_that_never_ticked_stamps_the_live_clock(): void {
		Core::$now   = 0.0;
		Core::$clock = static fn (): float => 1789000999.75;

		try {
			Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/queue /-->' );
		} finally {
			Core::$clock = null;
		}

		$this->assertSame( 1789000999.75, Composition_Store::read( self::BOARD )['saved_ts'] );
	}

	public function test_save_answers_what_read_answers(): void {
		$saved = Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );

		$this->assertSame( Composition_Store::read( self::BOARD ), $saved );
	}

	public function test_a_session_names_the_actor_where_no_user_is_logged_in(): void {
		unset( $GLOBALS['_wp_test_current_user_id'] );
		Capabilities::$session_label = 'desk-relay';

		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/queue /-->' );

		$this->assertSame( 'desk-relay', Composition_Store::read( self::BOARD )['actor'] );
	}

	public function test_save_stores_the_serialized_tree(): void {
		Composition_Store::save(
			self::BOARD,
			"\n  <!-- wp:acme-desk/tally {\"heading\":\"Open tickets\",\"limit\":7} /-->\n\n<!-- wp:acme-desk/rail -->\n  <!-- wp:acme-desk/lens {\"lens\":\"desk-q2\"} /-->\n<!-- /wp:acme-desk/rail -->\n"
		);

		$this->assertSame(
			'<!-- wp:acme-desk/tally {"heading":"Open tickets","limit":7,"open":true} /-->'
				. '<!-- wp:acme-desk/rail --><!-- wp:acme-desk/lens {"lens":"desk-q2"} /--><!-- /wp:acme-desk/rail -->',
			self::stored()['markup']
		);
	}

	/** A lens of 700 `<`, which the delimiter escapes to six bytes each. */
	private static function escaped_past_the_cap(): string {
		return '<!-- wp:acme-desk/lens {"lens":"' . \str_repeat( '<', 700 ) . '"} /-->';
	}

	public function test_save_holds_the_stored_markup_to_the_byte_cap(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );
		$before = self::stored();

		try {
			Composition_Store::save( self::BOARD, self::escaped_past_the_cap() );
			$this->fail( 'a layout past the cap stored' );
		} catch ( \RuntimeException $refused ) {
			$this->assertStringContainsString( (string) Composition::MAX_MARKUP_BYTES, $refused->getMessage() );
		}
		$this->assertSame( $before, self::stored() );
	}

	public function test_seed_holds_the_stored_markup_to_the_byte_cap(): void {
		try {
			Composition_Store::seed( self::BOARD, self::escaped_past_the_cap() );
			$this->fail( 'a seed past the cap stored' );
		} catch ( \RuntimeException $refused ) {
			$this->assertStringContainsString( (string) Composition::MAX_MARKUP_BYTES, $refused->getMessage() );
		}
		$this->assertFalse( self::stored() );
	}

	public function test_a_curated_value_keeps_its_place_when_the_default_moves(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/tally {"limit":10} /-->' );
		$this->declare_acme_desk(
			static function ( array $map ): array {
				$map['acme-desk']['blocks']['acme-desk/tally']['attributes']['limit']['default'] = 25;
				return $map;
			}
		);

		$this->assertSame( 10, Composition_Store::read( self::BOARD )['blocks'][0]['attributes']['limit'] );
	}

	public function test_a_write_the_options_table_refuses_is_refused(): void {
		$GLOBALS['_test_refused_option_writes'][ Composition_Store::OPTION_PREFIX . self::BOARD ] = true;

		try {
			foreach ( [ static fn () => Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/queue /-->' ), static fn () => Composition_Store::restore( self::BOARD ) ] as $write ) {
				try {
					$write();
					$this->fail( 'a refused write was answered as stored' );
				} catch ( \RuntimeException $refused ) {
					$this->assertStringContainsString( 'did not store', $refused->getMessage() );
				}
			}
		} finally {
			unset( $GLOBALS['_test_refused_option_writes'] );
		}
		$this->assertFalse( self::stored() );
	}

	public function test_a_check_refusal_refuses_the_save(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );
		$before = self::stored();

		try {
			Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q3"} /-->' );
			$this->fail( 'the check\'s refusal was not raised' );
		} catch ( \RuntimeException $refused ) {
			$this->assertSame( 'no lens: desk-q3', $refused->getMessage() );
		}
		$this->assertSame( $before, self::stored() );
	}

	public function test_restore_answers_the_default_and_leaves_a_tombstone(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );
		Core::$now = self::NOW + 60;

		$restored = Composition_Store::restore( self::BOARD );

		$this->assertSame(
			[
				'removed' => true,
				'actor'   => 'lakeside-editor',
				'ts'      => self::NOW + 60,
			],
			self::stored()
		);
		$this->assertSame( 'default', $restored['source'] );
		$this->assertSame( [ 'acme-desk/tally', 'acme-desk/queue' ], \array_column( $restored['blocks'], 'name' ) );
		$this->assertSame( self::NOW + 60, $restored['saved_ts'] );
		$this->assertSame( $restored, Composition_Store::read( self::BOARD ) );
	}

	public function test_seed_writes_only_a_context_never_named(): void {
		$this->assertTrue( Composition_Store::seed( self::DIGEST, '<!-- wp:acme-desk/summary {"tone":"terse"} /-->' ) );
		$this->assertSame( 'saved', Composition_Store::read( self::DIGEST )['source'] );
		$this->assertSame( 'terse', Composition_Store::read( self::DIGEST )['blocks'][0]['attributes']['tone'] );

		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );
		$saved = self::stored();
		$this->assertFalse( Composition_Store::seed( self::BOARD, '<!-- wp:acme-desk/queue /-->' ) );
		$this->assertSame( $saved, self::stored() );

		Composition_Store::restore( self::BOARD );
		$tombstone = self::stored();
		$this->assertFalse( Composition_Store::seed( self::BOARD, '<!-- wp:acme-desk/queue /-->' ) );
		$this->assertSame( $tombstone, self::stored() );
	}

	public function test_seed_checks_the_shape_and_never_the_check(): void {
		$this->assertTrue( Composition_Store::seed( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q3"} /-->' ) );
		$this->assertSame( [], $this->checked );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'acme-desk/ghost' );
		Composition_Store::seed( self::DIGEST, '<!-- wp:acme-desk/ghost /-->' );
	}

	public function test_a_stored_layout_that_no_longer_validates_is_refused_on_read(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );
		$this->declare_acme_desk(
			static function ( array $map ): array {
				unset( $map['acme-desk']['blocks']['acme-desk/lens'] );
				return $map;
			}
		);

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'acme-desk/lens is not a declared block' );
		Composition_Store::read( self::BOARD );
	}

	/**
	 * Records neither a save nor a restore writes.
	 *
	 * @return array<string,array{0:mixed}>
	 */
	public static function malformed_records(): array {
		$markup = '<!-- wp:acme-desk/queue /-->';
		return [
			'a record that is not a map' => [ 'desk-board' ],
			'a record with no clock'     => [ [ 'markup' => $markup, 'actor' => 'lakeside-editor' ] ],
			'a clock that is an int'     => [ [ 'markup' => $markup, 'actor' => 'lakeside-editor', 'ts' => 1789000123 ] ],
			'an actor that is a number'  => [ [ 'markup' => $markup, 'actor' => 31, 'ts' => self::NOW ] ],
			'no markup and no tombstone' => [ [ 'actor' => 'lakeside-editor', 'ts' => self::NOW ] ],
			'a tombstone that is a word' => [ [ 'removed' => 'yes', 'actor' => 'lakeside-editor', 'ts' => self::NOW ] ],
		];
	}

	#[DataProvider( 'malformed_records' )]
	public function test_a_malformed_record_is_refused_on_read( mixed $record ): void {
		\update_option( Composition_Store::OPTION_PREFIX . self::BOARD, $record, false );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'composition acme-desk/board: the stored layout is malformed' );
		Composition_Store::read( self::BOARD );
	}

	public function test_page_data_answers_a_refusal_in_place(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->' );
		$this->declare_acme_desk(
			static function ( array $map ): array {
				unset( $map['acme-desk']['blocks']['acme-desk/lens'] );
				return $map;
			}
		);

		$page = Composition_Store::page_data( [ self::BOARD, self::DIGEST ] );

		$this->assertSame( [ self::BOARD, self::DIGEST ], \array_keys( $page ) );
		$this->assertSame(
			[
				'context' => self::BOARD,
				'error'   => 'composition acme-desk/board: acme-desk/lens is not a declared block',
			],
			$page[ self::BOARD ]
		);
		$this->assertSame( Composition_Store::read( self::DIGEST ), $page[ self::DIGEST ] );
	}

	public function test_the_option_is_not_autoloaded(): void {
		Composition_Store::save( self::BOARD, '<!-- wp:acme-desk/queue /-->' );
		Composition_Store::seed( self::DIGEST, '<!-- wp:acme-desk/summary /-->' );
		$this->assertFalse( \wp_test_option_autoloads( Composition_Store::OPTION_PREFIX . self::BOARD ) );
		$this->assertFalse( \wp_test_option_autoloads( Composition_Store::OPTION_PREFIX . self::DIGEST ) );

		Composition_Store::restore( self::BOARD );
		$this->assertFalse( \wp_test_option_autoloads( Composition_Store::OPTION_PREFIX . self::BOARD ) );
	}

	public function test_an_undeclared_context_is_refused(): void {
		$this->expectException( \LogicException::class );
		Composition_Store::save( 'acme-desk/archive', '<!-- wp:acme-desk/queue /-->' );
	}

	public function test_an_undeclared_context_reads_no_option(): void {
		$read = [];
		$GLOBALS['_test_get_option_hook'] = static function ( string $key ) use ( &$read ): void {
			$read[] = $key;
		};

		try {
			Composition_Store::read( 'acme-desk/archive' );
			$this->fail( 'an undeclared context was read' );
		} catch ( \LogicException $refused ) {
			$this->assertStringContainsString( 'acme-desk/archive', $refused->getMessage() );
		} finally {
			unset( $GLOBALS['_test_get_option_hook'] );
		}
		$this->assertNotContains( Composition_Store::OPTION_PREFIX . 'acme-desk/archive', $read );
	}

	public function test_the_default_validates_against_the_declarations(): void {
		$this->assertSame( Composition::validate( self::BOARD, Composition::default_markup( self::BOARD ) ), Composition_Store::read( self::BOARD )['blocks'] );
	}
}
