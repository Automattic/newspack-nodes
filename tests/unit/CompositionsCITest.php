<?php
/**
 * CompositionsCITest: the `compositions` service interpreter, fired through
 * the request-scope graph `CommandHarness` builds, against the fictional
 * consumer `acme-desk`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Composition_Store;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\Compositions_CI_Node;
use Newspack_Nodes\Tests\Helpers\CommandHarness;
use Newspack_Nodes\Tests\Helpers\Composes_Acme_Desk;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Compositions_CI_Node::class )]
final class CompositionsCITest extends TestCase {

	use Composes_Acme_Desk;

	private const BOARD = 'acme-desk/board';

	private const LENS = '<!-- wp:acme-desk/lens {"lens":"desk-q2"} /-->';

	private float $saved_now;

	protected function setUp(): void {
		parent::setUp();
		$this->declare_acme_desk();
		$this->saved_now                                        = Core::$now;
		Core::$now                                              = 1789000400.25;
		$GLOBALS['_wp_test_current_user_id']                    = 52;
		$GLOBALS['_wp_test_user_logins'][52]                    = 'harbor-curator';
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
	}

	protected function tearDown(): void {
		CommandHarness::reset();
		Core::$now = $this->saved_now;
		$this->forget_declarations();
		parent::tearDown();
	}

	/** Fire one `compositions` command on a fresh graph and answer its payload. */
	private function fire( string $verb, string ...$args ): mixed {
		CommandHarness::reset();
		return CommandHarness::fire( new Compositions_CI_Node(), 'compositions', $verb, \array_values( $args ) );
	}

	public function test_the_schema_declares_each_role(): void {
		$roles = \array_column( Compositions_CI_Node::node_schema()['commands'], 'capability', 'name' );

		$this->assertSame(
			[
				'get'     => Capabilities::READ,
				'save'    => Capabilities::TUNE,
				'restore' => Capabilities::TUNE,
			],
			$roles
		);
	}

	public function test_get_answers_the_layout(): void {
		Composition_Store::save( self::BOARD, self::LENS );

		$this->assertSame( Composition_Store::read( self::BOARD ), $this->fire( 'get', self::BOARD ) );
	}

	public function test_get_is_read_and_writes_are_tune(): void {
		Capabilities::$session_scope = Capabilities::READ;

		$this->assertSame( 'default', $this->fire( 'get', self::BOARD )['source'] );
		$this->assertStringContainsString( 'permission denied: tune', $this->fire( 'save', self::BOARD, self::LENS ) );
		$this->assertStringContainsString( 'permission denied: tune', $this->fire( 'restore', self::BOARD ) );
		$this->assertFalse( \get_option( Composition_Store::OPTION_PREFIX . self::BOARD, false ) );

		Capabilities::$session_scope = Capabilities::TUNE;

		$saved = $this->fire( 'save', self::BOARD, self::LENS );
		$this->assertSame( 'saved', $saved['source'] );
		$this->assertSame( 'harbor-curator', $saved['actor'] );
		$this->assertSame( self::LENS, \get_option( Composition_Store::OPTION_PREFIX . self::BOARD )['markup'] );

		$restored = $this->fire( 'restore', self::BOARD );
		$this->assertSame( 'default', $restored['source'] );
		$this->assertTrue( \get_option( Composition_Store::OPTION_PREFIX . self::BOARD )['removed'] );
	}

	public function test_a_refused_layout_answers_the_refusal(): void {
		$reply = $this->fire( 'save', self::BOARD, '<!-- wp:acme-desk/ghost /-->' );

		$this->assertIsString( $reply );
		$this->assertStringContainsString( 'acme-desk/ghost is not a declared block', $reply );
	}
}
