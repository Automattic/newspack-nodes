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

	// Type flag bits (10 flags; TM_HEARTBEAT/TM_COMPLETION reserved for future).
	public const TM_BYTESTREAM = 1;
	public const TM_EOF        = 2;
	public const TM_PING       = 4;
	public const TM_COMMAND    = 8;
	public const TM_RESPONSE   = 16;
	public const TM_ERROR      = 32;
	public const TM_INFO       = 64;
	public const TM_PERSIST    = 128;
	public const TM_STORABLE   = 256;
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
		return \json_encode(
			[
				'type'      => $message[ self::TYPE ],
				'timestamp' => $message[ self::TIMESTAMP ],
				'from'      => $message[ self::FROM ],
				'to'        => $message[ self::TO ],
				'id'        => $message[ self::ID ],
				'key'       => $message[ self::KEY ],
				'value'     => $message[ self::VALUE ],
			],
			\JSON_UNESCAPED_SLASHES
		);
	}

	public static function unpacked( string $data ): array {
		$decoded = \json_decode( $data, true );
		return [
			self::TYPE      => $decoded['type']      ?? 0,
			self::TIMESTAMP => $decoded['timestamp'] ?? 0.0,
			self::FROM      => $decoded['from']      ?? '',
			self::TO        => $decoded['to']        ?? '',
			self::ID        => $decoded['id']        ?? '',
			self::KEY       => $decoded['key']       ?? '',
			self::VALUE     => $decoded['value']     ?? '',
		];
	}
}
