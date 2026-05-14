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
		return [
			'category'    => 'Transform',
			'description' => 'Inline PHP closure as a node — invokes a callable on each message.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
