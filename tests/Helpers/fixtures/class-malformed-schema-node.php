<?php
/**
 * Malformed_Schema_Node: a discoverable fixture whose node_schema()'s
 * commands[] and requests[] each mix malformed entries with a well-formed one.
 * Used by ClassesCITest to prove the catalog `dump` strip tolerates a
 * malformed verb (skips it) instead of fatal-ing the whole palette with a
 * TypeError.
 *
 * It lives in a separate file (not inline in the test) so the suite can register
 * it into the active composer classmap and exercise Classes_CI's real scan path.
 * Category is non-Hidden so the scan keeps it; it is a concrete Node subclass
 * under the registered `Newspack_Nodes\` prefix, ending in `_Node`.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Fixtures;

use Newspack_Nodes\Node;

class Malformed_Schema_Node extends Node {

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Fixture: a malformed verb entry coexists with a well-formed one.',
			'arguments'        => [],
			'commands'       => [
				[ 'name' => 'good', 'description' => 'Well-formed verb.', 'args' => [] ],
				'i-am-not-an-array',
			],
			'requests'       => [
				[
					'name'        => 'GET_KEA7713',
					'description' => 'Well-formed request.',
					'reply_shape' => '{ kea }',
					'handler'     => static fn (): array => [ 'kea' => 7713 ],
					'internal'    => 'an undeclared field the catalog must not carry',
				],
				[ 'description' => 'No name.' ],
				'i-am-not-an-array',
			],
		];
	}
}
