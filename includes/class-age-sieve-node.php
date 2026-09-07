<?php
/**
 * Age_Sieve
 *
 * Sheds stale work at a graph edge: forward a message whose TIMESTAMP age is
 * within `max_age`, drop everything older. A consumer resuming from its
 * offsetlog replays entries queued long before, and dispatching one of those
 * costs as much as fresh work for a result nobody reads; the sieve discards it
 * before that cost is spent. Event-logger-nodes' `job-router` and `job-feed`
 * topologies both wire `make_node Age_Sieve jobs:sieve 900 1` between their
 * Job_Router and `jobs:partition` for exactly that.
 *
 * Age is the SOLE criterion — there is no type gate — so an aged TM_COMMAND or
 * TM_EOF drops with the data. Keep control traffic off a sieved edge. Where
 * Tachikoma `cancel()`s a message it refuses, this port drops it, and without
 * `should_warn` that drop is silent: fill() returns nothing, so a producer
 * cannot tell a dropped message from a delivered one (ADR-13).
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
	 * A `max_age` token of zero or below is rewritten to the default without a
	 * warning. Tachikoma's `$max_age // 900` keeps a literal zero instead, so
	 * this port cannot express "drop everything older than the current tick".
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> The tokens as given, or the last set when $args is null.
	 * @throws \InvalidArgumentException When the `max_age` token is not numeric.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		// truthy() parses should_warn: `false` reads false here, true in Perl.
		$this->parse_schema_args( $args );
		if ( $this->max_age <= 0 ) {
			$this->max_age = self::DEFAULT_MAX_AGE;
		}
		return $args;
	}

	/**
	 * Drop the message when its age exceeds `max_age`, forward it otherwise.
	 *
	 * A non-numeric TIMESTAMP reads as 0.0, making the age the whole unix epoch
	 * and dropping the message. The stamp is all the sieve judges by, and
	 * `Message::new_message()` sets it on everything minted in process, so only
	 * a mangled wire record arrives without a usable one.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
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

	/** @api Introspection: the threshold in force; AgeSieve.pm's accessor also sets it. */
	public function max_age(): float {
		return $this->max_age;
	}

	/**
	 * Console-palette entry, and the argument list `parse_schema_args()` walks:
	 * `[ <max_age> [ should_warn ] ]`.
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
