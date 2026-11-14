<?php
/**
 * CompositionCoreBlocksTest: the nine core blocks every composed context
 * admits, where each may stand, the attributes each may carry, and the text
 * a heading, paragraph or list item holds, filtered to an inline allowlist
 * on every read and written back as core's own markup.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Composition;
use Newspack_Nodes\Tests\Helpers\Composes_Acme_Desk;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

#[CoversClass( Composition::class )]
final class CompositionCoreBlocksTest extends TestCase {

	use Composes_Acme_Desk;

	private const BOARD = 'acme-desk/board';

	private const DIGEST = 'acme-desk/digest';

	protected function setUp(): void {
		parent::setUp();
		$this->declare_acme_desk();
		// An enum's refusal lists its values through wp_sprintf's %l, as WordPress hooks it.
		\add_filter( 'wp_sprintf', 'wp_sprintf_l', 10, 2 );
	}

	protected function tearDown(): void {
		$this->forget_declarations();
		parent::tearDown();
	}

	/**
	 * Each core block, alone, in the shape a layout stores it, and the node
	 * it validates to: a text block's text in its schema's `text` tag, and no
	 * element for any other.
	 *
	 * @return array<string,array{string,array<string,mixed>}>
	 */
	public static function core_blocks(): array {
		return [
			'heading'   => [
				'<!-- wp:heading {"level":3} --><h2>Tide 7901</h2><!-- /wp:heading -->',
				[ 'name' => 'core/heading', 'attributes' => [ 'level' => 3, 'content' => 'Tide 7901' ], 'inner' => [] ],
			],
			'paragraph' => [
				'<!-- wp:paragraph {"direction":"rtl"} --><p>Moor <em>7902</em></p><!-- /wp:paragraph -->',
				[ 'name' => 'core/paragraph', 'attributes' => [ 'direction' => 'rtl', 'content' => 'Moor <em>7902</em>' ], 'inner' => [] ],
			],
			'list'      => [
				'<!-- wp:list {"ordered":true,"reversed":true,"start":4,"type":"upper-roman"} --><!-- wp:list-item --><li>Buoy 7903</li><!-- /wp:list-item --><!-- /wp:list -->',
				[
					'name'       => 'core/list',
					'attributes' => [ 'ordered' => true, 'reversed' => true, 'start' => 4, 'type' => 'upper-roman' ],
					'inner'      => [ [ 'name' => 'core/list-item', 'attributes' => [ 'content' => 'Buoy 7903' ], 'inner' => [] ] ],
				],
			],
			'group'     => [
				'<!-- wp:group {"tagName":"section","layout":{"type":"flex","orientation":"vertical"}} --><!-- wp:separator {"tagName":"div"} /--><!-- /wp:group -->',
				[
					'name'       => 'core/group',
					'attributes' => [ 'tagName' => 'section', 'layout' => [ 'type' => 'flex', 'orientation' => 'vertical' ] ],
					'inner'      => [ [ 'name' => 'core/separator', 'attributes' => [ 'tagName' => 'div' ], 'inner' => [] ] ],
				],
			],
			'columns'   => [
				'<!-- wp:columns {"isStackedOnMobile":false,"verticalAlignment":"center"} --><!-- wp:column {"verticalAlignment":"bottom","width":"62.5%","layout":{"type":"constrained"}} --><!-- wp:spacer {"height":"0px","width":"30px","style":{"layout":{"flexSize":"64px","selfStretch":"fixed"}}} /--><!-- /wp:column --><!-- /wp:columns -->',
				[
					'name'       => 'core/columns',
					'attributes' => [ 'isStackedOnMobile' => false, 'verticalAlignment' => 'center' ],
					'inner'      => [
						[
							'name'       => 'core/column',
							'attributes' => [ 'verticalAlignment' => 'bottom', 'width' => '62.5%', 'layout' => [ 'type' => 'constrained' ] ],
							'inner'      => [
								[
									'name'       => 'core/spacer',
									'attributes' => [ 'height' => '0px', 'width' => '30px', 'style' => [ 'layout' => [ 'flexSize' => '64px', 'selfStretch' => 'fixed' ] ] ],
									'inner'      => [],
								],
							],
						],
					],
				],
			],
		];
	}

	#[DataProvider( 'core_blocks' )]
	public function test_each_core_block_stands_on_every_context( string $markup, array $node ): void {
		$this->assertSame( [ $node ], Composition::validate( self::BOARD, $markup ) );
		$this->assertSame( [ $node ], Composition::validate( self::DIGEST, $markup ) );
	}

	#[DataProvider( 'core_blocks' )]
	public function test_each_core_block_writes_back_in_the_shape_it_was_stored( string $markup, array $node ): void {
		$this->assertSame( $markup, Composition::serialize( self::BOARD, [ $node ] ) );
	}

	/** A group and a separator read in each element core may write them as. */
	public function test_a_group_and_a_separator_read_in_their_other_elements(): void {
		$tree = Composition::validate(
			self::BOARD,
			'<!-- wp:group {"tagName":"aside"} --><aside class="wp-block-group"><!-- wp:separator {"tagName":"div"} --><div class="wp-block-separator"></div><!-- /wp:separator --></aside><!-- /wp:group --><!-- wp:separator --><hr class="wp-block-separator"/><!-- /wp:separator -->'
		);

		$this->assertSame( [ 'aside', 'div', 'hr' ], [ $tree[0]['attributes']['tagName'], $tree[0]['inner'][0]['attributes']['tagName'], $tree[1]['attributes']['tagName'] ] );
	}

	/** Markup as core itself writes it, element classes and all, still reads, and is stored in the one shape. */
	public function test_cores_own_markup_reads_and_is_stored_in_the_one_shape(): void {
		$tree = Composition::validate(
			self::BOARD,
			'<!-- wp:columns {"isStackedOnMobile":true} --><div class="wp-block-columns"><!-- wp:column {"width":"40%"} --><div class="wp-block-column" style="flex-basis:40%"><!-- wp:heading {"level":4} --><h4 class="wp-block-heading">Kelp 7922</h4><!-- /wp:heading --></div><!-- /wp:column --></div><!-- /wp:columns -->'
		);

		$this->assertSame(
			'<!-- wp:columns {"isStackedOnMobile":true} --><!-- wp:column {"width":"40%"} --><!-- wp:heading {"level":4} --><h2>Kelp 7922</h2><!-- /wp:heading --><!-- /wp:column --><!-- /wp:columns -->',
			Composition::serialize( self::BOARD, $tree )
		);
	}

	public function test_the_editor_is_offered_the_core_blocks_beside_the_contexts_own(): void {
		$blocks = Composition::schemas( self::DIGEST )['blocks'];

		$this->assertSame(
			[ 'core/heading', 'core/paragraph', 'core/list', 'core/list-item', 'core/group', 'core/columns', 'core/column', 'core/separator', 'core/spacer' ],
			\array_keys( \array_filter( $blocks, static fn ( array $block ): bool => $block['core'] ) )
		);
		$this->assertSame( [ 'acme-desk/tally', 'acme-desk/summary' ], \array_keys( \array_filter( $blocks, static fn ( array $block ): bool => ! $block['core'] ) ) );
		$this->assertSame( 'p', $blocks['core/paragraph']['text'] );
		$this->assertSame( 'h2', $blocks['core/heading']['text'] );
		$this->assertSame( 'li', $blocks['core/list-item']['text'] );
		$this->assertNull( $blocks['core/column']['text'] );
		$this->assertArrayNotHasKey( 'wrap', $blocks['core/paragraph'] );
		$this->assertSame( [ 'strong', 'em', 'b', 'i', 'code', 'a', 'br' ], Composition::schemas( self::DIGEST )['inline'] );
	}

	/**
	 * The core case of `tests/fixtures/composition-markup.json`, which
	 * `CompositionEditor.test.js` holds `serializeLayout()` to, stands and
	 * is stored as the editor wrote it, less the newlines framing each block.
	 */
	public function test_the_editors_core_markup_is_stored_as_written(): void {
		$cases  = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/composition-markup.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$markup = \array_column( $cases, 'markup', 'name' )['core text blocks in core columns'];

		$this->assertSame(
			\str_replace( "\n", '', $markup ),
			Composition::serialize( self::BOARD, Composition::validate( self::BOARD, $markup ) )
		);
	}

	/**
	 * Hostile text in a paragraph, and what may not survive it.
	 *
	 * @return array<string,array{string,string}>
	 */
	public static function hostile_text(): array {
		return [
			'a script'          => [ 'Moor 7904<script>alert(7904)</script>', '<script' ],
			'an on* attribute'  => [ '<em onclick="sink(7905)">Moor</em>', 'onclick' ],
			'a javascript: url' => [ '<a href="javascript:sink(7906)">Moor</a>', 'javascript:' ],
			'a style attribute' => [ '<b style="color:#7907">Moor</b>', 'style' ],
			'a heading inside'  => [ '<h2>Moor 7908</h2>', '<h2' ],
			'list markup'       => [ '<ul><li>Moor 7909</li></ul>', '<li' ],
			'a link handler'    => [ '<a href="https://example.com/7923" onmouseover="sink(7923)" target="_blank">Moor</a>', 'onmouseover' ],
		];
	}

	#[DataProvider( 'hostile_text' )]
	public function test_a_text_block_keeps_no_markup_past_the_inline_allowlist( string $text, string $stripped ): void {
		$tree = Composition::validate( self::BOARD, "<!-- wp:paragraph --><p>{$text}</p><!-- /wp:paragraph -->" );

		$this->assertStringNotContainsString( $stripped, $tree[0]['attributes']['content'] );
		$this->assertStringContainsString( 'Moor', $tree[0]['attributes']['content'] );
	}

	public function test_a_text_block_keeps_its_inline_formatting_and_a_safe_link(): void {
		$tree = Composition::validate(
			self::BOARD,
			'<!-- wp:paragraph --><p><strong>Bold</strong> <em>lean</em> <code>7910</code><br><a href="https://example.com/7910">link</a></p><!-- /wp:paragraph -->'
		);

		$this->assertSame(
			'<strong>Bold</strong> <em>lean</em> <code>7910</code><br><a href="https://example.com/7910">link</a>',
			$tree[0]['attributes']['content']
		);
	}

	public function test_a_link_opening_in_a_new_tab_survives_a_save(): void {
		$link   = '<a href="https://example.com/7924" target="_blank" rel="noreferrer noopener">Tab 7924</a>';
		$tree   = Composition::validate( self::BOARD, "<!-- wp:paragraph --><p>{$link}</p><!-- /wp:paragraph -->" );
		$stored = Composition::serialize( self::BOARD, $tree );

		$this->assertSame( $link, $tree[0]['attributes']['content'] );
		$this->assertSame( $tree, Composition::validate( self::BOARD, $stored ) );
	}

	/** Text the filter would turn into a block delimiter is refused before it is filtered. */
	public function test_text_holding_a_comment_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'core/paragraph holds a comment; its text holds inline formatting only' );
		Composition::validate( self::BOARD, '<!-- wp:paragraph --><p>Moor <!-- wp:acme-desk/tally ----> 7925</p><!-- /wp:paragraph -->' );
	}

	/** A tree that does not read back as it was handed is refused before it is stored. */
	public function test_a_tree_that_does_not_read_back_is_refused_on_write(): void {
		$node = [
			'name'       => 'core/paragraph',
			'attributes' => [ 'content' => 'Moor 7911<script>alert(7911)</script>' ],
			'inner'      => [],
		];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'composition acme-desk/board: the layout does not read back as it was written' );
		Composition::serialize( self::BOARD, [ $node ] );
	}

	/**
	 * A layout breaking a nesting rule, and the words refusing it.
	 *
	 * @return array<string,array{string,string}>
	 */
	public static function misplaced(): array {
		$para = '<!-- wp:paragraph --><p>Gull 7912</p><!-- /wp:paragraph -->';
		$nest = static fn ( string $inner ): string => "<!-- wp:group --><div class=\"wp-block-group\">{$inner}</div><!-- /wp:group -->";
		return [
			'a column at the top'             => [ '<!-- wp:column --><div class="wp-block-column"></div><!-- /wp:column -->', 'core/column stands only in core/columns' ],
			'a column in a group'             => [ $nest( '<!-- wp:column --><div class="wp-block-column"></div><!-- /wp:column -->' ), 'core/column stands only in core/columns' ],
			'a list item at the top'          => [ '<!-- wp:list-item --><li>Gull</li><!-- /wp:list-item -->', 'core/list-item stands only in core/list' ],
			'a paragraph in columns'          => [ "<!-- wp:columns --><div class=\"wp-block-columns\">{$para}</div><!-- /wp:columns -->", 'core/columns holds only core/column' ],
			'a paragraph in a list'           => [ "<!-- wp:list --><ul class=\"wp-block-list\">{$para}</ul><!-- /wp:list -->", 'core/list holds only core/list-item' ],
			'a block four deep'               => [ $nest( $nest( $nest( $nest( $para ) ) ) ), 'core/paragraph stands deeper than 3 blocks' ],
			'a container in a container'      => [ '<!-- wp:acme-desk/rail --><!-- wp:acme-desk/rail /--><!-- /wp:acme-desk/rail -->', 'acme-desk/rail stands only at the top, in a column or in a group' ],
			'a group in a declared container' => [ '<!-- wp:acme-desk/rail -->' . $nest( '' ) . '<!-- /wp:acme-desk/rail -->', 'core/group stands only at the top, in a column or in a group' ],
			'a separator holding blocks'      => [ "<!-- wp:separator -->{$para}<!-- /wp:separator -->", 'core/separator holds no blocks' ],
			'html outside a wrapper'          => [ '<!-- wp:group --><div class="wp-block-group"><p>stray 7913</p></div><!-- /wp:group -->', 'core/group holds HTML outside its own element' ],
			'text outside the paragraph'      => [ '<!-- wp:paragraph --><p>Gull</p>stray 7914<!-- /wp:paragraph -->', 'core/paragraph holds HTML outside its own element' ],
			'the frame column, gone'          => [ '<!-- wp:newspack-nodes/aside /-->', 'newspack-nodes/aside is not a declared block' ],
		];
	}

	#[DataProvider( 'misplaced' )]
	public function test_a_block_standing_where_it_may_not_is_refused( string $markup, string $why ): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( $why );
		Composition::validate( self::BOARD, $markup );
	}

	/** A list item is part of its list, so a list three deep holds its items. */
	public function test_a_list_three_deep_holds_its_items(): void {
		$tree = Composition::validate(
			self::BOARD,
			'<!-- wp:columns --><!-- wp:column --><!-- wp:group --><!-- wp:list --><!-- wp:list-item --><li>Skiff 7926</li><!-- /wp:list-item --><!-- /wp:list --><!-- /wp:group --><!-- /wp:column --><!-- /wp:columns -->'
		);

		$this->assertSame( 'Skiff 7926', $tree[0]['inner'][0]['inner'][0]['inner'][0]['inner'][0]['attributes']['content'] );
	}

	public function test_a_block_three_deep_and_a_container_in_a_column_stand(): void {
		$tree = Composition::validate(
			self::BOARD,
			'<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:group --><div class="wp-block-group"><!-- wp:acme-desk/tally /--></div><!-- /wp:group --><!-- wp:acme-desk/rail --><!-- wp:acme-desk/tally {"limit":37} /--><!-- /wp:acme-desk/rail --></div><!-- /wp:column --></div><!-- /wp:columns -->'
		);

		$column = $tree[0]['inner'][0];
		$this->assertSame( [ 'core/group', 'acme-desk/rail' ], \array_column( $column['inner'], 'name' ) );
		$this->assertSame( 'acme-desk/tally', $column['inner'][0]['inner'][0]['name'] );
		$this->assertSame( 37, $column['inner'][1]['inner'][0]['attributes']['limit'] );
	}

	/**
	 * A core block's attribute its schema refuses, and the words refusing it.
	 *
	 * @return array<string,array{string,string}>
	 */
	public static function refused_attributes(): array {
		return [
			'a seventh heading level'    => [ '<!-- wp:heading {"level":7} --><h2 class="wp-block-heading">Kelp</h2><!-- /wp:heading -->', 'core/heading attribute level' ],
			'a class name'               => [ '<!-- wp:paragraph {"className":"kelp-7916"} --><p>Kelp</p><!-- /wp:paragraph -->', 'core/paragraph declares no attribute className' ],
			'text in the delimiter'      => [ '<!-- wp:paragraph {"content":"Kelp 7917"} --><p>Kelp</p><!-- /wp:paragraph -->', 'core/paragraph declares no attribute content' ],
			'a computed column width'    => [ '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column {"width":"calc(10% + 7918px)"} --><div class="wp-block-column"></div><!-- /wp:column --></div><!-- /wp:columns -->', 'core/column attribute width' ],
			'a percentage spacer height' => [ '<!-- wp:spacer {"height":"79%"} --><div class="wp-block-spacer"></div><!-- /wp:spacer -->', 'core/spacer attribute height' ],
			'a layout key core never'    => [ '<!-- wp:group {"layout":{"type":"flex","kelp":7919}} --><div class="wp-block-group"></div><!-- /wp:group -->', 'core/group attribute layout' ],
			'a layout type core never'   => [ '<!-- wp:group {"layout":{"type":"kelp-7920"}} --><div class="wp-block-group"></div><!-- /wp:group -->', 'core/group attribute layout' ],
			'a list style core never'    => [ '<!-- wp:list {"ordered":true,"type":"kelp-7927"} --><!-- /wp:list -->', 'core/list attribute type' ],
			'a group as a span'          => [ '<!-- wp:group {"tagName":"span"} --><!-- /wp:group -->', 'core/group attribute tagName' ],
			'a spacer stretched oddly'   => [ '<!-- wp:spacer {"style":{"layout":{"selfStretch":"wide-7951"}}} /-->', 'core/spacer attribute style' ],
			'a spacer styled otherwise'  => [ '<!-- wp:spacer {"style":{"color":{"text":"#7952"}}} /-->', 'core/spacer attribute style' ],
			'columns stretched'          => [ '<!-- wp:columns {"verticalAlignment":"stretch"} --><!-- /wp:columns -->', 'core/columns attribute verticalAlignment' ],
		];
	}

	#[DataProvider( 'refused_attributes' )]
	public function test_a_core_block_refuses_an_attribute_its_schema_does_not_declare( string $markup, string $why ): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( $why );
		Composition::validate( self::BOARD, $markup );
	}

	/**
	 * A paragraph layout `$bytes` long.
	 *
	 * @param int $bytes The markup's length.
	 */
	private static function paragraph_of( int $bytes ): string {
		$open  = '<!-- wp:paragraph --><p>';
		$close = '</p><!-- /wp:paragraph -->';
		return $open . \str_repeat( 'g', $bytes - \strlen( $open . $close ) ) . $close;
	}

	public function test_a_layout_of_the_cap_stands_and_one_byte_more_is_refused(): void {
		$this->assertSame( 65536, Composition::MAX_MARKUP_BYTES );
		$this->assertCount( 1, Composition::validate( self::BOARD, self::paragraph_of( 65536 ) ) );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'the layout is 65537 bytes, more than 65536' );
		Composition::validate( self::BOARD, self::paragraph_of( 65537 ) );
	}
}
