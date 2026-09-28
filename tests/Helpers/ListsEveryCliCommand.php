<?php
/**
 * Assert every registered WP-CLI command lists in a usage overview.
 *
 * @package Newspack_Nodes\Tests
 */

namespace Newspack_Nodes\Tests;

/**
 * Replays a plugin's registrations through a model of WP-CLI's command tree.
 *
 * Each plugin's `CliUsageOverviewTest` uses it; pyrobase loads it from the
 * substrate checkout its suite already reads. The model follows
 * `WP_CLI::add_command()`, `defer_command_addition()`,
 * `RegisterDeferredCommands` and `Runner::run_command_and_exit()`:
 *
 * - A command whose path meets a missing level is DEFERRED, waiting on
 *   `after_add_command:<the path from that level on>`. A later command
 *   whose full name is exactly that path wakes it and builds the levels.
 * - `wp <path>` naming a group prints that group's usage at once, from
 *   what attached at load. Any other invocation first FLUSHES every
 *   deferred command, building each missing level as an empty group — so
 *   a group only a flush builds lists everything under it.
 * - A single command added where a group stands replaces it.
 * - A command whose immediate parent is a single command throws
 *   `can't have subcommands`: at load that ends every `wp` invocation, at
 *   the flush every one but a bare group's usage. A command further below
 *   a single command throws nothing and is unreachable, since the single
 *   command runs in its place.
 */
trait ListsEveryCliCommand {

	/**
	 * Assert every recorded command, and every level above it, lists in its
	 * parent's usage overview, and that none breaks WP-CLI's command tree.
	 *
	 * @param array<string,mixed> $commands Name => callable, in the order `WP_CLI::add_command()` received them.
	 */
	protected function assert_every_cli_command_listed( array $commands ): void {
		$this->assertNotEmpty( $commands, 'the registration recorded no WP-CLI command' );

		$loaded  = [
			'tree'     => [ '' => true ],
			'deferred' => [],
			'refused'  => [],
		];
		foreach ( \array_keys( $commands ) as $name ) {
			self::cli_add( $loaded, $commands, $name, false );
		}
		$flushed = $loaded;
		foreach ( \array_keys( $flushed['deferred'] ) as $name ) {
			self::cli_add( $flushed, $commands, $name, true );
		}

		$problems = $flushed['refused'];
		foreach ( \array_keys( $commands ) as $name ) {
			$words = \explode( ' ', $name );
			for ( $depth = 2; $depth <= \count( $words ); ++$depth ) {
				$path   = \implode( ' ', \array_slice( $words, 0, $depth ) );
				$parent = \implode( ' ', \array_slice( $words, 0, $depth - 1 ) );
				$tree   = isset( $loaded['tree'][ $parent ] ) ? $loaded['tree'] : $flushed['tree'];
				if ( isset( $problems[ $path ] ) || ! isset( $tree[ $parent ] ) ) {
					continue;
				}
				if ( ! $tree[ $parent ] ) {
					$problems[ $path ] = "`wp {$path}` is unreachable: `wp {$parent}` is a single command, which runs in its place";
				} elseif ( ! isset( $tree[ $path ] ) ) {
					$problems[ $path ] = "`wp {$path}` is missing from `wp {$parent}`: WP-CLI deferred it, and `wp {$parent}` prints its usage before a deferred command attaches";
				}
			}
		}
		$this->assertEmpty( $problems, "WP-CLI commands no usage overview lists:\n" . \implode( "\n", $problems ) );
	}

	/**
	 * One `WP_CLI::add_command()`, then the deferred commands its hook wakes.
	 *
	 * @param array{tree:array<string,bool>,deferred:array<string,string>,refused:array<string,string>} $state    Tree maps each path to whether it is a group; mutated.
	 * @param array<string,mixed>                                                                         $commands Name => callable.
	 * @param string                                                                                      $name     The command added.
	 * @param bool                                                                                        $build    Build a missing level as an empty group rather than defer.
	 */
	private static function cli_add( array &$state, array $commands, string $name, bool $build ): void {
		$path = \explode( ' ', $name );
		\array_pop( $path );
		$at = '';
		foreach ( $path as $i => $level ) {
			$next = \ltrim( "{$at} {$level}" );
			if ( ! isset( $state['tree'][ $next ] ) ) {
				if ( ! $build ) {
					$state['deferred'][ $name ] = \implode( ' ', \array_slice( $path, $i ) );
					return;
				}
				$state['tree'][ $next ] = true;
			}
			$at = $next;
		}
		if ( ! $state['tree'][ $at ] ) {
			$state['refused'][ $name ] = "`wp {$name}`: `wp {$at}` is a single command, and WP-CLI throws `can't have subcommands` for a command under one";
			return;
		}
		$group = self::is_cli_group( $commands[ $name ] );
		if ( ! $group ) {
			foreach ( \array_keys( $state['tree'] ) as $below ) {
				if ( \str_starts_with( (string) $below, "{$name} " ) ) {
					unset( $state['tree'][ $below ] );
				}
			}
		}
		$state['tree'][ $name ] = $group;
		foreach ( $state['deferred'] as $waiting => $hook ) {
			if ( $hook === $name && isset( $state['deferred'][ $waiting ] ) ) {
				unset( $state['deferred'][ $waiting ] );
				self::cli_add( $state, $commands, $waiting, true );
			}
		}
	}

	/**
	 * Whether WP-CLI builds $callable as a group: an object, or a class,
	 * declaring no `__invoke()`. A closure declares one.
	 *
	 * @param mixed $callable A recorded callable.
	 */
	private static function is_cli_group( mixed $callable ): bool {
		$is_class = \is_object( $callable ) || ( \is_string( $callable ) && \class_exists( $callable ) );
		return $is_class && ! ( new \ReflectionClass( $callable ) )->hasMethod( '__invoke' );
	}
}
