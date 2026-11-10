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

	/** A check refusal naming a key a reader may not see. */
	private const REFUSAL = 'lens desk-q2 reads vault key heron-ledger-5528';

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

	/** A reader's `get` over a refused layout answers the class word, never the key it names. */
	public function test_get_answers_a_reader_the_class_word_for_a_refused_layout(): void {
		$this->store_a_refused_lens();
		Capabilities::$session_scope = Capabilities::READ;

		$reply = $this->fire( 'get', self::BOARD );

		$this->assertSame( Composition_Store::UNREADABLE . "\n", $reply );
	}

	/** A logged-in operator's `get` over a refused layout answers the refusal. */
	public function test_get_answers_an_operator_the_refusal(): void {
		$this->store_a_refused_lens();

		$this->assertStringContainsString( self::REFUSAL, $this->fire( 'get', self::BOARD ) );
	}

	/** A worker's `get` under a manage session answers the refusal, with no user logged in. */
	public function test_get_answers_a_manage_worker_the_refusal(): void {
		$this->store_a_refused_lens();
		CommandHarness::reset();
		$GLOBALS['_wp_test_current_user_id']  = 0;
		$GLOBALS['_wp_test_current_user_can'] = [];
		Core::$var['topology']                = 'kestrel-3318';
		Capabilities::$session_scope          = Capabilities::MANAGE;

		$reply = CommandHarness::fire( new Compositions_CI_Node(), 'compositions', 'get', [ self::BOARD ] );

		$this->assertStringContainsString( self::REFUSAL, $reply );
	}

	/** Save the lens, then have the board's check refuse it naming a key. */
	private function store_a_refused_lens(): void {
		Composition_Store::save( self::BOARD, self::LENS );
		$this->declare_acme_desk(
			static function ( array $map ): array {
				$map['acme-desk']['contexts']['acme-desk/board']['check'] = static fn (): never => throw new \RuntimeException( self::REFUSAL );
				return $map;
			}
		);
	}
}
