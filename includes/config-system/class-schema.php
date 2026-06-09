<?php
/**
 * Schema: the declarative config registry — a list of Fields plus the section
 * metadata they render under, and the single place every consumer derives from.
 *
 * One Schema per plugin replaces the 4-6 parallel arrays (option_schema keys,
 * $option_names, $delete_on_blank_options, the register_setting loop, the
 * add_settings_field loop, the reset list, the restart classification) that
 * used to be hand-maintained in lockstep in Config + Admin. Add a setting once
 * as a Field; every view of it follows.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

class Schema {
	/**
	 * @param string                                                   $prefix   WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param array<int,Field>                                         $fields   The settings, in render order.
	 * @param array<string,array{title:string,callback:callable}>      $sections Section id => section title + intro callback.
	 */
	public function __construct(
		private readonly string $prefix,
		private readonly array $fields,
		private readonly array $sections = [],
	) {}

	public function prefix(): string {
		return $this->prefix;
	}

	/** @return array<int,Field> */
	public function fields(): array {
		return $this->fields;
	}

	/**
	 * Unprefixed keys of every real option — the Options_Overlay key-list and the
	 * autoload sweep set. Includes overlay-only (ui=false) keys; excludes
	 * display-only fields.
	 *
	 * @return array<int,string>
	 */
	public function overlay_keys(): array {
		return $this->collect_keys( static fn ( Field $f ): bool => $f->is_option() );
	}

	/**
	 * Prefixed option names of every rendered setting — the reset set and the
	 * register_setting targets. Excludes overlay-only + display fields.
	 *
	 * @return array<int,string>
	 */
	public function setting_option_names(): array {
		return $this->prefixed( static fn ( Field $f ): bool => $f->is_setting() );
	}

	/**
	 * Prefixed names of the blank-deletable subset (a blank save deletes the row
	 * so the file default resurfaces).
	 *
	 * @return array<int,string>
	 */
	public function delete_on_blank_options(): array {
		return $this->prefixed(
			static fn ( Field $f ): bool => $f->is_setting() && $f->delete_on_blank
		);
	}

	/** @return array<int,Field> Fields in the settings-page render loop, in order. */
	public function rendered_fields(): array {
		return \array_values( \array_filter( $this->fields, static fn ( Field $f ): bool => $f->is_rendered() ) );
	}

	/** The Field for an unprefixed option key, or null. */
	public function field_for_short( string $short ): ?Field {
		foreach ( $this->fields as $field ) {
			if ( $field->key === $short ) {
				return $field;
			}
		}
		return null;
	}

	/**
	 * Worker-restart classification for a short option key: the field's restart
	 * groups, 'supervisor_only', or [] (unknown key or no-restart field).
	 *
	 * @return array<int,string>|string
	 */
	public function restart_for( string $short ): array|string {
		$field = $this->field_for_short( $short );
		return null === $field ? [] : $field->restart;
	}

	/** Register every rendered setting via the WP Settings API. */
	public function register_options( string $group ): void {
		foreach ( $this->fields as $field ) {
			if ( ! $field->is_setting() || ! \is_callable( $field->sanitize ) ) {
				continue;
			}
			/** @var array{type?:string,default?:mixed,autoload?:bool,show_in_rest?:bool|array<mixed>} $extra */
			$extra = $field->register_args;
			\register_setting(
				$group,
				$this->prefix . $field->key,
				[ 'sanitize_callback' => $field->sanitize ] + $extra
			);
		}
	}

	/** Add each section then its fields to a settings page (in declaration order). */
	public function register_sections_and_fields( string $page ): void {
		$seen = [];
		foreach ( $this->rendered_fields() as $field ) {
			if ( ! \is_callable( $field->render ) ) {
				continue;
			}
			$section_id = $field->section;
			if ( ! isset( $seen[ $section_id ] ) ) {
				$section  = $this->sections[ $section_id ] ?? [];
				$title    = \is_string( $section['title'] ?? null ) ? $section['title'] : '';
				$callback = \is_callable( $section['callback'] ?? null ) ? $section['callback'] : static function (): void {};
				\add_settings_section( $section_id, $title, $callback, $page );
				$seen[ $section_id ] = true;
			}
			\add_settings_field( $field->render_id(), $field->label, $field->render, $page, $section_id );
		}
	}

	/**
	 * @param callable(Field):bool $predicate
	 * @return array<int,string>
	 */
	private function collect_keys( callable $predicate ): array {
		$out = [];
		foreach ( $this->fields as $field ) {
			if ( $predicate( $field ) ) {
				$out[] = $field->key;
			}
		}
		return $out;
	}

	/**
	 * @param callable(Field):bool $predicate
	 * @return array<int,string>
	 */
	private function prefixed( callable $predicate ): array {
		$out = [];
		foreach ( $this->fields as $field ) {
			if ( $predicate( $field ) ) {
				$out[] = $this->prefix . $field->key;
			}
		}
		return $out;
	}
}
