<?php
/**
 * Settings_CI: command-dispatch for the substrate-level integer settings.
 *
 * A CommandInterpreter that mounts at priority 11 alongside the rest of the
 * M2 service CIs.
 *
 * Verbs:
 *   get — returns the six substrate-owned integer settings as a snapshot
 *         (num_partitions, segment_size, min_segments, max_segments,
 *         min_lifetime, max_lifetime). The matching getter dashboards diff against.
 *   set — applies a single setting by its full `newspack_nodes_*` option name
 *         (the positional grammar Settings_Sync_Node fans out to spokes),
 *         writes via `update_option()`, then returns the post-set snapshot.
 *         Resets the application Config so the snapshot rebuild sees the new
 *         value rather than the stale cache.
 *
 * Allowed-keys whitelist + min/max bounds (1..2^30 for the count/size keys,
 * 0..2^30 for the lifetime keys), `manage_options` requirement, WP option keys. Throws
 * RuntimeException on validation / authorization failure;
 * CommandInterpreter::interpret() wraps as TM_COMMAND|TM_ERROR.
 *
 * Configuration-only verb; no service dependencies. The substrate Config
 * is a global accessed directly, matching the pattern in Status_CI /
 * Discovery_CI.
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
	 * Whitelist of {short-name => min} for the verbs. The WP option key is
	 * the short-name prefixed with `newspack_nodes_`. The count/size settings
	 * have min=1; the lifetime settings accept 0. The upper bound is
	 * shared (MAX_INT_VALUE).
	 *
	 * @var array<string,int>
	 */
	private const ALLOWED_KEYS = [
		'num_partitions' => 1,
		'segment_size'   => 1,
		'min_segments'   => 1,
		'max_segments'   => 1,
		'min_lifetime'   => 0,
		'max_lifetime'   => 0,
	];

	/**
	 * Upper bound for all integer settings (2^30 = 1 GiB), enforced by
	 * the validator.
	 */
	private const MAX_INT_VALUE = 1073741824;
	/**
	 * `get` verb handler — the current substrate-settings snapshot.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_get(): array {
		return self::snapshot();
	}

	/**
	 * `set` verb handler — set one substrate integer setting by full option name, return the post-set snapshot.
	 *
	 * @param string $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_set( string $args ): array {
		self::require_manage_options();
		// Positional: set <option> <value>; <option> is the full option key.
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
	}

	/**
	 * Build the canonical six-key snapshot from the substrate Config.
	 *
	 * @return array{num_partitions:int,segment_size:int,min_segments:int,max_segments:int,min_lifetime:int,max_lifetime:int}
	 */
	private static function snapshot(): array {
		/** @var int|float|string|bool|null $num_partitions */
		$num_partitions = RuntimeConfig::value( 'num_partitions' );
		/** @var int|float|string|bool|null $segment_size */
		$segment_size = RuntimeConfig::value( 'segment_size' );
		/** @var int|float|string|bool|null $min_segments */
		$min_segments = RuntimeConfig::value( 'min_segments' );
		/** @var int|float|string|bool|null $max_segments */
		$max_segments = RuntimeConfig::value( 'max_segments' );
		/** @var int|float|string|bool|null $min_lifetime */
		$min_lifetime = RuntimeConfig::value( 'min_lifetime' );
		/** @var int|float|string|bool|null $max_lifetime */
		$max_lifetime = RuntimeConfig::value( 'max_lifetime' );
		return [
			'num_partitions' => (int) $num_partitions,
			'segment_size'   => (int) $segment_size,
			'min_segments'   => (int) $min_segments,
			'max_segments'   => (int) $max_segments,
			'min_lifetime'   => (int) $min_lifetime,
			'max_lifetime'   => (int) $max_lifetime,
		];
	}

	/**
	 * Type-coerce + bounds-check. Int-only: the settings whitelist is
	 * entirely integer-valued.
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
			'description' => 'Substrate-level integer settings: get / update num_partitions, segment_size, min_segments, max_segments, min_lifetime, max_lifetime.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'description' => 'Return the six substrate-owned integer settings as a snapshot.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array => self::cmd_get(),
				],
				[
					'name'        => 'set',
					'description' => 'Set a single substrate-owned integer setting by its full option name, then return the post-set snapshot.',
					'args'        => [
						[ 'name' => 'option', 'type' => 'string', 'required' => true ],
						[ 'name' => 'value', 'type' => 'int', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array => self::cmd_set( $args ),
				],
			],
		] );
	}

}
