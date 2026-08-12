<?php
/**
 * BoundedIntBlankSaveTest: what a CLEARED bounded-int settings field ends up as.
 *
 * The derived clamp in Field::sanitize_callback() answers '' for a blank, and ''
 * read back as a segment size is a 1-BYTE segment (Partition_Node::arguments()
 * does `max( 1, (int) $segment_size )`). Nothing proved the composed end state,
 * so the two halves that make it safe could drift apart unnoticed. This walks
 * WordPress's documented update_option() order — sanitize_option_{$option}
 * (the Field's sanitizer) THEN pre_update_option_{$option} (Reset_Gate) — and
 * asserts the row ends ABSENT, so the config-file default resurfaces.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use Newspack_Nodes\Config_System\Field;
use Newspack_Nodes\Config_System\Options_Overlay;
use Newspack_Nodes\Config_System\Reset_Gate;
use Newspack_Nodes\Config_System\Schema;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Field::class )]
#[CoversClass( Schema::class )]
class BoundedIntBlankSaveTest extends TestCase {

	private const PREFIX = 'pfx_';
	private const OPTION = 'pfx_segment_size';
	private const MARK   = 'pfx_reset';

	/** The config FILE default — distinct from the Field default and from every bound. */
	private const FILE_DEFAULT = 12582912;

	/** The stored override the operator is clearing — distinct from everything else. */
	private const STORED = 4194304;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options'] = [];
		unset( $_POST[ self::MARK ] );
	}

	protected function tearDown(): void {
		unset( $_POST[ self::MARK ] );
		parent::tearDown();
	}

	/** One bounded int, declared as the substrate declares segment_size. */
	private function schema(): Schema {
		return new Schema(
			self::PREFIX,
			[
				new Field(
					key: 'segment_size',
					type: 'int',
					min: 1048576,
					max: 536870912,
					default: 67108864,
					label: 'Segment Size',
					section: 'storage',
					render: static function (): void {},
				),
			]
		);
	}

	/**
	 * Run one settings save through WordPress's order: the Field's sanitizer,
	 * then the Reset_Gate the same Schema declaration wires beside it.
	 */
	private function save( mixed $submitted ): void {
		$schema    = $this->schema();
		$sanitize  = $schema->fields()[0]->sanitize_callback();
		$sanitized = \call_user_func( $sanitize, $submitted );
		$old       = $GLOBALS['_wp_options'][ self::OPTION ] ?? false;
		$resolved  = Reset_Gate::resolve(
			$sanitized,
			$old,
			self::OPTION,
			self::MARK,
			$schema->delete_on_blank_options()
		);
		if ( $resolved !== $old ) {
			$GLOBALS['_wp_options'][ self::OPTION ] = $resolved;
		}
	}

	/** The effective config after the save: file defaults with the stored row overlaid. */
	private function effective(): mixed {
		$config = Options_Overlay::apply(
			[ 'segment_size' => self::FILE_DEFAULT ],
			$this->schema()->overlay_keys(),
			self::PREFIX
		);
		return $config['segment_size'];
	}

	public function test_clearing_a_bounded_int_restores_the_config_file_default(): void {
		$this->save( (string) self::STORED );
		$this->assertSame( self::STORED, $this->effective(), 'an in-range save must override the file default' );

		$this->save( '' );

		$this->assertArrayNotHasKey( self::OPTION, $GLOBALS['_wp_options'], 'a cleared field must leave NO row' );
		$this->assertSame( self::FILE_DEFAULT, $this->effective() );
	}

	/** Read the cleared setting the way Partition_Node::arguments() reads it. */
	public function test_a_cleared_bounded_int_never_becomes_a_one_byte_segment(): void {
		$this->save( (string) self::STORED );
		$this->save( '' );

		$this->assertNotSame( '', $this->effective(), "a stored '' is a 1-byte segment downstream" );
		$this->assertSame( self::FILE_DEFAULT, \max( 1, (int) $this->effective() ) );
	}

	public function test_junk_input_restores_the_config_file_default_rather_than_storing_zero(): void {
		$this->save( (string) self::STORED );
		$this->save( 'not-a-number' );

		$this->assertArrayNotHasKey( self::OPTION, $GLOBALS['_wp_options'] );
		$this->assertSame( self::FILE_DEFAULT, $this->effective() );
	}

	/**
	 * The invariant the derived `''` rests on: every field whose sanitizer can
	 * answer blank is in the set Reset_Gate deletes on blank.
	 */
	public function test_every_bounded_int_field_is_blank_deletable(): void {
		$schema = \Newspack_Nodes\Settings_Schema::get();
		foreach ( $schema->fields() as $field ) {
			if ( 'int' !== $field->type || null === $field->min || ! $field->is_setting() ) {
				continue;
			}
			$this->assertContains(
				$schema->prefix() . $field->key,
				$schema->delete_on_blank_options(),
				"bounded int {$field->key} sanitizes to '' but is not blank-deletable"
			);
		}
	}
}
