<?php
/**
 * Tee: fan-out to multiple targets via Router.
 *
 * Overrides Node's single-target connect_node to append to an array.
 * Dispatch sets TO per target and forwards through sink (typically _router).
 * Per-target try/catch isolates failures.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tee extends Node {
	public function __construct() {
		$this->target = [];
	}

	public function connect_node( string $target ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = '' !== $this->target ? [ $this->target ] : [];
		}
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
			// Durable state: which targets does this Tee fan out to? Cached
			// so late subscribers (debug_state) see the current target list
			// without replaying every connect/disconnect.
			$this->set_state( 'TARGETS', $this->target );
		}
	}

	public function disconnect_node( string $target = '' ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = [];
			return;
		}
		$before       = $this->target;
		$this->target = \array_values( \array_filter( $this->target, fn ( $t ) => $t !== $target ) );
		if ( $before !== $this->target ) {
			$this->set_state( 'TARGETS', $this->target );
		}
	}

	public function fill( array &$message ): void {
		++$this->counter;

		// Snapshot live targets. A target that's a bare node name
		// (no slash) gets pruned if the node disappeared since the
		// last connect — keeps the array clean across remove_node
		// churn. A path-shaped target (has a slash, e.g.
		// `_repl/_output/12345`) is routed by the sink, not looked up
		// here; we hand it through as-is. Without that distinction
		// the Tee would silently drop tail targets the cli/SSE adds
		// via `connect_node <tee>` (default = $message[FROM]).
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive   = [];
		foreach ( $targets as $t ) {
			if ( false !== \strpos( $t, '/' ) || Core::node( $t ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		foreach ( $alive as $t ) {
			try {
				$copy                = $message;
				$copy[ Message::TO ] = $t;
				$this->sink?->fill( $copy );
			} catch ( \Throwable $e ) {
				Core::print_less_often( "Tee {$this->name}: target $t threw: " . $e->getMessage() );
			}
		}
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Fan-out: copies each message to multiple targets via Router.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
