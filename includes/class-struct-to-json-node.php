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

/**
 * Struct_To_JSON node — `make_node Struct_To_JSON <name>`. It takes no
 * arguments: the TYPE bitmask and the VALUE's own type decide everything.
 */
class Struct_To_JSON_Node extends Node {

	/**
	 * Serialize a struct VALUE into a JSON line and re-type the message.
	 *
	 * Only the STRUCT bit is swapped for BYTESTREAM, so a co-existing flag —
	 * TM_RESPONSE on a Consumer or Job_Worker reply — survives the round trip
	 * JSON_To_Struct closes. Assigning the whole TYPE would strip it.
	 *
	 * A VALUE that is already a string forwards verbatim rather than being
	 * JSON-quoted: quoting it would hand the read side a JSON string where
	 * TM_STRUCT promises an array. Anything else goes through
	 * `wp_json_encode`, which returns false on invalid UTF-8 or a structure
	 * past its depth limit. That failure leaves VALUE and TYPE alone, so the
	 * struct reaches the sink intact instead of a bytestream carrying `false`.
	 * JSON_UNESCAPED_SLASHES keeps URLs and paths legible in the line, and
	 * `json_decode` reads either form, so the round trip is unaffected.
	 *
	 * The VALUE ends in exactly one newline — the record terminator a Log
	 * expects its producer to supply, so each struct lands as its own line. A
	 * TYPE without TM_STRUCT forwards untouched, and the `is_int()` guard is
	 * what makes the bitwise test safe: a message is `array<int,mixed>`, and
	 * `&` against a string TYPE is a TypeError.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
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

	/**
	 * Topology console manifest: a Transform with no arguments and no verbs.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Transform',
			'description' => 'Serialize a TM_STRUCT array VALUE into a TM_BYTESTREAM JSON line; other messages pass through unchanged.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
