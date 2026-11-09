<?php
/**
 * Composes_Acme_Desk: a fictional consumer's composition declaration, the
 * WordPress block and schema functions `Composition` calls, and a fresh
 * declarations memo for every test.
 *
 * `acme-desk` declares two contexts, `acme-desk/board` (seven blocks at
 * most, with a `check` refusing the lens `desk-q3`) and `acme-desk/digest`,
 * and five blocks: `tally` on both, the single `queue`, the container
 * `rail`, the `lens` the check reads, and the digest-only `summary`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Helpers;

use Newspack_Nodes\Composition;

trait Composes_Acme_Desk {

	/** Blocks the board's `check` was handed, in call order. */
	private array $checked = [];

	/** The filter `declare_acme_desk()` installed last, which the next replaces. */
	private ?\Closure $acme_desk = null;

	public static function setUpBeforeClass(): void {
		parent::setUpBeforeClass();
		Wp_Includes::load( [ 'parse_blocks', 'serialize_blocks', 'rest_validate_value_from_schema', 'rest_sanitize_value_from_schema' ] );
	}

	/** Forget the memo, so the next `declarations()` applies the filter. */
	private function forget_declarations(): void {
		( new \ReflectionProperty( Composition::class, 'declarations' ) )->setValue( null, null );
	}

	/** The absolute path of a default-markup fixture. */
	private static function fixture( string $name ): string {
		return \dirname( __DIR__ ) . "/fixtures/compositions/{$name}.html";
	}

	/**
	 * Declare `acme-desk`. `$change`, when given, takes the whole filter map,
	 * `acme-desk` included, and answers what the filter answers instead.
	 *
	 * @param (\Closure(array): mixed)|null $change Edits the filter's answer.
	 */
	private function declare_acme_desk( ?\Closure $change = null ): void {
		$this->forget_declarations();
		$declaration = [
			'blocks'   => [
				'acme-desk/tally'   => [
					'title'      => 'Tally',
					'contexts'   => [ 'acme-desk/board', 'acme-desk/digest' ],
					'attributes' => [
						'heading' => [ 'type' => 'string', 'default' => 'Open tickets', 'maxLength' => 80 ],
						'limit'   => [ 'type' => 'integer', 'default' => 10, 'minimum' => 1, 'maximum' => 50 ],
						'open'    => [ 'type' => 'boolean', 'default' => true ],
					],
				],
				'acme-desk/queue'   => [
					'title'      => 'Queue',
					'contexts'   => [ 'acme-desk/board' ],
					'attributes' => [ 'lane' => [ 'type' => 'string', 'default' => 'triage', 'enum' => [ 'triage', 'escalated' ] ] ],
					'multiple'   => false,
				],
				'acme-desk/rail'    => [
					'title'      => 'Rail',
					'contexts'   => [ 'acme-desk/board' ],
					'attributes' => [],
					'container'  => true,
				],
				'acme-desk/lens'    => [
					'title'      => 'Lens',
					'contexts'   => [ 'acme-desk/board' ],
					'attributes' => [ 'lens' => [ 'type' => 'string', 'default' => 'desk-all' ] ],
				],
				'acme-desk/summary' => [
					'title'      => 'Summary',
					'contexts'   => [ 'acme-desk/digest' ],
					'attributes' => [ 'tone' => [ 'type' => 'string', 'default' => 'plain' ] ],
				],
			],
			'contexts' => [
				'acme-desk/board'  => [
					'default'    => self::fixture( 'board' ),
					'max_blocks' => 7,
					'check'      => function ( string $block, array $attributes, string $context ): void {
						$this->checked[] = $block;
						if ( 'acme-desk/lens' === $block && 'desk-q3' === $attributes['lens'] ) {
							throw new \RuntimeException( 'no lens: desk-q3' );
						}
					},
				],
				'acme-desk/digest' => [
					'default'    => self::fixture( 'digest' ),
					'max_blocks' => 3,
				],
			],
		];
		$change ??= static fn ( array $declared ): array => $declared;
		if ( null !== $this->acme_desk ) {
			\remove_action( Composition::FILTER, $this->acme_desk );
		}
		$this->acme_desk = static fn ( array $declared ): mixed => $change( $declared + [ 'acme-desk' => $declaration ] );
		\add_filter( Composition::FILTER, $this->acme_desk );
	}
}
