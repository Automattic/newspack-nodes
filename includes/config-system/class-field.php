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
	/**
	 * Display label, stored unresolved. A plugin passes either a plain string OR
	 * a `fn(): string` thunk — the thunk defers `__()` to render time so building
	 * the schema for overlay_keys() (which a worker/CLI does via Config) never
	 * calls a translation function at load. Resolve via label().
	 *
	 * @var string|callable
	 */
	private readonly mixed $label_source;

	/** @var callable|null register_setting sanitize_callback (required for option fields). */
	public readonly mixed $sanitize;

	/** @var callable|null add_settings_field render callback (required for rendered fields). */
	public readonly mixed $render;

	/**
	 * @param string                   $key            Unprefixed option key; '' for a display-only field.
	 * @param string                   $type           Value-type tag (int/path/memcache_servers/array_strings/bool/text/float) — the sanitize-derivation hook.
	 * @param string|callable          $label          Settings-field label, or a `fn(): string` thunk (deferred `__()`).
	 * @param string                   $section        Section id this field renders under.
	 * @param string                   $id             add_settings_field id; defaults to $key when empty.
	 * @param bool                     $delete_on_blank Whether a blank save deletes the row (file default resurfaces).
	 * @param array<int,string>|string $restart        Worker groups to restart on save, or 'supervisor_only' (no restart), or [].
	 * @param callable|null            $sanitize       register_setting sanitize_callback; required for option fields.
	 * @param callable|null            $render         add_settings_field render callback; required for rendered fields.
	 * @param bool                     $ui             Whether the field appears in the settings page (false = overlay-only key).
	 * @param array<string,mixed>      $register_args  Extra register_setting args merged in (e.g. autoload, type, default).
	 * @param bool                     $overlay        Whether load_config() overlays this option (false = registered + resettable, but read directly via get_option, never through the per-request overlay).
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
		public readonly bool $overlay = true,
	) {
		$this->label_source = $label;
		$this->sanitize     = \is_callable( $sanitize ) ? $sanitize : null;
		$this->render       = \is_callable( $render ) ? $render : null;
	}

	/** The resolved label: a thunk is invoked here (render time), a plain string passes through. */
	public function label(): string {
		$label = $this->label_source;
		if ( \is_callable( $label ) ) {
			$label = $label();
		}
		return \is_string( $label ) ? $label : '';
	}

	/** A config option the per-request load_config() overlay reflects (excludes direct-read options). */
	public function is_overlaid(): bool {
		return $this->overlay && '' !== $this->key;
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
