<?php
/**
 * Layouts_CI: command-dispatch for substrate layout-storage verbs.
 *
 * Layouts (canvas node positions) are decoupled from topologies and live at
 * `<base_directory>/layouts/<name>.layout` as `{ positions: { node_id: [x, y] } }`.
 *
 * Verbs:
 *   get  — args `{name}`. Returns `{name, positions: object|null}`; never
 *          surfaces non-positions top-level keys from the saved file.
 *   save — args `{name, positions: {node_id: [x,y]}}`. Returns `{name, path,
 *          positions}`; silently drops invalid entries.
 *
 * Verb-level auth is capability-only (manage_options); errors throw
 * RuntimeException, which CommandInterpreter::interpret() wraps as TM_ERROR.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

class Layouts_CI_Node extends Service_CI_Node {

	private const ID_PATTERN      = '/^[a-zA-Z0-9_:.-]+$/';
	private const MAX_BODY_BYTES  = 1048576;
	/**
	 * `get` verb handler — read a saved layout's node positions by name.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
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
	 * `save` verb handler — persist node positions for a layout (1 MiB cap).
	 *
	 * @param list<string> $args Verb argument.
	 * @param array<int|string,mixed> $envelope Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_save( array $args, array $envelope = [] ): array {
		// $envelope is the 7-field positional message array (a list).
		if ( \array_is_list( $envelope ) && Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
			throw new \RuntimeException(
				\esc_html( 'body too large: layout arguments exceed 1 MiB' )
			);
		}
		// `save <name> <positions-json>`: name is first token, rest is JSON.
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

	private static function layout_path( string $name ): string {
		return self::layouts_dir() . '/' . $name . '.layout';
	}

	private static function layouts_dir(): string {
		$base = Config::get_base_directory();
		return \rtrim( $base, '/' ) . '/layouts';
	}

	/**
	 * Sanitize a positions blob — drop entries with non-string ids,
	 * ids that don't match ID_PATTERN, non-array positions, fewer
	 * than 2 coordinates, or non-finite x/y.
	 *
	 * @param array<mixed,mixed> $positions Raw positions blob from the args.
	 * @return array<string,array{0:float,1:float}>
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

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Per-topology canvas layout: get / save node positions.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'description' => 'Read saved node positions for a layout name.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_get( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'save',
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
