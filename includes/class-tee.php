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
	/** @var array<string,array{count:int,answered:int,from:string}> */
	private array $persist_tracking = [];

	public function __construct() {
		$this->target = [];
	}

	public function connect_node( string $target ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = $this->target !== '' ? [ $this->target ] : [];
		}
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
		}
	}

	public function disconnect_node( string $target = '' ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = [];
			return;
		}
		$this->target = \array_values( \array_filter( $this->target, fn ( $t ) => $t !== $target ) );
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		// Persist response routing.
		if ( ( $type & Message::TM_PERSIST ) && ( $type & Message::TM_RESPONSE ) ) {
			$id = $message[ Message::ID ];
			if ( $id !== '' && isset( $this->persist_tracking[ $id ] ) ) {
				$entry = &$this->persist_tracking[ $id ];
				++$entry['answered'];
				$is_cancel = ( $message[ Message::VALUE ] === 'cancel' );
				if ( $is_cancel ) {
					$this->forward_persist_response( $entry, 'cancel', $id );
					unset( $this->persist_tracking[ $id ] );
					return;
				}
				$alive_now = \min( $entry['count'], \count( \is_array( $this->target ) ? $this->target : [] ) );
				if ( $entry['answered'] >= $alive_now ) {
					$this->forward_persist_response( $entry, 'answer', $id );
					unset( $this->persist_tracking[ $id ] );
				}
				return;
			}
			return;
		}

		// Snapshot live targets.
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive = [];
		foreach ( $targets as $t ) {
			if ( Core::node( $t ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		if ( $type & Message::TM_PERSIST ) {
			$id = $message[ Message::ID ];
			if ( $id !== '' && \count( $alive ) > 0 ) {
				$this->persist_tracking[ $id ] = [
					'count'    => \count( $alive ),
					'answered' => 0,
					'from'     => $message[ Message::FROM ],
				];
			}
		}

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

	private function forward_persist_response( array $entry, string $payload, string $id ): void {
		if ( $entry['from'] === '' ) {
			return;
		}
		$resp                       = Message::new_message();
		$resp[ Message::TYPE ]      = Message::TM_PERSIST | Message::TM_RESPONSE;
		$resp[ Message::TIMESTAMP ] = Core::$right_now;
		$resp[ Message::FROM ]      = $this->name;
		$resp[ Message::TO ]        = $entry['from'];
		$resp[ Message::ID ]        = $id;
		$resp[ Message::VALUE ]     = $payload;
		$this->sink?->fill( $resp );
	}
}
