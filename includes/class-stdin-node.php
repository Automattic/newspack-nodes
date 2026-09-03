<?php
/**
 * Stdin: the bare stdin source — non-blocking `fgets` lines out as TM_BYTESTREAM,
 * one TM_EOF once the stream closes.
 *
 * Reading stdin from inside the drain loop is the point. A blocking
 * `while ( fgets() )` in the caller stalls every timer, Consumer and cURL handle
 * in the same process between keystrokes, so an attached `wp nodes cli` session
 * would render a worker's replies only when the operator happened to press a key.
 * Polling on a timer buys that back and costs a hand-paced cadence instead.
 * `TTY_In_Node` layers readline, completion and prompts on top of this class;
 * nothing here knows about a terminal.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Emits one TM_BYTESTREAM message per line, then a single TM_EOF, then flips
 * `$exit` once the post-EOF deadline passes.
 *
 * The three poll intervals are the design. Draining a busy stream costs nothing,
 * so it comes straight back; an idle terminal must not spin the CPU; a closed one
 * needs only enough ticks to notice its deadline. A session constructs this node
 * in PHP rather than from a topology line — it takes no positional arguments and
 * stays out of the console palette.
 */
class Stdin_Node extends Timer_Node {
	/** Bytes pending: come straight back, because another read costs nothing. */
	private const BUSY_POLL_MS = 0;

	/** Past TM_EOF: fast enough to notice the self-exit deadline promptly. */
	private const EOF_POLL_MS  = 10;

	/** No bytes pending: back off, because an idle terminal must not spin the loop. */
	private const IDLE_POLL_MS = 100;

	/** Drain-until flag the owner polls: `wp nodes cli` drains while this is false. */
	public bool $exit = false;

	/** @var resource The stream lines are read from, set non-blocking in the constructor. */
	public $stream;

	/** Core-clock second at which `$exit` flips; 0.0 until TM_EOF goes out. */
	private float $eof_deadline_at = 0.0;

	/** Grace period in seconds between TM_EOF and the self-exit. */
	private float $eof_deadline_s;

	/** Whether TM_EOF has gone out. The marker is emitted once per stream. */
	private bool $eof_sent = false;

	/**
	 * Take the stream and the grace period that follows its close.
	 *
	 * The stream goes non-blocking, which is what makes one `fgets()` per tick
	 * safe: a blocking read holds the whole drain loop until a line arrives. The
	 * deadline bounds the wait for whatever TM_EOF sets off downstream — the cli
	 * waits for its marker to echo back from the worker, and a worker that has
	 * died would otherwise hang the session for good.
	 *
	 * @param resource|null $stream         Input stream; defaults to STDIN.
	 * @param float         $eof_deadline_s Seconds to wait after stdin closes before flipping `$exit`.
	 */
	public function __construct( $stream = null, float $eof_deadline_s = 5.0 ) {
		parent::__construct();
		$this->stream         = $stream ?? \STDIN;
		$this->eof_deadline_s = $eof_deadline_s;
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		@\stream_set_blocking( $this->stream, false );
	}

	/**
	 * Drain one line through drain_once(), then hold the busy / EOF / idle cadence.
	 *
	 * The timer is RECURRING and re-armed only when the cadence changes, so
	 * nothing here has to re-arm to stay alive. A oneshot self-disarms in
	 * `fire_cb()` before dispatch, and either early return below would then drop
	 * this node out of the event loop for good — no error, no timer, just a node
	 * that stops firing. The cost is that stopping becomes explicit, which is what
	 * the `stop_timer()` calls on the two exit paths are. See
	 * `Timer_Node::set_timer()` for the rule and its other live examples.
	 */
	public function fire(): void {
		if ( $this->eof_sent && Core::$now >= $this->eof_deadline_at ) {
			$this->exit = true;
			$this->stop_timer();
			return;
		}
		$delivered = $this->drain_once();
		if ( $this->exit ) {
			$this->stop_timer();
			return;
		}
		if ( $delivered ) {
			$next_ms = self::BUSY_POLL_MS;
		} elseif ( $this->eof_sent ) {
			$next_ms = self::EOF_POLL_MS;
		} else {
			$next_ms = self::IDLE_POLL_MS;
		}
		if ( $this->interval_ms !== $next_ms ) {
			$this->set_timer( $next_ms );
		}
	}

	/**
	 * Read one line and emit it, or send the EOF marker once the stream is spent.
	 *
	 * A non-blocking `fgets()` returns false both when no line is ready yet and
	 * when the stream has closed, which is why `feof()` decides between them:
	 * treating every false as the end would cut a live terminal off on its first
	 * idle tick. `TTY_In_Node` overrides this to read through readline instead.
	 *
	 * @return bool True when a line was delivered.
	 */
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

	/**
	 * Send one line to the sink as TM_BYTESTREAM, its terminator included.
	 *
	 * FROM carries the reserved `_stdin` name rather than `$this->name`, because a
	 * session leaves its reader unnamed and `stamp_message()` refuses an empty
	 * name. TO stays empty, so the sink — the Shell, in the cli graph — decides
	 * what the line means. A line with no sink to take it is dropped, which keeps
	 * a half-wired graph from throwing on the first keystroke.
	 *
	 * @param string $line One line as `fgets()` returned it.
	 */
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

	/**
	 * Handle the close: emit ONE TM_EOF and arm the self-exit deadline.
	 *
	 * `fire()` keeps polling after EOF, so this is reached on every tick that
	 * follows. The guard is what keeps the marker single and stops the deadline
	 * sliding forward a tick at a time, which would never expire.
	 */
	protected function send_eof(): void {
		if ( $this->eof_sent ) {
			return;
		}
		$this->emit_eof();
		$this->eof_sent        = true;
		$this->eof_deadline_at = Core::right_now() + $this->eof_deadline_s;
	}

	/**
	 * Emit the TM_EOF marker to the sink, stamped `_stdin` like a line.
	 *
	 * What the marker sets off belongs to the sink. In the cli graph the Shell
	 * re-stamps FROM to its own reply path and TO to the cwd, so the interpreter's
	 * TO=FROM bounce lands on `_output`, whose Dumper flips `$exit` — that round
	 * trip is what drains the replies still in flight before the session ends. The
	 * deadline armed alongside covers the worker that never answers.
	 */
	protected function emit_eof(): void {
		if ( null === $this->sink ) {
			return;
		}
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$message[ Message::FROM ] = Node_Names::STDIN;
		$this->sink->fill( $message );
	}

	/**
	 * Schema behind `help Stdin`. `Hidden` keeps it out of the palette scan, since
	 * a session builds this node in PHP; `has_target` is false because a source
	 * fills its sink directly and leaves TO empty for the sink to read.
	 *
	 * @return array<string,mixed>
	 */
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
