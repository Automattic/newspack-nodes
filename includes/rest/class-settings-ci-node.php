<?php
/**
 * Settings_CI: command-dispatch for the substrate-level integer settings.
 *
 * A CommandInterpreter that mounts at priority 11 alongside the rest of the
 * M2 service CIs.
 *
 * Verbs:
 *   get — returns the seven substrate-owned integer settings as a snapshot
 *         (num_partitions, segment_size, min_segments, num_segments,
 *         min_lifetime, lifetime, max_segments). The matching getter dashboards diff against.
 *   set — applies a single setting by its full `newspack_nodes_*` option name
 *         (the positional grammar Settings_Sync_Node fans out to spokes),
 *         writes via `update_option()`, then returns the post-set snapshot.
 *         Resets the application Config so the snapshot rebuild sees the new
 *         value rather than the stale cache. A `set` to the value already
 *         stored still answers with the snapshot, but writes nothing and
 *         signals neither a restart nor a reload.
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

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Settings_Schema;

\defined( 'ABSPATH' ) || exit;

class Settings_CI_Node extends Service_CI_Node {

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
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_set( array $args ): array {
		// Positional: set <option> <value>; <option> is the full option key.
		[ $option, $value ] = \array_pad( Command_Args::parse( $args )['positional'], 2, null );

		$prefix = Settings_Schema::get()->prefix();
		$short  = \is_string( $option ) && \str_starts_with( $option, $prefix )
			? \substr( $option, \strlen( $prefix ) )
			: $option;
		$field = \is_string( $short )
			? Settings_Schema::get()->field_for_short( $short )
			: null;
		// One declaration: same key set and same bounds as the settings page.
		if ( null === $field || 'int' !== $field->type || null === $field->min ) {
			throw new \RuntimeException( \esc_html( 'unknown setting: ' . (string) $option ) );
		}
		$sanitized = self::sanitize_int( $value, $field->min, $field->max ?? \PHP_INT_MAX );
		if ( null === $sanitized ) {
			throw new \RuntimeException( \esc_html( "invalid value for setting: {$short}" ) );
		}

		// @longform A `set` to a value already in place is a no-op, not a
		// save. Settings_Sync re-pushes every registered option on its
		// sweep whether or not it moved, so acting on an unchanged push
		// recycles the whole fleet every sweep. The admin path is gated
		// for free: `updated_option` never fires.
		$stored = \get_option( $prefix . $short, null );
		if ( null !== $stored && $sanitized === Core::as_int( $stored ) ) {
			return self::snapshot();
		}

		\update_option( $prefix . $short, $sanitized, true );
		RuntimeConfig::reset();
		Restart_Planner::plan( Settings_Schema::get()->restart_for( $short ) );

		return self::snapshot();
	}

	/**
	 * Build the canonical seven-key snapshot from the substrate Config.
	 *
	 * @return array{num_partitions:int,segment_size:int,min_segments:int,num_segments:int,min_lifetime:int,lifetime:int,max_segments:int}
	 */
	private static function snapshot(): array {
		/** @var int|float|string|bool|null $num_partitions */
		$num_partitions = RuntimeConfig::value( 'num_partitions' );
		/** @var int|float|string|bool|null $segment_size */
		$segment_size = RuntimeConfig::value( 'segment_size' );
		/** @var int|float|string|bool|null $min_segments */
		$min_segments = RuntimeConfig::value( 'min_segments' );
		/** @var int|float|string|bool|null $num_segments */
		$num_segments = RuntimeConfig::value( 'num_segments' );
		/** @var int|float|string|bool|null $min_lifetime */
		$min_lifetime = RuntimeConfig::value( 'min_lifetime' );
		/** @var int|float|string|bool|null $lifetime */
		$lifetime = RuntimeConfig::value( 'lifetime' );
		/** @var int|float|string|bool|null $max_segments */
		$max_segments = RuntimeConfig::value( 'max_segments' );
		return [
			'num_partitions' => (int) $num_partitions,
			'segment_size'   => (int) $segment_size,
			'min_segments'   => (int) $min_segments,
			'num_segments'   => (int) $num_segments,
			'min_lifetime'   => (int) $min_lifetime,
			'lifetime'       => (int) $lifetime,
			'max_segments'   => (int) $max_segments,
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
			'description' => 'Substrate-level integer settings: get / update num_partitions, segment_size, min_segments, num_segments, min_lifetime, lifetime, max_segments.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'capability'  => Capabilities::READ,
					'description' => 'Return the seven substrate-owned integer settings as a snapshot.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_get(),
				],
				[
					'name'        => 'set',
					'capability'  => Capabilities::TUNE,
					'description' => 'Set a single substrate-owned integer setting by its full option name, then return the post-set snapshot.',
					'args'        => [
						[ 'name' => 'option', 'type' => 'string', 'required' => true ],
						[ 'name' => 'value', 'type' => 'int', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_set( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
