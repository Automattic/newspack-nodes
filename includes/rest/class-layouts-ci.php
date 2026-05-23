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

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI;

\defined( 'ABSPATH' ) || exit;

class Layouts_CI extends Service_CI {

	private const ID_PATTERN      = '/^[a-zA-Z0-9_:.-]+$/';
	private const MAX_BODY_BYTES  = 65536;

	public function __construct() {
		$this->commands( $this->verb_table() );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Per-topology canvas layout: get / save node positions.',
			'ctor'        => [],
			'verbs'       => [
				[
					'name'        => 'get',
					'description' => 'Read saved node positions for a layout name.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
				],
				[
					'name'        => 'save',
					'description' => 'Persist node positions for a layout name. 64 KiB cap.',
					'args'        => [
						[ 'name' => 'name', 'type' => 'string', 'required' => true ],
						[ 'name' => 'positions', 'type' => 'json', 'required' => true ],
					],
				],
			],
		];
	}

	private function verb_table(): array {
		return [
			'get'  => static function ( CommandInterpreter $self, string $args ): array {
				self::require_manage_options();
				$name = self::require_valid_name( [ 'name' => \trim( $args ) ] );
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
			},
			'save' => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ): array {
				self::require_manage_options();
				if ( Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
					throw new \RuntimeException(
						\esc_html( 'body too large: layout payload exceeds 64 KiB' )
					);
				}
				$decoded = \is_array( $payload ) ? $payload : [];
				$name    = self::require_valid_name( $decoded );
				if ( ! isset( $decoded['positions'] ) || ! \is_array( $decoded['positions'] ) ) {
					throw new \RuntimeException( 'invalid arguments: positions must be an object' );
				}

				$clean = self::sanitize_positions( $decoded['positions'] );
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
			},
		];
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
			$x = (float) $pos[0];
			$y = (float) $pos[1];
			if ( ! \is_finite( $x ) || ! \is_finite( $y ) ) {
				continue;
			}
			$clean[ $id ] = [ $x, $y ];
		}
		return $clean;
	}

	private static function layouts_dir(): string {
		$base = (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
		return \rtrim( $base, '/' ) . '/layouts';
	}

	private static function layout_path( string $name ): string {
		return self::layouts_dir() . '/' . $name . '.layout';
	}
}
