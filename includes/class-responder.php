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

	public function register_shell_callback( string $id, callable $cb ): void {
		$this->shell_callbacks[ $id ] = $cb;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];
		$id   = $message[ Message::ID ];

		// Shell-callback path.
		if ( $id !== '' && isset( $this->shell_callbacks[ $id ] ) ) {
			$cb     = $this->shell_callbacks[ $id ];
			$result = $cb(
				[
					'from'    => $message[ Message::FROM ],
					'event'   => $message[ Message::KEY ] !== '' ? $message[ Message::KEY ] : 'unknown',
					'payload' => $message[ Message::VALUE ],
					'error'   => (bool) ( $type & Message::TM_ERROR ),
				]
			);
			if ( ! $result ) {
				unset( $this->shell_callbacks[ $id ] );
			}
			return; // Do NOT forward to sink — callback handled it.
		}

		// Auto-cancel TM_PERSIST.
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
			$this->sink?->fill( $ack );
			return;
		}

		// Default: forward to sink (e.g. Dumper for async broadcasts).
		$this->sink?->fill( $message );
	}
}
