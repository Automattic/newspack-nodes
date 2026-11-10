<?php
/**
 * Publishes_Status: a node's status snapshot in the shared cache, for a
 * dashboard to read.
 *
 * The key is by node NAME and worker PARTITION, because one TSL line runs
 * once per partition, and site-scoped, so two installs naming a node alike
 * do not collide.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * @phpstan-require-extends Node
 */
trait Publishes_Status {

	/** Bytes of a failure's text a snapshot keeps, cut on a character boundary. */
	private const STATUS_TEXT_BYTES = 500;

	/**
	 * The snapshot this process last wrote or read back under `$status_key`.
	 *
	 * @var array<array-key,mixed>
	 */
	private array $status = [];

	/** The key `$status` was read back or written under; null before either. */
	private ?string $status_key = null;

	/** Wall-second the snapshot was last written; 0 before the first write. */
	private int $status_written_at = 0;

	/**
	 * Merge $data over the snapshot and write it when the merge changed it,
	 * or once `status_heartbeat()` seconds have run since the last write.
	 * The snapshot merged over is the previous process's after a restart, so
	 * a key omitted from $data is kept: a publisher clears a key by writing
	 * `null` to it. Outside a worker, or with no shared cache, it does nothing.
	 *
	 * @param array<string,mixed> $data Fields to merge over the snapshot.
	 * @return bool Whether the cache holds the merged snapshot: written now,
	 *              or unchanged since a write inside the heartbeat. False
	 *              outside a worker, with no shared cache, or when the cache
	 *              refused the write, which the next publish tries again.
	 */
	protected function publish_status( array $data ): bool {
		$cache     = Cache_Backend::shared_first();
		$partition = Core::bound_partition();
		if ( null === $cache || null === $partition ) {
			return false;
		}
		$key    = self::status_key( $this->name, $partition );
		$last   = $this->held_status( $key, $partition );
		$status = \array_merge( $last, $data );
		$now    = (int) Core::$now;
		if ( $status === $last && $now - $this->status_written_at < $this->status_heartbeat() ) {
			return true;
		}
		if ( ! $cache->set( $key, $status, $this->status_ttl() ) ) {
			return false;
		}
		$this->status            = $status;
		$this->status_written_at = $now;
		return true;
	}

	/** Seconds the cache keeps a snapshot that is never rewritten. */
	abstract protected function status_ttl(): int;

	/** Seconds after which an unchanged snapshot is written again. */
	abstract protected function status_heartbeat(): int;

	/**
	 * When the condition whose start $key holds began: the held snapshot's
	 * value there, or now when it holds none. A publisher keeps when a
	 * condition began by writing the key only while the condition stands,
	 * and null otherwise.
	 *
	 * @param string $key The snapshot key holding the condition's start.
	 */
	protected function status_since( string $key ): int {
		$since = $this->last_status()[ $key ] ?? null;
		return null === $since ? (int) Core::$now : Core::as_int( $since );
	}

	/**
	 * The snapshot this process holds, an empty one outside a worker.
	 *
	 * @return array<array-key,mixed>
	 */
	protected function last_status(): array {
		$partition = Core::bound_partition();
		return null === $partition ? [] : $this->held_status( self::status_key( $this->name, $partition ), $partition );
	}

	/**
	 * The snapshot held under $key. The first call under a key, in a process
	 * or after a rename, reads the cache back and restarts the write clock,
	 * so the next publish writes.
	 *
	 * @param string $key       The node's status key at $partition.
	 * @param int    $partition The worker partition it runs in.
	 * @return array<array-key,mixed>
	 */
	private function held_status( string $key, int $partition ): array {
		if ( $key !== $this->status_key ) {
			$this->status_key        = $key;
			$this->status            = self::read_status( $this->name, $partition ) ?? [];
			$this->status_written_at = 0;
		}
		return $this->status;
	}

	/**
	 * The snapshot a node published, or null when the key is absent or the
	 * host has no shared cache.
	 *
	 * @param string $name      The node's name.
	 * @param int    $partition The worker partition it runs in.
	 * @return array<array-key,mixed>|null
	 */
	public static function read_status( string $name, int $partition ): ?array {
		$value = Cache_Backend::shared_first()?->get( self::status_key( $name, $partition ) );
		return \is_array( $value ) ? $value : null;
	}

	/**
	 * The cache key a node publishes its snapshot under, which a reader
	 * resolves through the same call, so the two cannot drift.
	 *
	 * @param string $name      The node's name.
	 * @param int    $partition The worker partition it runs in.
	 */
	public static function status_key( string $name, int $partition ): string {
		return Cache_Backend::site_key( "status:{$name}:p{$partition}" );
	}

	/**
	 * A failure's text as a snapshot carries it, one line: invalid UTF-8
	 * scrubbed, each run of whitespace one space, trimmed, terminal-safe,
	 * then cut to STATUS_TEXT_BYTES on a character boundary.
	 *
	 * @param string $text The failure's text.
	 * @throws \RuntimeException When the regex engine fails on the text.
	 */
	protected static function status_text( string $text ): string {
		$line = \preg_replace( '/\s+/u', ' ', \mb_scrub( $text, 'UTF-8' ) );
		if ( null === $line ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( 'status_text: collapsing the line failed: ' . \preg_last_error_msg() );
		}
		return \mb_strcut( Core::terminal_safe( \trim( $line ) ), 0, self::STATUS_TEXT_BYTES, 'UTF-8' );
	}
}
