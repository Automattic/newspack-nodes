<?php
/**
 * Field: one declarative setting in a Config_System\Schema.
 *
 * The SINGLE description of a config key — its type, label, section, sanitizer,
 * renderer, blank-delete policy, and worker-restart class — from which the
 * Schema derives every consumer (overlay key-list, option_names, reset list,
 * register/render loops). Replaces the parallel hand-listed arrays that each
 * plugin's Config + Admin used to keep in lockstep.
 *
 * A Field is one of three shapes, distinguished by the predicates below:
 *   - a rendered option   (key set, ui true)  — the common case;
 *   - an overlay-only key  (key set, ui false) — loaded + autoloaded but not in
 *                                                the settings page (e.g. allowed_users);
 *   - a display-only field (no key, ui true)   — rendered but not an option
 *                                                (e.g. a computed total-storage readout).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

class Field {
	/** Display label — coerced so a degenerate `__()` stub returning null can't TypeError at build. */
	public readonly string $label;

	/** @var callable|null register_setting sanitize_callback (required for option fields). */
	public readonly mixed $sanitize;

	/** @var callable|null add_settings_field render callback (required for rendered fields). */
	public readonly mixed $render;

	/**
	 * @param string                   $key            Unprefixed option key; '' for a display-only field.
	 * @param string                   $type           Value-type tag (int/path/memcache_servers/array_strings/bool/text/float) — the sanitize-derivation hook.
	 * @param mixed                    $label          Settings-field label (coerced to string).
	 * @param string                   $section        Section id this field renders under.
	 * @param string                   $id             add_settings_field id; defaults to $key when empty.
	 * @param bool                     $delete_on_blank Whether a blank save deletes the row (file default resurfaces).
	 * @param array<int,string>|string $restart        Worker groups to restart on save, or 'supervisor_only' (no restart), or [].
	 * @param callable|null            $sanitize       register_setting sanitize_callback; required for option fields.
	 * @param callable|null            $render         add_settings_field render callback; required for rendered fields.
	 * @param bool                     $ui             Whether the field appears in the settings page (false = overlay-only key).
	 * @param array<string,mixed>      $register_args  Extra register_setting args merged in (e.g. autoload, type, default).
	 */
	public function __construct(
		public readonly string $key = '',
		public readonly string $type = '',
		mixed $label = '',
		public readonly string $section = '',
		public readonly string $id = '',
		public readonly bool $delete_on_blank = true,
		public readonly array|string $restart = [],
		mixed $sanitize = null,
		mixed $render = null,
		public readonly bool $ui = true,
		public readonly array $register_args = [],
	) {
		$this->label    = \is_string( $label ) ? $label : '';
		$this->sanitize = \is_callable( $sanitize ) ? $sanitize : null;
		$this->render   = \is_callable( $render ) ? $render : null;
	}

	/** A real config option (participates in the overlay + autoload sweep). */
	public function is_option(): bool {
		return '' !== $this->key;
	}

	/** A rendered option (register_setting, option_names, reset set, restart class). */
	public function is_setting(): bool {
		return $this->ui && '' !== $this->key;
	}

	/** Appears in the settings page render loop (incl. display-only fields). */
	public function is_rendered(): bool {
		return $this->ui;
	}

	/** add_settings_field id — the explicit $id, else the option key. */
	public function render_id(): string {
		return '' !== $this->id ? $this->id : $this->key;
	}
}
