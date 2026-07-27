<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Root must not drop a restart flag: the file would be root-owned, and the
 * worker that has to delete it on pickup runs as the web user. Denial is
 * non-fatal — the caller reports zero restarts rather than fataling.
 */
#[CoversClass( Lock_Node::class )]
class LockNodeRootTest extends TestCase {
	private string $lock_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->lock_dir = \sys_get_temp_dir() . '/nodes-root-lock-' . \uniqid();
		\mkdir( $this->lock_dir, 0700, true );
	}

	protected function tearDown(): void {
		foreach ( (array) \glob( $this->lock_dir . '/*' ) as $f ) {
			@\unlink( (string) $f );
		}
		@\rmdir( $this->lock_dir );
		parent::tearDown();
	}

	public function test_root_writes_no_restart_flag(): void {
		CLI::$uid_provider = static fn (): int => 0;
		Core::set_stderr_handler( static function ( string $line ): void {} );

		$this->assertFalse( Lock_Node::request_restart_at( $this->lock_dir ) );
		$this->assertSame( [], \glob( $this->lock_dir . '/*' ) ?: [] );
	}

	public function test_the_web_user_still_writes_one(): void {
		CLI::$uid_provider = static fn (): int => 1000;

		$this->assertTrue( Lock_Node::request_restart_at( $this->lock_dir ) );
		$this->assertNotSame( [], \glob( $this->lock_dir . '/*' ) ?: [] );
	}
}
