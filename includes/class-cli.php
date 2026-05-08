<?php
/**
 * Cli: wp-cli command implementations for `wp nodes ls` and `wp nodes cli`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Cli {
	public const STALE_TIMEOUT = 60;

	private string $base_dir;

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	public function ls_workers(): array {
		$locks_dir = "{$this->base_dir}/locks";
		if ( ! \is_dir( $locks_dir ) ) {
			return [];
		}
		$now     = \time();
		$workers = [];
		foreach ( \scandir( $locks_dir ) ?: [] as $entry ) {
			if ( ! \preg_match( '/^(.+)\.p(\d+)\.lock\.d$/', $entry, $m ) ) {
				continue;
			}
			$type      = $m[1];
			$partition = (int) $m[2];
			$hb        = "{$locks_dir}/{$entry}/heartbeat";
			$mtime     = @\filemtime( $hb );
			$stale     = ( $mtime === false || ( $now - $mtime ) > self::STALE_TIMEOUT );
			$workers[] = [
				'type'         => $type,
				'partition'    => $partition,
				'heartbeat_at' => $mtime ?: 0,
				'stale'        => $stale,
			];
		}
		\usort( $workers, fn ( $a, $b ) =>
			[ $a['type'], $a['partition'] ] <=> [ $b['type'], $b['partition'] ]
		);
		return $workers;
	}

	public function attach_to_worker( string $reader_id ): array {
		[ $type, $partition ] = $this->parse_reader_id( $reader_id );
		return [
			'input'     => "{$this->base_dir}/ipc/{$reader_id}/input",
			'output'    => "{$this->base_dir}/ipc/{$reader_id}/output",
			'type'      => $type,
			'partition' => $partition,
		];
	}

	private function parse_reader_id( string $reader_id ): array {
		if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $reader_id, $m ) ) {
			throw new \InvalidArgumentException( "invalid reader id: $reader_id (expected {type}.p{N})" );
		}
		return [ $m[1], (int) $m[2] ];
	}
}
