<?php
/**
 * SpawnController: REST endpoint that spawns a worker zombie-process.
 *
 * Accepts POST /newspack-nodes/v1/workers/spawn with {type, partition, nonce}.
 * Dual auth: internal HMAC token (current OR previous 10s window) OR external
 * manage_options + nonce (with a 2s per-user rate limit). type='supervisor'
 * runs Supervisor::run() synchronously — the worker IS the supervisor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Supervisor_Base;

\defined( 'ABSPATH' ) || exit;

class Spawn_Controller {
	/** WordPress nonce action name for external spawn requests. */
	public const NONCE_ACTION = 'newspack_nodes_spawn_worker';

	/** Per-user rate limit window for external spawn requests. */
	public const RATE_LIMIT_S = 2;

	private Supervisor $supervisor;

	public function __construct( Supervisor $supervisor ) {
		$this->supervisor = $supervisor;
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
						'sanitize_callback' => static fn ( $v ) => (int) $v,
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
	 * Validate a worker type: a topology type (via expand_workers) or
	 * 'supervisor'. Rejecting unknown types blocks arbitrary class instantiation.
	 *
	 * @param mixed $type Worker type (unsanitized request param).
	 * @return bool True if valid.
	 */
	public function validate_worker_type( $type ): bool {
		if ( ! \is_string( $type ) || '' === $type ) {
			return false;
		}

		if ( 'supervisor' === $type ) {
			return true;
		}

		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Validate a partition number for a type: [0, num_partitions); supervisor
	 * requires partition===0.
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @return bool True if valid.
	 */
	public function validate_partition( string $type, int $partition ): bool {
		if ( $partition < 0 ) {
			return false;
		}
		if ( $partition >= Supervisor_Base::MAX_PARTITIONS ) {
			return false;
		}

		// There can be only one supervisor.
		if ( 'supervisor' === $type ) {
			return 0 === $partition;
		}

		$max = 0;
		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type && ( $w['partition'] + 1 ) > $max ) {
				$max = $w['partition'] + 1;
			}
		}
		if ( 0 === $max ) {
			// Not in topology — defense-in-depth (validate_worker_type should have caught it).
			return false;
		}
		return $partition < $max;
	}

	/**
	 * Permission check: internal HMAC token (current/previous 10s window), else
	 * external manage_options + valid nonce + 2s per-user rate limit.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$nonce = (string) $req->get_param( 'nonce' );
		if ( '' === $nonce ) {
			return new \WP_Error( 'invalid_token', 'Missing spawn token', [ 'status' => 403 ] );
		}

		// Internal HMAC path — no capability/rate limit (supervisor self-limits).
		if ( $this->supervisor->validate_spawn_token( $nonce, \time() ) ) {
			return true;
		}

		// Capability THEN nonce THEN rate-limit: rate-limiting first would let
		// unauthenticated requests poison the transient table.
		if ( ! \function_exists( 'current_user_can' ) || ! \current_user_can( 'manage_options' ) ) {
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
		$user_id = \function_exists( 'get_current_user_id' ) ? (int) \get_current_user_id() : 0;
		$key     = 'newspack_nodes_spawn_rate:' . $user_id;
		$last    = \get_transient( $key );
		if ( false !== $last ) {
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
	 * Spawn handler. Detaches from FPM, validates the partition, dispatches
	 * to the supervisor (special-cased) or fires the spawn_worker action.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public function spawn( \WP_REST_Request $req ) {
		$type      = (string) $req->get_param( 'type' );
		$partition = (int) $req->get_param( 'partition' );

		if ( ! $this->validate_partition( $type, $partition ) ) {
			return new \WP_Error(
				'invalid_partition',
				'Partition out of range for worker type',
				[ 'status' => 400 ]
			);
		}

		// Acknowledge synchronously; do the work zombie-style. FPM detach is a no-op in CLI/test.
		if ( \function_exists( 'fastcgi_finish_request' ) ) {
			\fastcgi_finish_request();
		}
		\ignore_user_abort( true );
		\set_time_limit( 0 );

		// Worker context for sub-actions / logging.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;

		// Supervisor-as-worker: run synchronously. It self-manages lock contention,
		// so a concurrent spawn becomes a quick no-op.
		if ( 'supervisor' === $type ) {
			$result = $this->run_supervisor_sync();
			return new \WP_REST_Response(
				[
					'spawned'   => true,
					'type'      => 'supervisor',
					'partition' => 0,
					'result'    => $this->sanitize_worker_result( $result ),
				],
				200
			);
		}

		// Topology / application worker: topology owners hook this to build the graph and execute().
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
	 * Build a fresh Supervisor and run() it synchronously. try/catch so a
	 * transient failure doesn't crash the request — the cron backstop catches it.
	 *
	 * @return array{status: string}
	 */
	private function run_supervisor_sync(): array {
		try {
			$supervisor = Bootstrap::supervisor();
			$supervisor->run();
			return [ 'status' => 'completed' ];
		} catch ( \Throwable $e ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Newspack_Nodes\\SpawnController: supervisor run failed: ' . $e->getMessage() );
			return [ 'status' => 'error' ];
		}
	}

	/**
	 * Project a worker result to a safe response by VALUE TYPE, not by field name
	 * (project-agnostic): keep the string `status`, then surface any field with a
	 * numeric value (cast to int) under a safe `[a-zA-Z0-9_]` key. Strings, arrays,
	 * paths and traces are dropped, so no internal paths/keys leak; capped so a
	 * misbehaving worker can't flood the response.
	 *
	 * @param mixed $result Worker-reported result (unsanitized from the wire).
	 * @return array Sanitized projection.
	 */
	public function sanitize_worker_result( $result ): array {
		if ( ! \is_array( $result ) ) {
			return [ 'status' => 'unknown' ];
		}
		$safe = [
			'status' => isset( $result['status'] ) && \is_string( $result['status'] ) ? $result['status'] : 'unknown',
		];
		$count = 0;
		foreach ( $result as $key => $value ) {
			if ( 'status' === $key || ! \is_string( $key ) || ! \preg_match( '/^[a-zA-Z0-9_]{1,40}$/', $key ) ) {
				continue;
			}
			if ( \is_numeric( $value ) ) {
				$safe[ $key ] = (int) $value;
				if ( ++$count >= 32 ) {
					break;
				}
			}
		}
		return $safe;
	}
}
