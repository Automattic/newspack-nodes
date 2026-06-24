<?php
/**
 * Abstract_Probe_Node: a fixture that is an ABSTRACT Node subclass matching the
 * shell type `Probe`. Registered under a prefix that resolve_class scans BEFORE
 * the concrete-Probe prefix, so it proves resolve_class skips an abstract match
 * and keeps walking to the concrete one (mirroring the old make_node loop).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Fixtures\AbstractProbe;

use Newspack_Nodes\Node;

abstract class Probe_Node extends Node {
}
