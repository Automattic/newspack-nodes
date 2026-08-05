<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Age_Sieve_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Port of Tachikoma's AgeSieve.pm: drop any message whose TIMESTAMP age
 * exceeds max_age (default 900s); should_warn enables the rate-limited
 * drop warning. No type gating — age is the only criterion.
 */
#[CoversClass( Age_Sieve_Node::class )]
class AgeSieveTest extends TestCase {
	private float $prev_now;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_now = Core::$now;
		Core::$now      = 1000000.0;
	}

	protected function tearDown(): void {
		Core::$now = $this->prev_now;
		parent::tearDown();
	}

	private function sieve( array $args ): array {
		$sink  = new Capture_Sink_Node();
		$sieve = new Age_Sieve_Node();
		$sieve->name( 'jobs:sieve' );
		$sieve->sink( $sink );
		$sieve->arguments( $args );
		return [ $sieve, $sink ];
	}

	private function stamped( float $ts ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = $ts;
		$message[ Message::VALUE ]     = [ 'k' => 'job' ];
		return $message;
	}

	public function test_fresh_messages_pass_and_old_ones_drop(): void {
		[ $sieve, $sink ] = $this->sieve( [ '60' ] );

		$sieve->fill( $this->stamped( Core::$now - 59.0 ) );
		$sieve->fill( $this->stamped( Core::$now - 61.0 ) );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( Core::$now - 59.0, $sink->captured[0][ Message::TIMESTAMP ] );
	}

	public function test_default_max_age_matches_tachikoma(): void {
		[ $sieve, $sink ] = $this->sieve( [] );
		$this->assertSame( 900.0, $sieve->max_age() );

		$sieve->fill( $this->stamped( Core::$now - 899.0 ) );
		$sieve->fill( $this->stamped( Core::$now - 901.0 ) );
		$this->assertCount( 1, $sink->captured );
	}

	public function test_arguments_read_back_and_schema_names_both(): void {
		[ $sieve ] = $this->sieve( [ '60', '1' ] );
		$this->assertSame( [ '60', '1' ], $sieve->arguments() );
		$this->assertSame( 'Filtering', \Newspack_Nodes\Age_Sieve_Node::node_schema()['category'] );
	}

	public function test_should_warn_drops_without_crashing(): void {
		[ $sieve, $sink ] = $this->sieve( [ '60', '1' ] );
		$sieve->fill( $this->stamped( Core::$now - 3600.0 ) );
		$this->assertSame( [], $sink->captured );
	}

	/**
	 * `should_warn` is declared `'type' => 'bool'`, but `arguments()` parsed it
	 * with a raw `(bool)` cast — and every non-empty string is truthy in PHP,
	 * so `make_node AgeSieve x 900 false` turned the warning ON. The trait
	 * these nodes already `use` owns THE bool parse; four implementations of it
	 * existed, two inside classes that use the trait.
	 *
	 * Observed the way production does: the drop warning reaching stderr.
	 *
	 * @dataProvider provide_falsey_tokens
	 */
	public function test_a_falsey_token_leaves_should_warn_off( string $token ): void {
		$this->assertSame( [], $this->warnings_for_drop( [ '60', $token ] ) );
	}

	/**
	 * @return array<string, list<string>>
	 */
	public static function provide_falsey_tokens(): array {
		return [
			'false' => [ 'false' ],
			'no'    => [ 'no' ],
			'off'   => [ 'off' ],
			'0'     => [ '0' ],
		];
	}

	/**
	 * And the canonical truthy vocabulary still turns it on.
	 *
	 * @dataProvider provide_truthy_tokens
	 */
	public function test_the_truthy_vocabulary_enables_should_warn( string $token ): void {
		$this->assertNotSame( [], $this->warnings_for_drop( [ '60', $token ] ) );
	}

	/**
	 * @return array<string, list<string>>
	 */
	public static function provide_truthy_tokens(): array {
		return [
			'1'    => [ '1' ],
			'true' => [ 'true' ],
			'yes'  => [ 'yes' ],
			'on'   => [ 'on' ],
			'ON'   => [ 'ON' ],
		];
	}

	/**
	 * Drop one over-age message through a sieve built with $args, returning
	 * whatever it wrote to stderr.
	 *
	 * @param list<string> $args Constructor args.
	 * @return list<string> Emitted stderr lines.
	 */
	private function warnings_for_drop( array $args ): array {
		$seen = [];
		Core::set_stderr_handler(
			static function ( string $line ) use ( &$seen ): void {
				$seen[] = $line;
			}
		);
		try {
			[ $sieve ] = $this->sieve( $args );
			$sieve->fill( $this->stamped( Core::$now - 3600.0 ) );
		} finally {
			// Core::reset() in tearDown restores the default handler.
			Core::reset();
		}
		return $seen;
	}
}
