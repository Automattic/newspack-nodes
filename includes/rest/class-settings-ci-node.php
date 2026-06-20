<?php
/**
 * Settings_CI: command-dispatch for the substrate-level integer settings.
 *
 * Replaces legacy class-settings-controller.php with a CommandInterpreter
 * that mounts at priority 11 alongside the rest of the M2 service CIs.
 *
 * Verbs:
 *   get — returns the four substrate-owned integer settings as a snapshot
 *         (num_partitions, num_segments, segment_size, max_lifespan). The
 *         matching getter dashboards diff against.
 *   set — applies a single setting by its full `newspack_nodes_*` option name
 *         (the positional grammar Settings_Sync_Node fans out to spokes),
 *         writes via `update_option()`, then returns the post-set snapshot.
 *         Resets the application Config so the snapshot rebuild sees the new
 *         value rather than the stale cache.
 *
 * Allowed-keys whitelist + min/max bounds (1..2^30 for three keys, 0..2^30 for
 * max_lifespan), `manage_options` requirement, WP option keys. Throws
 * RuntimeException on validation / authorization failure;
 * CommandInterpreter::interpret() wraps as TM_COMMAND|TM_ERROR.
 *
 * Configuration-only verb; no service dependencies. The substrate Config
 * is a global accessed directly, matching the legacy controller and the
 * pattern in Status_CI / Discovery_CI.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

class Settings_CI_Node extends Service_CI_Node {

	/**
	 * Upper bound for all four integer settings (2^30 = 1 GiB). Matches
	 * legacy SettingsController::sanitize_value to keep the validator
	 * value-equivalent.
	 */
	private const MAX_INT_VALUE = 1073741824;

	/**
	 * Whitelist of {short-name => min} for the verbs. The WP option key is
	 * the short-name prefixed with `newspack_nodes_`. Three settings have
	 * min=1; max_lifespan accepts 0 (per legacy). The upper bound is
	 * shared (MAX_INT_VALUE).
	 *
	 * @var array<string,int>
	 */
	private const ALLOWED_KEYS = [
		'num_partitions' => 1,
		'num_segments'   => 1,
		'segment_size'   => 1,
		'max_lifespan'   => 0,
	];

	/**
	 * Build the canonical four-key snapshot from the substrate Config.
	 *
	 * @return array{num_partitions:int,num_segments:int,segment_size:int,max_lifespan:int}
	 */
	private static function snapshot(): array {
		$config = RuntimeConfig::load_config();
		/** @var int|float|string|bool|null $num_partitions */
		$num_partitions = $config['num_partitions'] ?? 0;
		/** @var int|float|string|bool|null $num_segments */
		$num_segments = $config['num_segments'] ?? 0;
		/** @var int|float|string|bool|null $segment_size */
		$segment_size = $config['segment_size'] ?? 0;
		/** @var int|float|string|bool|null $max_lifespan */
		$max_lifespan = $config['max_lifespan'] ?? 0;
		return [
			'num_partitions' => (int) $num_partitions,
			'num_segments'   => (int) $num_segments,
			'segment_size'   => (int) $segment_size,
			'max_lifespan'   => (int) $max_lifespan,
		];
	}

	/**
	 * Type-coerce + bounds-check. Value-equivalent with legacy
	 * SettingsController::sanitize_value (int branch only — the legacy
	 * whitelist is int-only).
	 *
	 * @param mixed $value Raw input.
	 * @param int   $min   Per-key minimum (inclusive).
	 * @param int   $max   Shared upper bound (inclusive).
	 * @return int|null Sanitized int, or null if rejected.
	 */
	private static function sanitize_int( mixed $value, int $min, int $max ): ?int {
		if ( ! \is_numeric( $value ) ) {
			return null;
		}
		$int = (int) $value;
		if ( $int < $min || $int > $max ) {
			return null;
		}
		return $int;
	}

	/**
	 * Schema-driven dispatch: each verb is declared once in `verbs[]` carrying
	 * its `handler`. The inherited Service_CI_Node ctor builds the commands
	 * table from this schema. Configuration-only verbs; no service dependencies.
	 *
	 * @api Used by substrate.
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Substrate-level integer settings: get / update num_partitions, num_segments, segment_size, max_lifespan.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'description' => 'Return the four substrate-owned integer settings as a snapshot.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						return self::snapshot();
					},
				],
				[
					'name'        => 'set',
					'description' => 'Set a single substrate-owned integer setting by its full option name, then return the post-set snapshot.',
					'args'        => [
						[ 'name' => 'option', 'type' => 'string', 'required' => true ],
						[ 'name' => 'value', 'type' => 'int', 'required' => true ],
					],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						self::require_manage_options();
						// Normalized positional receiver: `set <option> <value>`, one setting
						// per command — the grammar Settings_Sync_Node emits to fan a synced
						// setting out to spokes. `<option>` is the FULL `newspack_nodes_*` key.
						[ $option, $value ] = \array_pad( Command_Args::parse( $args )['positional'], 2, null );

						$short = \is_string( $option ) && \str_starts_with( $option, 'newspack_nodes_' )
							? \substr( $option, \strlen( 'newspack_nodes_' ) )
							: $option;
						if ( ! \is_string( $short ) || ! isset( self::ALLOWED_KEYS[ $short ] ) ) {
							throw new \RuntimeException( \esc_html( 'unknown setting: ' . (string) $option ) );
						}
						$sanitized = self::sanitize_int( $value, self::ALLOWED_KEYS[ $short ], self::MAX_INT_VALUE );
						if ( null === $sanitized ) {
							throw new \RuntimeException( \esc_html( "invalid value for setting: {$short}" ) );
						}

						\update_option( "newspack_nodes_{$short}", $sanitized, true );
						RuntimeConfig::reset();

						return self::snapshot();
					},
				],
			],
		] );
	}
}
