<?php
/**
 * Late_Node: a CONCRETE Node fixture whose namespace prefix is registered only
 * AFTER an initial resolve_class('Late') miss. It proves resolve_class does not
 * cache misses — a type that becomes resolvable after a later register_namespace()
 * must still resolve (no stale null).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Fixtures\LateProbe;

use Newspack_Nodes\Node;

class Late_Node extends Node {

	public function fill( array &$message ): void {
		++$this->counter;
		$this->sink?->fill( $message );
	}
}
