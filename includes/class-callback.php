<?php
/**
 * Callback: inline closure as a node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Callback extends Node {
	/** @var callable */
	private $cb;

	public function __construct( callable $cb ) {
		$this->cb = $cb;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		( $this->cb )( $message );
	}

	public static function node_schema(): array {
		// Hidden from the topology console: Callback wraps a PHP closure,
		// which can't be expressed in TSL or constructed from the GUI.
		// Application code (e.g. event-logger-nodes) still uses it
		// programmatically; we just don't surface it as a buildable
		// palette entry.
		return [
			'category'    => 'Hidden',
			'description' => 'Inline PHP closure as a node — invokes a callable on each message.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
