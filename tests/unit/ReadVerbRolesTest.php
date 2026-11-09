<?php
/**
 * ADR-26 has one role rule for a base command: a node schema that declares a
 * command under the name of a read-only base command declares it `read`, so
 * `workers inspect`, which sends only what `base_role()` answers READ for,
 * never reaches a command a higher role guards. The sweep reads each class's
 * `node_schema()['commands']`, the schema a patron's `:config` interpreter
 * dispatches against, so a Table's `stats` is held to it as a service CI's
 * `dump` is.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Composer\Autoload\ClassLoader;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Interpreter_Node::class )]
final class ReadVerbRolesTest extends TestCase {

	/** The sibling plugins whose node classes this suite loads beside its own. */
	private const SIBLINGS = [
		'newspack-event-logger-nodes',
		'newspack-intelligence',
		'newspack-pyrobase',
		'newspack-nuclear-gyrobase',
		'newspack-cache-cozy',
	];

	/**
	 * The sibling classes whose `node_schema()` needs their own plugin
	 * booted, which this suite cannot read; their own suites hold them.
	 *
	 * @var list<class-string<Node>>
	 */
	private const UNBOOTED = [ 'Newspack_Event_Logger_Nodes\\App\\Performance_CI_Node' ];

	public function test_every_declared_command_named_for_a_read_base_command_declares_read(): void {
		$siblings = self::sibling_loader();
		$siblings->register();
		try {
			$classes = $this->node_classes( $siblings );
			$loaded  = \array_values( \array_filter( $classes, self::schema_loads( ... ) ) );
			$skipped = \array_values( \array_diff( $classes, $loaded ) );
			\sort( $skipped );
			$this->assertSame( self::UNBOOTED, $skipped, 'a sibling class whose schema needs its own plugin booted is named here, so none escapes the sweep unseen' );
			$foreign = \array_filter( $loaded, static fn ( string $class ): bool => ! \str_starts_with( $class, 'Newspack_Nodes\\' ) );
			$this->assertContains( Table_Node::class, $loaded );
			$this->assertArrayHasKey( 'stats', Command_Interpreter_Node::declared_commands( Table_Node::class ), "a Table's :config stats is in the sweep" );
			$this->assertSame( [], self::wrong_roles( $loaded ) );
			if ( [] !== $siblings->getClassMap() ) {
				$this->assertNotEmpty( $foreign, 'no sibling node class read its schema in this suite' );
			}
		} finally {
			$siblings->unregister();
		}
	}

	public function test_a_config_stats_declared_above_read_fails_the_sweep(): void {
		$this->assertSame( [ Tune_Stats_Fixture_Node::class . ' stats: tune' ], self::wrong_roles( [ Tune_Stats_Fixture_Node::class ] ) );
	}

	/**
	 * Each command a class declares under a read base command's name at a
	 * role other than READ, as `<class> <verb>: <role>`.
	 *
	 * @param list<class-string<Node>> $classes The classes to read.
	 * @return list<string>
	 */
	private static function wrong_roles( array $classes ): array {
		$wrong = [];
		foreach ( $classes as $class ) {
			foreach ( Command_Interpreter_Node::declared_commands( $class ) as $verb => $declared ) {
				$role = \is_string( $declared['capability'] ?? null ) ? $declared['capability'] : Capabilities::MANAGE;
				if ( Capabilities::READ === Command_Interpreter_Node::base_role( (string) $verb ) && Capabilities::READ !== $role ) {
					$wrong[] = "{$class} {$verb}: {$role}";
				}
			}
		}
		return $wrong;
	}

	/**
	 * Whether a sibling class's schema reads in this suite: one that needs
	 * its own plugin booted, a constant or a class the plugin file defines,
	 * is left to that plugin's suite. A substrate class always reads.
	 *
	 * @param class-string<Node> $class The class.
	 */
	private static function schema_loads( string $class ): bool {
		if ( \str_starts_with( $class, 'Newspack_Nodes\\' ) ) {
			return true;
		}
		try {
			Command_Interpreter_Node::declared_commands( $class );
			return true;
		} catch ( \Error ) {
			return false;
		}
	}

	/**
	 * A loader for each sibling plugin's own classes, read from its composer
	 * classmap where the sibling is checked out beside this one.
	 */
	private static function sibling_loader(): ClassLoader {
		$sources = \dirname( __DIR__, 3 );
		$loader  = new ClassLoader();
		foreach ( self::SIBLINGS as $plugin ) {
			$file = "{$sources}/{$plugin}/vendor/composer/autoload_classmap.php";
			if ( \is_file( $file ) ) {
				$loader->addClassMap(
					\array_filter(
						(array) require $file,
						static fn ( string $path ): bool => \str_starts_with( $path, "{$sources}/{$plugin}/includes/" )
					)
				);
			}
		}
		return $loader;
	}

	/**
	 * Every Node class in this suite's classmaps and the siblings', abstract
	 * ones included, since a subclass inherits their schemas.
	 *
	 * @return list<class-string<Node>>
	 */
	private function node_classes( ClassLoader $siblings ): array {
		$map = $siblings->getClassMap();
		foreach ( ClassLoader::getRegisteredLoaders() as $loader ) {
			$map += $loader->getClassMap();
		}
		$classes = [];
		foreach ( \array_keys( $map ) as $fqcn ) {
			if ( \str_ends_with( $fqcn, '_Node' ) && \is_subclass_of( $fqcn, Node::class ) ) {
				$classes[] = $fqcn;
			}
		}
		$this->assertNotEmpty( $classes, 'the composer classmap lists no node classes (run composer dump-autoload -o)' );
		return $classes;
	}
}

/** A node declaring a `:config` `stats` at `tune`, the shape the sweep refuses. */
final class Tune_Stats_Fixture_Node extends Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				[
					'name'       => 'stats',
					'capability' => Capabilities::TUNE,
					'handler'    => static fn (): array => [],
				],
			],
		];
	}
}
