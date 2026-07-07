<?php
/**
 * HTTP_Filter: SSE-process Node registered at `_output`. Consumers
 * tailing worker output Partitions sink into _router. Worker replies for
 * pivoted commands have TO=`_output/_sse:<originating-sse-pid>/<reply-node>`
 * (the browser `_sse` session node stamps that pivot). _router peels `_output`
 * and forwards here with TO=`_sse:<sse-pid>/<reply-node>`; this Node matches the
 * head segment against its own `_sse:<pid>`, strips it, and forwards the
 * remainder (the reply-node, e.g. `_output`) to the SSE writer only on match.
 *
 * The shared-worker scenario without this filter leaks every other
 * browser tab's command replies to every connected tab. Pid-equality is
 * the only correct gate.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class HTTP_Filter_Node extends Node {

	private int $own_pid;

	public function __construct( int $own_pid ) {
		parent::__construct();
		$this->own_pid = $own_pid;
	}

	public function fill( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		++$this->counter;
		[ $head, $reply_node ] = Message::split_first( Core::as_string( $message[ Message::TO ] ) );
		// Match this session's `_sse:<pid>` head; drop silently otherwise — the
		// reply belongs to a different session's SSE process.
		if ( Node_Names::SSE . ':' . $this->own_pid !== $head ) {
			return;
		}
		// The remainder (e.g. `_output`) is the browser-side reply-node.
		$message[ Message::TO ] = $reply_node;
		$this->sink->fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Per-session pivoted-reply gate; SSE-process equivalent of SSE_Out.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
