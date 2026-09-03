<?php
/**
 * Field: one declarative setting in a Config_System\Schema.
 *
 * The SINGLE description of a config key — its type, bounds, default, label,
 * section, sanitizer, renderer, blank-delete policy and worker-restart class.
 * Everything else derives from the Field list: the overlay key-list, the
 * defaults map ADR-20 puts in code, the option names, the reset list, and the
 * register/render loops. Declare a setting once; every view of it follows.
 *
 * Nothing here may reach for a substrate class. Consumers load this file in
 * hermetic harnesses that never define Core.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

/**
 * An immutable declaration, built while a plugin assembles its Schema and read
 * by every settings surface afterwards.
 *
 * A Field is one of three shapes, told apart by the predicates below:
 *   - a rendered option    (key set, ui true)  — the common case;
 *   - an overlay-only key  (key set, ui false) — overlaid onto the config and
 *     readable through `Config::value()`, absent from the settings page (e.g.
 *     `allowed_users`);
 *   - a display-only field (no key, ui true)   — rendered but not an option
 *     (e.g. the computed total-storage readout).
 */
class Field {

	/**
	 * Whether a blank save deletes the option row instead of storing the blank.
	 *
	 * Derived from the type, and read by `Schema::delete_on_blank_options()` to
	 * build the Reset_Gate list. Every non-`bool` field deletes, so clearing an
	 * input falls back to the declared default. A `bool` opts out because false
	 * is a real value there: deleting the row would resurface a `true` default
	 * and leave "off" unstorable.
	 */
	public readonly bool $delete_on_blank;

	/**
	 * The `add_settings_field` render callback, null when the declaration
	 * passed no callable. `Schema::register_sections_and_fields()` skips a
	 * field without one, so a rendered field must declare it.
	 *
	 * @var callable|null
	 */
	public readonly mixed $render;

	/**
	 * The declared `register_setting` sanitizer, null when the declaration
	 * passed no callable. A bounded `int` declares none and derives its own —
	 * registration reads {@see self::sanitize_callback()}, never this field.
	 *
	 * @var callable|null
	 */
	public readonly mixed $sanitize;

	/**
	 * The label as declared: a plain string, or a `fn(): string` thunk.
	 *
	 * The thunk defers `__()` to render time. A worker or WP-CLI process builds
	 * the whole schema through `Config` just to read `overlay_keys()`, and a
	 * translation call at that point runs at plugin load for a page nobody
	 * renders. Resolve through {@see self::label()}.
	 *
	 * @var string|callable
	 */
	private readonly mixed $label_source;

	/**
	 * @param string                   $key            Unprefixed option key; '' for a display-only field.
	 * @param string                   $type           Value-type tag. Field reads two of them: `int` with a `min` derives the clamp below, and `bool` opts out of blank-delete. Any other tag (`path`, `text`, `array_strings`, …) belongs to the declaring plugin's own renderer.
	 * @param string|callable          $label          Settings-field label, or a `fn(): string` thunk (deferred `__()`).
	 * @param string                   $section        Section id this field renders under.
	 * @param string                   $id             add_settings_field id; defaults to $key when empty.
	 * @param array<int,string>|string $restart        Restart classification, consumed by Restart_Planner:
	 *                                                  - list of CONSUMER NODE-TYPE tokens (e.g. ['Partition','Topic'] or ['Flame_Builder']);
	 *                                                    restarts active topologies whose graph instantiates a matching node (by class ancestry);
	 *                                                  - 'all' — every active topology (process-wide settings: base dir, memcache);
	 *                                                  - [] — no restart; live workers pick the value up from the reload flag instead.
	 *                                                  NEVER a topology name — those drift; node classes are stable. See Restart_Planner.
	 * @param callable|null            $sanitize       register_setting sanitize_callback. A rendered option needs either this or derivable int bounds; `Schema::register_options()` skips a field with neither.
	 * @param callable|null            $render         add_settings_field render callback; required for rendered fields.
	 * @param bool                     $ui             Whether the field appears in the settings page; false declares an overlay-only key.
	 * @param array<string,mixed>      $register_args  Extra register_setting args merged in (autoload, type, default, show_in_rest).
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
		 * Inclusive lower bound for an `int` field, and the trigger that
		 * derives its clamp. Declared HERE because bounds belong to the
		 * setting, not to one of its consumers: the settings page and the
		 * `settings` service verb both read this one declaration, so an option
		 * cannot mean 1..16 through the page and 1..2^30 through the verb.
		 *
		 * @api
		 */
		public readonly ?int $min = null,
		/** @api Inclusive upper bound for an `int` field; null clamps at PHP_INT_MAX. See $min. */
		public readonly ?int $max = null,
		/**
		 * The key's built-in value: what `Config::load_config_defaults()`
		 * starts from, what a blank save falls back to, and the page's
		 * placeholder. It lives HERE because a default that lives only in the
		 * shipped config file reads null on every install whose file predates
		 * the key — a deploy preserves the operator's file, so the key never
		 * appears in it (ADR-20). null means the Field declares none.
		 *
		 * @api
		 * @var mixed
		 */
		public readonly mixed $default = null,
		mixed $sanitize = null,
		mixed $render = null,
		public readonly bool $ui = true,
		public readonly array $register_args = [],
	) {
		$this->label_source    = $label;
		$this->sanitize        = \is_callable( $sanitize ) ? $sanitize : null;
		$this->render          = \is_callable( $render ) ? $render : null;
		$this->delete_on_blank = 'bool' !== $this->type;
	}

	/** The resolved label: a thunk is invoked here (render time), a plain string passes through, anything else answers ''. */
	public function label(): string {
		$label = $this->label_source;
		if ( \is_callable( $label ) ) {
			$label = $label();
		}
		// Inline (not Core::str): Config_System stays Core-free.
		return \is_string( $label ) ? $label : '';
	}

	/**
	 * The sanitizer `register_setting()` gets: a bounded `int` derives its own
	 * clamp, and every other field uses the callable it declared.
	 *
	 * The derived clamp reads the SAME min/max the `settings` service verb
	 * bounds-checks against, so the two cannot disagree about what is valid.
	 * They deliberately differ in what they do about an invalid value: the page
	 * CLAMPS, because its input is a constrained widget and a browser round
	 * trip has nowhere to report to; the verb REFUSES with `invalid value for
	 * setting`, because a programmatic caller must be told rather than silently
	 * handed a different number.
	 *
	 * A blank or non-numeric value answers `''`, which is NOT a value this
	 * sanitizer may store: presence is override (see Options_Overlay), and a
	 * stored `''` reads back as a 1-byte segment size. The `''` is the hand-off
	 * to {@see Reset_Gate}, which runs next on `pre_update_option_{$option}`
	 * and deletes the row so the declared default resurfaces — for every
	 * blank-deletable field, which by derivation is every bounded int.
	 * Registering this sanitizer without that gate stores the `''`.
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

	/** Whether this is a rendered option: it registers, and joins option_names, the reset set and the restart classification. */
	public function is_setting(): bool {
		return $this->ui && '' !== $this->key;
	}

	/** Whether this appears in the settings-page render loop (display-only fields included). */
	public function is_rendered(): bool {
		return $this->ui;
	}

	/** The add_settings_field id — the explicit $id, else the option key. */
	public function render_id(): string {
		return '' !== $this->id ? $this->id : $this->key;
	}
}
