<?php
/**
 * Remote_IPC: a per-worker interactive command channel, as distinct from
 * Remote_Source (durable aggregation). Modelled after the browser console's pivot
 * into a topology worker (JS RemoteIpcNode): `cd /{worker}` routes commands straight
 * to it — the worker's name IS the address.
 *
 * It EXTENDS Remote_Link — same SSE_In + HTTP_Out patrons, heartbeat, status — and
 * specializes the base via the seams plus a `send()` override that carries the two
 * halves of the worker-pivot that used to live in SSE_In + HTTP_Out:
 *  - The reply-FROM wrap: a command minted by a reply node (`_metadata`/`_output`/…)
 *    gets FROM rewritten to the private pivot `_sse:{pid}/{node}` so the spoke's
 *    HTTP_Filter can demux its ASYNC reply back to THIS session's stream. The `_sse`
 *    head is the server's wire contract, not this node's name.
 *  - The `connect_worker_input` bundling: each send rides a leading
 *    `connect_worker_input {reader}` so the stateless request-scope graph mounts the
 *    worker's input Partition before the command routes to it. Both messages ride
 *    the patron HTTP_Out's per-tick batch → ONE POST, so the mount + command land in
 *    the same server process.
 *
 * Single live connection: a send boots this link's SSE_In, closing whichever
 * Remote_IPC held it (the cwd-changes-worker swap).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_IPC_Node extends Remote_Link_Node {

	/**
	 * The single Remote_IPC currently holding the live SSE_In (one stream per
	 * session; a send swaps it). Static so siblings can hand it off.
	 */
	public static ?Remote_IPC_Node $active = null;

	/**
	 * Make this link's SSE_In the live stream, replacing whichever Remote_IPC held
	 * it. Idempotent while already streaming (a steady poll doesn't reconnect).
	 *
	 * @api Dynamic entrypoint.
	 */
	public function connect(): void {
		$current = self::$active;
		if ( $current === $this && $this->is_streaming() ) {
			return;
		}
		if ( null !== $current && $current !== $this ) {
			$current->close();
		}
		parent::connect();
		self::$active = $this;
	}

	/**
	 * Close the composed stream and release the live-connection claim.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function close(): void {
		parent::close();
		if ( self::$active === $this ) {
			self::$active = null;
		}
	}

	/**
	 * Worker-pivot send: boot/steal the live connection, then route the bundled
	 * `[connect_worker_input, command]` pair through the patron HTTP_Out (one POST).
	 *
	 * @param array<int, mixed> $message Positional Message; TO is the remainder past this node's name.
	 */
	protected function send( array &$message ): void {
		$this->connect();
		if ( null === $this->http_out ) {
			return;
		}

		$reader    = $this->remote_partition;
		$remainder = Core::as_string( $message[ Message::TO ] );
		$command   = $message;
		$from      = Core::as_string( $command[ Message::FROM ] );
		if ( '' !== $from ) {
			$command[ Message::FROM ] = Node_Names::SSE . ':' . $this->sse_in?->pid() . '/' . $from;
		}
		$command[ Message::TO ] = '' === $remainder ? $reader : "{$reader}/{$remainder}";

		$connect                   = Message::new_message();
		$connect[ Message::TYPE ]  = Message::TM_COMMAND;
		$connect[ Message::TO ]    = 'topologies';
		$connect[ Message::VALUE ] = [ 'name' => 'connect_worker_input', 'arguments' => $reader ];

		// Both ride the HTTP_Out per-tick batch → one POST, so the request-scope
		// mount and the command land in the same server process.
		$this->http_out->fill( $connect );
		$this->http_out->fill( $command );
	}

	/** Only the active link's tick keeps the stream alive; the rest stay dormant. */
	protected function should_connect(): bool {
		return self::$active === $this;
	}

	/**
	 * Teardown: release the live-connection claim, then tear down the patrons + self.
	 *
	 * @api Dynamic entrypoint.
	 */
	public function remove_node(): void {
		if ( self::$active === $this ) {
			self::$active = null;
		}
		parent::remove_node();
	}

	/**
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Per-worker interactive command channel: cd onto it and commands ride to the remote worker.',
		] );
	}
}
