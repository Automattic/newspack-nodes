<?php
/**
 * Hook: WordPress action/filter as a node.
 *
 * Action mode: do_action($hook, $message) then forward unchanged to sink.
 * Filter mode: apply_filters($hook, $message) and forward result to sink.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Hook extends Node {
	private string $hook_name;
	private bool $filter;

	public function __construct( string $hook_name, bool $filter = false ) {
		$this->hook_name = $hook_name;
		$this->filter    = $filter;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		if ( $this->filter ) {
			$message = \apply_filters( $this->hook_name, $message );
		} else {
			\do_action( $this->hook_name, $message );
		}
		$this->sink?->fill( $message );
	}
}
