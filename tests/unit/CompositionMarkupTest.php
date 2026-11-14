<?php
/**
 * The layout markup the browser's composition editor writes, read back by
 * the server's parser: `tests/fixtures/composition-markup.json` holds editor
 * blocks and the markup `serializeLayout()` sends for them, a core text
 * block's `content` written inside its element, and its jest twin holds the
 * browser to the same file.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\Helpers\Wp_Includes;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Every case's markup parses back to its blocks.
 */
final class CompositionMarkupTest extends TestCase {

	/**
	 * The fixture's cases, by name.
	 *
	 * @return array<string,array{list<array<string,mixed>>, string}>
	 */
	public static function cases(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/composition-markup.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$named = [];
		foreach ( $cases as $case ) {
			$named[ $case['name'] ] = [ $case['blocks'], $case['markup'] ];
		}
		return $named;
	}

	/**
	 * @param list<array<string,mixed>> $blocks The editor blocks.
	 * @param string                    $markup What the editor sends for them.
	 */
	#[DataProvider( 'cases' )]
	public function test_the_markup_parses_back_to_its_blocks( array $blocks, string $markup ): void {
		Wp_Includes::load( [ 'parse_blocks' ] );
		$this->assertSame( $blocks, self::tree( \parse_blocks( $markup ) ) );
	}

	/**
	 * Parsed blocks in the fixture's editor shape, whitespace between them
	 * dropped and a text block's element read back as its `content`.
	 *
	 * @param array<mixed> $parsed What `parse_blocks()` answered.
	 * @return list<array<string,mixed>>
	 */
	private static function tree( array $parsed ): array {
		$tree = [];
		foreach ( $parsed as $block ) {
			if ( null === $block['blockName'] ) {
				continue;
			}
			$attributes = $block['attrs'];
			if ( 1 === \preg_match( '#^<([a-z0-9]+)>(.*)</\\1>$#s', \trim( $block['innerHTML'] ), $text ) ) {
				$attributes['content'] = $text[2];
			}
			$tree[] = [
				'name'        => $block['blockName'],
				'attributes'  => $attributes,
				'innerBlocks' => self::tree( $block['innerBlocks'] ),
			];
		}
		return $tree;
	}
}
