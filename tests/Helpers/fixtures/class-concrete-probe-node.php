<?php
/**
 * Concrete_Probe_Node: the CONCRETE counterpart to the abstract Probe fixture,
 * matching the shell type `Probe` under a prefix scanned AFTER the abstract one.
 * resolve_class must skip the earlier abstract match and return THIS FQCN.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Fixtures\ConcreteProbe;

use Newspack_Nodes\Node;

class Probe_Node extends Node {

	public function fill( array &$message ): void {
		++$this->counter;
		$this->sink?->fill( $message );
	}
}
