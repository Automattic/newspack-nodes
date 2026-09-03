<?php
/**
 * Age_Sieve
 *
 * Sheds stale work at a graph edge: forward a message whose TIMESTAMP age is
 * within `max_age`, drop everything older. A consumer resuming from its
 * offsetlog replays entries queued long before, and dispatching one of those
 * costs as much as fresh work for a result nobody reads; the sieve discards it
 * before that cost is spent. Event-logger-nodes wires
 * `make_node Age_Sieve jobs:sieve 900 1` between its Job_Router and
 * `jobs:partition` for exactly that.
 *
 * Age is the SOLE criterion — there is no type gate — so an aged TM_COMMAND or
 * TM_EOF goes with the data. Keep control traffic off a sieved edge.
 *
 * Modeled on Tachikoma's `AgeSieve.pm`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Age_Sieve node — `make_node Age_Sieve <name> [ <max_age> [ should_warn ] ]`.
 */
class Age_Sieve_Node extends Node {
	use Schema_Reflection;

	/** Seconds; Tachikoma's default and the non-positive-token fallback. */
	public const DEFAULT_MAX_AGE = 900.0;

	/** Seconds; a message older than this drops. Positional 0. */
	private float $max_age = self::DEFAULT_MAX_AGE;

	/** Whether a drop emits the rate-limited stderr warning. Positional 1. */
	private bool $should_warn = false;

	/**
	 * Assign `max_age` and `should_warn` from the positional tokens.
	 *
	 * A `max_age` of zero or below takes the default rather than its literal
	 * reading, which drops everything older than the current tick. Tachikoma's
	 * `//` keeps the zero, so a mistyped token there empties the stream.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> The tokens as given.
	 * @throws \InvalidArgumentException When the max_age token is not numeric.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		// truthy() in the trait, not a (bool) cast, reads `900 false` as off.
		$this->parse_schema_args( $args );
		if ( $this->max_age <= 0 ) {
			$this->max_age = self::DEFAULT_MAX_AGE;
		}
		return $args;
	}

	/**
	 * Drop the message when its age exceeds `max_age`, forward it otherwise.
	 *
	 * A missing or non-numeric TIMESTAMP reads as 0.0, which makes the age the
	 * whole unix epoch and drops the message. The stamp is all the sieve has to
	 * judge by, and `Message::new_message()` sets it on everything minted in
	 * process, so only a mangled wire record arrives without one.
	 *
	 * @param array<int,mixed> $message Message reference.
	 */
	public function fill( array $message ): void {
		$age = Core::$now - Core::num_float( $message[ Message::TIMESTAMP ], 0.0 );
		if ( $age > $this->max_age ) {
			if ( $this->should_warn ) {
				$this->print_less_often( "WARNING: age > {$this->max_age} - dropping messages" );
			}
			return;
		}
		parent::fill( $message );
	}

	/** @api Introspection: the threshold (Tachikoma accessor parity). */
	public function max_age(): float {
		return $this->max_age;
	}

	/**
	 * Palette entry and argument form for the topology console.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Filtering',
			'description' => 'Drops messages older than max_age seconds by TIMESTAMP (Tachikoma AgeSieve variant).',
			'arguments'   => [
				[ 'name' => 'max_age', 'type' => 'float', 'default' => self::DEFAULT_MAX_AGE, 'description' => 'Maximum message age in seconds.' ],
				[ 'name' => 'should_warn', 'type' => 'bool', 'default' => false, 'description' => 'Rate-limited warning on drops.' ],
			],
			'commands'    => [],
			'requests'    => [],
			'has_target'  => true,
		];
	}
}
