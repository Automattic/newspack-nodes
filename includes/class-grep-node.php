<?php
/**
 * Grep: payload filter. Forwards a message only when its VALUE matches the regex; drops the rest. Ported from Tachikoma's Grep.pm.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Grep_Node extends Node {

	/** Bracket-delimited PCRE (mirrors Grep.pm's qr{}); default matches everything. */
	private string $pattern = '{.}';

	public function arguments( ?string $args = null ): string {
		if ( null !== $args ) {
			$this->arguments = $args;
			$pattern         = '' !== $args ? $args : '.';
			$this->pattern   = '{' . $pattern . '}';
		}
		return $this->arguments;
	}

	public function fill( array $message ): void {
		$value   = $message[ Message::VALUE ];
		$subject = \is_string( $value ) ? $value : (string) \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES );
		if ( 1 === \preg_match( $this->pattern, $subject ) ) {
			parent::fill( $message );
		}
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Filtering',
			'description' => 'Forwards a message only when its VALUE matches a regex; drops the rest.',
			'arguments'   => [
				[ 'name' => 'pattern', 'type' => 'string', 'default' => '.' ],
			],
		] );
	}
}
