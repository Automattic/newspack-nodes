<?php
/**
 * JSON_To_Struct: decode a TM_BYTESTREAM JSON line back into a TM_STRUCT array.
 *
 * The read-side inverse of Struct_To_JSON_Node (the Tachikoma JSONtoStorable /
 * StorableToJSON pair): splice one behind the Tail or Consumer reading a log a
 * struct producer wrote, and downstream nodes get the array VALUE back. A line
 * that is not a JSON array or object passes through as a plain bytestream, so a
 * log mixing serialized structs with plain text survives the node intact.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * JSON_To_Struct node — `make_node JSON_To_Struct <name>`. It takes no
 * arguments: the TYPE bitmask and the decoded shape decide everything.
 */
class JSON_To_Struct_Node extends Node {

	/**
	 * Decode a JSON line into an array VALUE and re-type the message.
	 *
	 * Only the BYTESTREAM bit is swapped for STRUCT, so a co-existing flag —
	 * TM_RESPONSE on a Consumer or Job_Worker reply — survives the round trip
	 * Struct_To_JSON started. Assigning the whole TYPE would strip it.
	 *
	 * A non-string VALUE, a TYPE without TM_BYTESTREAM, and a line decoding to
	 * anything but an array all forward untouched. `json_decode` also succeeds
	 * on a bare `42`, but TM_STRUCT promises an array VALUE, so a scalar stays
	 * a bytestream rather than handing downstream nodes a VALUE its own type
	 * flag denies. The `is_int()` guard is what makes the bitwise test safe: a
	 * message is `array<int,mixed>`, and `&` against a string TYPE is a
	 * TypeError.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type  = $message[ Message::TYPE ];
		$value = $message[ Message::VALUE ];
		if ( \is_int( $type ) && ( $type & Message::TM_BYTESTREAM ) && \is_string( $value ) ) {
			$decoded = \json_decode( $value, true );
			if ( \is_array( $decoded ) ) {
				$message[ Message::VALUE ] = $decoded;
				// Swap BYTESTREAM bit for STRUCT; keep other flags.
				$message[ Message::TYPE ] = ( $type & ~Message::TM_BYTESTREAM ) | Message::TM_STRUCT;
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
			'description' => 'Decode a TM_BYTESTREAM JSON line into a TM_STRUCT array VALUE; non-JSON lines pass through unchanged.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
