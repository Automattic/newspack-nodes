<?php
/**
 * Message: 7-field array shape + type-flag bitmask + helpers.
 *
 * Per spec section "Message Format". Indices are integers (faster than hash
 * lookup in hot paths); type flags are single-bit values for bitwise composition.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Message {
	// Field indices.
	public const TYPE      = 0;
	public const TIMESTAMP = 1;
	public const FROM      = 2;
	public const TO        = 3;
	public const ID        = 4;
	public const KEY       = 5;
	public const VALUE     = 6;

	/**
	 * Last addressable VALUE-bearing index. Code that copies messages should use
	 * `array_slice(0, LAST_VALUE_INDEX + 1)` to drop any internal bookkeeping
	 * fields appended by callers. Per spec line 770.
	 */
	public const LAST_VALUE_INDEX = self::VALUE;

	// Type flag bits.
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
		// Positional JSON: indexed array, no key strings on the wire. Field
		// constants TYPE..VALUE = 0..6 so the in-memory message IS the wire
		// representation — no key->index translation per side.
		return \wp_json_encode( $message, \JSON_UNESCAPED_SLASHES );
	}

	public static function unpacked( string $data ): array {
		$decoded = \json_decode( $data, true );
		if ( \is_array( $decoded ) && \count( $decoded ) >= 7 && \array_is_list( $decoded ) ) {
			return $decoded;
		}
		return self::new_message();
	}
}
