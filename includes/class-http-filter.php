<?php
/**
 * HTTP_Filter: SSE-process Node registered at `_http`. Consumers
 * tailing worker output Partitions sink into _router. Worker replies for
 * pivoted commands have TO=`_http/<originating-sse-pid>/<reply-node>`.
 * _router peels `_http` and forwards here with TO=`<sse-pid>/<reply-node>`;
 * this Node matches the head segment against its own PID, strips it, and
 * forwards the remainder (the reply-node, e.g. `_output`) to the SSE writer
 * only on match.
 *
 * The shared-worker scenario without this filter leaks every other
 * browser tab's command replies to every connected tab. Pid-equality is
 * the only correct gate.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class HTTP_Filter extends Node {
	private int $own_pid;

	public function __construct( int $own_pid ) {
		$this->own_pid = $own_pid;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		[ $pid, $reply_node ] = Message::split_first( $message[ Message::TO ] );
		// Drop silently — this reply belongs to a different session's SSE process.
		if ( (string) $this->own_pid !== $pid ) {
			return;
		}
		// The remainder (e.g. `_output`) is the browser-side reply-node.
		$message[ Message::TO ] = $reply_node;
		$this->sink?->fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Per-session pivoted-reply gate; SSE-process equivalent of SSE_Out.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
