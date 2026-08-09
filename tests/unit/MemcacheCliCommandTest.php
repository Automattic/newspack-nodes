<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Memcache_CLI_Command;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * `wp nodes memcache get` — the reader that reverses the key grammar.
 *
 * Every substrate key is `newspack_nodes:{version}:{scope}:{logical}`, so a
 * logical name plus a scope is enough to rebuild the address. That is the whole
 * point of the command: an operator types the name a surface writes under and
 * never the version or the site hash.
 */
#[CoversClass( Memcache_CLI_Command::class )]
class MemcacheCliCommandTest extends TestCase {

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd                 = Core::$memd;
		$GLOBALS['_test_wp_cli_lines']   = [];
		$GLOBALS['_test_wp_cli_errors']  = [];
		Cache_Backend::$apcu_usable      = static fn (): bool => false;
	}

	protected function tearDown(): void {
		Core::$memd                 = $this->prev_memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		parent::tearDown();
	}

	/** @return list<string> */
	private function lines(): array {
		return $GLOBALS['_test_wp_cli_lines'];
	}

	public function test_key_resolves_the_address_without_reading(): void {
		// Comparing two installs is the reason --key exists: it answers even
		// when nothing has been written there.
		Core::$memd = new InMemoryMemcached();

		( new Memcache_CLI_Command() )->get( [ 'table:prices:sku-9' ], [ 'key' => true ] );

		$this->assertSame(
			[ Cache_Backend::site_key( 'table:prices:sku-9' ) ],
			$this->lines()
		);
	}

	public function test_host_scope_resolves_the_per_machine_address(): void {
		Core::$memd = new InMemoryMemcached();

		( new Memcache_CLI_Command() )->get( [ 'sse:17:abc12345:0' ], [ 'key' => true, 'host' => true ] );

		$this->assertSame(
			[ Cache_Backend::host_key( 'sse:17:abc12345:0' ) ],
			$this->lines()
		);
		$this->assertStringContainsString( (string) \gethostname(), $this->lines()[0] );
	}

	public function test_a_hit_prints_the_key_then_the_value(): void {
		$memd = new InMemoryMemcached();
		$memd->set( Cache_Backend::site_key( 'table:prices:sku-9' ), [ 'usd' => 1250 ], 300 );
		Core::$memd = $memd;

		( new Memcache_CLI_Command() )->get( [ 'table:prices:sku-9' ], [] );

		$this->assertCount( 2, $this->lines() );
		$this->assertSame( Cache_Backend::site_key( 'table:prices:sku-9' ), $this->lines()[0] );
		$this->assertStringContainsString( '"usd": 1250', $this->lines()[1] );
	}

	public function test_porcelain_drops_the_key_line_for_piping(): void {
		$memd = new InMemoryMemcached();
		$memd->set( Cache_Backend::site_key( 'table:prices:sku-9' ), [ 'usd' => 1250 ], 300 );
		Core::$memd = $memd;

		( new Memcache_CLI_Command() )->get( [ 'table:prices:sku-9' ], [ 'porcelain' => true ] );

		$this->assertCount( 1, $this->lines() );
		$this->assertStringContainsString( '"usd": 1250', $this->lines()[0] );
	}

	public function test_a_confirmed_miss_and_a_read_error_are_different_answers(): void {
		// A script that cannot tell them apart treats an outage as "absent".
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;

		$this->assertStringStartsWith(
			'not found',
			$this->error_message( fn () => ( new Memcache_CLI_Command() )->get( [ 'table:prices:gone' ], [] ) )
		);

		$memd->fail_get( Cache_Backend::site_key( 'table:prices:sku-9' ), \Memcached::RES_TIMEOUT );
		$this->assertStringStartsWith(
			'backend read error',
			$this->error_message( fn () => ( new Memcache_CLI_Command() )->get( [ 'table:prices:sku-9' ], [] ) )
		);
	}

	public function test_a_missing_logical_name_is_refused(): void {
		Core::$memd = new InMemoryMemcached();

		$this->assertStringStartsWith(
			'a logical name is required',
			$this->error_message( fn () => ( new Memcache_CLI_Command() )->get( [], [] ) )
		);
	}

	public function test_no_backend_is_refused_rather_than_reported_as_absent(): void {
		Core::$memd = null;

		$this->assertStringStartsWith(
			'no cache backend',
			$this->error_message( fn () => ( new Memcache_CLI_Command() )->get( [ 'table:prices:sku-9' ], [] ) )
		);
	}

	/** The message WP_CLI::error() was called with. */
	private function error_message( callable $run ): string {
		try {
			$run();
		} catch ( \RuntimeException $e ) {
			// The stub throws out of error(); production exits there.
			unset( $e );
		}
		$last = \end( $GLOBALS['_test_wp_cli_errors'] );
		return \is_string( $last ) ? $last : '';
	}
}
