<?php
/**
 * CommandHarnessTest: `CommandHarness::fire()` never absorbs PHPUnit's own
 * exceptions. `interpret()` wraps whatever a command throws as its TM_ERROR
 * reply, so the per-test time limit, or an assertion failing inside a seam
 * the command calls, would otherwise come back as a string and let the test
 * pass on a command that never finished.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Helpers\CommandHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\AssertionFailedError;
use SebastianBergmann\Invoker\TimeoutException;

class CommandHarnessTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		CommandHarness::reset();
		$GLOBALS['_wp_test_current_user_can'] = [];
		parent::tearDown();
	}

	/**
	 * A CI whose one command throws what `$throw` builds.
	 *
	 * @param \Closure(): \Throwable $throw Builds the exception the command raises.
	 */
	private static function throwing_ci( \Closure $throw ): Command_Interpreter_Node {
		$ci = new class() extends Service_CI_Node {
			/** @var \Closure(): \Throwable */
			public static \Closure $throw;

			public static function node_schema(): array {
				return [
					'category'    => 'Service',
					'description' => 'harness double',
					'arguments'   => [],
					'commands'    => [
						[
							'name'       => 'stall',
							'capability' => Capabilities::READ,
							'args'       => [],
							'handler'    => static function (): never {
								throw ( self::$throw )();
							},
						],
					],
				];
			}
		};
		$ci::$throw = $throw;
		return $ci;
	}

	public function test_the_per_test_time_limit_escapes_the_command(): void {
		$ci = self::throwing_ci( static fn (): \Throwable => new TimeoutException( 'kiwi-5512 overran' ) );

		$this->expectException( TimeoutException::class );
		$this->expectExceptionMessage( 'kiwi-5512 overran' );

		CommandHarness::fire( $ci, 'kiwi-ci', 'stall' );
	}

	public function test_an_assertion_failing_inside_the_command_escapes_it(): void {
		$ci = self::throwing_ci( static fn (): \Throwable => new AssertionFailedError( 'takahe-3391 mismatched' ) );

		$this->expectException( AssertionFailedError::class );
		$this->expectExceptionMessage( 'takahe-3391 mismatched' );

		CommandHarness::fire( $ci, 'kiwi-ci', 'stall' );
	}

	public function test_a_prior_dispatch_wrapper_runs_and_is_restored_when_the_command_escapes(): void {
		$ran   = [];
		$prior = static function ( Command_Interpreter_Node $ci, string $verb, \Closure $run, \Closure $command ) use ( &$ran ): mixed {
			$ran[] = 'kea-8821';
			return $run();
		};
		Command_Interpreter_Node::$around_dispatch = $prior;
		$ci     = self::throwing_ci( static fn (): \Throwable => new TimeoutException( 'kiwi-5512 overran' ) );
		$caught = null;
		try {
			CommandHarness::fire( $ci, 'kiwi-ci', 'stall' );
		} catch ( TimeoutException $e ) {
			$caught = $e;
		} finally {
			$restored                                  = Command_Interpreter_Node::$around_dispatch;
			Command_Interpreter_Node::$around_dispatch = null;
		}

		$this->assertInstanceOf( TimeoutException::class, $caught );
		$this->assertSame( [ 'kea-8821' ], $ran, 'the prior wrapper ran' );
		$this->assertSame( $prior, $restored, 'the prior wrapper is restored' );
	}

	public function test_a_refusal_still_comes_back_as_the_reply(): void {
		$ci = self::throwing_ci( static fn (): \Throwable => new \RuntimeException( 'weka-7046 refused' ) );

		$this->assertSame( "weka-7046 refused\n", CommandHarness::fire( $ci, 'kiwi-ci', 'stall' ) );
	}
}
