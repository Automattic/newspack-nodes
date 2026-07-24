<?php
/**
 * AgeSieve
 *
 * Port of Tachikoma's `AgeSieve.pm` (v2.0.280): drop any message whose
 * TIMESTAMP age exceeds `max_age`; everything younger passes through. No
 * type gating — age is the sole criterion, so keep control traffic off a
 * sieved edge. `should_warn` enables the rate-limited drop warning.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * AgeSieve node.
 */
class Age_Sieve_Node extends Node {
	use Schema_Reflection;

	public const DEFAULT_MAX_AGE = 900.0;

	private float $max_age = self::DEFAULT_MAX_AGE;

	private bool $should_warn = false;

	/**
	 * `[ <max_age> [ should_warn ] ]` — seconds, Tachikoma default 900.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->arguments   = $args;
		$max_age           = Core::num_float( $args[0] ?? 0, 0.0 );
		$this->max_age     = $max_age > 0 ? $max_age : self::DEFAULT_MAX_AGE;
		$this->should_warn = (bool) ( $args[1] ?? false );
		return $args;
	}

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

	/** @api Introspection (Tachikoma accessor parity). */
	public function max_age(): float {
		return $this->max_age;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Filtering',
			'description' => 'Drops messages older than max_age seconds by TIMESTAMP (Tachikoma AgeSieve port).',
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
