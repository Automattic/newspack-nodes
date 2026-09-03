<?php
/**
 * Topologies_CI: command-dispatch for the substrate's topology files.
 *
 * A topology is a `.tsl` file describing a node graph. Stock copies the plugin
 * ships own their names — `Topology_Registry::resolve()` reads the stock dirs
 * before the user dir — so a user file saved under a stock name would sit
 * inert, and save refuses one. Save under a new name and `include` the stock
 * one; this interpreter writes and deletes only inside the user dir.
 *
 * Verbs:
 *   list   — no args. Returns `{topologies: [{name, source, active,
 *            num_partitions, frontmatter, includes}], user_dir}`. `source` is
 *            'user'|'stock'|'both'; `active` is the catalog narrowed by the
 *            `topologies` config key, which is what a spawn would start;
 *            `num_partitions` is the canonical count (Bootstrap::num_partitions_for).
 *   get    — args `{name}`. Returns `{name, source, tsl, includes, expanded,
 *            resolved_config_edges}`, and throws on an unknown name.
 *            `expanded` contains only borrowed include members, while
 *            `resolved_config_edges` carries the whole topology's
 *            token-resolved config routing for the console's seed.
 *   save   — args `{name, tsl}`. Returns `{name, path, shadows_stock,
 *            restarted_fleets}`, under a 1 MiB envelope cap. The body is
 *            dry-run validated through Shell_Node::parse_statements and
 *            Topology_Analyzer::expand, which rejects an unknown include, a
 *            cycle, or a make_node the body and an include declare differently
 *            — each of which would otherwise save clean and kill the worker at
 *            its next spawn. Every catalogued topology whose graph composes the
 *            name then restarts.
 *   expand — args `{names…}`. Returns `{nodes, edges, tree, hulls}` for an
 *            include SET: the composed graph with provenance (`origin` = the
 *            directly-declared includes providing a node, a LIST since a
 *            diamond-shared node has several; `via` = the path it entered
 *            through; `hulls` = the node set of every topology in the tree, one
 *            outline per include the canvas draws). Informational — the runtime
 *            is the Shell's `include`. The console's edit-mode baseline.
 *   delete — args `{name}`. Returns `{name, deleted, stock_fallback,
 *            pruned_active, restarted_fleets}`. User copy only (stock immutable);
 *            restarts the affected fleets (symmetry with save). When no stock
 *            fallback remains, prunes the now-orphaned name from the active
 *            set (`newspack_nodes_topologies`); `pruned_active` reports whether it
 *            was present and removed.
 *   activate   — args `{name}`. Adds the name to the persisted active set
 *                (`newspack_nodes_topologies` option), invalidates the config
 *                cache and spawns the fleet, all through the shared
 *                `Topology_Registry::activate()`. Returns
 *                `{name, active:true, spawned:<int>}`.
 *   deactivate — args `{name}`. Removes the name from the active set, invalidates
 *                the config cache and drains the fleet, through
 *                `Topology_Registry::deactivate()`. Returns `{name, active:false}`.
 *   connect_worker_input — args `{reader}`. Mounts that worker's input Partition
 *                into this request's graph and answers nothing, so a command
 *                addressed TO the worker later in the same POST batch resolves
 *                instead of bouncing NOT_AVAILABLE.
 *
 * Each verb names its role in `node_schema()` — READ for `list`, `get` and
 * `expand`, the MANAGE default for the rest — and `Service_CI_Node::commands()`
 * wraps every handler in that check; the name and body helpers come from the
 * same base. A refusal throws RuntimeException, which
 * `Command_Interpreter_Node::interpret()` returns as TM_COMMAND|TM_ERROR, and an
 * array a verb returns rides as the reply's VALUE untouched, never separately
 * JSON-encoded.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

/**
 * List, read, write, delete and activate topology files, plus the request-scope
 * worker-input mount the console's attached command channel rides.
 */
class Topologies_CI_Node extends Service_CI_Node {

	/**
	 * Ceiling on the packed command envelope, in bytes — 1 MiB. A `.tsl` runs to
	 * a few kilobytes, so the cap refuses a runaway body without bounding any
	 * topology an operator would write.
	 */
	private const MAX_BODY_BYTES = 1048576;

	/**
	 * `list` verb handler — every registered topology, its source and its active
	 * state.
	 *
	 * Each row carries the topology's direct includes, so the console draws the
	 * composition without a `get` per row, and the rows are sorted by name so it
	 * renders a stable order.
	 *
	 * @return array<int|string,mixed> `{topologies, user_dir}`.
	 */
	public static function cmd_list(): array {
		// Active = what the fleet would spawn (catalog + overlay).
		$resolved = Bootstrap::get_topologies();
		$active   = [];
		foreach ( $resolved as $name => $_def ) {
			if ( '' !== $name ) {
				$active[ $name ] = true;
			}
		}

		$out = [];
		foreach ( Topology_Registry::describe() as $name => $sources ) {
			$out[] = [
				'name'           => $name,
				'source'         => self::source_of( $sources ),
				'active'         => isset( $active[ $name ] ),
				'num_partitions' => Bootstrap::num_partitions_for( $name ),
				'frontmatter'    => Topology_Analyzer::frontmatter( $name ),
				'includes'       => self::direct_includes( $name ),
			];
		}
		\usort( $out, static fn ( $a, $b ) => $a['name'] <=> $b['name'] );

		return [
			'topologies' => $out,
			'user_dir'   => Topology_Registry::user_dir(),
		];
	}

	/**
	 * `get` verb handler — one topology's TSL and the metadata the console opens
	 * it with.
	 *
	 * The two composed views answer different questions, so neither can serve as
	 * the other. `expanded` composes the body's INCLUDES alone, which is what
	 * lets the editor render a borrowed node as borrowed; expanding the topology
	 * itself would fold the body's own nodes in and make them uneditable.
	 * `resolved_config_edges` expands the whole topology, because a config verb
	 * pointed at a `<ns:key>` token names an edge only the server can resolve,
	 * and the canvas draws that edge from the body's own nodes too.
	 *
	 * @param list<string> $args Verb tokens; the topology name is the first.
	 *
	 * @return array<int|string,mixed> `{name, source, tsl, includes, expanded, resolved_config_edges}`.
	 * @throws \RuntimeException When the name is not file-name safe, resolves to no file, or names a file that cannot be read.
	 */
	public static function cmd_get( array $args ): array {
		$name = self::require_valid_name( $args[0] ?? '' );

		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			throw new \RuntimeException(
				\esc_html( "no topology named: $name" )
			);
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_get_contents,WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Path is always a local .tsl file resolved via Topology_Registry; never a URL.
		$tsl = @\file_get_contents( $path );
		if ( false === $tsl ) {
			throw new \RuntimeException(
				\esc_html( "failed to read topology file: $path" )
			);
		}
		$sources = Topology_Registry::describe()[ $name ] ?? [
			'user'  => null,
			'stock' => [],
		];

		// Composed graph rides along: the console seeds its canvas from this.
		$includes              = self::direct_includes_from_tsl( $tsl );
		$resolved_config_edges = \array_values(
			\array_filter(
				Topology_Analyzer::expand( [ $name ] )['edges'],
				static fn ( array $edge ): bool => \in_array( 'config', $edge['roles'], true )
			)
		);

		return [
			'name'                  => $name,
			'source'                => self::source_of( $sources ),
			'tsl'                   => $tsl,
			'includes'              => $includes,
			'expanded'              => Topology_Analyzer::expand( $includes ),
			'resolved_config_edges' => $resolved_config_edges,
		];
	}

	/**
	 * Reduce a Topology_Registry::describe() entry to its 'user'|'stock'|'both'
	 * label (shared by list+get so the source flag stays consistent).
	 *
	 * @param array{user:?string,stock:array<int,string>} $sources describe() entry.
	 *
	 * @return string One of 'user', 'stock' or 'both'.
	 */
	private static function source_of( array $sources ): string {
		$has_user  = null !== ( $sources['user'] ?? null );
		$has_stock = ! empty( $sources['stock'] );
		if ( $has_user && $has_stock ) {
			return 'both';
		}
		return $has_user ? 'user' : 'stock';
	}

	/**
	 * `save` verb handler — validate a topology body, then write it to the user
	 * dir.
	 *
	 * Validation is a dry run of the loader's own front-end, so a refusal names
	 * the physical line the operator typed. Nothing reaches disk until the whole
	 * include set resolves: a body that parses can still kill the worker at its
	 * next spawn.
	 *
	 * @param list<string>            $args     Verb tokens: the name, then the whole TSL body.
	 * @param array<int|string,mixed> $envelope The inbound TM_COMMAND message, whose packed size the 1 MiB cap measures.
	 *
	 * @return array<int|string,mixed> `{name, path, shadows_stock, restarted_fleets}`.
	 * @throws \RuntimeException When the envelope exceeds the cap, the name is invalid or stock-owned, the body is empty or fails validation, or the dir or file cannot be written.
	 */
	public static function cmd_save( array $args, array $envelope = [] ): array {
		// $envelope is the 7-field positional message array (a list).
		if ( \array_is_list( $envelope ) && Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
			throw new \RuntimeException(
				\esc_html( 'body too large: topology arguments exceed 1 MiB' )
			);
		}
		[ $name_raw, $tsl ] = self::split_first_token( $args );
		$name = self::require_valid_name( $name_raw );
		if ( '' === $tsl ) {
			throw new \RuntimeException( 'invalid arguments: tsl (topology body) is required' );
		}

		// The loader's own front-end validates, and names the PHYSICAL line.
		try {
			Shell_Node::parse_statements( $tsl );
			$borrowed = Topology_Analyzer::expand( self::direct_includes_from_tsl( $tsl ) );
			self::assert_no_borrowed_node_conflict( $tsl, $borrowed['nodes'] );
		} catch ( \RuntimeException $e ) {
			// Topology_Analyzer::expand already esc_html's its thrown messages.
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
			throw new \RuntimeException( "validation failed: {$e->getMessage()}" );
		}

		$path     = self::user_path( $name );
		$user_dir = Topology_Registry::user_dir();
		if ( ! \is_dir( $user_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			$made = @\mkdir( $user_dir, 0700, true );
			if ( ! $made && ! \is_dir( $user_dir ) ) {
				throw new \RuntimeException(
					\esc_html( "failed to create user dir: $user_dir" )
				);
			}
		}

		// A user file under a stock name would sit inert; refuse the write.
		$pre_sources = Topology_Registry::describe()[ $name ] ?? [ 'stock' => [] ];
		if ( ! empty( $pre_sources['stock'] ) ) {
			throw new \RuntimeException(
				\esc_html( "refusing to write \"$name\": a stock topology owns that name. Save under a new name and `include $name`." )
			);
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$bytes = @\file_put_contents( $path, $tsl );
		if ( false === $bytes ) {
			throw new \RuntimeException(
				\esc_html( "failed to write topology file: $path" )
			);
		}

		// The file changed under the memoized readers.
		Topology_Registry::reset_basename_cache();

		$restarted = self::restart_affected_fleets( $name );

		return [
			'name'             => $name,
			'path'             => $path,
			// Always false: a stock name is refused above, so nothing shadows.
			'shadows_stock'    => false,
			'restarted_fleets' => $restarted,
		];
	}

	/**
	 * Throw if the saved body redeclares a borrowed node differently.
	 *
	 * `make_node` collapses an IDENTICAL redeclaration and throws on a
	 * conflicting one, so a body whose own `make_node` clashes with a node an
	 * `include` provides would save clean here and kill the worker at its next
	 * spawn. Catch it at the boundary instead.
	 *
	 * @param string $tsl The body being saved.
	 * @param list<array{name:string,class:string,fans_out:bool,args:list<string>,verbs:list<array{verb:string,args:list<string>}>,origin:list<string>,via:list<string>}> $borrowed_nodes expand()'s node records; only `name`, `class` and `args` are read.
	 * @throws \RuntimeException On a conflicting redeclaration.
	 */
	private static function assert_no_borrowed_node_conflict( string $tsl, array $borrowed_nodes ): void {
		$borrowed = [];
		foreach ( $borrowed_nodes as $node ) {
			$borrowed[ $node['name'] ] = [
				'class' => $node['class'],
				'args'  => \implode( ' ', $node['args'] ),
			];
		}
		foreach ( Shell_Node::parse_statements( $tsl ) as $statement ) {
			if ( 'make_node' !== $statement['verb'] ) {
				continue;
			}
			$node_name = $statement['values'][2] ?? '';
			$prior     = $borrowed[ $node_name ] ?? null;
			if ( null === $prior ) {
				continue;
			}
			$class = $statement['values'][1] ?? '';
			$args  = \implode( ' ', \array_slice( $statement['spans'], 3 ) );
			if ( $prior['class'] === $class && $prior['args'] === $args ) {
				continue;
			}
			throw new \RuntimeException(
				\esc_html( "make_node conflict: '{$node_name}' is provided by an include as {$prior['class']} '{$prior['args']}', redeclared as {$class} '{$args}'" )
			);
		}
	}

	/**
	 * `delete` verb handler — remove a user topology by name.
	 *
	 * Only the user copy is unlinked, so a stock topology of the same name
	 * survives and the name keeps resolving. With no stock copy behind it the
	 * name resolves to nothing, and leaving it in the active set would make
	 * every spawn chase a file that is gone — hence the prune.
	 *
	 * @param list<string> $args Verb tokens; the topology name is the first.
	 *
	 * @return array<int|string,mixed> `{name, deleted, stock_fallback, pruned_active, restarted_fleets}`.
	 * @throws \RuntimeException When the name is not file-name safe, no user copy exists, or the unlink fails.
	 */
	public static function cmd_delete( array $args ): array {
		$name = self::require_valid_name( $args[0] ?? '' );
		$path = self::user_path( $name );
		if ( ! \is_file( $path ) ) {
			throw new \RuntimeException(
				\esc_html( "no user-saved topology named: $name (stock copies are protected)" )
			);
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink,WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		if ( ! @\unlink( $path ) ) {
			throw new \RuntimeException(
				\esc_html( "failed to unlink topology file: $path" )
			);
		}
		// After unlink, resolve() returns the stock copy iff one exists.
		$has_stock_fallback = null !== Topology_Registry::resolve( $name );

		// No stock fallback → prune the name from the active set.
		$pruned = false;
		if ( ! $has_stock_fallback ) {
			$active = \array_values( \array_filter( (array) \get_option( 'newspack_nodes_topologies', [] ), '\is_string' ) );
			$pruned = \in_array( $name, $active, true );
			if ( $pruned ) {
				\update_option( 'newspack_nodes_topologies', \array_values( \array_diff( $active, [ $name ] ) ) );
				Topology_Registry::invalidate_config_cache();
			}
		}

		// The file changed under the memoized readers (symmetry with save).
		Topology_Registry::reset_basename_cache();

		// Symmetry with save: deleting a child changes its parents too.
		$restarted = self::restart_affected_fleets( $name );

		return [
			'name'             => $name,
			'deleted'          => $path,
			'stock_fallback'   => $has_stock_fallback,
			'pruned_active'    => $pruned,
			'restarted_fleets' => $restarted,
		];
	}

	/**
	 * The writable `<user_dir>/<name>.tsl` path save and delete both operate on.
	 *
	 * One resolution and one refusal, so a missing user dir reads as the same
	 * fault whichever verb hits it.
	 *
	 * @param string $name Validated topology name.
	 *
	 * @return string Absolute path to the user copy, which need not exist yet.
	 * @throws \RuntimeException When no user dir is configured.
	 */
	private static function user_path( string $name ): string {
		$user_dir = Topology_Registry::user_dir();
		if ( '' === $user_dir ) {
			throw new \RuntimeException( 'Topology_Registry has no user dir configured' );
		}
		return $user_dir . '/' . $name . '.tsl';
	}

	/**
	 * Restart every registered topology whose graph this one is part of.
	 *
	 * A topology's content is its own statements PLUS its includes', so saving
	 * a child changes every parent that composes it. The child itself is
	 * usually not an active fleet, so restarting only the saved name leaves
	 * those parents running the old graph with nothing to say so.
	 *
	 * @param string $name Topology just written or deleted.
	 *
	 * @return list<string> Fleet names the restart action fired for, in catalog order.
	 */
	private static function restart_affected_fleets( string $name ): array {
		// Catalog filter, not the overlay; the accessor latches global wiring.
		$resolved  = (array) \apply_filters( 'newspack_nodes/topologies', [] );
		$restarted = [];
		foreach ( \array_keys( $resolved ) as $fleet ) {
			$fleet = (string) $fleet;
			if ( $fleet !== $name && ! self::fleet_includes( $fleet, $name ) ) {
				continue;
			}
			\do_action( 'newspack_nodes/restart_fleet', $fleet );
			$restarted[] = $fleet;
		}
		return $restarted;
	}

	/**
	 * Whether a fleet composes `$name`, transitively.
	 *
	 * Walks the `include` lines themselves rather than composing the graph:
	 * the write has already happened, so a graph that will not resolve — the
	 * dangling one a delete just created, or a `make_node` conflict — must
	 * neither fail the write nor hide a parent that does compose `$name`.
	 * `direct_includes` never merges, but it does TOKENIZE, and an unbalanced
	 * quote throws there — so it swallows that and reports no includes.
	 *
	 * @param string $fleet Catalogued fleet to inspect.
	 * @param string $name  Topology just written or deleted.
	 *
	 * @return bool True when the fleet's graph contains `$name`.
	 */
	private static function fleet_includes( string $fleet, string $name ): bool {
		$seen  = [];
		$queue = [ $fleet ];
		while ( $queue ) {
			$current = \array_shift( $queue );
			if ( isset( $seen[ $current ] ) ) {
				continue;
			}
			$seen[ $current ] = true;
			foreach ( self::direct_includes( $current ) as $child ) {
				if ( $child === $name ) {
					return true;
				}
				$queue[] = $child;
			}
		}
		return false;
	}

	/**
	 * A topology's DIRECT `include` lines, in declaration order.
	 *
	 * Reads whichever copy `resolve()` picks, so the includes are the ones the
	 * runtime would load. An unresolvable name and a file that will not tokenize
	 * both answer no includes: every caller walks a graph a write may already
	 * have broken.
	 *
	 * @param string $name Topology name.
	 *
	 * @return list<string> Direct include names; empty when the name does not resolve.
	 */
	private static function direct_includes( string $name ): array {
		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			return [];
		}
		try {
			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			return self::direct_includes_from_tsl( (string) \file_get_contents( $path ) );
		} catch ( \RuntimeException ) {
			// A file that will not tokenize can name no includes.
			return [];
		}
	}

	/**
	 * `include` lines parsed straight out of a TSL body string rather than by
	 * name — what lets save validate a body before it reaches disk, and what
	 * `get` and `direct_includes` reuse once the file is read.
	 *
	 * @param string $tsl Topology source.
	 *
	 * @return list<string> Direct include names, in declaration order.
	 * @throws \RuntimeException When the body leaves a quote or a backslash continuation open.
	 */
	private static function direct_includes_from_tsl( string $tsl ): array {
		$out = [];
		foreach ( Shell_Node::parse_statements( $tsl ) as $statement ) {
			if ( 'include' === $statement['verb'] && '' !== ( $statement['values'][1] ?? '' ) ) {
				$out[] = $statement['values'][1];
			}
		}
		return $out;
	}

	/**
	 * `expand` verb handler — compose an include set for the console.
	 *
	 * Every name is validated although nothing is written: the analyzer opens
	 * each file, so the file-name-safe pattern is what keeps a path out of the
	 * argument.
	 *
	 * @param list<string> $args Verb tokens, one topology name each; blanks are dropped.
	 *
	 * @return array<int|string,mixed> `{nodes, edges, tree, hulls}`, from Topology_Analyzer::expand().
	 * @throws \RuntimeException On a name that is not file-name safe, an unknown include, a cycle, or a conflicting make_node.
	 */
	public static function cmd_expand( array $args ): array {
		$names = $args;
		$names = \array_values( \array_filter( $names, fn ( $n ) => '' !== $n ) );
		foreach ( $names as $name ) {
			self::require_valid_name( $name );
		}
		return Topology_Analyzer::expand( $names );
	}

	/**
	 * `activate` verb handler — activate a topology by name.
	 *
	 * @param list<string> $args Verb tokens; the topology name is the first.
	 *
	 * @return array<int|string,mixed> `{name, active:true, spawned:<int>}`, `spawned` counting spawn POSTs requested.
	 * @throws \RuntimeException When the name is not file-name safe or unknown, or activating it would put two fleets on one log.
	 */
	public static function cmd_activate( array $args ): array {
		// Only the name is checked here; the rest is Topology_Registry's.
		return Topology_Registry::activate( self::require_valid_name( $args[0] ?? '' ) );
	}

	/**
	 * `deactivate` verb handler — deactivate a topology by name.
	 *
	 * @param list<string> $args Verb tokens; the topology name is the first.
	 *
	 * @return array<int|string,mixed> `{name, active:false}`.
	 * @throws \RuntimeException When the name is not file-name safe.
	 */
	public static function cmd_deactivate( array $args ): array {
		return Topology_Registry::deactivate( self::require_valid_name( $args[0] ?? '' ) );
	}

	/**
	 * `connect_worker_input` verb handler — mount one worker's input Partition
	 * into this request's graph.
	 *
	 * The console's attached channel sends this ahead of every command in the
	 * same POST: the request graph is built per request, so without the mount
	 * Router answers NOT_AVAILABLE for a TO naming the worker. Only the named
	 * worker is mounted. A worker that cannot be — an id outside
	 * `{topology}.p{N}`, no lock dir and no wakeable sleeper, no ipc input dir —
	 * is not reported here; the command behind it bounces NOT_AVAILABLE.
	 *
	 * @param list<string> $args Verb tokens; the worker id (`{topology}.p{N}`) is the first.
	 *
	 * @return string Always empty, so the mount adds no reply to the batch.
	 */
	public static function cmd_connect_worker_input( array $args ): string {
		Bootstrap::register_worker_partition( $args[0] ?? '', Bootstrap::base_dir() );
		return '';
	}

	/**
	 * The console manifest and the verb table in one declaration.
	 * `Service_CI_Node` builds the dispatch table from `commands[]` here, so a
	 * verb is named once and the `capability` beside it is the role its handler
	 * is wrapped in. A verb declaring none takes MANAGE, the strictest.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Topology (.tsl) management: list / get / save / delete user topology files, activate / deactivate topologies (immediate spawn / drain), and mount a worker input partition.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'capability'  => Capabilities::READ,
					'description' => 'List topologies with source (user/stock/both) and active state.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_list(),
				],
				[
					'name'        => 'get',
					'capability'  => Capabilities::READ,
					'description' => 'Read a topology .tsl by name.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_get( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'save',
					'description' => 'Write a user topology: `save <name> <tsl…>` (validated; restarts the active fleet). 1 MiB cap.',
					'args'        => [
						[ 'name' => 'name', 'type' => 'string', 'required' => true ],
						[ 'name' => 'tsl', 'type' => 'text', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_save( self::arg_strings( $args ), $envelope ),
				],
				[
					'name'        => 'delete',
					'description' => 'Delete a user topology (stock copies are protected).',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_delete( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'activate',
					'description' => 'Activate a topology: add it to the active set, persist, and spawn its fleet now.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_activate( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'deactivate',
					'description' => 'Deactivate a topology: remove it from the active set, persist, and drain its fleet now.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_deactivate( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'expand',
					'capability'  => Capabilities::READ,
					'description' => 'Compose an include set into one graph with provenance (informational).',
					'args'        => [ [ 'name' => 'names', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_expand( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'connect_worker_input',
					'description' => "Mount the named worker's input partition into this request's graph.",
					'args'        => [ [ 'name' => 'reader', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_connect_worker_input( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
