<?php
/**
 * Classes_CI: the node-class catalog behind the topology console's palette.
 *
 * The `dump` verb scans the composer classmap for concrete `*_Node` classes
 * under a registered namespace prefix, inlines the serializable half of each
 * `node_schema()`, drops the classes the palette must not offer, sorts by
 * `[category, shell_name]`, and ships the formatter registry beside them so an
 * argument naming a formatter has a list to choose from.
 *
 * Discovery reads the classmap rather than a class registry (ADR-10): a plugin
 * registers its namespace prefix once, and every node type it adds after that
 * is a class and nothing more. The cost is that a class added or renamed
 * without `composer dump-autoload -o` is absent from the palette, with nothing
 * else wrong.
 *
 * Like the other service interpreters, this extends Service_CI_Node: the verb is
 * declared once in `node_schema()` carrying its handler and its capability, and
 * the base derives the dispatch table and the capability gate from that.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Composer\Autoload\ClassLoader;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Core;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Formatters;
use Newspack_Nodes\Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tee_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * Service interpreter for the `classes` scope: one read-only verb, `dump`.
 */
class Classes_CI_Node extends Service_CI_Node {
	/**
	 * What a command entry carries past `strip_entries()`: `args` always, and
	 * three flags — `multiple` renders one row per invocation, `hidden` drops
	 * the Inspector's verb button, `action` keeps the verb out of the editor.
	 */
	private const COMMAND_FIELDS = [
		'args'     => 'always',
		'multiple' => 'flag',
		'hidden'   => 'flag',
		'action'   => 'flag',
	];

	/** What a request entry carries past `strip_entries()`: `args` and `reply_shape`, where declared. */
	private const REQUEST_FIELDS = [
		'args'        => 'if_set',
		'reply_shape' => 'string',
	];

	/**
	 * `dump` verb: every concrete Node class this process can build, each
	 * carrying the serializable half of its `node_schema()`, plus the names the
	 * formatter registry holds.
	 *
	 * Four gates decide membership, cheapest first — the FQCN sits under a
	 * namespace prefix registered through `Command_Interpreter_Node`, its short
	 * name ends in `_Node`, it is a concrete `Node` subclass, and its schema
	 * offers the class to the palette. Only the last two load the class and call
	 * into it, so the two string tests run first on a classmap holding every
	 * class in the process. The palette gate refuses three shapes: a `Hidden`
	 * category, no category at all, and the `hidden` flag a node with no patron
	 * raises to keep itself off both palette and canvas.
	 *
	 * The console reads this as one slice of its batched poll, so the whole
	 * catalog is a single payload and no class costs a follow-up request.
	 *
	 * @return array<string,mixed> `classes`, sorted by `[category, shell_name]`, and the sorted `formatters` names.
	 */
	public static function cmd_dump(): array {
		$prefixes = Command_Interpreter_Node::registered_namespaces();
		$seen     = [];
		$classes  = [];
		foreach ( ClassLoader::getRegisteredLoaders() as $loader ) {
			foreach ( \array_keys( $loader->getClassMap() ) as $fqcn ) {
				if ( isset( $seen[ $fqcn ] ) ) {
					continue;
				}
				// (a) under a registered namespace prefix (string match).
				$under = false;
				foreach ( $prefixes as $prefix ) {
					if ( \str_starts_with( $fqcn, $prefix ) ) {
						$under = true;
						break;
					}
				}
				if ( ! $under ) {
					continue;
				}
				// (b) short name ends with `_Node`.
				$short = \strpos( $fqcn, '\\' ) !== false
					? \substr( (string) \strrchr( $fqcn, '\\' ), 1 )
					: $fqcn;
				if ( ! \str_ends_with( $short, '_Node' ) ) {
					continue;
				}
				// (c) concrete Node subclass; node_schema() guaranteed by base.
				if ( ! \is_subclass_of( $fqcn, Node::class ) ) {
					continue;
				}
				if ( ( new \ReflectionClass( $fqcn ) )->isAbstract() ) {
					continue;
				}
				$schema = $fqcn::node_schema();
				$cat    = $schema['category'] ?? '';
				// (d) skip non-palette: Hidden, empty category, or hidden flag.
				if ( 'Hidden' === $cat || '' === $cat || ! empty( $schema['hidden'] ) ) {
					continue;
				}
				$seen[ $fqcn ]   = true;
				$schema_commands = $schema['commands'] ?? [];
				$classes[]       = [
					'shell_name'     => \substr( $short, 0, -\strlen( '_Node' ) ),
					'fqcn'           => $fqcn,
					'category'       => $cat,
					'description'    => $schema['description'] ?? '',
					'arguments'      => $schema['arguments']   ?? [],
					// Strip non-serializable handler; keep palette fields.
					'commands'       => self::strip_entries( Core::arr( $schema_commands ), self::COMMAND_FIELDS ),
					'requests'       => self::strip_entries( Core::arr( $schema['requests'] ?? [] ), self::REQUEST_FIELDS ),
					// Valid register events; inspector UI lists them per node.
					'registrations'  => $schema['registrations'] ?? [],
					'accepts_fill'   => (bool) ( $schema['accepts_fill'] ?? true ),
					'has_target'     => (bool) ( $schema['has_target']   ?? true ),
					// An interpreter is addressed directly; others via :config.
					'is_interpreter' => \is_subclass_of( $fqcn, Command_Interpreter_Node::class ),
					// A fan-out target is a LIST; the editor renders chips.
					'fans_out'       => Core::class_fans_out( $fqcn ),
				];
			}
		}
		\usort(
			$classes,
			static fn ( $a, $b ) =>
				[ $a['category'], $a['shell_name'] ] <=>
				[ $b['category'], $b['shell_name'] ]
		);
		$formatters = Formatters::list_names();
		\sort( $formatters );
		return [
			'classes'    => $classes,
			'formatters' => $formatters,
		];
	}

	/**
	 * Strip node_schema entries — `commands[]` or `requests[]` — to the
	 * serializable fields the console renders: `name` and `description`, then
	 * each field `$fields` names, kept by its rule. The non-serializable
	 * `handler`, the `capability` the base gate enforces server-side, and any
	 * field no rule names stay server-side, so the strip fails closed.
	 *
	 * Rules: `always` keeps the value, `[]` when absent; `if_set` keeps a set
	 * value; `string` keeps a set value as a string; `flag` keeps `true` for a
	 * non-empty value. Fail-soft: a non-array or nameless entry is skipped
	 * rather than thrown, because one bad class must not fatal the whole
	 * catalog `dump`. Returns a list, which the palette consumes as a JSON array.
	 *
	 * @param array<int|string,mixed>                          $entries Raw entries from a node_schema.
	 * @param array<string,'always'|'if_set'|'string'|'flag'> $fields  Field => keep rule.
	 * @return list<array<string,mixed>>
	 */
	private static function strip_entries( array $entries, array $fields ): array {
		$stripped = [];
		foreach ( $entries as $entry ) {
			if ( ! \is_array( $entry ) ) {
				continue;
			}
			$name = Core::as_string( $entry['name'] ?? '' );
			if ( '' === $name ) {
				continue;
			}
			$kept = [
				'name'        => $name,
				'description' => Core::as_string( $entry['description'] ?? '' ),
			];
			foreach ( $fields as $field => $rule ) {
				$value = $entry[ $field ] ?? null;
				$value = match ( $rule ) {
					'always' => $value ?? [],
					'if_set' => $value,
					'string' => null === $value ? null : Core::as_string( $value ),
					'flag'   => empty( $value ) ? null : true,
				};
				if ( null !== $value ) {
					$kept[ $field ] = $value;
				}
			}
			$stripped[] = $kept;
		}
		return $stripped;
	}

	/**
	 * The manifest and the verb table in one declaration: `Service_CI_Node`
	 * builds the dispatch table from `commands[]` and gates each handler at the
	 * capability its entry names.
	 *
	 * `dump` is READ because it exposes class metadata and nothing else — no
	 * fleet state, no credentials — so a dashboard-only role can fill a palette.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Class catalog: enumerate every registered node class with its inlined node_schema, plus the formatter registry.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'dump',
					'capability'  => Capabilities::READ,
					'description' => 'Dump every registered class with its schema, plus the formatters.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_dump(),
				],
			],
		] );
	}

}
