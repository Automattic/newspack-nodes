<?php
/**
 * Settings_CI: the command surface for the substrate's integer settings.
 *
 * Mounted as `settings` on the request-scope interpreter by
 * `newspack_nodes_mount_substrate_cis()`.
 *
 * The settings page is one door onto substrate config and this interpreter is
 * the other, so both read `Settings_Schema`. The key set, the per-key bounds
 * and the worker-restart class are declared once, and a verb cannot clamp to
 * limits the page does not.
 *
 * Verbs:
 *   get — return the seven storage settings as one snapshot: num_partitions,
 *         segment_size, min_segments, num_segments, min_lifetime, lifetime,
 *         max_segments. They are EFFECTIVE values, so a key never saved
 *         reports its schema default rather than an empty option.
 *   set — write one integer setting, then answer with the post-write
 *         snapshot. `Settings_Sync_Node` mints this verb to push a hub's
 *         settings out to its spokes, and reads the reply to confirm
 *         convergence. A value already in place still answers with the
 *         snapshot, writing nothing and signalling no restart.
 *
 * `set` reaches every `int` Field declaring a minimum — the storage keys, the
 * `remote_*` spoke geometry, the alert thresholds and the `sse_*` limits —
 * while `get` answers with the seven storage keys alone.
 *
 * Every refusal throws `RuntimeException`, which
 * `Command_Interpreter_Node::interpret()` wraps as TM_COMMAND|TM_ERROR: an
 * unknown key, a non-numeric or out-of-bounds value, and the capability check
 * `Service_CI_Node` wraps around each handler. Answering with a refusal
 * string instead would leave the hub unable to tell one from a snapshot.
 *
 * Configuration only, with no service dependencies: the substrate `Config` is
 * a global this reads directly, as `Status_CI` does.
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

/**
 * The `settings` service interpreter: schema-bounded `get` and `set`.
 */
class Settings_CI_Node extends Service_CI_Node {

	/**
	 * `get` verb handler — the current substrate-settings snapshot.
	 *
	 * @return array<string,mixed> The seven storage settings.
	 */
	public static function cmd_get(): array {
		return self::snapshot();
	}

	/**
	 * `set` verb handler — write one substrate integer setting, then return the
	 * post-write snapshot.
	 *
	 * Takes `<option> <value>` positionally. The option name is accepted with
	 * or without the `newspack_nodes_` prefix: the hub pushes the full WP
	 * option name, while an operator at the REPL types the short key.
	 *
	 * A write is followed by two steps before the snapshot is read back. The
	 * substrate Config is reset, so the snapshot rebuilds from the new value
	 * rather than the cache frozen at first read. `Restart_Planner` then
	 * recycles the workers the Field's restart class names and asks every
	 * other live worker to re-read its config, which is what keeps a field
	 * classified `[]` from waiting out a whole worker lifetime.
	 *
	 * @param list<string> $args Verb argument tokens.
	 *
	 * @return array<string,mixed> The seven storage settings, read after the write.
	 * @throws \RuntimeException When the name is not a bounded `int` Field, or the value falls outside its bounds.
	 */
	public static function cmd_set( array $args ): array {
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
	 * Every key is read through the fail-loud `Config::value()` rather than
	 * `get_option()`: that resolves the EFFECTIVE value — option, per-request
	 * overlay or schema default — and throws on a key no schema declares, so a
	 * renamed key surfaces here instead of reporting a silent zero.
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
	 * Coerce to int and bounds-check, answering null so the caller words the
	 * refusal in its own voice. Int-only because `cmd_set` rejects every Field
	 * whose type is not `int` before reaching here.
	 *
	 * @param mixed $value Raw input token.
	 * @param int   $min   The Field's minimum (inclusive).
	 * @param int   $max   The Field's maximum (inclusive), or PHP_INT_MAX when it declares none.
	 * @return int|null Sanitized int, or null when the token is non-numeric or out of bounds.
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
	 * Palette entry and verb declaration: each verb is declared ONCE in
	 * `commands[]`, carrying its handler and the capability role it demands.
	 * The inherited `Service_CI_Node` constructor builds the dispatch table
	 * from this and gates every handler on the declared role, so no hand-built
	 * table can drift from what the catalog and `help` advertise.
	 *
	 * `get` is READ because a snapshot changes nothing; `set` is TUNE, the
	 * role covering declared configuration.
	 *
	 * @api Used by substrate.
	 * @return array<string,mixed>
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
