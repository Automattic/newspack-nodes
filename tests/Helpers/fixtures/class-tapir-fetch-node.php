<?php
/**
 * A broker that is no Remote_Source: a direct Remote_Broker subclass, for
 * pinning that what recognizes a broker does so by the base class.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

use Newspack_Nodes\Remote_Consumer_Node;

\defined( 'ABSPATH' ) || exit;

class Tapir_Fetch_Node extends \Newspack_Nodes\Remote_Broker_Node {
	protected function housekeep(): void {}

	protected function settle_reply( array $message ): void {}

	public function restream(): void {}

	public function refill( Remote_Consumer_Node $child ): void {}
}
