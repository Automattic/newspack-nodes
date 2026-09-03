<?php
/**
 * Layouts_CI: command-dispatch for the substrate's saved canvas positions.
 *
 * A layout is the arrangement of a topology's nodes on the console canvas,
 * stored apart from the graph it describes: one JSON file per name at
 * `<base_directory>/layouts/<name>.layout`, holding
 * `{ positions: { node_id: [x, y] } }`. The console asks for the layout under
 * the topology name it is viewing, but the positions never enter that .tsl —
 * writing them there would route every drag through `topologies save`, which
 * restarts the matching active fleet.
 *
 * Verbs:
 *   get  — args `{name}`. Returns `{name, positions: object|null}`. A missing,
 *          unreadable or malformed file answers null, which tells the console
 *          to auto-fit; no other top-level key of the saved file is surfaced.
 *   save — args `{name, positions: {node_id: [x,y]}}`. Returns `{name, path,
 *          positions}`, the positions being what survived sanitizing — an entry
 *          that fails validation is dropped rather than refusing the write.
 *
 * Each verb names its role in `node_schema()`, `get` READ and `save` TUNE, and
 * `Service_CI_Node::commands()` wraps the handler in that check. A refusal
 * throws \RuntimeException, which `Command_Interpreter_Node::interpret()`
 * catches and returns as TM_COMMAND|TM_ERROR.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * Read and write canvas node positions by layout name.
 */
class Layouts_CI_Node extends Service_CI_Node {

	/**
	 * Node ids a layout may carry a position for. Deliberately wider than the
	 * layout NAME, which becomes a file name: an id is only ever a JSON key, and
	 * node names carry punctuation a file name should not — the `:` of an owned
	 * sibling (`jobs:consumer`), plus `.` and `-`. An id that does not match is
	 * dropped, so the pattern also bounds what reaches the console.
	 */
	private const ID_PATTERN = '/^[a-zA-Z0-9_:.-]+$/';

	/**
	 * Ceiling on the packed command envelope, in bytes — 1 MiB. A captured
	 * graph runs to thousands of positions, so the cap sits far above any
	 * layout the console produces and refuses only a runaway blob.
	 */
	private const MAX_BODY_BYTES = 1048576;

	/**
	 * `get` verb — the saved positions for one layout name.
	 *
	 * A missing file is an answer, not an error: the console asks before the
	 * operator has dragged anything, and a null `positions` is what sends it to
	 * auto-fit. An unreadable or malformed file reads the same way, so a
	 * truncated write costs the arrangement rather than the canvas. Only the
	 * `positions` key of the file is returned.
	 *
	 * @param list<string> $args Verb tokens; the layout name is the first.
	 *
	 * @return array<string,mixed> `{name, positions}`, positions null when nothing is saved.
	 * @throws \RuntimeException When the name is absent or not file-name safe.
	 */
	public static function cmd_get( array $args ): array {
		$name = self::require_valid_name( $args[0] ?? '' );
		$path = self::layout_path( $name );

		$positions = null;
		if ( \is_file( $path ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_get_contents,WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Path is always a local .layout file under base_directory.
			$body = @\file_get_contents( $path );
			if ( false !== $body ) {
				$parsed = \json_decode( $body, true );
				if ( \is_array( $parsed ) && isset( $parsed['positions'] ) ) {
					$positions = $parsed['positions'];
				}
			}
		}

		return [
			'name'      => $name,
			'positions' => $positions,
		];
	}

	/**
	 * `save` verb — persist a layout's node positions, creating the layouts
	 * directory on the first write.
	 *
	 * The cap measures the packed envelope before anything is decoded, so an
	 * oversized blob is refused without parsing it. Measuring the envelope
	 * rather than the positions JSON counts what the transport actually carried,
	 * arguments and all. `array_is_list()` is what narrows the envelope to the
	 * positional message array `Message::packed_size()` takes; every real
	 * envelope is one, so the cap always applies.
	 *
	 * @param list<string>            $args     Verb tokens: the layout name, then the positions JSON as one token.
	 * @param array<int|string,mixed> $envelope The inbound TM_COMMAND message, or [] for an inline dispatch.
	 *
	 * @return array<string,mixed> `{name, path, positions}`, positions being what survived sanitizing.
	 * @throws \RuntimeException When the envelope exceeds the cap, the name is
	 *                           invalid, the positions are not an object, the
	 *                           directory cannot be created, or the write fails.
	 */
	public static function cmd_save( array $args, array $envelope = [] ): array {
		if ( \array_is_list( $envelope ) && Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
			throw new \RuntimeException(
				\esc_html( 'body too large: layout arguments exceed 1 MiB' )
			);
		}
		// `save <name> <positions-json>`: two tokens, the blob whole.
		[ $name_raw, $positions_json ] = self::split_first_token( $args );
		$name      = self::require_valid_name( $name_raw );
		$positions = \json_decode( $positions_json, true );
		if ( ! \is_array( $positions ) ) {
			throw new \RuntimeException( 'invalid arguments: positions must be an object' );
		}

		$clean = self::sanitize_positions( $positions );
		$dir   = self::layouts_dir();
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			$made = @\mkdir( $dir, 0700, true );
			if ( ! $made && ! \is_dir( $dir ) ) {
				throw new \RuntimeException(
					\esc_html( "failed to create layouts directory: $dir" )
				);
			}
		}

		$path  = self::layout_path( $name );
		$json  = (string) \wp_json_encode( [ 'positions' => $clean ] );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$bytes = @\file_put_contents( $path, $json );
		if ( false === $bytes ) {
			throw new \RuntimeException(
				\esc_html( "failed to write layout file: $path" )
			);
		}

		return [
			'name'      => $name,
			'path'      => $path,
			'positions' => $clean,
		];
	}

	/**
	 * Path of one layout file. Callers pass a name `require_valid_name()` has
	 * already accepted — that check is the only thing keeping a `..` segment or
	 * a slash out of this concatenation.
	 *
	 * @param string $name Validated layout name.
	 *
	 * @return string Absolute path to `<base_directory>/layouts/<name>.layout`.
	 */
	private static function layout_path( string $name ): string {
		return self::layouts_dir() . '/' . $name . '.layout';
	}

	/**
	 * The layouts directory, derived from the substrate base directory so
	 * layouts follow the rest of the runtime's storage when an operator moves
	 * it.
	 *
	 * @return string Absolute path, no trailing slash.
	 */
	private static function layouts_dir(): string {
		$base = Config::get_base_directory();
		return \rtrim( $base, '/' ) . '/layouts';
	}

	/**
	 * Keep the entries that describe a node position and drop the rest.
	 *
	 * An entry survives when its key is a string matching ID_PATTERN and its
	 * value is an array of at least two members whose first two are scalar or
	 * null and cast to finite floats. Dropped, therefore: an integer key (PHP
	 * turns the decoded JSON key "42" into one), a punctuated id, a value that
	 * is not an array, a single coordinate, and `1e500` overflowing to INF.
	 *
	 * The cast normalizes what JSON decoding produced — an int for a whole
	 * number, a string for `"12"` — so every stored coordinate is a float.
	 *
	 * @param array<mixed,mixed> $positions Raw positions blob from the args.
	 *
	 * @return array<string,array{0:float,1:float}> Node id => [x, y].
	 */
	private static function sanitize_positions( array $positions ): array {
		$clean = [];
		foreach ( $positions as $id => $pos ) {
			if ( ! \is_string( $id ) || ! \is_array( $pos ) || \count( $pos ) < 2 ) {
				continue;
			}
			if ( ! \preg_match( self::ID_PATTERN, $id ) ) {
				continue;
			}
			$raw_x = $pos[0];
			$raw_y = $pos[1];
			if ( ! \is_scalar( $raw_x ) && null !== $raw_x ) {
				continue;
			}
			if ( ! \is_scalar( $raw_y ) && null !== $raw_y ) {
				continue;
			}
			$x = (float) $raw_x;
			$y = (float) $raw_y;
			if ( ! \is_finite( $x ) || ! \is_finite( $y ) ) {
				continue;
			}
			$clean[ $id ] = [ $x, $y ];
		}
		return $clean;
	}

	/**
	 * The console manifest and the verb table in one declaration.
	 * `Service_CI_Node` builds the dispatch table from `commands[]` here, so a
	 * verb is named once and the `capability` beside it is the role its handler
	 * is wrapped in.
	 *
	 * @api Used by the substrate to provide UI etc.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Per-topology canvas layout: get / save node positions.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'capability'  => Capabilities::READ,
					'description' => 'Read saved node positions for a layout name.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_get( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'save',
					'capability'  => Capabilities::TUNE,
					'description' => 'Persist node positions for a layout: `save <name> <positions-json>`. 1 MiB cap.',
					'args'        => [
						[ 'name' => 'name', 'type' => 'string', 'required' => true ],
						[ 'name' => 'positions', 'type' => 'json', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_save( self::arg_strings( $args ), $envelope ),
				],
			],
		] );
	}

}
