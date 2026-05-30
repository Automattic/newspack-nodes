<?php
/**
 * Command_Signer: HMAC-signs command provenance before the IPC wire.
 *
 * Interposed between a Shell and a worker's IPC input Partition in pivoted
 * `wp nodes cli` mode (the cli is a local secret-holding issuer). Signs each
 * TM_COMMAND (non-response) via Command_Auth so the worker's verifier interpreter accepts
 * it — the LOCAL provenance taint is stripped at the wire boundary, so a signed
 * envelope is what survives IPC. Non-command messages pass through unchanged.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Command_Signer_Node extends Node {
	public function fill( array &$message ): void {
		++$this->counter;
		if ( ( $message[ Message::TYPE ] & Message::TM_COMMAND ) && ! ( $message[ Message::TYPE ] & Message::TM_RESPONSE ) ) {
			Command_Auth::sign( $message );
		}
		$this->sink?->fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Signs TM_COMMAND provenance (HMAC) before the IPC wire — pivoted-cli issuer.',
			'arguments'        => [],
			'commands'       => [],
		];
	}
}
