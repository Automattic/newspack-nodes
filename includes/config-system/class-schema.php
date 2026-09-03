<?php
/**
 * The one declaration every view of a plugin's settings derives from.
 *
 * A setting is added once, as a `Field`. The per-request overlay key-list, the
 * code defaults, the `register_setting()` and `add_settings_field()` loops, the
 * reset set and the worker-restart classification are all read back off that
 * declaration. Keeping any of them as a list of its own is what lets two views
 * of one setting disagree — the settings page and the `settings` verb enforcing
 * different bounds, or a key the overlay loads that the reset control never
 * clears.
 *
 * One of the five `Config_System` files a sibling's hermetic test harness loads
 * without the substrate, so nothing here may name `Core` or any other substrate
 * class.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

/**
 * A plugin's whole settings surface: the WP-option prefix, its Fields in
 * declaration order, and the sections those Fields group under.
 *
 * Every method is one VIEW of that Field list, and each filters differently:
 * `overlay_keys()` takes any keyed Field, `setting_option_names()` only the
 * keyed Fields the page renders, and `rendered_fields()` every rendered Field
 * including the keyless display-only readouts. Declaration order is render
 * order, so a Field's position decides where it appears and which section
 * opens first.
 *
 * A Schema resolves nothing when it is built: no option read, no label
 * translated, no render callback invoked. That is what lets a worker or a CLI
 * process build one for its key-list without loading the admin surface.
 */
class Schema {

	/**
	 * Hold a plugin's declaration.
	 *
	 * @param string                                                       $prefix   WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param array<int,Field>                                             $fields   The settings, in render order.
	 * @param array<string,array{title:string|callable,callback:callable}> $sections Section id => title (a string or a `fn(): string` thunk) plus the callback printing that section's intro.
	 */
	public function __construct(
		private readonly string $prefix,
		private readonly array $fields,
		private readonly array $sections = [],
	) {}

	/**
	 * The unprefixed key of every Field that names one — what `Options_Overlay`
	 * overlays onto the defaults, and the set `Config` declares as readable.
	 *
	 * Whether the page renders a key is irrelevant here. A `ui: false` Field is
	 * an overlay-only key an operator sets in the config file, and it has to
	 * resolve through `Config::value()` like any other or the read is refused.
	 * Only the keyless display-only Fields drop out.
	 *
	 * @return array<int,string>
	 */
	public function overlay_keys(): array {
		return $this->collect_keys( static fn ( Field $f ): bool => '' !== $f->key );
	}

	/**
	 * The unprefixed keys of the Fields the predicate accepts, in declaration
	 * order.
	 *
	 * @param callable(Field):bool $predicate Field filter.
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
	 * The prefixed option name of every rendered setting — what
	 * `register_setting()` registers, what `Reset_Gate` guards, and what the
	 * Config Audit values allowlist starts from.
	 *
	 * Overlay-only and display-only Fields are excluded: neither has a widget
	 * the page saves, so registering them would expose options nothing writes.
	 *
	 * @return array<int,string>
	 */
	public function setting_option_names(): array {
		return $this->prefixed( static fn ( Field $f ): bool => $f->is_setting() );
	}

	/**
	 * The prefixed names of the settings a blank save DELETES rather than
	 * stores.
	 *
	 * Presence is override (see `Options_Overlay`), so a stored `''` is a real
	 * configuration — a one-byte segment size, not the declared default.
	 * Clearing a box therefore has to remove the row, which is the delete
	 * `Reset_Gate` performs off this list. Every type but `bool` qualifies,
	 * because an unchecked box is a genuine value.
	 *
	 * @return array<int,string>
	 */
	public function delete_on_blank_options(): array {
		return $this->prefixed(
			static fn ( Field $f ): bool => $f->is_setting() && $f->delete_on_blank
		);
	}

	/**
	 * The prefixed option names of the Fields the predicate accepts, in
	 * declaration order.
	 *
	 * @param callable(Field):bool $predicate Field filter.
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

	/**
	 * The raw worker-restart classification declared for an unprefixed option
	 * key, handed to `Restart_Planner` verbatim: the Field's consumer node-type
	 * list, 'all', or [] for a no-restart Field or an unknown key.
	 *
	 * Never a topology name. Topology names are deployment config an operator
	 * renames or shadows, so a name-keyed classification touches a lock dir
	 * that no longer exists and silently restarts nothing; a node class is a
	 * stable code-level identifier.
	 *
	 * @param string $short Unprefixed option key.
	 * @return array<int,string>|string
	 */
	public function restart_for( string $short ): array|string {
		$field = $this->field_for_short( $short );
		return null === $field ? [] : $field->restart;
	}

	/**
	 * The Field declaring an unprefixed option key, or null when none does.
	 *
	 * @param string $short Unprefixed option key.
	 */
	public function field_for_short( string $short ): ?Field {
		foreach ( $this->fields as $field ) {
			if ( $field->key === $short ) {
				return $field;
			}
		}
		return null;
	}

	/**
	 * Add every rendered Field to a settings page, opening each section the
	 * first time a Field names it.
	 *
	 * Sections open lazily and in Field order, so one whose Fields are all
	 * hidden never appears, and the page's section order follows the Field
	 * declaration rather than the `$sections` map. A section id the map does
	 * not describe still opens, with an empty title and a no-op intro: a typo
	 * there costs a heading, not the fields under it. A Field with no callable
	 * renderer is skipped whole — it can neither draw itself nor justify
	 * opening its section.
	 *
	 * @param string $page Settings-page slug the section and fields attach to.
	 */
	public function register_sections_and_fields( string $page ): void {
		$seen = [];
		foreach ( $this->rendered_fields() as $field ) {
			if ( ! \is_callable( $field->render ) ) {
				continue;
			}
			$section_id = $field->section;
			if ( ! isset( $seen[ $section_id ] ) ) {
				$section   = $this->sections[ $section_id ] ?? [];
				$raw_title = $section['title'] ?? '';
				if ( \is_callable( $raw_title ) ) {
					$raw_title = $raw_title();
				}
				// Inline, not Core::str: Config_System stays Core-free.
				$title    = \is_string( $raw_title ) ? $raw_title : '';
				$callback = \is_callable( $section['callback'] ?? null ) ? $section['callback'] : static function (): void {};
				\add_settings_section( $section_id, $title, $callback, $page );
				$seen[ $section_id ] = true;
			}
			\add_settings_field( $field->render_id(), $field->label(), $field->render, $page, $section_id );
		}
	}

	/**
	 * Every Field the settings page renders, in declaration order — the keyed
	 * settings and the keyless display-only readouts alike.
	 *
	 * @return array<int,Field>
	 */
	public function rendered_fields(): array {
		return \array_values( \array_filter( $this->fields, static fn ( Field $f ): bool => $f->is_rendered() ) );
	}

	/**
	 * Every declared key's built-in default — the base `Config` layers the
	 * config files and then the WP-option overlay onto (ADR-20).
	 *
	 * The schema is the definition and every config file is an override
	 * surface. A deploy preserves the operator's file, so a key added after
	 * that file was written never appears in it; a default living only there
	 * reads null forever, and the feature it gates ships inert.
	 *
	 * Only Fields that DECLARE a default appear: a keyed Field written without
	 * `default:` is omitted, and `Config::value()` then returns null for a key
	 * that is nonetheless declared — the inert-feature bug this exists to
	 * close. A plugin using this as its config base asserts completeness itself
	 * (`ConfigSchemaTest::test_the_schema_supplies_a_default_for_every_declared_key`).
	 * Plugins whose defaults live in a `Config::config_defaults()` array
	 * instead — pyrobase, nuclear — declare no Field defaults.
	 *
	 * @return array<string,mixed>
	 */
	public function defaults(): array {
		$out = [];
		foreach ( $this->fields as $field ) {
			if ( '' !== $field->key && null !== $field->default ) {
				$out[ $field->key ] = $field->default;
			}
		}
		return $out;
	}

	/** The WP-option name prefix every key of this schema is stored under. */
	public function prefix(): string {
		return $this->prefix;
	}

	/**
	 * The Fields themselves, in declaration order, for a consumer that needs
	 * more of a setting than a derived list carries — `Settings_Renderer` reads
	 * each one's label, restart class and `register_args` to build the
	 * Effective Configuration panel.
	 *
	 * @api
	 * @return array<int,Field>
	 */
	public function fields(): array {
		return $this->fields;
	}

	/**
	 * Register every rendered setting via the WP Settings API, each with the
	 * sanitizer its Field resolves to — a bounded int derives its clamp from
	 * the same min/max the `settings` verb enforces, so one save path cannot
	 * accept what the other refuses.
	 *
	 * A Field that resolves to no sanitizer is skipped, and an unregistered
	 * option is one `options.php` will not store: a setting the page can save
	 * has to declare how its value is cleaned.
	 *
	 * @param string $group Settings group the options register under.
	 */
	public function register_options( string $group ): void {
		foreach ( $this->fields as $field ) {
			$sanitize = $field->sanitize_callback();
			if ( ! $field->is_setting() || ! \is_callable( $sanitize ) ) {
				continue;
			}
			/** @var array{type?:string,default?:mixed,autoload?:bool,show_in_rest?:bool|array<mixed>} $extra */
			$extra = $field->register_args;
			\register_setting(
				$group,
				$this->prefix . $field->key,
				[ 'sanitize_callback' => $sanitize ] + $extra
			);
		}
	}
}
