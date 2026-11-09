<?php
/**
 * Compositions_CI: command-dispatch for the composition layer's layouts.
 *
 * A layout is serialized block markup a consumer's declared blocks compose
 * on one of its declared contexts (`Composition`), stored one option per
 * context (`Composition_Store`). Each command answers the layout as `read()`
 * answers it: `{ context, source, blocks, saved_ts, actor }`.
 *
 * Commands:
 *   get     — args `{context}`, at READ.
 *   save    — args `{context, markup}`, at TUNE: validates the markup, the
 *             context's `check` included, and stores it.
 *   restore — args `{context}`, at TUNE: stores the tombstone, so the
 *             context reads its default.
 *
 * `dispatch()` refuses a caller below the role each command declares
 * (ADR-26). A refusal throws, and `interpret()` answers it as
 * TM_COMMAND|TM_ERROR.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Composition_Store;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * Read, save and restore a context's layout.
 */
class Compositions_CI_Node extends Service_CI_Node {

	/**
	 * The console manifest and the command table in one declaration, each
	 * command's `capability` the role `dispatch()` refuses below (ADR-26).
	 *
	 * @api Used by the substrate to provide UI etc.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$context = [
			'name'        => 'context',
			'type'        => 'string',
			'required'    => true,
			'description' => 'A declared composition context, `<namespace>/<name>`.',
		];
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Block layouts a consumer composes: get / save / restore.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'capability'  => Capabilities::READ,
					'description' => 'Read the layout a context composes, saved or its default.',
					'args'        => [ $context ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => Composition_Store::read( Core::as_string( $args['context'] ) ),
				],
				[
					'name'        => 'save',
					'capability'  => Capabilities::TUNE,
					'description' => 'Validate a layout and store it for a context: `save <context> <markup>`.',
					'args'        => [
						$context,
						[ 'name' => 'markup', 'type' => 'string', 'required' => true, 'description' => 'Serialized block markup holding only the context\'s declared blocks.' ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => Composition_Store::save( Core::as_string( $args['context'] ), Core::as_string( $args['markup'] ) ),
				],
				[
					'name'        => 'restore',
					'capability'  => Capabilities::TUNE,
					'description' => 'Restore a context\'s default layout for every reader.',
					'args'        => [ $context ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => Composition_Store::restore( Core::as_string( $args['context'] ) ),
				],
			],
		] );
	}
}
