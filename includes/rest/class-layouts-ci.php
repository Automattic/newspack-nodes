<?php
/**
 * Layouts_CI: command-dispatch for substrate layout-storage verbs.
 *
 * Replaces legacy class-layouts-controller.php (the GET/POST
 * /layouts/{name} REST endpoints) with a CommandInterpreter the M3
 * Command_Controller mounts alongside the other substrate-side CIs.
 *
 * Layouts are decoupled from topologies — the TSL file describes the
 * graph (nodes, edges, verbs); the `.layout` file describes positions.
 * The supervisor never reads layouts; only the topology console does,
 * as a default for the canvas's "Reset Layout" affordance.
 *
 * Files live at `<base_directory>/layouts/<name>.layout`, JSON encoded
 * as `{ positions: { node_id: [x, y], ... } }`.
 *
 * Verbs:
 *   get  — args `{name}`. Returns `{name, positions: object|null}`. Missing
 *          file or unparseable JSON returns `positions: null`; the response
 *          NEVER surfaces non-positions top-level keys from the saved file.
 *   save — args `{name, positions: {node_id: [x,y]}}`. Returns
 *          `{name, path, positions}`. Sanitizes positions (numeric pairs
 *          only, node-id matches `[a-zA-Z0-9_:.-]+`, x/y finite floats);
 *          silently drops invalid entries.
 *
 * The legacy controller's nonce check is dropped — CI dispatch happens
 * post-auth via Command_Controller, so verb-level checks are limited to
 * the capability (`manage_options`). Errors throw RuntimeException;
 * CommandInterpreter::interpret() wraps them as TM_COMMAND | TM_ERROR.
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
		// Node + CommandInterpreter have no explicit __construct; the
		// inherited no-op is implicit. Mirrors M3 Classes_CI and M2 CIs.
		$this->commands( $this->verb_table() );
	}

	private function verb_table(): array {
		return [
			'get'  => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ): array {
				self::require_manage_options();
				$decoded = \is_array( $payload ) ? $payload : [];
				$name    = self::require_valid_name( $decoded );
				$path    = self::layout_path( $name );

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
