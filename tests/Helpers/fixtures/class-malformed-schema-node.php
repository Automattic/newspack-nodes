<?php
/**
 * Malformed_Schema_Node: a discoverable fixture whose node_schema()'s verbs[]
 * mixes a non-array entry (a bare string) with a well-formed verb. Used by
 * ClassesCITest to prove the catalog `list` strip tolerates a malformed verb
 * (skips it) instead of fatal-ing the whole palette with a TypeError.
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
			'ctor'        => [],
			'commands'       => [
				[ 'name' => 'good', 'description' => 'Well-formed verb.', 'args' => [] ],
				'i-am-not-an-array',
			],
		];
	}
}
