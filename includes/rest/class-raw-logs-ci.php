<?php
/**
 * Raw_Logs_CI: command-dispatch for the Raw Logs dashboard.
 *
 * Two verbs exposed to the operator UI:
 *
 *   firehose_logs    — args `{}`. Returns the sorted catalog of log files
 *                       the dashboard's picker can subscribe to, derived
 *                       from `{base}/logs/*.log/` via `Log_Discovery::on_disk`.
 *                       Replaces the legacy hardcoded `AVAILABLE_LOGS` list
 *                       in `FirehoseController`, which silently omitted any
 *                       log a topology added after deploy.
 *
 *   firehose_status  — args `{log:string?}`. Returns per-partition segment
 *                       metadata (size, count) for one log file. Unknown
 *                       or missing log keys fall through to `firehose.log`.
 *
 * Both verbs read substrate state only (the on-disk log directory + config),
 * so the entire CI is substrate-owned. Live SSE tailing of the chosen log
 * happens through `Messages_Stream_Controller`, which is also substrate.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Service_CI;

\defined( 'ABSPATH' ) || exit;

class Raw_Logs_CI extends Service_CI {

	/** Fallback log key when the operator's `log` arg is missing or unknown. */
	private const DEFAULT_LOG_KEY = 'firehose';

	public function __construct() {
		$this->commands(
			[
				'firehose_logs'   => static function ( CommandInterpreter $self, string $args, array $envelope = [] ): string {
					self::require_manage_options();
					$result = [];
					foreach ( Log_Discovery::on_disk() as $key ) {
						$result[] = [
							'key'   => $key,
							'label' => "{$key}.log",
						];
					}
					return (string) \wp_json_encode( $result );
				},
				'firehose_status' => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ): string {
					self::require_manage_options();
					$decoded = \is_array( $payload ) ? $payload : [];
					$log_key = self::resolve_log_key( (string) ( $decoded['log'] ?? '' ) );

					$config         = RuntimeConfig::load_config();
					$base_dir       = (string) ( $config['base_directory'] ?? '/tmp/newspack-nodes' );
					$num_partitions = (int) ( $config['num_partitions'] ?? 1 );
					$log_file       = "{$log_key}.log";
					$log_base       = $base_dir . '/logs';

					$partitions     = [];
					$total_size     = 0;
					$total_segments = 0;
					for ( $p = 0; $p < $num_partitions; $p++ ) {
						$partition        = new Partition( "{$log_base}/{$log_file}", $p );
						$segments         = $partition->get_segments( true );
						$size             = (int) \array_sum( \array_column( $segments, 'size' ) );
						$partitions[ $p ] = [
							'segments'      => $segments,
							'segment_count' => \count( $segments ),
							'size'          => $size,
						];
						$total_size      += $size;
						$total_segments  += \count( $segments );
					}

					return (string) \wp_json_encode( [
						'log_id'         => $log_key,
						'log_file'       => $log_file,
						'num_partitions' => $num_partitions,
						'partitions'     => $partitions,
						'total_segments' => $total_segments,
						'total_size'     => $total_size,
					] );
				},
			]
		);
	}

	/**
	 * Map an inbound log argument to a known catalog key. Strips a `.log`
	 * suffix and falls through to `DEFAULT_LOG_KEY` (or the first discovered
	 * log if `firehose.log` doesn't exist for any reason).
	 */
	private static function resolve_log_key( string $log ): string {
		$keys = Log_Discovery::on_disk();
		if ( empty( $keys ) ) {
			return self::DEFAULT_LOG_KEY;
		}
		$index   = \array_flip( $keys );
		$default = isset( $index[ self::DEFAULT_LOG_KEY ] ) ? self::DEFAULT_LOG_KEY : $keys[0];
		if ( '' === $log ) {
			return $default;
		}
		$key = \str_replace( '.log', '', $log );
		return isset( $index[ $key ] ) ? $key : $default;
	}
}
