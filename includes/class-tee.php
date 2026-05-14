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

		// TM_REQUEST handler: replies with the current target list without
		// fanning out. Lets `request <tee-name> GET_TARGETS` round-trip the
		// state inline, parallel to the cached TARGETS set_state available
		// via debug_state.
		$type = $message[ Message::TYPE ];
		if ( ( $type & Message::TM_REQUEST ) && ! ( $type & Message::TM_RESPONSE ) ) {
			$this->handle_request( $message );
			return;
		}

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

	private function handle_request( array $message ): void {
		$value   = (string) $message[ Message::VALUE ];
		$verb    = \strtoupper( \explode( ' ', \trim( $value ), 2 )[0] );
		$targets = \is_array( $this->target ) ? \array_values( $this->target ) : [];
		$payload = 'GET_TARGETS' === $verb
			? [ 'count' => \count( $targets ), 'targets' => $targets ]
			: [ 'error' => "unknown request verb: {$verb}" ];

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_RESPONSE | Message::TM_STRUCT;
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
