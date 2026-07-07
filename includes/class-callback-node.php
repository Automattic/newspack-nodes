<?php
/**
 * Callback: inline closure as a node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Callback_Node extends Node {

	/** @var callable */
	private $cb;

	public function __construct( callable $cb ) {
		parent::__construct();
		$this->cb = $cb;
	}

	public function fill( array $message ): void {
		++$this->counter;
		( $this->cb )( $message );
	}

	public static function node_schema(): array {
		// Hidden: a PHP closure can't be expressed in TSL or built from the GUI (still used programmatically).
		return [
			'category'    => 'Hidden',
			'description' => 'Inline PHP closure as a node — invokes a callable on each message.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
