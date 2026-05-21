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
	public const TYPE      = 0;
	public const TIMESTAMP = 1;
	public const FROM      = 2;
	public const TO        = 3;
	public const ID        = 4;
	public const KEY       = 5;
	public const VALUE     = 6;

	/** Last addressable VALUE-bearing index; copiers use array_slice(0, LAST_VALUE_INDEX + 1) to drop appended bookkeeping fields. */
	public const LAST_VALUE_INDEX = self::VALUE;

	public const TM_BYTESTREAM = 1;
	public const TM_EOF        = 2;
	public const TM_PING       = 4;
	public const TM_COMMAND    = 8;
	public const TM_RESPONSE   = 16;
	public const TM_ERROR      = 32;
	public const TM_INFO       = 64;
	public const TM_STRUCT     = 256;
	public const TM_REQUEST    = 512;

	public static function new_message(): array {
		return [
			self::TYPE      => 0,
			self::TIMESTAMP => \microtime( true ),
			self::FROM      => '',
			self::TO        => '',
			self::ID        => '',
			self::KEY       => '',
			self::VALUE     => '',
		];
	}

	public static function packed( array $message ): string {
		// Positional JSON: the in-memory message IS the wire representation (no key->index translation).
		return \wp_json_encode( $message, \JSON_UNESCAPED_SLASHES );
	}

	/** Byte size of the whole packed Message; use this (not value_size) for PIPE_BUF / size checks. */
	public static function packed_size( array $message ): int {
		return \strlen( self::packed( $message ) );
	}

	public static function unpacked( string $data ): array {
		$decoded = \json_decode( $data, true );
		if ( \is_array( $decoded ) && \count( $decoded ) == 7 && \array_is_list( $decoded ) ) {
			return $decoded;
		}
		throw new \InvalidArgumentException( 'Message::unpacked(): expected a 7-element positional array' );
	}
}
