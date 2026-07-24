<?php
/**
 * Stdin: bare fgets stdin source — emits TM_BYTESTREAM lines to its sink,
 * one TM_EOF on close. No readline, no shell, no prompt (see TTY_In_Node).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Stdin_Node extends Timer_Node {
	private const BUSY_POLL_MS = 0;   // Bytes pending — drain ASAP next tick.
	private const EOF_POLL_MS  = 10;  // post-TM_EOF: check deadline + drain.

	private const IDLE_POLL_MS = 100; // No bytes pending — back off.
	public bool $exit = false;

	/** @var resource */
	public $stream;
	private float $eof_deadline_at = 0.0;
	private float $eof_deadline_s;
	private bool $eof_sent = false;

	/**
	 * @param resource|null $stream         Input stream (defaults to STDIN); set non-blocking.
	 * @param float         $eof_deadline_s Cap on waiting after stdin closes before self-exit.
	 */
	public function __construct( $stream = null, float $eof_deadline_s = 5.0 ) {
		parent::__construct();
		$this->stream         = $stream ?? \STDIN;
		$this->eof_deadline_s = $eof_deadline_s;
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		@\stream_set_blocking( $this->stream, false );
	}

	/**
	 * Timer override: drain one line via drain_once(), re-arm (busy/EOF/idle cadence).
	 */
	public function fire(): void {
		if ( $this->eof_sent && Core::$now >= $this->eof_deadline_at ) {
			$this->exit = true;
			return;
		}
		$delivered = $this->drain_once();
		if ( $this->exit ) {
			return;
		}
		if ( $delivered ) {
			$next_ms = self::BUSY_POLL_MS;
		} elseif ( $this->eof_sent ) {
			$next_ms = self::EOF_POLL_MS;
		} else {
			$next_ms = self::IDLE_POLL_MS;
		}
		$this->set_timer( $next_ms, true );
	}

	/** Drain one line (fgets); emit it, or on EOF send the marker. Returns true if a line was delivered. Overridden by TTY_In_Node for readline. */
	protected function drain_once(): bool {
		$line = \fgets( $this->stream );
		if ( false === $line ) {
			if ( \feof( $this->stream ) ) {
				$this->send_eof();
			}
			return false;
		}
		$this->emit_line( $line );
		return true;
	}

	protected function emit_line( string $line ): void {
		if ( null === $this->sink ) {
			return;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = Node_Names::STDIN;
		$message[ Message::VALUE ] = $line;
		$this->sink->fill( $message );
	}

	/** Stdin closed: emit ONE TM_EOF and arm the self-exit deadline. Idempotent. */
	protected function send_eof(): void {
		if ( $this->eof_sent ) {
			return;
		}
		$this->emit_eof();
		$this->eof_sent        = true;
		$this->eof_deadline_at = Core::right_now() + $this->eof_deadline_s;
	}

	/** Emit the TM_EOF marker to the sink. Overridden by TTY_In_Node to drive the shell. */
	protected function emit_eof(): void {
		if ( null === $this->sink ) {
			return;
		}
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$message[ Message::FROM ] = Node_Names::STDIN;
		$this->sink->fill( $message );
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Hidden',
			'description' => 'Bare stdin source — fgets lines to its sink as TM_BYTESTREAM, TM_EOF on close.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		] );
	}
}
