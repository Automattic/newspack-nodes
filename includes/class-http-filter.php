<?php
/**
 * HTTP_Filter: SSE-process Node registered at `_http`. Consumers
 * tailing worker output Partitions sink into _router. Worker replies for
 * pivoted commands have TO=`_http/<originating-sse-pid>`. _router peels
 * `_http` and forwards here; this Node compares the remaining TO
 * against its own PID and forwards to the SSE writer only on match.
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

	/** @var \Closure SSE writer; signature: function (array $msg): void */
	private \Closure $emit;

	public function __construct( int $own_pid, \Closure $emit ) {
		$this->own_pid = $own_pid;
		$this->emit    = $emit;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		if ( (string) $this->own_pid === (string) $message[ Message::TO ] ) {
			( $this->emit )( $message );
		}
		// else: silently drop — this reply belongs to a different session.
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Per-session pivoted-reply gate; SSE-process equivalent of HTTP_Out.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
