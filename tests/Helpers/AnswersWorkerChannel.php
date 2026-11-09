<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Callback_Node;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Worker_Base;

/**
 * A fake live worker for a test that talks to one over its command channel:
 * its lock dir with a fresh heartbeat, and the read of its input channel that
 * answers each command onto its output channel. The using class supplies the
 * runtime tree as `$this->base`.
 */
trait Answers_Worker_Channel {

	/** Every command the fake worker verified and answered, as `<to> <verb>`. */
	private array $answered = [];

	/** Text of an unaddressed broadcast the fake worker writes before each answer; '' writes none. */
	private string $broadcast = '';

	/** The FROM of every command the fake worker read. */
	private array $asked_from = [];

	/** Whether the fake worker follows each answer with one to another session's same receiver. */
	private bool $decoy = false;

	/** Whether the fake worker answers each command late, TO the FROM of the one before it. */
	private bool $late = false;

	/** The FROM a late-answering fake worker answers next; null before its first command. */
	private ?string $late_from = null;

	/**
	 * A live `{topology}.p{partition}`'s lock dir with a fresh heartbeat, and
	 * the read of its input channel a worker runs, verifying each command and
	 * answering it through the interpreter it addresses onto its output
	 * channel, TO the command's FROM; an empty address is the worker's own
	 * interpreter's, an address naming any other node delivers the command to
	 * it as a Router does, and an address naming no node bounces as the
	 * Router bounces it.
	 *
	 * @param bool $answers False for a worker that reads commands and answers none.
	 */
	private function answer_channel( string $topology, int $partition, bool $answers = true ): void {
		$lock = "{$this->base}/locks/{$topology}.p{$partition}.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", '1' );
		$input  = Worker_Base::ipc_dir( $this->base, $topology, $partition, Worker_Base::IPC_INPUT );
		$output = Worker_Base::ipc_dir( $this->base, $topology, $partition, Worker_Base::IPC_OUTPUT );
		\mkdir( $input, 0755, true );
		\mkdir( $output, 0755, true );
		$replies = new Partition_Node();
		$replies->arguments( Worker_Base::ipc_partition_args( $output ) );
		// A Partition's batch flushes on its timer, which fires only with a sink.
		$replies->sink( new Capture_Sink_Node() );
		$reader = new Consumer_Node();
		$reader->arguments( [ $input ] );
		$reader->next_offset( 'start' );
		$reader->sink(
			new Callback_Node(
				function ( array $command ) use ( $replies, $answers ): void {
					$this->assertTrue( Command_Auth::verify( $command, \time(), \time() ), 'the CLI signs what it sends a worker' );
					$verb             = Core::as_string( $command[ Message::VALUE ]['name'] );
					$arguments        = Core::arr( $command[ Message::VALUE ]['arguments'] );
					$this->answered[] = Core::as_string( $command[ Message::TO ] ) . " {$verb}";
					$this->asked_from[] = Core::as_string( $command[ Message::FROM ] );
					if ( ! $answers ) {
						return;
					}
					if ( $this->late ) {
						[ $command[ Message::FROM ], $this->late_from ] = [ $this->late_from, Core::as_string( $command[ Message::FROM ] ) ];
						if ( null === $command[ Message::FROM ] ) {
							return;
						}
					}
					if ( '' !== $this->broadcast ) {
						$note                   = Message::new_message();
						$note[ Message::TYPE ]  = Message::TM_INFO;
						$note[ Message::VALUE ] = $this->broadcast;
						$replies->fill( $note );
					}
					$to                     = Core::as_string( $command[ Message::TO ] );
					$reply                  = Message::new_message();
					$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;
					$reply[ Message::FROM ] = $to;
					$reply[ Message::TO ]   = $command[ Message::FROM ];
					// An empty TO is the worker's own interpreter's.
					$interpreter            = Core::node( '' === $to ? Node_Names::COMMAND_INTERPRETER : $to );
					if ( null === $interpreter ) {
						// Router_Node::send_error()'s bounce: a bare string VALUE.
						$reply[ Message::TYPE ]  = Message::TM_ERROR;
						$reply[ Message::VALUE ] = "NOT_AVAILABLE\n";
						$replies->fill( $reply );
						return;
					}
					if ( ! $interpreter instanceof Command_Interpreter_Node ) {
						// A Router delivers to whatever node the address names.
						$command[ Message::TO ] = '';
						$interpreter->fill( $command );
						return;
					}
					try {
						$payload = $interpreter->dispatch( $verb, $arguments );
					} catch ( \RuntimeException $e ) {
						$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_ERROR;
						$payload                = $e->getMessage() . "\n";
					}
					$reply[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $arguments, 'payload' => $payload ];
					$replies->fill( $reply );
					if ( $this->decoy ) {
						$other                   = $reply;
						$other[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
						$other[ Message::TO ]    = \str_replace( '_cli:' . \getmypid(), '_cli:48211', Core::as_string( $command[ Message::FROM ] ) );
						$other[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => [], 'payload' => "decoy-3318\n" ];
						$replies->fill( $other );
					}
				}
			)
		);
	}
}
