<?php
/**
 * Settings_Renderer: the shared settings-field markup.
 *
 * One home for the per-field reset wrapper (`data-nn-reset` flex row + the `↺`
 * toggle) and the generic controls (number / directory / textarea / checkbox
 * list) that the three plugins used to copy-paste into every field callback.
 * Each method RETURNS escaped HTML (pure + testable); the caller echoes it.
 *
 * The checkbox list emits the previously-missing `data-nn-reset-default` hint
 * per box, so the field-reset JS restores the SHIPPED default set on ↺ instead
 * of clearing every box (see src/admin-field-reset/index.js `clear()`).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

class Settings_Renderer {

	/**
	 * A number field. Shows blank (placeholder = default) when unset or equal to
	 * the default; a real override shows its value. Wide ranges get `regular-text`,
	 * narrow ones `small-text`.
	 *
	 * @param int|string $value Stored option value ('' when unset).
	 */
	public static function number(
		string $id,
		string $name,
		int|string $value,
		int $default,
		int $min,
		int $max,
		string $description,
		string $mark_name
	): string {
		$value         = (string) $value;
		$display_value = ( '' === $value || (int) $value === $default ) ? '' : $value;
		$input_class   = $max > 999 ? 'regular-text' : 'small-text';
		$inner         = '<input type="number" id="' . \esc_attr( $id ) . '"'
			. ' name="' . \esc_attr( $name ) . '"'
			. ' value="' . \esc_attr( $display_value ) . '"'
			. ' min="' . \esc_attr( (string) $min ) . '"'
			. ' max="' . \esc_attr( (string) $max ) . '"'
			. ' class="' . \esc_attr( $input_class ) . '"'
			. ' placeholder="' . \esc_attr( (string) $default ) . '" />'
			. '<p class="description">' . \esc_html( $description ) . '</p>';
		return self::reset_wrapper( $mark_name, $inner );
	}
	/** Flex row: the control(s) on the left, the reset toggle on the right. */
	public static function reset_wrapper( string $mark_name, string $inner ): string {
		return '<div style="display: flex; align-items: flex-start; gap: 10px;" data-nn-reset="' . \esc_attr( $mark_name ) . '">'
			. '<div style="flex: 1;">' . $inner . '</div>'
			. self::reset_toggle()
			. '</div>';
	}

	/** The `↺` reset-toggle button (paired with a reset_wrapper). */
	public static function reset_toggle(): string {
		return '<button type="button" class="button button-secondary" data-nn-reset-toggle'
			. ' title="' . \esc_attr__( 'Reset to default (toggle, then Save)', 'newspack-nodes' ) . '">↺</button>';
	}

	/** A directory/text field whose placeholder advertises the file default. */
	public static function directory(
		string $id,
		string $name,
		string $value,
		string $default,
		string $description,
		string $mark_name
	): string {
		$inner = '<input type="text" id="' . \esc_attr( $id ) . '"'
			. ' name="' . \esc_attr( $name ) . '"'
			. ' value="' . \esc_attr( $value ) . '"'
			. ' class="regular-text code"'
			. ' placeholder="' . \esc_attr( $default ) . '" />'
			. '<p class="description">' . \esc_html( $description ) . '</p>';
		return self::reset_wrapper( $mark_name, $inner );
	}

	/** A textarea whose placeholder advertises the file default (e.g. server list). */
	public static function textarea(
		string $id,
		string $name,
		string $value,
		string $placeholder,
		string $description,
		string $mark_name
	): string {
		$inner = '<textarea id="' . \esc_attr( $id ) . '"'
			. ' name="' . \esc_attr( $name ) . '" rows="3" class="regular-text code"'
			. ' placeholder="' . \esc_attr( $placeholder ) . '">' . \esc_textarea( $value ) . '</textarea>'
			. '<p class="description">' . \esc_html( $description ) . '</p>';
		return self::reset_wrapper( $mark_name, $inner );
	}

	/**
	 * A single-boolean checkbox toggle. Emits the hidden `value="0"` sentinel (so an
	 * unchecked box still posts) followed by the checkbox carrying its file-default
	 * hint, then a `<label for>`. `checked="checked"` follows `value="1"` adjacently
	 * — callers match on that. The attr is built directly (not via `\checked()`,
	 * which echoes) so the method stays a pure string returner.
	 *
	 * @api
	 * @param string $id        Checkbox element id (also the label's `for`).
	 * @param string $name      WP-option name (shared by the hidden sentinel + checkbox).
	 * @param bool   $checked   Whether the box renders checked (the stored/effective value).
	 * @param bool   $default   The file default — drives `data-nn-reset-default`, independent of $checked.
	 * @param string $label     Visible label text.
	 * @param string $mark_name The per-field reset mark (reset_wrapper's `data-nn-reset`).
	 */
	public static function checkbox(
		string $id,
		string $name,
		bool $checked,
		bool $default,
		string $label,
		string $mark_name
	): string {
		$checked_attr = $checked ? ' checked="checked"' : '';
		$inner        = '<input type="hidden" name="' . \esc_attr( $name ) . '" value="0" />'
			. '<input type="checkbox" id="' . \esc_attr( $id ) . '"'
			. ' name="' . \esc_attr( $name ) . '" value="1"'
			. ' data-nn-reset-default="' . ( $default ? '1' : '0' ) . '"'
			. $checked_attr . ' />'
			. '<label for="' . \esc_attr( $id ) . '">' . \esc_html( $label ) . '</label>';
		return self::reset_wrapper( $mark_name, $inner );
	}

	/**
	 * A React-mount field: a hidden JSON carrier (`{field}_json`) the form posts
	 * back, plus the mount `<div>` whose `data-field` / `data-values` / `data-default`
	 * the React tree reads. Generic — the caller supplies the mount id + class.
	 *
	 * @api
	 * @param string $field        Field short-name (drives `data-field` + the carrier id).
	 * @param string $mount_id     The mount div's id.
	 * @param string $mount_class  The mount div's class (the React tree's selector).
	 * @param string $option_name  WP-option name carried by the hidden JSON input.
	 * @param string $values_json  JSON of the current values.
	 * @param string $default_json JSON of the file-default values (the ↺ target).
	 * @param string $description  Field description.
	 * @param string $mark_name    The per-field reset mark.
	 */
	public static function react_mount(
		string $field,
		string $mount_id,
		string $mount_class,
		string $option_name,
		string $values_json,
		string $default_json,
		string $description,
		string $mark_name
	): string {
		$inner = '<input type="hidden" id="' . \esc_attr( $field ) . '_json"'
			. ' name="' . \esc_attr( $option_name ) . '" value="' . \esc_attr( $values_json ) . '" />'
			. '<div id="' . \esc_attr( $mount_id ) . '"'
			. ' data-field="' . \esc_attr( $field ) . '"'
			. ' data-values="' . \esc_attr( $values_json ) . '"'
			. ' data-default="' . \esc_attr( $default_json ) . '"'
			. ' class="' . \esc_attr( $mount_class ) . '"></div>'
			. '<p class="description">' . \esc_html( $description ) . '</p>';
		return self::reset_wrapper( $mark_name, $inner );
	}
}
