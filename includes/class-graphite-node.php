<?php
/**
 * Graphite
 *
 * Plaintext-protocol egress — the substrate's stand-in for Tachikoma's
 * `connect_inet … :2003 graphite`. fill() writes each TM_BYTESTREAM VALUE
 * (newline-terminated `path value ts` lines, pre-batched upstream by
 * Probe_To_Graphite) to the configured endpoint over UDP: fire-and-forget,
 * no connection state, no blocking in the drain loop.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Graphite node.
 */
class Graphite_Node extends Node {
	use Schema_Reflection;

	/**
	 * Datagram-write seam. Tests reassign to capture without a live server;
	 * production resolves lazily to the real stream write so the fopen/fwrite
	 * path stays covered logic, not mock. Signature:
	 * `function ( string $endpoint, string $payload ): bool`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $transport = null;

	private string $endpoint = '';

	/**
	 * `<host:port>` — required; a metrics egress with no destination is a
	 * misconfigured topology, not a default.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
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
			$socket = @\fopen( $endpoint, 'w' );
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
