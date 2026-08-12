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

	/** Derived from type: every non-bool field blank-deletes to its file default. */
	public readonly bool $delete_on_blank;

	/** @var callable|null add_settings_field render callback (required for rendered fields). */
	public readonly mixed $render;

	/** @var callable|null Declared sanitizer; a bounded int derives one instead (see sanitize_callback()). */
	public readonly mixed $sanitize;

	/**
	 * Display label, stored unresolved. A plugin passes either a plain string OR
	 * a `fn(): string` thunk — the thunk defers `__()` to render time so building
	 * the schema for overlay_keys() (which a worker/CLI does via Config) never
	 * calls a translation function at load. Resolve via label().
	 *
	 * @var string|callable
	 */
	private readonly mixed $label_source;

	/**
	 * @param string                   $key            Unprefixed option key; '' for a display-only field.
	 * @param string                   $type           Value-type tag (int/path/memcache_servers/array_strings/bool/text/float) — the sanitize-derivation hook.
	 * @param string|callable          $label          Settings-field label, or a `fn(): string` thunk (deferred `__()`).
	 * @param string                   $section        Section id this field renders under.
	 * @param string                   $id             add_settings_field id; defaults to $key when empty.
	 * @param array<int,string>|string $restart        Restart classification, consumed by Restart_Planner:
	 *                                                  - list of CONSUMER NODE-TYPE tokens (e.g. ['Partition','Topic'] or ['Flame_Builder']);
	 *                                                    restarts active topologies whose graph instantiates a matching node (by class ancestry);
	 *                                                  - 'all' — every active topology (process-wide settings: base dir, memcache);
	 *                                                  - [] — no restart; live workers pick it up from the reload watermark instead.
	 *                                                  NEVER a topology name — those drift; node classes are stable. See Restart_Planner.
	 * @param callable|null            $sanitize       register_setting sanitize_callback; required for option fields.
	 * @param callable|null            $render         add_settings_field render callback; required for rendered fields.
	 * @param bool                     $ui             Whether the field appears in the settings page (false = overlay-only key).
	 * @param array<string,mixed>      $register_args  Extra register_setting args merged in (e.g. autoload, type, default).
	 */
	public function __construct(
		public readonly string $key = '',
		/** @api */
		public readonly string $type = '',
		mixed $label = '',
		public readonly string $section = '',
		public readonly string $id = '',
		public readonly array|string $restart = [],
		/**
		 * Inclusive bounds for an `int` field, and the value a blank falls back
		 * to. Declared HERE because they belong to the setting, not to one of
		 * its consumers: the admin page and the `settings` service CI each held
		 * their own copy and disagreed — `num_partitions` was 1..16 on the page
		 * and 1..2^30 through the verb, so the same option had two definitions
		 * of valid depending on which door it came through.
		 *
		 * @api
		 */
		public readonly ?int $min = null,
		/** @api Inclusive upper bound for an `int` field. See $min. */
		public readonly ?int $max = null,
		/** @api The value a blank falls back to; also the page's placeholder. */
		public readonly ?int $default = null,
		mixed $sanitize = null,
		mixed $render = null,
		public readonly bool $ui = true,
		public readonly array $register_args = [],
	) {
		$this->label_source = $label;
		$this->sanitize     = \is_callable( $sanitize ) ? $sanitize : null;
		$this->render       = \is_callable( $render ) ? $render : null;
		// Blank deletes the row to its default; only a bool opts out.
		$this->delete_on_blank = 'bool' !== $this->type;
	}

	/** The resolved label: a thunk is invoked here (render time), a plain string passes through. */
	public function label(): string {
		$label = $this->label_source;
		if ( \is_callable( $label ) ) {
			$label = $label();
		}
		// Inline (not Core::str): Config_System stays Core-free for consumers.
		return \is_string( $label ) ? $label : '';
	}

	/**
	 * The sanitizer `register_setting()` gets. A bounded `int` field derives its
	 * own clamp from the declared min/max — the SAME declaration the `settings`
	 * service CI bounds-checks against, so the two cannot disagree about what is
	 * valid. They deliberately differ in what they do about an invalid value: the
	 * page CLAMPS, because its input is a constrained widget and a browser round
	 * trip has nowhere to report to; the CI REFUSES with `invalid value for
	 * setting`, because a programmatic caller must be told rather than silently
	 * given a different number. Every other field uses the callable it declared.
	 *
	 * A blank (or non-numeric) value answers `''`, which is NOT a value this
	 * sanitizer may store: presence is override (see Options_Overlay), and a
	 * stored `''` reads back as a 1-byte segment size. `''` is the hand-off to
	 * {@see Reset_Gate}, which runs next on `pre_update_option_{$option}` and
	 * deletes the row so the config-file default resurfaces — every blank-
	 * deletable field, which by derivation is every bounded int. Registering
	 * this sanitizer without that gate stores the `''`.
	 *
	 * @return callable|null
	 */
	public function sanitize_callback(): mixed {
		if ( 'int' !== $this->type || null === $this->min ) {
			return $this->sanitize;
		}
		$min = $this->min;
		$max = $this->max ?? \PHP_INT_MAX;
		return static fn ( mixed $value ): int|string =>
			\is_numeric( $value ) ? \max( $min, \min( $max, (int) $value ) ) : '';
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
