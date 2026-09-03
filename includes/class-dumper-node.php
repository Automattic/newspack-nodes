<?php
/**
 * Dumper: renders any message to a human-readable text line (TM_BYTESTREAM) and
 * forwards it to its target. The cli wires it as `_output` (rendering to
 * `_stdout`), but it's a placeable Transform node — the lossy, display-oriented
 * counterpart to the lossless Struct_To_JSON / JSON_To_Struct pair.
 *
 * The render is one-way: a command response becomes its `payload`, a TM_PING
 * becomes a round-trip time, and the envelope is gone. Splice in Struct_To_JSON
 * instead wherever something downstream has to read the message back.
 *
 * Four behaviors belong to `wp nodes cli` and lie dormant in a graph that wires
 * none of them: the completion intercept, the per-session TO filter, the EOF
 * drain callback, and the `prompt` response that writes the Shell's prompt.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Dumper_Node extends Node {

	/**
	 * Highest debug-render level. `Shell_Node`'s `debug_level` builtin refuses
	 * anything above it, `set_debug_level()` clamps to it, and
	 * `src/runtime/dumper-node.js` mirrors the value for the browser REPL.
	 */
	public const MAX_DEBUG_LEVEL = 2;

	/**
	 * Tab-completion intercept, wired by `wp nodes cli` in readline mode. It gets
	 * first crack at every inbound message, and returning true consumes that
	 * message: a completion reply feeds the reader's candidate cache instead of
	 * the terminal. Null leaves every message to the render below.
	 *
	 * Signature: `function ( array $message ): bool`, true when consumed.
	 *
	 * @var callable|null
	 */
	private $completion_sink = null;

	/**
	 * Render-verbosity dial. Level 0 emits the curated line alone. Level 1
	 * prefixes a `<FLAGS> from <FROM>:` header and still emits that line. Level 2
	 * emits the whole envelope INSTEAD of it, because the envelope already
	 * carries the VALUE and rendering both prints the payload twice.
	 */
	private int $debug_level = 0;

	/**
	 * Fired when the TM_EOF this session sent on stdin close comes back — the
	 * drain marker saying every reply queued ahead of it has been rendered. The
	 * cli flips its exit flag from here, so a piped script ends on the echo
	 * rather than on the reader's five-second deadline.
	 *
	 * Signature: `function (): void`.
	 *
	 * @var callable|null
	 */
	private $on_eof = null;

	/**
	 * The REPL front-end that owns this Dumper. A `prompt` response writes
	 * `$shell->prompt`, and `$shell->path` is the attachment `prompt_is_trusted()`
	 * weighs a sender against. Null in a graph that wires no Shell, which leaves
	 * both paths dead.
	 */
	private ?Shell_Node $shell = null;

	/**
	 * This cli session's pid. Every attached session tails the SAME worker output
	 * partition, so another session's replies arrive here too; only a TO naming
	 * this pid, or an empty TO (an unaddressed broadcast), renders.
	 */
	private string $to_filter = '';

	/**
	 * Render one inbound message, in the order the cascade has to run: drop
	 * another session's reply, let the completion intercept take its own
	 * traffic, emit the debug header, fire the EOF drain callback, then render
	 * by type.
	 *
	 * The EOF callback fires ahead of either early return, so the drain marker
	 * reaches the cli at every verbosity. A level that swallowed it would leave
	 * the session waiting out the reader's deadline instead.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		// Drop messages addressed to a different cli session; empty TO renders.
		if ( '' !== $this->to_filter ) {
			$to = Core::as_string( $message[ Message::TO ] );
			if ( '' !== $to
				&& ! \preg_match( '/^(?:_output\/)?' . \preg_quote( $this->to_filter, '/' ) . '$/', $to )
			) {
				return;
			}
		}

		// Tab-completion replies feed cli's candidate cache, not terminal.
		if ( null !== $this->completion_sink && ( $this->completion_sink )( $message ) ) {
			return;
		}

		$type = Core::as_int( $message[ Message::TYPE ] );

		if ( $this->debug_level >= 2 ) {
			$this->emit( $this->format_envelope_dump( $message ) );
		} elseif ( $this->debug_level >= 1 ) {
			$flags = self::format_type_flags( $type );
			$from  = Core::as_string( $message[ Message::FROM ] ?? '' );
			$this->emit( $flags . ' from ' . $from . ":\n" );
		}

		// TM_EOF: drain marker — fire the callback, render nothing.
		if ( $type & Message::TM_EOF ) {
			if ( null !== $this->on_eof ) {
				( $this->on_eof )();
			}
			return;
		}

		// A full envelope dump stands in for the curated render below.
		if ( $this->debug_level >= 2 ) {
			return;
		}

		if ( $type & Message::TM_COMMAND ) {
			if ( $type & Message::TM_RESPONSE ) {
				$cmd = $message[ Message::VALUE ];
				if ( \is_array( $cmd ) ) {
					$name    = Core::as_string( $cmd['name'] ?? '' );
					$payload = self::render_payload( $cmd['payload'] ?? '' );

					if ( 'prompt' === $name && null !== $this->shell
							&& $this->prompt_is_trusted( $message ) ) {
						$this->shell->prompt = $payload;
						return;
					}

					$this->emit( $payload );
					return;
				}
			} elseif ( $type & Message::TM_ERROR ) {
				$cmd     = $message[ Message::VALUE ];
				$payload = \is_array( $cmd ) ? self::render_payload( $cmd['payload'] ?? '' ) : Core::as_string( $cmd );
				$this->emit( $payload );
				return;
			}
		}

		// TM_PING: bounced reply; VALUE is the send timestamp, render as RTT.
		if ( $type & Message::TM_PING ) {
			$sent = Core::num_float( $message[ Message::VALUE ] );
			$rtt  = ( Core::$now - $sent ) * 1000.0;
			$this->emit( \sprintf( "round trip time: %.2f ms\n", $rtt ) );
			return;
		}

		if ( $type & Message::TM_STRUCT || $type & Message::TM_COMMAND ) {
			$value = $message[ Message::VALUE ];
			$line  = \is_string( $value ) ? $value : self::stringify_value( $value );
			$this->emit( $line );
			return;
		}

		$this->emit( Core::as_string( $message[ Message::VALUE ] ) );
	}

	/**
	 * Forward one rendered line to the terminal as a fresh TM_BYTESTREAM.
	 *
	 * Minting a new message leaves TO empty, which is what lets `Node::fill()`
	 * stamp TO from `$this->target` (`_stdout`); forwarding the inbound message
	 * would carry its TO of `_output/<pid>` past this node.
	 *
	 * `parent::fill()` also bumps `$this->counter`, so the counter `ls -c` prints
	 * tracks lines EMITTED rather than messages received — one message at debug
	 * level 1 emits two.
	 *
	 * @param string $text The rendered text. A newline belongs in it; none is appended.
	 */
	private function emit( string $text ): void {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $text;
		parent::fill( $message );
	}

	/**
	 * The level-2 dump: the whole envelope as a multi-line `Message { … }` block,
	 * one field per line in canonical field order.
	 *
	 * `formatMessageEnvelope()` in `src/runtime/dumper-node.js` renders the same
	 * block field for field, so one message reads identically in the terminal and
	 * in the browser console. Change the shape here and change it there too.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	private function format_envelope_dump( array $message ): string {
		$type     = Core::as_int( $message[ Message::TYPE ] ?? 0 );
		$flags    = self::format_type_flags( $type );
		$ts       = Core::as_string( $message[ Message::TIMESTAMP ] ?? '' );
		$ts_human = '' !== $ts && \is_numeric( $ts )
			? \gmdate( 'Y-m-d H:i:s', (int) $ts ) . ' UTC'
			: '';
		// Trim the value's trailing newline (else a blank line precedes `}`).
		$value    = \rtrim( self::stringify_value( $message[ Message::VALUE ] ?? '' ), "\n" );

		$lines = [
			'Message {',
			'    type:      ' . $flags,
			'    timestamp: ' . $ts . ( '' !== $ts_human ? ' (' . $ts_human . ')' : '' ),
			'    from:      ' . Core::as_string( $message[ Message::FROM ] ?? '' ),
			'    to:        ' . Core::as_string( $message[ Message::TO ] ?? '' ),
			'    id:        ' . Core::as_string( $message[ Message::ID ] ?? '' ),
			'    key:       ' . Core::as_string( $message[ Message::KEY ] ?? '' ),
			'    value:     ' . self::indent_following_lines( $value, '               ' ),
			'}',
		];
		return \implode( "\n", $lines ) . "\n";
	}

	/**
	 * Render a TM-flag bitmask for display, naming the unmatched bits in hex.
	 * Public because the dead-letter `dl_show` verb renders through it too. The
	 * names come from `Message::type_labels()`, the one flags-to-names map.
	 *
	 * @param int $type The TYPE bitmask.
	 */
	public static function format_type_flags( int $type ): string {
		$flags = Message::type_labels( $type );
		return $flags ? \implode( ' | ', $flags ) : \sprintf( 'TM_UNKNOWN(0x%x)', $type );
	}

	/**
	 * Stringify a `Message::VALUE` for display. A VALUE that already holds a JSON
	 * object or array is decoded first, so the dump pretty-prints its structure
	 * instead of one long escaped line.
	 *
	 * @param mixed $value The raw VALUE.
	 */
	private static function stringify_value( $value ): string {
		if ( \is_string( $value ) && '' !== $value && ( '{' === $value[0] || '[' === $value[0] ) ) {
			$value = \json_decode( $value, true );
		}
		return self::render_payload( $value );
	}

	/**
	 * Render a command-response `payload` for terminal display. An array becomes
	 * pretty JSON carrying a trailing newline, so the next prompt starts on its
	 * own line; a scalar passes through as it is.
	 *
	 * @param mixed $payload The `payload` field of a response VALUE.
	 */
	private static function render_payload( $payload ): string {
		if ( \is_array( $payload ) ) {
			return (string) \wp_json_encode( $payload, \JSON_UNESCAPED_SLASHES | \JSON_PRETTY_PRINT ) . "\n";
		}
		return Core::as_string( $payload );
	}

	/**
	 * Indent every line after the first by `$prefix`, so a multi-line VALUE stays
	 * aligned under the envelope dump's `value:` label.
	 *
	 * @param string $text   The rendered value.
	 * @param string $prefix The indent applied to the second line and on.
	 */
	private static function indent_following_lines( string $text, string $prefix ): string {
		$lines = \explode( "\n", $text );
		if ( \count( $lines ) <= 1 ) {
			return $text;
		}
		return $lines[0] . "\n" . \implode( "\n", \array_map( static fn ( $l ) => $prefix . $l, \array_slice( $lines, 1 ) ) );
	}

	/**
	 * Whether a `prompt` response may set the shell's prompt.
	 *
	 * `prompt` is the one response that mutates state rather than rendering, so
	 * it is the one worth spoofing: a peer that repoints the prompt makes the
	 * operator believe they are attached elsewhere and type the next command
	 * there. FROM is X-Forwarded-For — the IPC Consumer stamps the worker id at
	 * the HEAD and everything after it is whatever the worker wrote, so only the
	 * head is ours to trust. Bare mode has no remote peer feeding this Dumper.
	 *
	 * @param array<int,mixed> $message The response Message.
	 * @return bool True when the sender may write the prompt.
	 */
	private function prompt_is_trusted( array $message ): bool {
		if ( null === $this->shell ) {
			return false;
		}
		$attached = $this->shell->path;
		if ( '' === $attached ) {
			return true;
		}
		$from = Core::as_string( $message[ Message::FROM ] );
		$head = \strtok( $from, '/' );
		return $attached === $head;
	}

	/** Give the Dumper the REPL front-end whose prompt a `prompt` response may write. */
	public function set_shell( Shell_Node $shell ): void {
		$this->shell = $shell;
	}

	/**
	 * Wire the stdin-close drain callback; null clears it.
	 *
	 * @param callable|null $cb `function (): void`, fired on the TM_EOF echo.
	 */
	public function on_eof( ?callable $cb ): void {
		$this->on_eof = $cb;
	}

	/**
	 * Wire the tab-completion intercept; null clears it.
	 *
	 * @param callable|null $cb `function ( array $message ): bool`, true when it consumed the message.
	 */
	public function set_completion_sink( ?callable $cb ): void {
		$this->completion_sink = $cb;
	}

	/**
	 * Confine rendering to one cli session. An empty pid renders everything.
	 *
	 * @param string $pid This session's pid, the tail of the `_output/<pid>` the Shell stamps into FROM.
	 */
	public function set_to_filter( string $pid ): void {
		$this->to_filter = $pid;
	}

	/**
	 * Set the debug-render level, clamped to `[0, MAX_DEBUG_LEVEL]`. The applied
	 * value comes back because the Shell echoes it: the operator reads the level
	 * that took effect, not the one requested.
	 *
	 * @param int $level The requested level.
	 * @return int The level now in force.
	 */
	public function set_debug_level( int $level ): int {
		$this->debug_level = \max( 0, \min( self::MAX_DEBUG_LEVEL, $level ) );
		return $this->debug_level;
	}

	/** The level in force. The Shell's `debug_level` builtin reads it to toggle. */
	public function debug_level(): int {
		return $this->debug_level;
	}

	/** @return array<string,mixed> */
	public static function node_schema(): array {
		return [
			'category'    => 'Transform',
			'description' => 'Render any message to a human-readable text line (TM_BYTESTREAM) and forward it — the lossy display counterpart to the Struct_To_JSON / JSON_To_Struct pair.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => true,
		];
	}
}
