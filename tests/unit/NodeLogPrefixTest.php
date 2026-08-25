<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\NodeLogPrefixTestCase;

class NodeLogPrefixTest extends NodeLogPrefixTestCase {
	protected function topology_dir(): string {
		return \dirname( __DIR__, 2 ) . '/topologies';
	}
}
