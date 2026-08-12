<?php
/**
 * Message: 7-field array shape + type-flag bitmask + helpers.
 *
 * Indices are integers (faster than hash lookup in hot paths); type flags are single bits.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Message {
	/** @ordered */
	public const TYPE      = 0;
	public const TIMESTAMP = 1;
	public const FROM      = 2;
	public const TO        = 3;
	public const ID        = 4;
	public const KEY       = 5;
	public const VALUE     = 6;

	/** Last addressable VALUE-bearing index; copiers use array_slice(0, LAST_VALUE_INDEX + 1) to drop appended bookkeeping fields. */
	public const LAST_VALUE_INDEX = self::VALUE;

	/**
	 * LOCAL: provenance taint appended AFTER the canonical 7 fields. Set only by a
	 * Shell on a command it mints in-process; its presence means "born here".
	 * packed() never emits it, so it cannot cross a process boundary — an
	 * off-process (SSE/IPC) message inherently lacks it. The client-tier
	 * authorization default gates on isset( $message[ LOCAL ] ).
	 */
	public const LOCAL = 7;

	/** @ordered */
	public const TM_BYTESTREAM = 1;
	public const TM_EOF        = 2;
	public const TM_PING       = 4;
	public const TM_COMMAND    = 8;
	public const TM_STRUCT     = 16;
	public const TM_ERROR      = 32;
	public const TM_INFO       = 64;
	public const TM_REQUEST    = 128;
	public const TM_RESPONSE   = 256;
	public const TM_NOREPLY    = 512;

	/**
	 * The mint default: a message that exists but has not been typed yet. A free
	 * HIGH bit, so it matches NO type gate — an untyped message is inert rather
	 * than every type at once (which is what a -1 sentinel would be as a bitmask).
	 * Every minter assigns TYPE and overwrites it; one that reaches a sink still
	 * carrying it is a bug, and the drop audit names it. A naked array (no TYPE)
	 * stays TYPE_UNKNOWN — a different failure, worth telling apart.
	 */
	public const TM_UNTYPED = 1024;

	/**
	 * The ONE flags-to-names map, beside the constants it names. Renderers read
	 * it through type_labels() and supply their own separator and no-match
	 * label; a private copy is how a renderer ends up omitting a flag.
	 *
	 * @var array<int,string>
	 */
	private const TYPE_NAMES = [
		self::TM_BYTESTREAM => 'TM_BYTESTREAM',
		self::TM_EOF        => 'TM_EOF',
		self::TM_PING       => 'TM_PING',
		self::TM_COMMAND    => 'TM_COMMAND',
		self::TM_RESPONSE   => 'TM_RESPONSE',
		self::TM_ERROR      => 'TM_ERROR',
		self::TM_INFO       => 'TM_INFO',
		self::TM_STRUCT     => 'TM_STRUCT',
		self::TM_REQUEST    => 'TM_REQUEST',
		self::TM_NOREPLY    => 'TM_NOREPLY',
		self::TM_UNTYPED    => 'TM_UNTYPED',
	];

	/** Bound a logged/exception excerpt so a huge payload can't flood the log. */
	private const EXCERPT_LENGTH = 200;

	/**
	 * Byte size of the whole packed Message; use this (not value_size) for PIPE_BUF / size checks.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public static function packed_size( array $message ): int {
		return \strlen( self::packed( $message ) );
	}

	/** @param array<int,mixed> $message The 7-field positional message array. */
	public static function packed( array $message ): string {
		// Canonical 7 fields; slicing drops LOCAL, never crosses processes.
		$fields = \array_slice( $message, 0, self::LAST_VALUE_INDEX + 1 );
		// Substitute a bad byte rather than fail the whole encode.
		$flags = \JSON_UNESCAPED_SLASHES | \JSON_INVALID_UTF8_SUBSTITUTE;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode -- hot path; the wrapper is the ?: fallback.
		$json = \json_encode( $fields, $flags ) ?: \wp_json_encode( $fields, $flags );
		if ( false !== $json ) {
			return $json;
		}
		// Residual failure: log loudly, never emit '' (see class docblock).
		$reason = \json_last_error_msg();
		Core::stderr( 'Message::packed(): encode failed: ' . $reason );
		$error_message                 = self::new_message();
		$error_message[ self::TYPE ]   = self::TM_ERROR;
		$error_message[ self::VALUE ]  = 'Message::packed(): ' . $reason;
		return (string) \wp_json_encode( $error_message, \JSON_UNESCAPED_SLASHES );
	}

	/** @return array<int,mixed> The 7-field positional message array. */
	public static function new_message(): array {
		return [
			self::TYPE      => self::TM_UNTYPED,
			// Cached per-tick clock; a warming fresh read outside the drain.
			self::TIMESTAMP => Core::$now ?: Core::right_now(),
			self::FROM      => '',
			self::TO        => '',
			self::ID        => '',
			self::KEY       => '',
			self::VALUE     => '',
		];
	}

	/** @return array<int,mixed> The 7-field positional message array. */
	public static function unpacked( string $data ): array {
		$decoded = \json_decode( $data, true );
		if ( null === $decoded && \JSON_ERROR_NONE !== \json_last_error() ) {
			$reason = 'Message::unpacked(): not valid JSON (' . \json_last_error_msg() . '): ' . self::excerpt( $data );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( $reason );
		}
		if ( \is_array( $decoded ) && 7 === \count( $decoded ) && \array_is_list( $decoded ) ) {
			return $decoded;
		}
		$reason = 'Message::unpacked(): expected a 7-element positional array, got: ' . self::excerpt( $data );
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
		throw new \InvalidArgumentException( $reason );
	}

	/** Bounded excerpt of a raw frame for exception messages — never the whole payload. */
	private static function excerpt( string $data ): string {
		return \strlen( $data ) > self::EXCERPT_LENGTH
			? \substr( $data, 0, self::EXCERPT_LENGTH ) . '…'
			: $data;
	}

	/**
	 * Names of every flag set in $type, in TYPE_NAMES order. Empty when no
	 * known flag matches — the caller names that case (the drop audit says
	 * TYPE_UNKNOWN, the Dumper prints the unmatched bits in hex).
	 *
	 * @return list<string>
	 */
	public static function type_labels( int $type ): array {
		$labels = [];
		foreach ( self::TYPE_NAMES as $flag => $name ) {
			if ( $type & $flag ) {
				$labels[] = $name;
			}
		}
		return $labels;
	}

	/**
	 * Split a slash-delimited path into `[ first_segment, remainder ]` — the
	 * single source of truth for taking the leading path segment (Router
	 * dispatch + HTTP_Filter pid gate). Remainder is `''` when there is no slash.
	 *
	 * @return array{0:string,1:string}
	 */
	public static function split_first( string $path ): array {
		$parts = \explode( '/', $path, 2 );
		return [ $parts[0], $parts[1] ?? '' ];
	}
}
