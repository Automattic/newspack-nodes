<?php
/**
 * Dumper: terminal output node for the REPL.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Dumper_Node extends Node {

	private ?Shell_Node $shell = null;

	public function fill( array $message ): void {
		// Drop messages addressed to a different cli session; empty TO always renders.
		if ( '' !== $this->to_filter ) {
			$to = self::coerce_string( $message[ Message::TO ] );
			if ( '' !== $to
				&& ! \preg_match( '/^(?:_output\/)?' . \preg_quote( $this->to_filter, '/' ) . '$/', $to )
			) {
				return;
			}
		}

		// Tab-completion replies are consumed before render — they feed the cli's
		// candidate cache, not the terminal.
		if ( null !== $this->completion_sink && ( $this->completion_sink )( $message ) ) {
			return;
		}

		$type = self::coerce_int( $message[ Message::TYPE ] );

		if ( $this->debug_level >= 2 ) {
			$this->emit( $this->format_envelope_dump( $message ) );
			return;
		}
		if ( $this->debug_level >= 1 ) {
			$flags = self::format_type_flags( $type );
			$from  = self::coerce_string( $message[ Message::FROM ] ?? '' );
			$this->emit( $flags . ' from ' . $from . ':' );
		}

		// TM_EOF: drain marker — fire the callback, render nothing.
		if ( $type & Message::TM_EOF ) {
			if ( null !== $this->on_eof ) {
				( $this->on_eof )();
			}
			return;
		}

		if ( $type & Message::TM_COMMAND ) {
			if ( $type & Message::TM_RESPONSE ) {
				$cmd = $message[ Message::VALUE ];
				if ( \is_array( $cmd ) ) {
					$name    = self::coerce_string( $cmd['name'] ?? '' );
					$payload = self::render_payload( $cmd['payload'] ?? '' );

					if ( 'prompt' === $name && null !== $this->shell ) {
						$this->shell->prompt = $payload;
						return;
					}

					$this->emit( $payload );
					return;
				}
			} elseif ( $type & Message::TM_ERROR ) {
				$cmd     = $message[ Message::VALUE ];
				$payload = \is_array( $cmd ) ? self::render_payload( $cmd['payload'] ?? '' ) : self::coerce_string( $cmd );
				$this->emit( $payload );
				return;
			}
		}

		// TM_PING: bounced reply; VALUE is the send timestamp, render as RTT.
		if ( $type & Message::TM_PING ) {
			$sent = self::coerce_float( $message[ Message::VALUE ] );
			$rtt  = ( Core::$now - $sent ) * 1000.0;
			$this->emit( \sprintf( 'round trip time: %.2f ms', $rtt ) );
			return;
		}

		if ( $type & Message::TM_STRUCT || $type & Message::TM_COMMAND ) {
			$value = $message[ Message::VALUE ];
			$line  = \is_string( $value ) ? $value : \wp_json_encode( $value, JSON_UNESCAPED_SLASHES );
			$this->emit( (string) $line );
			return;
		}

		$this->emit( self::coerce_string( $message[ Message::VALUE ] ) );
	}

	public function set_shell( Shell_Node $shell ): void {
		$this->shell = $shell;
	}

	/**
	 * Forward one rendered line to the terminal as a fresh TM_BYTESTREAM.
	 *
	 * Mints a NEW message (TO='') so Node::fill() stamps TO=$this->target
	 * (_stdout) — the inbound reply's TO=_output/$pid never leaks here.
	 *
	 * NB: parent::fill() is what bumps $this->counter — so counter tracks lines
	 * emitted (a debug_level>=1 message emits two), not inbound messages.
	 */
	private function emit( string $text ): void {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $text;
		parent::fill( $message );
	}

	/** Multi-session TO filter (this cli's $pid); render only matching or empty-TO messages. */
	private string $to_filter = '';

	/**
	 * Fired when a TM_EOF echo matching to_filter arrives (stdin-close drain marker).
	 *
	 * @var callable|null
	 */
	private $on_eof = null;

	public function on_eof( ?callable $cb ): void {
		$this->on_eof = $cb;
	}

	/**
	 * Tab-completion intercept. Gets first crack at every inbound message; if it
	 * returns true the message is consumed (a completion reply) and rendered as
	 * nothing. Null → no interception.
	 *
	 * Signature: `function ( array $message ): bool` (true = consumed).
	 *
	 * @var callable|null
	 */
	private $completion_sink = null;

	public function set_completion_sink( ?callable $cb ): void {
		$this->completion_sink = $cb;
	}

	public function set_to_filter( string $pid ): void {
		$this->to_filter = $pid;
	}

	/**
	 * Render-verbosity dial: 0 = curated, 1 = + per-message header, 2 = + full envelope dump.
	 *
	 * @var int 0, 1, or 2.
	 */
	private int $debug_level = 0;

	/**
	 * Set the debug-render level (clamped to [0, 2]); returns the applied value.
	 */
	public function set_debug_level( int $level ): int {
		$this->debug_level = \max( 0, \min( 2, $level ) );
		return $this->debug_level;
	}

	public function debug_level(): int {
		return $this->debug_level;
	}

	/**
	 * Coerce a mixed Message field to string, reproducing PHP's `(string)` cast
	 * (null→'', scalar→its string form, array→'Array') without a mixed-cast.
	 *
	 * @param mixed $v Raw Message field.
	 */
	private static function coerce_string( $v ): string {
		if ( \is_string( $v ) ) {
			return $v;
		}
		if ( null === $v ) {
			return '';
		}
		if ( \is_array( $v ) ) {
			return 'Array';
		}
		if ( \is_object( $v ) ) {
			return $v instanceof \Stringable ? (string) $v : '';
		}
		if ( \is_scalar( $v ) ) {
			return (string) $v;
		}
		return '';
	}

	/**
	 * Coerce a mixed Message field to float, reproducing PHP's `(float)` cast
	 * (null→0.0, scalar→its float form, non-empty array→1.0) without a mixed-cast.
	 *
	 * @param mixed $v Raw Message field.
	 */
	private static function coerce_float( $v ): float {
		if ( null === $v ) {
			return 0.0;
		}
		if ( \is_array( $v ) ) {
			return empty( $v ) ? 0.0 : 1.0;
		}
		if ( \is_object( $v ) ) {
			return 1.0;
		}
		if ( \is_scalar( $v ) ) {
			return (float) $v;
		}
		return 0.0;
	}

	/**
	 * Coerce a mixed Message field to int, reproducing PHP's `(int)` cast
	 * (null→0, scalar→its int form, non-empty array→1) without a mixed-cast.
	 *
	 * @param mixed $v Raw Message field.
	 */
	private static function coerce_int( $v ): int {
		if ( null === $v ) {
			return 0;
		}
		if ( \is_array( $v ) ) {
			return empty( $v ) ? 0 : 1;
		}
		if ( \is_object( $v ) ) {
			return 1;
		}
		if ( \is_scalar( $v ) ) {
			return (int) $v;
		}
		return 0;
	}

	/**
	 * Render a TM-flag bitmask as a human-readable string (multi-flag types concatenated).
	 */
	private static function format_type_flags( int $type ): string {
		/** @var array<int, string> $map */
		static $map = [
			Message::TM_BYTESTREAM => 'TM_BYTESTREAM',
			Message::TM_EOF        => 'TM_EOF',
			Message::TM_PING       => 'TM_PING',
			Message::TM_COMMAND    => 'TM_COMMAND',
			Message::TM_RESPONSE   => 'TM_RESPONSE',
			Message::TM_ERROR      => 'TM_ERROR',
			Message::TM_INFO       => 'TM_INFO',
			Message::TM_STRUCT     => 'TM_STRUCT',
			Message::TM_REQUEST    => 'TM_REQUEST',
		];
		$flags = [];
		foreach ( $map as $flag => $name ) {
			if ( $type & $flag ) {
				$flags[] = $name;
			}
		}
		return $flags ? \implode( ' | ', $flags ) : \sprintf( 'TM_UNKNOWN(0x%x)', $type );
	}

	/**
	 * Level-2 dump: full envelope as a structural multi-line render.
	 *
	 * @param array<int, mixed> $message The Message to render.
	 */
	private function format_envelope_dump( array $message ): string {
		$type      = self::coerce_int( $message[ Message::TYPE ] ?? 0 );
		$flags     = self::format_type_flags( $type );
		$ts        = self::coerce_string( $message[ Message::TIMESTAMP ] ?? '' );
		$ts_human  = '' !== $ts && \is_numeric( $ts )
			? \gmdate( 'Y-m-d H:i:s', (int) $ts ) . ' UTC'
			: '';
		$value     = self::stringify_value( $message[ Message::VALUE ] ?? '', true );

		$lines = [
			'Message {',
			'    type:      ' . $flags,
			'    from:      ' . self::coerce_string( $message[ Message::FROM ] ?? '' ),
			'    to:        ' . self::coerce_string( $message[ Message::TO ] ?? '' ),
			'    id:        ' . self::coerce_string( $message[ Message::ID ] ?? '' ),
			'    key:       ' . self::coerce_string( $message[ Message::KEY ] ?? '' ),
			'    timestamp: ' . $ts . ( '' !== $ts_human ? ' (' . $ts_human . ')' : '' ),
			'    value:     ' . self::indent_following_lines( $value, '               ' ),
			'}',
		];
		return \implode( "\n", $lines );
	}

	/**
	 * Render a command-response `payload` for terminal display (arrays → pretty JSON).
	 *
	 * @param mixed $payload The `payload` field of a response VALUE.
	 */
	private static function render_payload( $payload ): string {
		if ( \is_array( $payload ) ) {
			return (string) \wp_json_encode( $payload, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES );
		}
		return self::coerce_string( $payload );
	}

	/**
	 * Stringify a Message::VALUE for the level-2 envelope dump (arrays/JSON-strings → JSON).
	 *
	 * @param mixed $value      Raw VALUE.
	 * @param bool  $structured Whether to use JSON_PRETTY_PRINT for arrays.
	 */
	private static function stringify_value( $value, bool $structured ): string {
		if ( \is_array( $value ) ) {
			$flags = JSON_UNESCAPED_SLASHES;
			if ( $structured ) {
				$flags |= JSON_PRETTY_PRINT;
			}
			return (string) \wp_json_encode( $value, $flags );
		}
		if ( \is_string( $value ) && '' !== $value && ( '{' === $value[0] || '[' === $value[0] ) ) {
			$decoded = \json_decode( $value, true );
			if ( \is_array( $decoded ) ) {
				$flags = JSON_UNESCAPED_SLASHES;
				if ( $structured ) {
					$flags |= JSON_PRETTY_PRINT;
				}
				return (string) \wp_json_encode( $decoded, $flags );
			}
		}
		return self::coerce_string( $value );
	}

	/**
	 * Indent every line after the first by $prefix.
	 */
	private static function indent_following_lines( string $text, string $prefix ): string {
		$lines = \explode( "\n", $text );
		if ( \count( $lines ) <= 1 ) {
			return $text;
		}
		return $lines[0] . "\n" . \implode( "\n", \array_map( static fn ( $l ) => $prefix . $l, \array_slice( $lines, 1 ) ) );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'REPL output — printed to stream, not user-placeable in topology graphs.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}
