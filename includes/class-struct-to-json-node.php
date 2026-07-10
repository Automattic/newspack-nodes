<?php
/**
 * Struct_To_JSON: serialize a TM_STRUCT message into a TM_BYTESTREAM JSON line.
 *
 * The lossless, round-trippable counterpart to JSON_To_Struct_Node (the
 * Tachikoma StorableToJSON / JSONtoStorable pair): splice one in front of a Log
 * or terminal so a TM_STRUCT producer's array VALUE can be written as a line,
 * and its inverse back to reconstruct the struct on the read side.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Struct_To_JSON_Node extends Node {

	public function fill( array $message ): void {
		$type = $message[ Message::TYPE ];
		if ( \is_int( $type ) && ( $type & Message::TM_STRUCT ) ) {
			$value = $message[ Message::VALUE ];
			// Adopt only a string; failed encode (false) keeps the struct.
			$encoded = \is_string( $value ) ? $value : \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES );
			if ( \is_string( $encoded ) ) {
				$message[ Message::VALUE ] = \rtrim( $encoded, "\n" ) . "\n";
				// Swap STRUCT bit for BYTESTREAM; keep other flags.
				$message[ Message::TYPE ] = ( $type & ~Message::TM_STRUCT ) | Message::TM_BYTESTREAM;
			}
		}
		parent::fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Transform',
			'description' => 'Serialize a TM_STRUCT array VALUE into a TM_BYTESTREAM JSON line; other messages pass through unchanged.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
