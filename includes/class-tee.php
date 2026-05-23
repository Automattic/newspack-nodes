<?php
/**
 * Tee: fan-out to multiple targets via Router. Per-target try/catch isolates failures.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tee_Node extends Node {
	public function __construct() {
		$this->target = [];
	}

	public function connect_node( string $target ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = '' !== $this->target ? [ $this->target ] : [];
		}
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
			// Cached so late subscribers (debug_state) see the current target list.
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

		$type = $message[ Message::TYPE ];
		if ( $type & Message::TM_REQUEST ) {
			$this->handle_request( $message );
			return;
		}

		// Prune dead bare-name targets; pass path-shaped targets (with a slash) through as-is for the sink to route.
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
				// log_midfix prepends the node name; keep only the class label here.
				$this->print_less_often( "Tee: target $t threw: " . $e->getMessage() );
			}
		}
	}

	private function handle_request( array $message ): void {
		$value   = (string) $message[ Message::VALUE ];
		$verb    = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );
		$targets = \is_array( $this->target ) ? \array_values( $this->target ) : [];
		$payload = 'GET_TARGETS' === $verb
			? [ 'count' => \count( $targets ), 'targets' => $targets ]
			: [ 'error' => "unknown request verb: {$verb}" ];

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$this->sink?->fill( $reply );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Fan-out: copies each message to multiple targets via Router.',
			'ctor'        => [],
			'verbs'       => [],
			'requests'    => [
				[
					'name'        => 'GET_TARGETS',
					'description' => 'Current fan-out target list.',
					'reply_shape' => '{ count, targets }',
				],
			],
		];
	}
}
