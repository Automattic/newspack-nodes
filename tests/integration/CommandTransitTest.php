<?php
/**
 * Command auth survives real transit.
 *
 * A signed command is written to a Partition, read back by a Consumer, routed
 * through the Router, and dispatched by a verifier-gated Command_Interpreter —
 * the exact path a wire command takes into a worker. It must still verify and
 * execute.
 *
 * This locks the load-bearing invariant behind moving the auth timestamp into
 * Message::TIMESTAMP: the timestamp is part of the signed canonical, so anything
 * that re-stamps TIMESTAMP between sign() and verify() would break the HMAC and
 * the command would be dropped. The Partition pack/unpack hop also drops the
 * LOCAL taint, so the reader is forced down the real signature-verify path
 * rather than trusting an in-process command. Flip any forwarder (Consumer,
 * Router, interpreter) to re-stamp TIMESTAMP and this test goes red.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

class CommandTransitTest extends TestCase {

	private string $tmp;

	/** @var \Closure(string, int): bool|null */
	private ?\Closure $saved_claim;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
		// make_node resolves <type> against this prefix; the standalone interpreter
		// here doesn't go through Bootstrap, so register it explicitly.
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		// Single-use claim always succeeds: this test covers transit + signature,
		// not replay (that's CommandAuthTest's job). Restored in tearDown.
		$this->saved_claim         = Command_Auth::$claim_nonce;
		Command_Auth::$claim_nonce = static fn( string $nonce, int $ttl ): bool => true;
	}

	protected function tearDown(): void {
		Command_Auth::$claim_nonce = $this->saved_claim;
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_signed_command_survives_partition_consumer_router_transit_and_executes(): void {
		// Verifier-gated interpreter + router, wired as a worker's input path is.
		$interpreter            = new Command_Interpreter_Node();
		$interpreter->authorize = Command_Auth::verifier(); // refuse anything that doesn't verify.
		$interpreter->sink( new Capture_Sink_Node() );      // absorb the command response.
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );

		// A make_node command, minted "now" so it lands inside the freshness window,
		// then signed — TIMESTAMP is now baked into the HMAC canonical.
		$cmd                       = Message::new_message();
		$cmd[ Message::TYPE ]      = Message::TM_COMMAND;
		$cmd[ Message::TIMESTAMP ] = \time();
		$cmd[ Message::VALUE ]     = [ 'name' => 'make_node', 'arguments' => 'Tee proof' ];
		Command_Auth::sign( $cmd );
		$this->assertIsArray( $cmd[ Message::VALUE ]['auth'] ?? null, 'precondition: the command was signed' );

		// IPC hop: the Partition packs the command to a line (dropping LOCAL), so the
		// Consumer that reads it back must verify the signature, not trust a taint.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/input.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$source->fill( $cmd );
		$source->flush();

		// Worker input Consumer: tails the partition, routes each line to the interpreter.
		$consumer = new Consumer_Node();
		$consumer->arguments( "{$this->tmp}/input.p0 {$this->tmp}/offsets.p0" );
		$consumer->sink( $router );
		$consumer->target( Node_Names::COMMAND_INTERPRETER );
		$this->pump_consumer( $consumer );

		// The command verified and ran ONLY if its signed TIMESTAMP survived the
		// pack/unpack + Consumer forward + Router hop untouched.
		$this->assertNotNull(
			Core::node( 'proof' ),
			'signed command must verify and execute after Partition -> Consumer -> Router -> interpreter transit'
		);
	}
}
