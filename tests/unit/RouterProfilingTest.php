<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Port of Tachikoma Router profiling (Router.pm push_profile/pop_profile/
 * trim_profiles + CommandInterpreter.pm list_profiles). The enable/disable
 * pair is collapsed into a single `profile [on|off]` verb (debug_state-
 * precedent) — a deliberate divergence. Self-time accounting: a nested
 * router dispatch subtracts the child's elapsed from the parent's open frame.
 */
#[CoversClass( Router_Node::class )]
#[CoversClass( Command_Interpreter_Node::class )]
class RouterProfilingTest extends TestCase {
	protected function tearDown(): void {
		Router_Node::profiles( null );
		Router_Node::$clock = null;
		parent::tearDown();
	}

	/** Scripted clock: each push/pop reads the next value. */
	private function script_clock( array $times ): void {
		$i                  = 0;
		Router_Node::$clock = static function () use ( $times, &$i ): float {
			return $times[ $i++ ];
		};
	}

	public function test_profiles_disabled_by_default_and_enable_resets_stack(): void {
		$this->assertNull( Router_Node::profiles() );
		Router_Node::profiles( [] );
		$this->assertSame( [], Router_Node::profiles() );
	}

	public function test_fill_records_self_time_count_avg_oldest_timestamp(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$dst = new Capture_Sink_Node();
		$dst->name( 'alice' );

		Router_Node::profiles( [] );
		$this->script_clock( [ 100.0, 100.25 ] );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'alice';
		$router->fill( $message );

		$profiles = Router_Node::profiles();
		$this->assertArrayHasKey( 'alice', $profiles );
		$info = $profiles['alice'];
		$this->assertEqualsWithDelta( 0.25, $info['time'], 1e-9 );
		$this->assertSame( 1, $info['count'] );
		$this->assertEqualsWithDelta( 0.25, $info['avg'], 1e-9 );
		$this->assertEqualsWithDelta( 100.0, $info['oldest'], 1e-9 );
		$this->assertEqualsWithDelta( 100.25, $info['timestamp'], 1e-9 );
		$this->assertCount( 1, $dst->captured, 'profiled dispatch still delivers' );
	}

	public function test_profiling_off_records_nothing(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$dst = new Capture_Sink_Node();
		$dst->name( 'alice' );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'alice';
		$router->fill( $message );

		$this->assertNull( Router_Node::profiles() );
	}

	public function test_nested_dispatch_subtracts_child_time_from_parent(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$child = new Capture_Sink_Node();
		$child->name( 'kid' );

		// Parent whose fill() routes a second message through the router.
		$parent       = new class() extends \Newspack_Nodes\Node {
			public function fill( array $message ): void {
				$inner                = Message::new_message();
				$inner[ Message::TO ] = 'kid';
				$router               = Core::node( '_router' );
				if ( null !== $router ) {
					$router->fill( $inner );
				}
			}
		};
		$parent->name( 'mother' );

		Router_Node::profiles( [] );
		// push mother=10.0, push kid=10.1, pop kid=10.4, pop mother=10.5.
		$this->script_clock( [ 10.0, 10.1, 10.4, 10.5 ] );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'mother';
		$router->fill( $message );

		$profiles = Router_Node::profiles();
		$this->assertEqualsWithDelta( 0.3, $profiles['kid']['time'], 1e-9 );
		// Mother's gross 0.5 minus kid's 0.3 = 0.2 self time.
		$this->assertEqualsWithDelta( 0.2, $profiles['mother']['time'], 1e-9 );
		$this->assertCount( 1, $child->captured );
	}

	public function test_trim_profiles_drops_entries_idle_past_ttl(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		Core::$now = 200_000;
		Router_Node::profiles( [
			'stale' => [
				'time'      => 0.5,
				'count'     => 3,
				'avg'       => 0.5 / 3,
				'oldest'    => 100.0,
				'timestamp' => 200_000 - Router_Node::PROFILE_TTL_S - 1,
			],
			'fresh' => [
				'time'      => 0.5,
				'count'     => 3,
				'avg'       => 0.5 / 3,
				'oldest'    => 100.0,
				'timestamp' => 200_000 - Router_Node::PROFILE_TTL_S + 1,
			],
		] );

		$router->trim_profiles();

		$profiles = Router_Node::profiles();
		$this->assertArrayNotHasKey( 'stale', $profiles );
		$this->assertArrayHasKey( 'fresh', $profiles );
	}

	public function test_profile_verb_bare_toggles_both_directions(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();

		// Bare `profile` toggles: off -> on -> off (debug_state-precedent).
		$this->assertSame( "profiling enabled\n", $interpreter->dispatch( 'profile' ) );
		$this->assertSame( [], Router_Node::profiles() );
		$this->assertSame( "profiling disabled\n", $interpreter->dispatch( 'profile' ) );
		$this->assertNull( Router_Node::profiles() );
	}

	public function test_profile_on_off_are_idempotent_set(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();

		// Explicit set (the form scripts + UI use): idempotent, never races.
		$this->assertSame( "profiling enabled\n", $interpreter->dispatch( 'profile', [ 'on' ] ) );
		$this->assertSame( [], Router_Node::profiles() );
		$this->assertSame( "profiling already enabled\n", $interpreter->dispatch( 'profile', [ 'on' ] ) );
		$this->assertSame( "profiling disabled\n", $interpreter->dispatch( 'profile', [ 'off' ] ) );
		$this->assertNull( Router_Node::profiles() );
		$this->assertSame( "profiling already disabled\n", $interpreter->dispatch( 'profile', [ 'off' ] ) );
	}

	public function test_list_profiles_renders_ranked_table_with_total_row(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();

		Core::$now = 500;
		Router_Node::profiles( [
			'slowpoke' => [
				'time'      => 4.0,
				'count'     => 2,
				'avg'       => 2.0,
				'oldest'    => 480.0,
				'timestamp' => 496.0,
			],
			'zippy'    => [
				'time'      => 0.3,
				'count'     => 6,
				'avg'       => 0.05,
				'oldest'    => 490.0,
				'timestamp' => 499.0,
			],
		] );

		$out = $interpreter->dispatch( 'list_profiles' );

		foreach ( [ 'AVERAGE', 'TIME', 'COUNT', 'WINDOW', 'RATE', 'AGE', 'WHAT' ] as $column ) {
			$this->assertStringContainsString( $column, $out );
		}
		$slow = \strpos( $out, 'slowpoke' );
		$zip  = \strpos( $out, 'zippy' );
		$this->assertNotFalse( $slow );
		$this->assertNotFalse( $zip );
		$this->assertLessThan( $zip, $slow, 'sorted by avg descending: slowpoke first' );
		$this->assertStringContainsString( '--total--', $out );
		$this->assertStringContainsString( "\nreturned 2 profiles", $out, 'trailer starts on its own line' );
	}

	public function test_throwing_fill_still_pops_its_frame_and_records_elapsed(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$boom = new class() extends \Newspack_Nodes\Node {
			public function fill( array $message ): void {
				throw new \RuntimeException( 'poison' );
			}
		};
		$boom->name( 'boom' );
		$calm = new Capture_Sink_Node();
		$calm->name( 'calm' );

		Router_Node::profiles( [] );
		// push boom=50.0, pop boom=50.2 (finally), push calm=60.0, pop calm=60.5.
		$this->script_clock( [ 50.0, 50.2, 60.0, 60.5 ] );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'boom';
		try {
			$router->fill( $message );
			$this->fail( 'poison throw must propagate (ADR-12)' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'poison', $e->getMessage() );
		}

		$next                = Message::new_message();
		$next[ Message::TO ] = 'calm';
		$router->fill( $next );

		$profiles = Router_Node::profiles();
		// Frame popped on the throw path: elapsed recorded, stack balanced —
		// calm's pop must NOT subtract into a stale 'boom' frame.
		$this->assertEqualsWithDelta( 0.2, $profiles['boom']['time'], 1e-9 );
		$this->assertEqualsWithDelta( 0.5, $profiles['calm']['time'], 1e-9 );
	}

	public function test_worker_should_stop_propagates_through_profiled_dispatch(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$stopper = new class() extends \Newspack_Nodes\Node {
			public function fill( array $message ): void {
				throw new \Newspack_Nodes\Worker_Should_Stop( 'cooperative stop' );
			}
		};
		$stopper->name( 'stopper' );

		Router_Node::profiles( [] );
		$this->script_clock( [ 70.0, 70.1 ] );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'stopper';

		$this->expectException( \Newspack_Nodes\Worker_Should_Stop::class );
		$router->fill( $message );
	}

	public function test_list_profiles_glob_filters_rows(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();

		Core::$now = 500;
		Router_Node::profiles( [
			'slowpoke' => [ 'time' => 4.0, 'count' => 2, 'avg' => 2.0, 'oldest' => 480.0, 'timestamp' => 496.0 ],
			'zippy'    => [ 'time' => 0.3, 'count' => 6, 'avg' => 0.05, 'oldest' => 490.0, 'timestamp' => 499.0 ],
		] );

		$out = $interpreter->dispatch( 'list_profiles', [ 'zip' ] );

		$this->assertStringContainsString( 'zippy', $out );
		$this->assertStringNotContainsString( 'slowpoke', $out );
		$this->assertStringContainsString( 'returned 1 profiles', $out );
	}
}
