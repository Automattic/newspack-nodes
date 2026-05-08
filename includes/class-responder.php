<?php
/**
 * Responder: convenience cancel-sink for TM_PERSIST + shell-callback ID dispatch.
 *
 * Per spec REPL section: present in every process as `_responder`. Terminal consumers
 * of TM_PERSIST sink to here; Responder sends the cancel back along the FROM trail.
 * Secondary path: ID-correlation against shell callbacks for request/response pairing.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Responder extends Node {
	/** @var array<string,callable> */
	private array $shell_callbacks = [];

	private ?Shell $shell = null;

	public function register_shell_callback( string $id, callable $cb ): void {
		$this->shell_callbacks[ $id ] = $cb;
	}

	/**
	 * Bind a Shell whose callbacks the Responder will also dispatch into.
	 * When set, the Responder checks its local shell_callbacks first, then
	 * falls back to the Shell's registry.
	 */
	public function set_shell( Shell $shell ): void {
		$this->shell = $shell;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];
		$id   = $message[ Message::ID ];

		// Shell-callback path: try local registry first, then bound Shell.
		if ( $id !== '' ) {
			$info = [
				'from'    => $message[ Message::FROM ],
				'event'   => $message[ Message::KEY ] !== '' ? $message[ Message::KEY ] : 'unknown',
				'payload' => $message[ Message::VALUE ],
				'error'   => (bool) ( $type & Message::TM_ERROR ),
			];
			if ( isset( $this->shell_callbacks[ $id ] ) ) {
				$cb     = $this->shell_callbacks[ $id ];
				$result = $cb( $info );
				if ( ! $result ) {
					unset( $this->shell_callbacks[ $id ] );
				}
				return; // Do NOT forward to sink — callback handled it.
			}
			if ( $this->shell !== null && $this->shell->callback( $id, $info ) ) {
				return; // Shell's single-shot callback handled it.
			}
		}

		// Auto-cancel TM_PERSIST. The reply needs path-based routing back along
		// the FROM trail, so it goes through _router (Core lookup) — NOT through
		// $this->sink (which is _dumper in the cli, _router via the worker
		// scaffolding default; using _router directly works in both). Matches
		// real Tachikoma's pattern where Responder always sinks into Dumper but
		// addresses replies through the Router. Spec line 689 + user direction.
		if ( $type & Message::TM_PERSIST ) {
			if ( $message[ Message::FROM ] === '' ) {
				return; // Silent drop, same rule as Node::answer/cancel.
			}
			$ack                       = Message::new_message();
			$ack[ Message::TYPE ]      = Message::TM_PERSIST | Message::TM_RESPONSE;
			$ack[ Message::TIMESTAMP ] = Core::$right_now;
			$ack[ Message::FROM ]      = $this->name;
			$ack[ Message::TO ]        = $message[ Message::FROM ];
			$ack[ Message::ID ]        = $message[ Message::ID ];
			$ack[ Message::KEY ]       = $message[ Message::KEY ];
			$ack[ Message::VALUE ]     = ( $type & Message::TM_ERROR ) ? 'answer' : 'cancel';
			$router                    = Core::node( '_router' );
			if ( $router !== null ) {
				$router->fill( $ack );
			} else {
				$this->sink?->fill( $ack );
			}
			return;
		}

		// Default: forward to sink (e.g. Dumper for async broadcasts).
		$this->sink?->fill( $message );
	}
}
