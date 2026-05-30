<?php
/**
 * ClassesCITest: unit tests for Classes_CI, the M3 service-interpreter that
 * replaces the legacy ClassesController. Sets the substrate pattern
 * every other M3 interpreter test (Layouts_CI, Topologies_CI) will follow:
 * instantiate the interpreter (no ctor args — substrate state is global),
 * fire a verb through VerbHarness, assert on the decoded payload.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Composer\Autoload\ClassLoader;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Tests\Fixtures\Malformed_Schema_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Classes_CI_Node::class )]
class ClassesCITest extends TestCase {

	/** @var array<class-string,string>|null Loader classMap snapshot for restore. */
	private ?array $classmap_snapshot = null;

	protected function tearDown(): void {
		$this->restore_classmap();
		VerbHarness::reset();
		parent::tearDown();
	}

	/**
	 * Register a fixture class into the active composer classmap so Classes_CI's
	 * scan discovers it, snapshotting the prior classMap for tearDown to restore
	 * (composer's ClassLoader has no public removeClassMap).
	 *
	 * @param class-string $fqcn Fully-qualified fixture class name.
	 * @param string       $file Path to the file declaring it.
	 */
	private function register_fixture_class( string $fqcn, string $file ): void {
		require_once $file;
		$loaders = ClassLoader::getRegisteredLoaders();
		$loader  = \reset( $loaders );
		$this->assertNotFalse( $loader, 'a composer ClassLoader must be registered for fixture injection' );
		$ref = new \ReflectionProperty( ClassLoader::class, 'classMap' );
		$ref->setAccessible( true );
		$this->classmap_snapshot = $ref->getValue( $loader );
		$loader->addClassMap( [ $fqcn => $file ] );
	}

	/** Restore the loader's classMap if a fixture was registered this test. */
	private function restore_classmap(): void {
		if ( null === $this->classmap_snapshot ) {
			return;
		}
		$loaders = ClassLoader::getRegisteredLoaders();
		$loader  = \reset( $loaders );
		if ( false !== $loader ) {
			$ref = new \ReflectionProperty( ClassLoader::class, 'classMap' );
			$ref->setAccessible( true );
			$ref->setValue( $loader, $this->classmap_snapshot );
		}
		$this->classmap_snapshot = null;
	}

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Classes_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame( [ 'list' ], $names );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_list_verb_returns_classes_and_formatters(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$this->assertIsArray( $result );
		$this->assertArrayHasKey( 'classes', $result );
		$this->assertArrayHasKey( 'formatters', $result );
		$this->assertNotEmpty( $result['classes'] );
	}

	public function test_list_filters_hidden_category(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		foreach ( $result['classes'] as $entry ) {
			$this->assertNotSame(
				'Hidden',
				$entry['category'],
				"Class '{$entry['shell_name']}' has Hidden category — should be filtered out"
			);
		}
	}

	public function test_list_returns_sorted_by_category_then_name(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$pairs = \array_map(
			static fn ( $c ) => [ $c['category'], $c['shell_name'] ],
			$result['classes']
		);
		$sorted = $pairs;
		\usort( $sorted, static fn ( $a, $b ) => $a <=> $b );
		$this->assertSame( $sorted, $pairs );
	}

	public function test_list_strips_verb_handlers_to_plain_serializable_fields(): void {
		// Topologies_CI now carries `handler` closures inside its node_schema
		// verbs[]; the catalog must inline only {name,description,args} so the
		// payload stays a plain, serializable structure.
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		// Guard: a stale/empty composer classmap (no `composer dump-autoload -o`)
		// would yield zero classes and pass this strip test vacuously. Assert
		// discovery actually found classes — and Topologies specifically — so a
		// broken classmap fails LOUDLY here, not silently green.
		$this->assertNotEmpty( $result['classes'], 'class discovery found nothing — stale composer classmap?' );
		$shell_names = \array_column( $result['classes'], 'shell_name' );
		$this->assertContains(
			'Topologies_CI',
			$shell_names,
			'Topologies_CI absent from catalog — class discovery broken (run composer dump-autoload -o)'
		);

		$topologies = null;
		foreach ( $result['classes'] as $entry ) {
			if ( 'Topologies_CI' === $entry['shell_name'] ) {
				$topologies = $entry;
				break;
			}
		}
		$this->assertNotNull( $topologies, 'Topologies must appear in the class catalog' );
		$this->assertNotEmpty( $topologies['commands'] );

		foreach ( $topologies['commands'] as $verb ) {
			$this->assertSame(
				[ 'name', 'description', 'args' ],
				\array_keys( $verb ),
				"verb '{$verb['name']}' must expose only name/description/args — no handler leak"
			);
			$this->assertArrayNotHasKey( 'handler', $verb );
		}
	}

	public function test_list_tolerates_a_malformed_verb_entry(): void {
		// A registered class whose node_schema's verbs[] mixes a non-array entry
		// (a bare string) with a well-formed verb must NOT fatal the whole `list`
		// (which scans every registered class). The malformed entry is skipped;
		// the well-formed one is stripped to {name,description,args}.
		$this->register_fixture_class(
			Malformed_Schema_Node::class,
			\dirname( __DIR__ ) . '/Helpers/fixtures/class-malformed-schema-node.php'
		);

		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$fixture = null;
		foreach ( $result['classes'] as $entry ) {
			if ( 'Malformed_Schema' === $entry['shell_name'] ) {
				$fixture = $entry;
				break;
			}
		}
		$this->assertNotNull( $fixture, 'the fixture class must be discovered by the catalog scan' );

		// Exactly the well-formed verb survives, stripped to {name,description,args};
		// the bare-string entry is omitted (no TypeError, no malformed leftover).
		$this->assertCount( 1, $fixture['commands'], 'only the well-formed verb may survive the strip' );
		$this->assertSame( 'good', $fixture['commands'][0]['name'] );
		$this->assertSame(
			[ 'name', 'description', 'args' ],
			\array_keys( $fixture['commands'][0] ),
			'surviving verb must expose only name/description/args'
		);
		// List shape: a sequential (JSON-array) list, no string leftover.
		$this->assertSame( \array_values( $fixture['commands'] ), $fixture['commands'] );
		foreach ( $fixture['commands'] as $verb ) {
			$this->assertIsArray( $verb, 'no non-array (string) verb may leak through the strip' );
		}
	}

	public function test_raw_catalog_payload_has_no_live_closures(): void {
		// Dispatch the verb DIRECTLY (not through VerbHarness, whose JSON wire
		// would already have flattened any leaked Closure to `{}` → `[]`). On the
		// raw in-memory payload a leaked handler is still a live Closure; assert
		// the catalog is therefore JSON-lossless (a Closure silently encodes as an
		// empty object, corrupting the verb the GUI consumes — json_encode never
		// returns false for it).
		$raw = ( new Classes_CI_Node() )->dispatch( 'list' );

		// Guard: a stale/empty classmap yields zero classes, making the
		// no-closures walk pass vacuously. Assert discovery found Topologies_CI
		// (whose schema carries the very handler closures this test guards
		// against) so a broken classmap fails LOUDLY as "discovery broken".
		$this->assertNotEmpty( $raw['classes'], 'class discovery found nothing — stale composer classmap?' );
		$this->assertContains(
			'Topologies_CI',
			\array_column( $raw['classes'], 'shell_name' ),
			'Topologies_CI absent from catalog — class discovery broken (run composer dump-autoload -o)'
		);

		$json = \wp_json_encode( $raw );
		$this->assertNotFalse( $json, 'class catalog must be JSON-encodable' );

		$round_tripped = \json_decode( (string) $json, true );
		$this->assertEquals(
			$raw['classes'],
			$round_tripped['classes'],
			'a JSON round-trip must be lossless — a leaked Closure would survive as an empty object'
		);

		// Belt-and-suspenders: no Closure anywhere in the raw payload.
		\array_walk_recursive(
			$raw,
			function ( $leaf ): void {
				$this->assertNotInstanceOf( \Closure::class, $leaf, 'no Closure may leak into the class catalog' );
			}
		);
	}

	public function test_list_flags_interpreter_classes_with_is_interpreter(): void {
		// The console routes a node's command verbs to the bare node iff the node
		// IS a Command_Interpreter_Node (it handles verbs directly); otherwise to
		// `<name>:config` (a sibling interpreter). The catalog is the single source of
		// truth for that distinction, exposed per class as `is_interpreter`.
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$by_name = [];
		foreach ( $result['classes'] as $entry ) {
			$by_name[ $entry['shell_name'] ] = $entry;
		}

		// A *_CI_Node (Command_Interpreter_Node subclass) → true.
		$this->assertArrayHasKey(
			'Topologies_CI',
			$by_name,
			'Topologies_CI absent from catalog — class discovery broken (run composer dump-autoload -o)'
		);
		$this->assertArrayHasKey(
			'is_interpreter',
			$by_name['Topologies_CI'],
			'each catalog entry must carry an is_interpreter flag'
		);
		$this->assertTrue(
			$by_name['Topologies_CI']['is_interpreter'],
			'an interpreter (Command_Interpreter_Node subclass) must report is_interpreter === true'
		);

		// A plain data/processing node (Tee, not an interpreter) → false.
		$this->assertArrayHasKey(
			'Tee',
			$by_name,
			'Tee absent from catalog — class discovery broken (run composer dump-autoload -o)'
		);
		$this->assertFalse(
			$by_name['Tee']['is_interpreter'],
			'a non-interpreter data node must report is_interpreter === false'
		);
	}
}
