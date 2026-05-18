<?php
/**
 * SpawnController: REST endpoint that spawns a worker zombie-process.
 *
 * Accepts POST /newspack-nodes/v1/workers/spawn with {type, partition, nonce}.
 *
 * Auth model (dual):
 *   1. Internal supervisor / worker self-respawn: HMAC token validates via
 *      Supervisor::validate_spawn_token() (current OR previous 10s window).
 *      No user capability needed — token IS the credential.
 *   2. External / admin-initiated: current_user_can('manage_options') AND
 *      wp_verify_nonce($nonce, 'newspack_nodes_spawn_worker'). Adds a 2s
 *      per-user rate limit so accidental dashboard hammering doesn't fork-bomb.
 *
 * Validation:
 *   - validate_worker_type: type must be in expand_workers() topology types
 *     OR 'supervisor'. Prevents spinning up arbitrary class names.
 *   - validate_partition: partition must satisfy 0 <= p < num_partitions
 *     for the type (read from the topology). Supervisor requires partition===0.
 *
 * Special case: type='supervisor' invokes Supervisor::run() synchronously
 * inside the spawn handler. The worker IS the supervisor; no separate fork
 * needed.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\SupervisorBase;

\defined( 'ABSPATH' ) || exit;

class SpawnController {
	/** WordPress nonce action name for external spawn requests. */
	public const NONCE_ACTION = 'newspack_nodes_spawn_worker';

	/** Per-user rate limit window for external spawn requests. */
	public const RATE_LIMIT_S = 2;

	/** Whitelist of numeric fields surfaced in the JSON response. */
	public const SAFE_RESULT_FIELDS = [
		'entries_processed',
		'requests_complete',
		'requests_pending',
		'flames_written',
		'jobs_processed',
	];

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
	 * Validate a worker type. Accepts:
	 *  - any type registered in the topology filter (via expand_workers).
	 *  - 'supervisor'.
	 *
	 * Reject unknown types with a 400 — prevents the spawn endpoint from
	 * being used to instantiate arbitrary classes via the type parameter.
	 *
	 * @param mixed $type Worker type — comes from `$request->get_param('type')`
	 *                   so it's whatever the user sent (mixed), not yet
	 *                   guaranteed to be a string.
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
	 * Validate a partition number for a given type. Must be in
	 * [0, num_partitions) for that type. Supervisor requires partition===0.
	 *
	 * @param string $type Worker type.
	 * @param int    $partition Partition number.
	 * @return bool True if valid.
	 */
	public function validate_partition( string $type, int $partition ): bool {
		if ( $partition < 0 ) {
			return false;
		}
		if ( $partition >= SupervisorBase::MAX_PARTITIONS ) {
			return false;
		}

		// Supervisor path first.  There can be only one.
		if ( 'supervisor' === $type ) {
			return 0 === $partition;
		}

		// Topology path: partition must be < num_partitions for the type.
		$max = 0;
		foreach ( Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] === $type && ( $w['partition'] + 1 ) > $max ) {
				$max = $w['partition'] + 1;
			}
		}
		if ( 0 === $max ) {
			// Type isn't in topology at all — fall back to false (validate_worker_type
			// should have caught this; keep defense-in-depth here).
			return false;
		}
		return $partition < $max;
	}

	/**
	 * Permission check: dual auth.
	 *
	 *  - HMAC token (current or previous 10s window) → authorized as
	 *    internal request. No user capability needed.
	 *  - Otherwise: capability 'manage_options' AND a valid wp_verify_nonce
	 *    against the NONCE_ACTION; plus a 2s per-user rate limit.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$nonce = (string) $req->get_param( 'nonce' );
		if ( '' === $nonce ) {
			return new \WP_Error( 'invalid_token', 'Missing spawn token', [ 'status' => 403 ] );
		}

		// Internal HMAC path. No capability check, no rate limit — supervisor
		// handles its own spawn rate limiting.
		if ( $this->supervisor->validate_spawn_token( $nonce, \time() ) ) {
			return true;
		}

		// External path. Capability THEN nonce THEN rate-limit. Order matters:
		// rate-limit before capability would let unauthenticated requests
		// poison the transient table; capability before rate-limit makes the
		// rate counter meaningful only against authenticated users.
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
	 * 2s per-user rate limit on external spawn requests. No-op if the
	 * transient API isn't available (test contexts) — the HMAC path
	 * doesn't go through this and is fine.
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
	 * to the supervisor (special-cased) or fires the spawn_worker action
	 * for topology owners to instantiate the right worker class.
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

		// Acknowledge synchronously; do the work zombie-style.
		// Skip the FPM detach in CLI/test contexts where the function is a no-op.
		if ( \function_exists( 'fastcgi_finish_request' ) ) {
			\fastcgi_finish_request();
		}
		\ignore_user_abort( true );
		\set_time_limit( 0 );

		// Store worker context in $_SERVER for sub-actions / logging.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;

		// Supervisor-as-worker: instantiate + run synchronously, return a
		// minimal sanitized result. The Supervisor class manages its own
		// lock contention, so a concurrent spawn becomes a quick no-op.
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

		// Topology / application worker: fire the action; topology owners
		// hook this to build the graph and call ->execute().
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
	 * Build a fresh Supervisor and run() it synchronously inside the spawn
	 * handler. Wrapped in try/catch so a transient failure doesn't crash
	 * the request — the cron backstop will pick it up.
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
	 * Whitelist response fields. Surfaced numeric counters; no internal
	 * paths, stack traces, or arbitrary keys leak into the response body.
	 *
	 * @param mixed $result Worker-reported result — comes from a
	 *                     `wp_remote_post`/`json_decode` chain so it's
	 *                     whatever the worker emitted (mixed), not yet
	 *                     guaranteed to be an array.
	 * @return array Sanitized projection.
	 */
	public function sanitize_worker_result( $result ): array {
		if ( ! \is_array( $result ) ) {
			return [ 'status' => 'unknown' ];
		}
		$safe = [
			'status' => isset( $result['status'] ) && \is_string( $result['status'] ) ? $result['status'] : 'unknown',
		];
		foreach ( self::SAFE_RESULT_FIELDS as $field ) {
			if ( isset( $result[ $field ] ) && \is_numeric( $result[ $field ] ) ) {
				$safe[ $field ] = (int) $result[ $field ];
			}
		}
		return $safe;
	}
}
