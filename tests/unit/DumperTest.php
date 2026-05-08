<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Dumper;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Dumper::class )]
class DumperTest extends TestCase {

	/** @return array{0:Dumper, 1:resource, 2:resource} */
	private function fresh(): array {
		$out    = \fopen( 'php://memory', 'w+' );
		$err    = \fopen( 'php://memory', 'w+' );
		$dumper = new Dumper( $out, $err );
		return [ $dumper, $out, $err ];
	}

	private function read_all( $stream ): string {
		\rewind( $stream );
		return \stream_get_contents( $stream );
	}

	public function test_TM_COMMAND_TM_RESPONSE_prints_payload(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => "alice\nbob" ] );
		$dumper->fill( $msg );

		$this->assertSame( "alice\nbob\n", $this->read_all( $out ) );
		$this->assertSame( '', $this->read_all( $err ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_does_not_double_newline(): void {
		[ $dumper, $out ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => "ends-with-newline\n" ] );
		$dumper->fill( $msg );

		$this->assertSame( "ends-with-newline\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_name_prompt_updates_shell_prompt(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$shell = new Shell();
		$dumper->set_shell( $shell );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'prompt', 'payload' => 'pivot> ' ] );
		$dumper->fill( $msg );

		$this->assertSame( 'pivot> ', $shell->prompt );
		$this->assertSame( '', $this->read_all( $out ), 'prompt-update must NOT print to stdout' );
	}

	public function test_TM_ERROR_prints_to_stderr_with_prefix(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_ERROR;
		$msg[ Message::VALUE ] = "NOT_AVAILABLE\n";
		$dumper->fill( $msg );

		$this->assertSame( '', $this->read_all( $out ) );
		$this->assertSame( "ERROR: NOT_AVAILABLE\n", $this->read_all( $err ) );
	}

	public function test_TM_INFO_prints_with_FROM_prefix(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'alpha';
		$msg[ Message::VALUE ] = 'broadcast text';
		$dumper->fill( $msg );

		$this->assertSame( "INFO[alpha]: broadcast text\n", $this->read_all( $out ) );
		$this->assertSame( '', $this->read_all( $err ) );
	}

	public function test_default_type_prints_VALUE(): void {
		[ $dumper, $out ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'plain bytes';
		$dumper->fill( $msg );

		$this->assertSame( "plain bytes\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_invalid_json_falls_through_to_default(): void {
		[ $dumper, $out ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = 'not-json';
		$dumper->fill( $msg );

		// json_decode → null, !is_array → fall through to default branch (prints VALUE).
		$this->assertSame( "not-json\n", $this->read_all( $out ) );
	}

	public function test_counter_increments_per_fill(): void {
		[ $dumper, $out ] = $this->fresh();
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'x';
		$msg[ Message::VALUE ] = 'a';

		$dumper->fill( $msg );
		$dumper->fill( $msg );

		$this->assertSame( 2, $dumper->counter() );
	}
}
