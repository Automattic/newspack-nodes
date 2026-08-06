<?php
/**
 * SpawnController: REST endpoint that spawns a worker zombie-process.
 *
 * Accepts POST /newspack-nodes/v1/workers/spawn with {type, partition, nonce}.
 * Dual auth: internal HMAC token (current OR previous 10s window) OR external
 * manage_options + nonce (with a 2s per-user rate limit).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Spawn_Coordinator;

\defined( 'ABSPATH' ) || exit;

class Spawn_Controller {

	/** WordPress nonce action name for external spawn requests. */
	public const NONCE_ACTION = 'newspack_nodes_spawn_worker';

	/** Per-user rate limit window for external spawn requests. */
	public const RATE_LIMIT_S = 2;

	private Spawn_Coordinator $coordinator;

	public function __construct( Spawn_Coordinator $coordinator ) {
		$this->coordinator = $coordinator;
	}

	/**
	 * Permission check: internal HMAC token (current/previous 10s window), else
	 * external manage_options + valid nonce + 2s per-user rate limit.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		$raw_nonce = $req->get_param( 'nonce' );
		$nonce     = Core::as_string( $raw_nonce );
		if ( '' === $nonce ) {
			return new \WP_Error( 'invalid_token', 'Missing spawn token', [ 'status' => 403 ] );
		}

		// Internal HMAC path — no cap/nonce; spawn() throttles per worker.
		if ( $this->coordinator->validate_spawn_token( $nonce, \time() ) ) {
			return true;
		}

		// Capability->nonce->rate-limit: rate-limiting first poisons the table.
		if ( ! \function_exists( 'current_user_can' ) || ! Capabilities::can( Capabilities::MANAGE ) ) {
			return new \WP_Error(
				'invalid_token',
				'Invalid spawn token',
				[ 'status' => 403 ]
			);
		}

		if ( ! \function_exists( 'wp_verify_nonce' ) || ! \wp_verify_nonce( $nonce, self::NONCE_ACTION ) ) {
			return new \WP_Error(
				'invalid_token',
				'Invalid spawn token',
				[ 'status' => 403 ]
			);
		}

		$rate_check = $this->check_rate_limit();
		if ( $rate_check instanceof \WP_Error ) {
			return $rate_check;
		}

		return true;
	}

	/**
	 * 2s per-user rate limit on external spawn requests. No-op without the
	 * transient API (test contexts).
	 *
	 * @return true|\WP_Error
	 */
	protected function check_rate_limit() {
		if ( ! \function_exists( 'get_transient' ) || ! \function_exists( 'set_transient' ) ) {
			return true;
		}
		$user_id = \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
		$key     = 'newspack_nodes_spawn_rate:' . $user_id;
		$last    = \get_transient( $key );
		if ( false !== $last && \is_scalar( $last ) ) {
			$elapsed = \time() - (int) $last;
			if ( $elapsed < self::RATE_LIMIT_S ) {
				return new \WP_Error(
					'rate_limited',
					'Too many spawn requests; please wait a moment.',
					[ 'status' => 429 ]
				);
			}
		}
		\set_transient( $key, \time(), 10 );
		return true;
	}

	/**
	 * Spawn handler. Detaches from FPM, validates the partition, then fires
	 * the spawn_worker action the topology owner hooks.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public function spawn( \WP_REST_Request $req ) {
		$raw_type      = $req->get_param( 'type' );
		$raw_partition = $req->get_param( 'partition' );
		$type          = Core::as_string( $raw_type );
		$partition     = Core::as_int( $raw_partition );

		if ( ! $this->validate_partition( $type, $partition ) ) {
			return new \WP_Error(
				'invalid_partition',
				'Partition out of range for worker type',
				[ 'status' => 400 ]
			);
		}

		// The one throttle every spawn path crosses (Tachikoma-style).
		$now = Core::right_now();
		if ( $this->coordinator->is_recently_spawned( $type, $partition, $now ) ) {
			return new \WP_Error(
				'spawn_throttled',
				\sprintf( '%s.p%d spawned less than %ds ago', $type, $partition, Spawn_Coordinator::MIN_SPAWN_INTERVAL_S ),
				[ 'status' => 429 ]
			);
		}
		$this->coordinator->record_spawn( $type, $partition, $now );

		// Ack synchronously; work zombie-style (FPM detach no-op in CLI/test).
		if ( \function_exists( 'fastcgi_finish_request' ) ) {
			\fastcgi_finish_request();
		}
		\ignore_user_abort( true );
		\set_time_limit( 0 );

		// Worker context for sub-actions / logging.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;

		// Topology worker: owners hook this to build the graph and execute().
		\do_action( 'newspack_nodes/spawn_worker', $type, $partition );

		return new \WP_REST_Response(
			[
				'spawned'   => true,
				'type'      => $type,
				'partition' => $partition,
			],
			200
		);
	}

	/**
	 * Validate a partition number for a type: [0, num_partitions).
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @return bool True if valid.
	 */
	public function validate_partition( string $type, int $partition ): bool {
		if ( $partition < 0 ) {
			return false;
		}
		if ( $partition >= Spawn_Coordinator::MAX_PARTITIONS ) {
			return false;
		}

		$max = 0;
		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type && ( $w['partition'] + 1 ) > $max ) {
				$max = $w['partition'] + 1;
			}
		}
		if ( 0 === $max ) {
			// Not in topology — defense-in-depth (should've been caught).
			return false;
		}
		return $partition < $max;
	}

	public function register_routes(): void {
		\register_rest_route(
			'newspack-nodes/v1',
			'/workers/spawn',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'spawn' ],
				'permission_callback' => [ $this, 'check_permission' ],
				'args'                => [
					'type'      => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
						'validate_callback' => [ $this, 'validate_worker_type' ],
					],
					'partition' => [
						'required'          => true,
						'sanitize_callback' => static fn ( $v ): int => Core::as_int( $v ),
					],
					'nonce'     => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					],
				],
			]
		);
	}

	/**
	 * Validate a worker type against expand_workers(). Rejecting unknown types
	 * blocks arbitrary class instantiation.
	 *
	 * @param mixed $type Worker type (unsanitized request param).
	 * @return bool True if valid.
	 */
	public function validate_worker_type( $type ): bool {
		if ( ! \is_string( $type ) || '' === $type ) {
			return false;
		}

		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type ) {
				return true;
			}
		}
		return false;
	}
}
