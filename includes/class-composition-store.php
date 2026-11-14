<?php
/**
 * Composition_Store: a context's layout, one option per context.
 *
 * `newspack_nodes_composition:<context>` holds `{ markup, actor, ts }`, or
 * after a restore the tombstone `{ removed: true, actor, ts }`, and is not
 * autoloaded, so a page that composes nothing never loads it. The options
 * table is where every web host reads the same row; the settings audit
 * records each write's name, uninstall's `newspack_nodes_` sweep erases it,
 * and the object cache serves the read.
 *
 * Every read validates what it reads, the default included, through
 * `Composition::validate()`, so a layout a later version can no longer read
 * is refused rather than migrated or replaced by the default.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Read, save, restore and seed a context's layout.
 *
 * @phpstan-import-type Tree from Composition
 * @phpstan-type Layout array{context: string, source: 'saved'|'default', blocks: Tree, saved_ts: float|null, actor: string|null}
 */
final class Composition_Store {

	/** A context's option is this prefix and the context's name. */
	public const OPTION_PREFIX = 'newspack_nodes_composition:';

	/** What a caller who does not speak for the operator reads of a refusal. */
	public const UNREADABLE = 'this layout could not be read';

	/**
	 * Validate `$markup` and store it as the serialized tree, every attribute
	 * written, so a chosen value never moves with a later default, under the
	 * caller and the clock.
	 *
	 * @param string $context A declared context.
	 * @param string $markup  Serialized block markup.
	 * @return Layout What `read()` now answers.
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the markup is refused or the option will not store.
	 */
	public static function save( string $context, string $markup ): array {
		$tree  = Composition::validate( $context, $markup );
		$stamp = self::stamp();
		self::write( $context, [ 'markup' => Composition::serialize( $context, $tree ) ] + $stamp );
		return self::layout( $context, 'saved', $tree, $stamp['ts'], $stamp['actor'] );
	}

	/**
	 * Store the tombstone, so the context reads its default and a seed never
	 * writes it again.
	 *
	 * @param string $context A declared context.
	 * @return Layout The default, as `read()` now answers it.
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the default no longer validates or the option will not store.
	 */
	public static function restore( string $context ): array {
		$tree  = self::default_tree( $context );
		$stamp = self::stamp();
		self::write( $context, [ 'removed' => true ] + $stamp );
		return self::layout( $context, 'default', $tree, $stamp['ts'], $stamp['actor'] );
	}

	/**
	 * Store a record, refusing a write the options table did not take.
	 *
	 * @param array<string,mixed> $record The record.
	 * @throws \RuntimeException When the option will not store.
	 */
	private static function write( string $context, array $record ): void {
		$option = self::OPTION_PREFIX . $context;
		if ( ! \update_option( $option, $record, false ) && \get_option( $option, null ) !== $record ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( "composition {$context}: the layout did not store" );
		}
	}

	/**
	 * Store `$markup` for a context that has no record, after every rule but
	 * the context's `check`, so neither a saved layout nor a restore is ever
	 * reset.
	 *
	 * @param string $context A declared context.
	 * @param string $markup  Serialized block markup.
	 * @api Called from consumer plugins' seed runs (cross-repo, invisible here).
	 * @return bool True when it wrote.
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the markup, or the layout it stores, is refused.
	 */
	public static function seed( string $context, string $markup ): bool {
		$record = [ 'markup' => Composition::serialize( $context, Composition::validate_shape( $context, $markup ) ) ] + self::stamp();
		return \add_option( self::OPTION_PREFIX . $context, $record, '', false );
	}

	/**
	 * Who writes a record, the caller's login else the label of the session
	 * in force, and when, a request that never ticked reading the live clock.
	 *
	 * @return array{actor: string|null, ts: float}
	 */
	private static function stamp(): array {
		$login = 0 !== Core::current_user_id() ? Core::as_string( \wp_get_current_user()->user_login ) : '';
		return [
			'actor' => '' !== $login ? $login : Capabilities::$session_label,
			'ts'    => Core::$now ?: Core::right_now(),
		];
	}

	/**
	 * Each context's `read()`, or `{ context, error }` in its place for one
	 * refused, so a page renders the refusal where the layout would stand,
	 * worded as `Core::caller_message()` lets this caller read it. Enqueues
	 * core's `wp-block-library` styles, which a layout's core blocks wear.
	 *
	 * @param list<string> $contexts Declared contexts.
	 * @api Called from consumer plugins' admin pages (cross-repo, invisible here).
	 * @return array<string,Layout|array{context: string, error: string}>
	 * @throws \LogicException When a context is not declared.
	 * @throws \InvalidArgumentException Through `Capabilities::cap_for()`, on a broken capability map.
	 */
	public static function page_data( array $contexts ): array {
		\wp_enqueue_style( 'wp-block-library' );
		$page = [];
		foreach ( $contexts as $context ) {
			try {
				$page[ $context ] = self::read( $context );
			} catch ( Worker_Should_Stop $stop ) {
				throw $stop;
			} catch ( \RuntimeException $refused ) {
				$page[ $context ] = [
					'context' => $context,
					'error'   => Core::caller_message( $refused, "composition {$context}" ),
				];
			}
		}
		return $page;
	}

	/**
	 * The layout `$context` reads: the saved one, else the default, with
	 * when its record was written and by whom, both null for no record.
	 * A refusal can name a key the reader may not see, so it reaches a
	 * caller who `Core::speaks_for_operator()` as thrown, and everyone else
	 * as a RuntimeException reading UNREADABLE that chains it, so
	 * `Core::caller_message()` still logs an engine or driver error beneath;
	 * a stop passes as thrown.
	 *
	 * @param string $context A declared context.
	 * @return Layout
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the record is malformed or no longer validates.
	 * @throws \InvalidArgumentException Through `Capabilities::cap_for()`, on a broken capability map.
	 */
	public static function read( string $context ): array {
		try {
			return self::read_layout( $context );
		} catch ( Worker_Should_Stop $stop ) {
			throw $stop;
		} catch ( \RuntimeException $refused ) {
			if ( Core::speaks_for_operator() ) {
				throw $refused;
			}
			throw new \RuntimeException( self::UNREADABLE, 0, $refused );
		}
	}

	/**
	 * The layout `read()` answers, every refusal in its own words.
	 *
	 * @return Layout
	 * @throws \LogicException When the context is not declared.
	 * @throws \RuntimeException When the record is malformed or no longer validates.
	 */
	private static function read_layout( string $context ): array {
		Composition::context_of( $context );
		$record = \get_option( self::OPTION_PREFIX . $context, null );
		if ( null === $record ) {
			return self::layout( $context, 'default', self::default_tree( $context ), null, null );
		}
		$record = \is_array( $record ) ? $record : [];
		$ts     = $record['ts'] ?? null;
		$actor  = $record['actor'] ?? null;
		if ( ! \is_float( $ts ) || ( null !== $actor && ! \is_string( $actor ) ) ) {
			self::malformed( $context );
		}
		if ( true === ( $record['removed'] ?? null ) ) {
			return self::layout( $context, 'default', self::default_tree( $context ), $ts, $actor );
		}
		$markup = $record['markup'] ?? null;
		if ( ! \is_string( $markup ) ) {
			self::malformed( $context );
		}
		return self::layout( $context, 'saved', Composition::validate( $context, $markup ), $ts, $actor );
	}

	/**
	 * Refuse a record neither a save nor a restore could have written.
	 *
	 * @throws \RuntimeException Always.
	 */
	private static function malformed( string $context ): never {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		throw new \RuntimeException( "composition {$context}: the stored layout is malformed" );
	}

	/**
	 * The context's default layout, validated.
	 *
	 * @return Tree
	 */
	private static function default_tree( string $context ): array {
		return Composition::validate( $context, Composition::default_markup( $context ) );
	}

	/**
	 * One layout answer.
	 *
	 * @param 'saved'|'default' $source Which layout the context reads.
	 * @param Tree              $tree   Its validated tree.
	 * @return Layout
	 */
	private static function layout( string $context, string $source, array $tree, ?float $ts, ?string $actor ): array {
		return [
			'context'  => $context,
			'source'   => $source,
			'blocks'   => $tree,
			'saved_ts' => $ts,
			'actor'    => $actor,
		];
	}
}
