<?php
/**
 * Graphite: plaintext-metrics egress.
 *
 * Ships each TM_BYTESTREAM VALUE — newline-terminated `path value ts` lines,
 * batched 16 to a message upstream by Probe_To_Graphite — to a Graphite
 * plaintext endpoint as one UDP datagram. It stands in for Tachikoma's
 * `connect_inet --io --reconnect <host>:2003 graphite` and diverges on the
 * transport: Tachikoma holds a reconnecting TCP socket, this opens and closes a
 * connectionless one per message. A datagram needs no handshake, keeps no
 * reconnect state, and leaves no send buffer to back up behind a collector that
 * is down. Losing a sweep beats stalling the graph that produced it, and the
 * upstream batching is what makes a socket per message affordable.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Graphite node — `make_node Graphite <name> <host:port>`.
 */
class Graphite_Node extends Node {
	use Schema_Reflection;

	/**
	 * Datagram-write seam replacing the socket open, write and close in fill();
	 * the type gate, the empty-VALUE skip, the counter and the failure log run
	 * as production code either way. Tests reassign it to capture payloads with
	 * no Graphite listener, and restore null to exercise the real write.
	 * Production never assigns it, so the lazy default inside fill() is what
	 * runs — a closure is not a constant expression and cannot be this
	 * property's declared default. A replacement satisfies
	 * `function ( string $endpoint, string $payload ): bool`, returning false
	 * when nothing left the process.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $transport = null;

	/** The `udp://host:port` stream target arguments() derives; empty until then. */
	private string $endpoint = '';

	/**
	 * `<host:port>` — required, and prefixed with `udp://` into the endpoint
	 * fill() writes to. A metrics egress with no destination is a misconfigured
	 * topology rather than a default, so an absent token throws at make_node
	 * time instead of discarding every line for the life of the worker.
	 *
	 * The check is shape-only: a colon must be present, and nothing confirms the
	 * host resolves or that anything listens. UDP reports neither. A host that
	 * fails to resolve at least fails the write and logs; a wrong port or a dead
	 * collector accepts every datagram, so those surface only as metrics that
	 * never arrive.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> The tokens as given.
	 * @throws \InvalidArgumentException Without a host:port argument.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->arguments = $args;
		$endpoint        = Core::as_string( $args[0] ?? '', '' );
		if ( '' === $endpoint || ! \str_contains( $endpoint, ':' ) ) {
			throw new \InvalidArgumentException( 'Graphite requires a host:port argument' );
		}
		$this->endpoint = "udp://{$endpoint}";
		return $args;
	}

	/**
	 * Write the message VALUE to the endpoint as one datagram.
	 *
	 * Only TM_BYTESTREAM is written: a TM_STRUCT VALUE is an array and the
	 * plaintext protocol reads lines, so put a formatter — Probe_To_Graphite,
	 * or a Dumper — in front. An empty VALUE is skipped, because a zero-length
	 * datagram carries no metric and still costs a socket.
	 *
	 * The counter advances on every accepted message, a failed write included,
	 * so `ls` reports what this node was asked to ship. A failure logs
	 * rate-limited and returns — fill() returns void (ADR-13), and throwing
	 * would take the drain loop down over an unreachable metrics host.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		if ( ! ( Core::as_int( $message[ Message::TYPE ], 0 ) & Message::TM_BYTESTREAM ) ) {
			return;
		}
		$payload = Core::as_string( $message[ Message::VALUE ] );
		if ( '' === $payload ) {
			return;
		}
		++$this->counter;
		$write = self::$transport ?? static function ( string $endpoint, string $payload ): bool {
			// phpcs:disable WordPress.WP.AlternativeFunctions, WordPressVIPMinimum.Functions.RestrictedFunctions -- raw UDP datagram socket; no WP_Filesystem equivalent.
			$socket = @\stream_socket_client( $endpoint, $error_code, $error_message, 1.0 );
			if ( false === $socket ) {
				return false;
			}
			$sent = @\fwrite( $socket, $payload );
			\fclose( $socket );
			// phpcs:enable
			return false !== $sent;
		};
		if ( ! $write( $this->endpoint, $payload ) ) {
			$this->print_less_often( 'graphite write failed to ', $this->endpoint );
		}
	}

	/**
	 * Palette entry and argument form for the topology console. `has_target` is
	 * false because the datagram is the terminus: there is nothing downstream to
	 * connect this node to.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Writes bytestream lines to a Graphite plaintext endpoint over UDP (fire-and-forget).',
			'arguments'   => [
				[ 'name' => 'endpoint', 'type' => 'string', 'required' => true, 'description' => 'Graphite host:port (plaintext protocol, e.g. graphite1:2003).' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => false,
		];
	}
}
