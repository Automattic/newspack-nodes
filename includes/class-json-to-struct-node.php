<?php
/**
 * JSON_To_Struct: decode a TM_BYTESTREAM JSON line back into a TM_STRUCT array.
 *
 * The inverse of Struct_To_JSON_Node (the Tachikoma JSONtoStorable /
 * StorableToJSON pair): on the read side, reconstruct the struct a producer
 * serialized so downstream consumers get the array VALUE back. A line that
 * isn't a JSON array/object passes through as a plain bytestream.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class JSON_To_Struct_Node extends Node {

	public function fill( array $message ): void {
		$type  = $message[ Message::TYPE ];
		$value = $message[ Message::VALUE ];
		if ( \is_int( $type ) && ( $type & Message::TM_BYTESTREAM ) && \is_string( $value ) ) {
			$decoded = \json_decode( $value, true );
			if ( \is_array( $decoded ) ) {
				$message[ Message::VALUE ] = $decoded;
				// Swap only the BYTESTREAM bit for STRUCT; preserve co-existing flags (e.g. TM_RESPONSE).
				$message[ Message::TYPE ] = ( $type & ~Message::TM_BYTESTREAM ) | Message::TM_STRUCT;
			}
		}
		parent::fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Transform',
			'description' => 'Decode a TM_BYTESTREAM JSON line into a TM_STRUCT array VALUE; non-JSON lines pass through unchanged.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
