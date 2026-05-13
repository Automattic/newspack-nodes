<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Formatters;
use Newspack_Nodes\Tests\TestCase;

class FormattersTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		Formatters::reset();
	}

	public function test_register_and_resolve_round_trips(): void {
		Formatters::register( 'foo', static fn () => 'foo-result' );
		$cb = Formatters::resolve( 'foo' );
		$this->assertNotNull( $cb );
		$this->assertSame( 'foo-result', $cb() );
	}

	public function test_resolve_returns_null_for_unknown_name(): void {
		$this->assertNull( Formatters::resolve( 'missing' ) );
	}

	public function test_list_names_returns_registered(): void {
		Formatters::register( 'a', static fn () => null );
		Formatters::register( 'b', static fn () => null );
		$names = Formatters::list_names();
		\sort( $names );
		$this->assertSame( [ 'a', 'b' ], $names );
	}

	public function test_register_replaces_existing(): void {
		Formatters::register( 'x', static fn () => 1 );
		Formatters::register( 'x', static fn () => 2 );
		$this->assertSame( 2, ( Formatters::resolve( 'x' ) )() );
	}
}
