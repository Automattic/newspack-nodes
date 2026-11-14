<?php
/**
 * CompositionTest: the composition layer's declarations, its validator, its
 * serializer, the editor's page data and the editor's mount, against the
 * fictional consumer `acme-desk` that `Composes_Acme_Desk` declares.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Block_Editor_Bootstrap;
use Newspack_Nodes\Composition;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\Composes_Acme_Desk;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

#[CoversClass( Composition::class )]
final class CompositionTest extends TestCase {

	use Composes_Acme_Desk;

	private const BOARD = 'acme-desk/board';

	private const EDITOR = 'acme-desk-editor';

	private const PAGES = [ 'board' => self::BOARD ];

	private const BUILD = __DIR__ . '/../fixtures/editor-build';

	protected function setUp(): void {
		parent::setUp();
		$this->declare_acme_desk();
	}

	protected function tearDown(): void {
		$this->forget_declarations();
		( new \ReflectionProperty( Block_Editor_Bootstrap::class, 'canvas_context' ) )->setValue( null, null );
		( new \ReflectionProperty( Block_Editor_Bootstrap::class, 'content_blocks_loaded' ) )->setValue( null, false );
		\wp_shim_reset_block_editor();
		unset( $GLOBALS['_registered_scripts'] );
		parent::tearDown();
	}

	/**
	 * One edit of the filter map per declaration refusal, and the words the
	 * refusal names.
	 *
	 * @return array<string,array{0:\Closure(array): mixed,1:list<string>}>
	 */
	public static function refused_declarations(): array {
		$edit = static fn ( \Closure $change ): \Closure => static function ( array $map ) use ( $change ): array {
			$map['acme-desk'] = $change( $map['acme-desk'] );
			return $map;
		};
		return [
			'a filter answering no map'          => [ static fn ( array $map ): string => 'acme-desk', [ Composition::FILTER ] ],
			'a namespace that is not one'        => [ static fn ( array $map ): array => [ 'Acme_Desk' => $map['acme-desk'] ], [ 'Acme_Desk', 'not a namespace' ] ],
			'a declaration that is not a map'    => [ static fn ( array $map ): array => [ 'acme-desk' => 'desk' ], [ 'acme-desk', '{ blocks, contexts }' ] ],
			'a declaration with no contexts'     => [ $edit( static function ( array $d ): array {
				unset( $d['contexts'] );
				return $d;
			} ), [ 'acme-desk', '{ blocks, contexts }' ] ],
			'a block outside its namespace'      => [ $edit( static function ( array $d ): array {
				$d['blocks']['core/html'] = $d['blocks']['acme-desk/tally'];
				return $d;
			} ), [ 'acme-desk', 'core/html' ] ],
			'a context outside its namespace'    => [ $edit( static function ( array $d ): array {
				$d['contexts']['other/board'] = $d['contexts']['acme-desk/digest'];
				return $d;
			} ), [ 'acme-desk', 'other/board' ] ],
			'a block name holding a capital'     => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/Tally'] = $d['blocks']['acme-desk/tally'];
				return $d;
			} ), [ 'acme-desk/Tally', 'block name' ] ],
			'a block name opening on a digit'    => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/9tally'] = $d['blocks']['acme-desk/tally'];
				return $d;
			} ), [ 'acme-desk/9tally', 'block name' ] ],
			'a block with no title'              => [ $edit( static function ( array $d ): array {
				unset( $d['blocks']['acme-desk/queue']['title'] );
				return $d;
			} ), [ 'acme-desk/queue', 'title' ] ],
			'a block on no context'              => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/queue']['contexts'] = [];
				return $d;
			} ), [ 'acme-desk/queue', 'contexts' ] ],
			'a block on another namespace'       => [ static function ( array $map ): array {
				$map['acme-desk']['blocks']['acme-desk/tally']['contexts'][] = 'other/board';
				return [ 'other' => [ 'blocks' => [], 'contexts' => [ 'other/board' => $map['acme-desk']['contexts']['acme-desk/digest'] ] ] ] + $map;
			}, [ 'acme-desk/tally', 'other/board', 'outside acme-desk/' ] ],
			'a block on an undeclared context'   => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/tally']['contexts'][] = 'acme-desk/archive';
				return $d;
			} ), [ 'acme-desk/tally', 'undeclared context acme-desk/archive' ] ],
			'attributes that are not a map'      => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/queue']['attributes'] = 'lane';
				return $d;
			} ), [ 'acme-desk/queue', 'attributes' ] ],
			'an attribute with no type'          => [ $edit( static function ( array $d ): array {
				unset( $d['blocks']['acme-desk/queue']['attributes']['lane']['type'] );
				return $d;
			} ), [ 'acme-desk/queue', 'lane declares no type' ] ],
			'an attribute with no default'       => [ $edit( static function ( array $d ): array {
				unset( $d['blocks']['acme-desk/tally']['attributes']['limit']['default'] );
				return $d;
			} ), [ 'acme-desk/tally', 'limit declares no default' ] ],
			'a default its own schema refuses'   => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/tally']['attributes']['limit']['default'] = 99;
				return $d;
			} ), [ 'acme-desk/tally', 'limit has a default its schema refuses' ] ],
			'a flag that is not a bool'          => [ $edit( static function ( array $d ): array {
				$d['blocks']['acme-desk/rail']['container'] = 'yes';
				return $d;
			} ), [ 'acme-desk/rail', 'container' ] ],
			'a context with no default file'     => [ $edit( static function ( array $d ): array {
				$d['contexts']['acme-desk/digest']['default'] = '/nowhere/acme-desk/digest.html';
				return $d;
			} ), [ 'acme-desk/digest names no default layout file' ] ],
			'a default path that is relative'    => [ $edit( static function ( array $d ): array {
				$d['contexts']['acme-desk/digest']['default'] = 'fixtures/compositions/digest.html';
				return $d;
			} ), [ 'acme-desk/digest names no default layout file' ] ],
			'a context with no blocks cap'       => [ $edit( static function ( array $d ): array {
				$d['contexts']['acme-desk/digest']['max_blocks'] = 0;
				return $d;
			} ), [ 'acme-desk/digest', 'max_blocks' ] ],
			'a check that is not a closure'      => [ $edit( static function ( array $d ): array {
				$d['contexts']['acme-desk/digest']['check'] = 'strtoupper';
				return $d;
			} ), [ 'acme-desk/digest', 'check' ] ],
		];
	}

	/**
	 * @param \Closure(array): mixed $change
	 * @param list<string>           $names
	 */
	#[DataProvider( 'refused_declarations' )]
	public function test_a_declaration_breaking_a_rule_is_refused( \Closure $change, array $names ): void {
		$this->declare_acme_desk( $change );

		try {
			Composition::declarations();
			$this->fail( 'the declaration was accepted' );
		} catch ( \LogicException $refused ) {
			foreach ( $names as $name ) {
				$this->assertStringContainsString( $name, $refused->getMessage() );
			}
		}
	}

	public function test_a_throwing_declaration_filter_surfaces(): void {
		$calls = 0;
		\add_filter(
			Composition::FILTER,
			static function ( array $declared ) use ( &$calls ): array {
				if ( 1 === ++$calls ) {
					throw new \RuntimeException( 'acme-desk config unreadable' );
				}
				return $declared;
			}
		);

		try {
			Composition::declarations();
			$this->fail( 'the filter\'s throw was swallowed' );
		} catch ( \RuntimeException $thrown ) {
			$this->assertSame( 'acme-desk config unreadable', $thrown->getMessage() );
		}
		$this->assertArrayHasKey( self::BOARD, Composition::declarations()['contexts'] );
		$this->assertSame( 2, $calls );
		Composition::declarations();
		$this->assertSame( 2, $calls, 'a declaration that stood is memoized' );
	}

	/**
	 * One markup per refusal, and the words the refusal names.
	 *
	 * @return array<string,array{0:string,1:list<string>}>
	 */
	public static function refused_shapes(): array {
		$tally   = '<!-- wp:acme-desk/tally /-->';
		$padding = \str_repeat( 'x', Composition::MAX_MARKUP_BYTES );
		return [
			'an undeclared block'           => [ '<!-- wp:acme-desk/ghost /-->', [ 'acme-desk/ghost', 'not a declared block' ] ],
			'a block the context refuses'   => [ '<!-- wp:acme-desk/summary /-->', [ 'acme-desk/summary', self::BOARD ] ],
			'HTML between blocks'           => [ "{$tally}<p>loose</p>{$tally}", [ 'HTML outside a block' ] ],
			'HTML inside a block'           => [ '<!-- wp:acme-desk/tally --><p>x</p><!-- /wp:acme-desk/tally -->', [ 'acme-desk/tally', 'holds HTML' ] ],
			'a block holding blocks'        => [ "<!-- wp:acme-desk/tally -->{$tally}<!-- /wp:acme-desk/tally -->", [ 'acme-desk/tally', 'holds no blocks' ] ],
			'a container in a container'    => [ '<!-- wp:acme-desk/rail --><!-- wp:acme-desk/rail /--><!-- /wp:acme-desk/rail -->', [ 'acme-desk/rail', 'only at the top, in a column or in a group' ] ],
			'a second single block'         => [ '<!-- wp:acme-desk/queue /--><!-- wp:acme-desk/queue {"lane":"escalated"} /-->', [ 'acme-desk/queue', 'once' ] ],
			'attributes that are not JSON'  => [ '<!-- wp:acme-desk/tally {"limit":} /-->', [ 'acme-desk/tally', 'not a JSON object' ] ],
			'an undeclared attribute'       => [ '<!-- wp:acme-desk/tally {"colour":"red"} /-->', [ 'acme-desk/tally', 'colour' ] ],
			'an attribute its schema fails' => [ '<!-- wp:acme-desk/tally {"limit":99} /-->', [ 'acme-desk/tally', 'limit' ] ],
			'eight blocks past seven'       => [ \str_repeat( $tally, 8 ), [ '8 blocks', '7' ] ],
			'markup past the byte cap'      => [ "<!-- wp:acme-desk/tally {\"heading\":\"{$padding}\"} /-->", [ (string) Composition::MAX_MARKUP_BYTES ] ],
		];
	}

	/**
	 * @param list<string> $names
	 */
	#[DataProvider( 'refused_shapes' )]
	public function test_validate_refuses_each_shape( string $markup, array $names ): void {
		try {
			Composition::validate( self::BOARD, $markup );
			$this->fail( 'the markup was accepted' );
		} catch ( \RuntimeException $refused ) {
			foreach ( $names as $name ) {
				$this->assertStringContainsString( $name, $refused->getMessage() );
			}
		}
	}

	public function test_a_container_holds_blocks_at_the_top_level(): void {
		$tree = Composition::validate(
			self::BOARD,
			"<!-- wp:acme-desk/rail -->\n<!-- wp:acme-desk/lens {\"lens\":\"desk-q2\"} /-->\n<!-- /wp:acme-desk/rail -->"
		);

		$this->assertSame(
			[
				[
					'name'       => 'acme-desk/rail',
					'attributes' => [],
					'inner'      => [
						[
							'name'       => 'acme-desk/lens',
							'attributes' => [ 'lens' => 'desk-q2' ],
							'inner'      => [],
						],
					],
				],
			],
			$tree
		);
	}

	public function test_validate_hands_every_block_to_the_check(): void {
		Composition::validate( self::BOARD, "<!-- wp:acme-desk/queue /-->\n<!-- wp:acme-desk/rail --><!-- wp:acme-desk/lens /--><!-- /wp:acme-desk/rail -->" );

		$this->assertSame( [ 'acme-desk/queue', 'acme-desk/rail', 'acme-desk/lens' ], $this->checked );
	}

	public function test_validate_shape_never_calls_check(): void {
		$tree = Composition::validate_shape( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"desk-q3"} /-->' );

		$this->assertSame( 'desk-q3', $tree[0]['attributes']['lens'] );
		$this->assertSame( [], $this->checked );
	}

	public function test_attributes_are_laid_over_their_defaults(): void {
		$tree = Composition::validate( self::BOARD, '<!-- wp:acme-desk/tally {"limit":7} /-->' );

		$this->assertSame( [ 'heading' => 'Open tickets', 'limit' => 7, 'open' => true ], $tree[0]['attributes'] );
	}

	public function test_attributes_take_their_schema_type(): void {
		$tree = Composition::validate( self::BOARD, '<!-- wp:acme-desk/tally {"limit":"7","open":"false"} /-->' );

		$this->assertSame( 7, $tree[0]['attributes']['limit'] );
		$this->assertFalse( $tree[0]['attributes']['open'] );
	}

	public function test_a_declared_default_takes_its_schema_type(): void {
		$this->declare_acme_desk(
			static function ( array $map ): array {
				$map['acme-desk']['blocks']['acme-desk/tally']['attributes']['limit']['default'] = '12';
				return $map;
			}
		);

		$this->assertSame( 12, Composition::validate( self::BOARD, '<!-- wp:acme-desk/tally /-->' )[0]['attributes']['limit'] );
		$this->assertSame( 12, Composition::schemas( self::BOARD )['blocks']['acme-desk/tally']['attributes']['limit']['default'] );
	}

	public function test_serialize_writes_every_attribute_and_no_whitespace(): void {
		$tree = Composition::validate(
			self::BOARD,
			"\n<!-- wp:acme-desk/tally {\"limit\":7} /-->\n\n<!-- wp:acme-desk/rail -->\n  <!-- wp:acme-desk/lens /-->\n<!-- /wp:acme-desk/rail -->\n"
		);

		$this->assertSame(
			'<!-- wp:acme-desk/tally {"heading":"Open tickets","limit":7,"open":true} /-->'
				. '<!-- wp:acme-desk/rail --><!-- wp:acme-desk/lens {"lens":"desk-all"} /--><!-- /wp:acme-desk/rail -->',
			Composition::serialize( self::BOARD, $tree )
		);
	}

	public function test_serialize_holds_the_escaped_markup_to_the_byte_cap(): void {
		$tree = Composition::validate( self::BOARD, '<!-- wp:acme-desk/lens {"lens":"' . \str_repeat( '<', \intdiv( Composition::MAX_MARKUP_BYTES, 5 ) ) . '"} /-->' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( (string) Composition::MAX_MARKUP_BYTES );
		Composition::serialize( self::BOARD, $tree );
	}

	public function test_an_undeclared_context_is_refused(): void {
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'acme-desk/archive' );

		Composition::validate( 'acme-desk/archive', '' );
	}

	/** Capture what the composition layer logs. */
	private function logged(): \ArrayObject {
		$lines = new \ArrayObject();
		Core::set_stderr_handler( static function ( string $line ) use ( $lines ): void {
			$lines[] = $line;
		} );
		return $lines;
	}

	public function test_an_unreadable_default_logs_why_and_names_no_path(): void {
		$dir  = $this->make_temp_dir( 'composition-default-' );
		$path = "{$dir}/digest.html";
		\copy( self::fixture( 'digest' ), $path );
		\chmod( $path, 0 );
		$this->declare_acme_desk(
			static function ( array $map ) use ( $path ): array {
				$map['acme-desk']['contexts']['acme-desk/digest']['default'] = $path;
				return $map;
			}
		);
		$logged = $this->logged();

		try {
			Composition::default_markup( 'acme-desk/digest' );
			$this->fail( 'an unreadable default was read' );
		} catch ( \RuntimeException $refused ) {
			$this->assertSame( 'composition acme-desk/digest: its default layout will not read', $refused->getMessage() );
			$this->assertStringNotContainsString( $dir, $refused->getMessage() );
		} finally {
			\chmod( $path, 0600 );
		}
		$log = \implode( "\n", (array) $logged );
		$this->assertStringContainsString( $path, $log );
		$this->assertStringContainsString( 'Permission denied', $log );
	}

	public function test_a_missing_default_file_logs_its_path_and_refuses_without_it(): void {
		$this->declare_acme_desk(
			static function ( array $map ): array {
				$map['acme-desk']['contexts']['acme-desk/digest']['default'] = '/nowhere/acme-desk/digest.html';
				return $map;
			}
		);
		$logged = $this->logged();

		try {
			Composition::declarations();
			$this->fail( 'a missing default file was declared' );
		} catch ( \LogicException $refused ) {
			$this->assertStringContainsString( 'acme-desk/digest names no default layout file', $refused->getMessage() );
			$this->assertStringNotContainsString( '/nowhere', $refused->getMessage() );
		}
		$this->assertStringContainsString( '/nowhere/acme-desk/digest.html', \implode( "\n", (array) $logged ) );
	}

	public function test_schemas_answer_the_blocks_a_context_admits(): void {
		$schemas = Composition::schemas( 'acme-desk/digest' );

		$this->assertSame( 'acme-desk/digest', $schemas['context'] );
		$this->assertSame( 3, $schemas['max_blocks'] );
		$this->assertSame(
			[ 'acme-desk/tally', 'acme-desk/summary' ],
			\array_keys( \array_filter( $schemas['blocks'], static fn ( array $block ): bool => ! $block['core'] ) )
		);
		$this->assertSame(
			[
				'title'      => 'Summary',
				'attributes' => [ 'tone' => [ 'type' => 'string', 'default' => 'plain' ] ],
				'container'  => false,
				'multiple'   => true,
				'core'       => false,
				'text'       => null,
			],
			$schemas['blocks']['acme-desk/summary']
		);
		$this->assertFalse( Composition::schemas( self::BOARD )['blocks']['acme-desk/queue']['multiple'] );
		$this->assertTrue( Composition::schemas( self::BOARD )['blocks']['acme-desk/rail']['container'] );
	}

	/**
	 * Give the digest context `$patterns`.
	 *
	 * @param array<mixed> $patterns The context's `patterns`.
	 */
	private function declare_patterns( array $patterns ): void {
		$this->declare_acme_desk(
			static function ( array $map ) use ( $patterns ): array {
				$map['acme-desk']['contexts']['acme-desk/digest']['patterns'] = $patterns;
				return $map;
			}
		);
	}

	public function test_schemas_list_a_contexts_patterns_as_their_trees(): void {
		$this->declare_patterns(
			[
				'tui-7720'  => [ 'title' => 'Tui hush', 'file' => self::fixture( 'pattern-tui-7720' ) ],
				'ruru-7721' => [ 'title' => 'Ruru roost', 'file' => self::fixture( 'pattern-ruru-7721' ) ],
			]
		);

		$this->assertSame(
			[
				[
					'name'   => 'tui-7720',
					'title'  => 'Tui hush',
					'blocks' => [ [ 'name' => 'acme-desk/summary', 'attributes' => [ 'tone' => 'hush' ], 'inner' => [] ] ],
				],
				[
					'name'   => 'ruru-7721',
					'title'  => 'Ruru roost',
					'blocks' => [
						[ 'name' => 'acme-desk/tally', 'attributes' => [ 'heading' => 'Ruru roost', 'limit' => 7, 'open' => true ], 'inner' => [] ],
						[ 'name' => 'acme-desk/summary', 'attributes' => [ 'tone' => 'plain' ], 'inner' => [] ],
					],
				],
			],
			Composition::schemas( 'acme-desk/digest' )['patterns']
		);
	}

	public function test_a_pattern_that_does_not_validate_refuses_the_declarations(): void {
		$this->declare_patterns( [ 'ruru-7721' => [ 'title' => 'Ruru', 'file' => self::fixture( 'pattern-bad-7722' ) ] ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'composition declaration acme-desk: acme-desk/digest pattern ruru-7721' );
		Composition::declarations();
	}

	public function test_a_refused_pattern_leaves_nothing_memoized(): void {
		$this->declare_patterns( [ 'ruru-7721' => [ 'title' => 'Ruru', 'file' => self::fixture( 'pattern-bad-7722' ) ] ] );
		try {
			Composition::declarations();
			$this->fail( 'the pattern was accepted' );
		} catch ( \LogicException ) {
			$this->expectException( \LogicException::class );
			$this->expectExceptionMessage( 'pattern ruru-7721' );
			Composition::declarations();
		}
	}

	public function test_a_pattern_may_name_a_shared_block_its_context_admits(): void {
		$this->declare_shared( [ 'kea-7710/strip' ], null, [ 'tahi-7723' => [ 'title' => 'Tahi', 'file' => self::fixture( 'pattern-strip-7723' ) ] ] );

		$this->assertSame(
			[
				[
					'name'   => 'tahi-7723',
					'title'  => 'Tahi',
					'blocks' => [ [ 'name' => 'kea-7710/strip', 'attributes' => [ 'hue' => 'plum' ], 'inner' => [] ] ],
				],
			],
			Composition::schemas( 'weka-7711/board' )['patterns']
		);
	}

	public function test_patterns_declared_as_a_list_are_refused(): void {
		$this->declare_patterns( [ [ 'title' => 'Ruru', 'file' => self::fixture( 'pattern-ruru-7721' ) ] ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'acme-desk/digest declares patterns that are not a map of slug => { title, file }' );
		Composition::declarations();
	}

	public function test_a_pattern_that_is_not_a_map_is_refused(): void {
		$this->declare_patterns( [ 'ruru-7721' => 'pattern-ruru-7721' ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'pattern ruru-7721 is not a { title, file } map' );
		Composition::declarations();
	}

	public function test_a_pattern_naming_a_missing_file_refuses_the_declarations(): void {
		$this->declare_patterns( [ 'ruru-7721' => [ 'title' => 'Ruru', 'file' => '/nowhere/ruru-7721.html' ] ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'acme-desk/digest pattern ruru-7721 names no layout file' );
		Composition::declarations();
	}

	public function test_a_pattern_slug_or_title_that_breaks_a_rule_refuses_the_declarations(): void {
		$this->declare_patterns( [ 'Ruru_7721' => [ 'title' => 'Ruru', 'file' => self::fixture( 'pattern-ruru-7721' ) ] ] );
		try {
			Composition::declarations();
			$this->fail( 'the slug was accepted' );
		} catch ( \LogicException $refused ) {
			$this->assertStringContainsString( 'pattern Ruru_7721 is not a slug', $refused->getMessage() );
		}

		$this->declare_patterns( [ 'ruru-7721' => [ 'title' => '', 'file' => self::fixture( 'pattern-ruru-7721' ) ] ] );
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'pattern ruru-7721 declares no title' );
		Composition::declarations();
	}

	public function test_a_context_without_patterns_lists_none(): void {
		$this->assertSame( [], Composition::schemas( self::BOARD )['patterns'] );
	}

	/**
	 * Declare `kea-7710`'s shared block `strip` and `weka-7711`'s context
	 * `board`, which admits `$admits`.
	 *
	 * @param list<string>              $admits Block names the board admits.
	 * @param (\Closure(array): array)|null $edit   Edits the shared block's declaration.
	 * @param array<mixed>                  $patterns The board's patterns.
	 */
	private function declare_shared( array $admits, ?\Closure $edit = null, array $patterns = [] ): void {
		$strip = [
			'title'      => 'Strip',
			'shared'     => true,
			'attributes' => [ 'hue' => [ 'type' => 'string', 'default' => 'teal' ] ],
		];
		$strip = null === $edit ? $strip : $edit( $strip );
		\add_filter(
			Composition::FILTER,
			static fn ( array $declared ): array => $declared + [
				'kea-7710'  => [
					'blocks'   => [ 'kea-7710/strip' => $strip ],
					'contexts' => [],
				],
				'weka-7711' => [
					'blocks'   => [],
					'contexts' => [
						'weka-7711/board' => [
							'default'    => self::fixture( 'digest' ),
							'max_blocks' => 4,
							'admits'     => $admits,
							'patterns'   => $patterns,
						],
					],
				],
			]
		);
		$this->forget_declarations();
	}

	public function test_a_context_admits_a_shared_block_from_another_namespace(): void {
		$this->declare_shared( [ 'kea-7710/strip' ] );

		$tree = Composition::validate( 'weka-7711/board', '<!-- wp:kea-7710/strip {"hue":"plum"} /-->' );

		$this->assertSame( 'kea-7710/strip', $tree[0]['name'] );
		$this->assertSame( [ 'hue' => 'plum' ], $tree[0]['attributes'] );
		$this->assertSame(
			[ 'kea-7710/strip', 'core/heading', 'core/paragraph', 'core/list', 'core/list-item', 'core/group', 'core/columns', 'core/column', 'core/separator', 'core/spacer' ],
			\array_keys( Composition::blocks_for( 'weka-7711/board' ) )
		);
	}

	public function test_an_unadmitted_shared_block_is_refused_on_a_context(): void {
		$this->declare_shared( [] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'kea-7710/strip does not stand on weka-7711/board' );
		Composition::validate( 'weka-7711/board', '<!-- wp:kea-7710/strip /-->' );
	}

	public function test_admitting_an_undeclared_block_refuses_the_declarations(): void {
		$this->declare_shared( [ 'kea-7710/ghost' ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'composition declaration weka-7711: weka-7711/board admits kea-7710/ghost, which is not a shared block' );
		Composition::declarations();
	}

	public function test_admitting_a_block_that_is_not_shared_refuses_the_declarations(): void {
		$this->declare_shared( [ 'acme-desk/tally' ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'weka-7711/board admits acme-desk/tally, which is not a shared block' );
		Composition::declarations();
	}

	public function test_a_block_declaring_shared_and_contexts_is_refused(): void {
		$this->declare_shared(
			[],
			static fn ( array $strip ): array => $strip + [ 'contexts' => [ 'kea-7710/board' ] ]
		);

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'kea-7710/strip declares shared and contexts' );
		Composition::declarations();
	}

	public function test_an_admits_that_is_not_a_list_of_names_is_refused(): void {
		$this->declare_shared( [ 'strip' => 'kea-7710/strip' ] );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'weka-7711/board declares an admits that is not a list of block names' );
		Composition::declarations();
	}

	public function test_a_shared_that_is_not_a_bool_is_refused(): void {
		$this->declare_shared(
			[],
			static fn ( array $strip ): array => [ 'shared' => 'yes' ] + $strip
		);

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'kea-7710/strip declares a shared that is not a bool' );
		Composition::declarations();
	}

	public function test_schemas_carry_an_admitted_block(): void {
		$this->declare_shared( [ 'kea-7710/strip' ] );

		$blocks = Composition::schemas( 'weka-7711/board' )['blocks'];

		$this->assertSame(
			[
				'title'      => 'Strip',
				'attributes' => [ 'hue' => [ 'type' => 'string', 'default' => 'teal' ] ],
				'container'  => false,
				'multiple'   => true,
				'core'       => false,
				'text'       => null,
			],
			$blocks['kea-7710/strip']
		);
	}

	public function test_the_substrate_declares_its_shared_blocks(): void {
		$registered = \array_values(
			\array_filter(
				$GLOBALS['_wp_initial_action_registrations'][ Composition::FILTER ] ?? [],
				static fn ( array $one ): bool => [ Composition::class, 'declare_substrate_blocks' ] === $one['callback']
			)
		);
		$this->assertCount( 1, $registered );
		$this->assertSame( 5, $registered[0]['priority'] );

		$this->declare_shared( [ 'kea-7710/strip', 'newspack-nodes/section', 'newspack-nodes/stats' ] );

		$source = [ 'type' => 'string', 'default' => '' ];
		$names  = [
			'type'    => 'array',
			'items'   => [ 'type' => 'string' ],
			'default' => [],
		];
		$block  = static fn ( string $title, array $attributes, bool $container = false, bool $multiple = true ): array => [
			'title'      => $title,
			'contexts'   => [],
			'shared'     => true,
			'attributes' => $attributes,
			'container'  => $container,
			'multiple'   => $multiple,
		];
		$this->assertSame(
			[
				'newspack-nodes/stats'      => $block(
					'Stats',
					[
						'source'  => $source,
						'fields'  => $names,
						'columns' => [ 'type' => 'integer', 'minimum' => 0, 'maximum' => 12, 'default' => 0 ],
					]
				),
				'newspack-nodes/time-chart' => $block(
					'Time chart',
					[
						'source'  => $source,
						'metrics' => $names,
						'stacked' => [ 'type' => 'boolean', 'default' => false ],
						'title'   => $source,
					]
				),
				'newspack-nodes/table'      => $block(
					'Table',
					[
						'source'  => $source,
						'columns' => $names,
						'sort'    => [
							'type'                 => 'object',
							'properties'           => [
								'field'     => [ 'type' => 'string' ],
								'direction' => [ 'type' => 'string', 'enum' => [ 'asc', 'desc' ] ],
							],
							'additionalProperties' => false,
							'default'              => [ 'field' => '', 'direction' => 'desc' ],
						],
						'perPage' => [ 'type' => 'integer', 'minimum' => 1, 'maximum' => 100, 'default' => 20 ],
						'title'   => $source,
					]
				),
				'newspack-nodes/log-stream' => $block(
					'Log stream',
					[
						'source'  => $source,
						'columns' => $names,
						'title'   => $source,
					]
				),
				'newspack-nodes/sparkline'  => $block(
					'Sparkline',
					[
						'source' => $source,
						'field'  => $source,
						'title'  => $source,
					]
				),
				'newspack-nodes/section'    => $block(
					'Section',
					[
						'title'       => $source,
						'description' => $source,
					],
					true
				),
			],
			\array_filter(
				Composition::declarations()['blocks'],
				static fn ( array $block, string $name ): bool => $block['shared'] && \str_starts_with( $name, 'newspack-nodes/' ),
				\ARRAY_FILTER_USE_BOTH
			)
		);

		$tree = Composition::validate(
			'weka-7711/board',
			'<!-- wp:newspack-nodes/section {"title":"Moa 7712"} --><!-- wp:newspack-nodes/stats {"source":"moa-7712","fields":["height"],"columns":3} /--><!-- /wp:newspack-nodes/section -->'
		);
		$this->assertSame( 'newspack-nodes/section', $tree[0]['name'] );
		$this->assertSame(
			[
				'source'  => 'moa-7712',
				'fields'  => [ 'height' ],
				'columns' => 3,
			],
			$tree[0]['inner'][0]['attributes']
		);

		$tree = Composition::validate(
			'weka-7711/board',
			'<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:newspack-nodes/section {"title":"Kiwi 7713"} --><!-- wp:kea-7710/strip {"hue":"plum"} /--><!-- /wp:newspack-nodes/section --></div><!-- /wp:column --></div><!-- /wp:columns -->'
		);
		$section = $tree[0]['inner'][0]['inner'][0];
		$this->assertSame( 'Kiwi 7713', $section['attributes']['title'] );
		$this->assertSame( [ 'hue' => 'plum' ], $section['inner'][0]['attributes'] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'newspack-nodes/section stands only at the top, in a column or in a group' );
		Composition::validate(
			'weka-7711/board',
			'<!-- wp:newspack-nodes/section --><!-- wp:newspack-nodes/section /--><!-- /wp:newspack-nodes/section -->'
		);
	}

	public function test_a_foreign_declaration_under_the_substrate_namespace_is_refused(): void {
		$GLOBALS['_wp_actions'][ Composition::FILTER ] = [
			static fn ( array $declared ): array => $declared + [
				'newspack-nodes' => [
					'blocks'   => [
						'quail-4410/strip' => [
							'title'      => 'Strip',
							'shared'     => true,
							'attributes' => [],
						],
					],
					'contexts' => [],
				],
			],
			[ Composition::class, 'declare_substrate_blocks' ],
		];
		$this->forget_declarations();

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'composition declaration newspack-nodes: newspack-nodes belongs to the substrate, which declares its own blocks there' );
		Composition::declarations();
	}

	/** The `core` namespace belongs to WordPress, whose blocks every context admits. */
	public function test_a_declaration_under_the_core_namespace_is_refused(): void {
		$GLOBALS['_wp_actions'][ Composition::FILTER ] = [
			static fn ( array $declared ): array => $declared + [
				'core' => [
					'blocks'   => [
						'core/quail-4411' => [
							'title'      => 'Quail',
							'shared'     => true,
							'attributes' => [],
						],
					],
					'contexts' => [],
				],
			],
		];
		$this->forget_declarations();

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'composition declaration core: core belongs to WordPress, whose blocks every context admits' );
		Composition::declarations();
	}

	/** Log in a user holding `$caps`, `read` filtered onto `edit_posts`. */
	private function log_in( array $caps ): void {
		$GLOBALS['_enqueued_scripts']         = [];
		$GLOBALS['_localized_scripts']        = [];
		$GLOBALS['_wp_test_current_user_id']  = 7;
		$GLOBALS['_wp_test_current_user_can'] = $caps;
		\add_filter( 'newspack_nodes/capability_map', static fn ( array $map ): array => [ 'read' => 'edit_posts' ] + $map );
	}

	public function test_the_editor_loads_for_tune_only(): void {
		\wp_register_script( self::EDITOR, '/acme-desk/editor.js' );
		$this->log_in( [ 'edit_posts' => true ] );

		$this->assertFalse( Composition::editor( self::BOARD, self::EDITOR ) );
		$this->assertArrayNotHasKey( 'wp-block-editor', $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayNotHasKey( 'wp-block-library', $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayNotHasKey( self::EDITOR, $GLOBALS['_enqueued_scripts'] );
		$this->assertSame( [], $GLOBALS['_localized_scripts'] );

		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$this->assertTrue( Composition::editor( self::BOARD, self::EDITOR ) );
		$this->assertArrayHasKey( 'wp-block-editor', $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayHasKey( 'wp-block-library', $GLOBALS['_enqueued_scripts'], 'the core blocks the canvas offers register' );
		$this->assertArrayHasKey( self::EDITOR, $GLOBALS['_enqueued_scripts'] );
		$this->assertStringContainsString( 'for-acme-desk\/board', \implode( "\n", \array_column( $GLOBALS['_inline_scripts'], 1 ) ) );
		$this->assertStringContainsString( 'registerCoreBlocks()', \implode( "\n", \array_column( $GLOBALS['_inline_scripts'], 1 ) ) );
		$localized = $GLOBALS['_localized_scripts'][ self::EDITOR ];
		$this->assertSame( Composition::EDITOR_GLOBAL, $localized['object_name'] );
		$this->assertSame( self::BOARD, $localized['data']['context'] );
		$this->assertSame( \array_keys( Composition::schemas( self::BOARD )['blocks'] ), \array_keys( $localized['data']['blocks'] ) );

		$this->expectException( \LogicException::class );
		Composition::editor( 'acme-desk/archive', self::EDITOR );
	}

	public function test_the_editor_refuses_a_bundle_never_registered_before_the_canvas(): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );

		try {
			Composition::editor( self::BOARD, self::EDITOR );
			$this->fail( 'an unregistered bundle loaded' );
		} catch ( \LogicException $refused ) {
			$this->assertStringContainsString( self::EDITOR, $refused->getMessage() );
		}
		$this->assertArrayNotHasKey( 'wp-block-editor', $GLOBALS['_enqueued_scripts'] );
		$this->assertSame( [], $GLOBALS['_localized_scripts'] );
	}

	/**
	 * Run `$run` with `$_GET['edit']` set to `$edit`, `$_GET` restored after.
	 *
	 * @param string   $edit The `?edit=` value.
	 * @param \Closure $run  What to run under it.
	 */
	private function with_edit( string $edit, \Closure $run ): void {
		$before = $_GET;
		try {
			$_GET['edit'] = $edit;
			$run();
		} finally {
			$_GET = $before;
		}
	}

	public function test_enqueue_editor_loads_the_page_named_by_edit_for_tune(): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );
		$this->with_edit(
			'board',
			function (): void {
				$this->assertTrue( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD, 'https://x.test/b' ) );
			}
		);
		$this->assertArrayHasKey( 'acme-fx-editor', $GLOBALS['_enqueued_scripts'] );
		$registered = $GLOBALS['_registered_scripts']['acme-fx-editor'];
		$this->assertSame( 'https://x.test/b/layout-editor.js', $registered['src'] );
		$this->assertSame( [ 'wp-element', 'wp-blocks' ], $registered['deps'] );
		$this->assertSame( 'fx-4417', $registered['version'] );
		$this->assertSame( self::BOARD, $GLOBALS['_localized_scripts']['acme-fx-editor']['data']['context'] );
		$style = $GLOBALS['_enqueued_styles']['acme-fx-editor'];
		$this->assertSame( 'https://x.test/b/layout-editor.css', $style['src'] );
		$this->assertSame( [ 'wp-components', 'wp-block-editor' ], $style['deps'] );
		$this->assertSame( 'fx-4417', $style['version'] );
		$this->assertSame( 'replace', $GLOBALS['_style_data']['acme-fx-editor']['rtl'] );
	}

	public function test_enqueue_editor_skips_a_stylesheet_the_build_lacks(): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );
		unset( $GLOBALS['_enqueued_styles'] );
		$this->with_edit(
			'board',
			function (): void {
				$this->assertTrue( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD . '-bare', 'https://x.test/b' ) );
			}
		);
		$this->assertArrayNotHasKey( 'acme-fx-editor', $GLOBALS['_enqueued_styles'] ?? [] );
	}

	public function test_enqueue_editor_ignores_an_edit_that_is_not_a_string(): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );
		$before = $_GET;
		try {
			$_GET['edit'] = [ 'board' ];
			$this->assertFalse( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD, 'https://x.test/b' ) );
		} finally {
			$_GET = $before;
		}
		$this->assertArrayNotHasKey( 'acme-fx-editor', $GLOBALS['_registered_scripts'] ?? [] );
		$this->assertSame( [], $GLOBALS['_enqueued_scripts'] );
	}

	/** @return array<string,array{0:string}> */
	public static function unclean_edits(): array {
		return [
			'trailing whitespace' => [ "board\n" ],
			'slashed value'       => [ 'bo\\ard' ],
		];
	}

	#[DataProvider( 'unclean_edits' )]
	public function test_enqueue_editor_reads_edit_unslashed_and_sanitized( string $edit ): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );
		$this->with_edit(
			$edit,
			function (): void {
				$this->assertTrue( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD, 'https://x.test/b' ) );
			}
		);
		$this->assertArrayHasKey( 'acme-fx-editor', $GLOBALS['_enqueued_scripts'] );
	}

	public function test_enqueue_editor_ignores_an_unknown_page(): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );
		$this->with_edit(
			'nope',
			function (): void {
				$this->assertFalse( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD, 'https://x.test/b' ) );
			}
		);
		$this->assertArrayNotHasKey( 'acme-fx-editor', $GLOBALS['_registered_scripts'] ?? [] );
		$this->assertSame( [], $GLOBALS['_enqueued_scripts'] );
	}

	public function test_enqueue_editor_loads_nothing_below_tune(): void {
		$this->log_in( [ 'edit_posts' => true ] );
		$this->with_edit(
			'board',
			function (): void {
				$this->assertFalse( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD, 'https://x.test/b' ) );
			}
		);
		$this->assertSame( [], $GLOBALS['_enqueued_scripts'] );
		$this->assertSame( [], $GLOBALS['_localized_scripts'] );
	}

	public function test_enqueue_editor_loads_nothing_when_the_bundle_is_unbuilt(): void {
		$this->log_in( [ 'edit_posts' => true, 'manage_options' => true ] );
		$this->with_edit(
			'board',
			function (): void {
				$this->assertFalse( Composition::enqueue_editor( self::PAGES, 'acme-fx-editor', self::BUILD . '-missing', 'https://x.test/b' ) );
			}
		);
		$this->assertArrayNotHasKey( 'acme-fx-editor', $GLOBALS['_registered_scripts'] ?? [] );
		$this->assertSame( [], $GLOBALS['_enqueued_scripts'] );
	}
}
