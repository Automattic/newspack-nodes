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
	 * A checkbox list. Each box carries `data-nn-reset-default` ('1' if it is in
	 * the shipped default set) so a ↺ reset restores that set, not "all off".
	 *
	 * @param string             $name        Array-input name (e.g. `opt[]`).
	 * @param array<int,string>  $options     Every available value.
	 * @param array<int,string>  $checked     Currently-checked values.
	 * @param array<int,string>  $defaults    The file-default set (the ↺ target).
	 */
	public static function checkbox_list(
		string $name,
		array $options,
		array $checked,
		array $defaults,
		string $description,
		string $mark_name
	): string {
		$boxes = '';
		foreach ( $options as $value ) {
			// `checked` directly follows `value` (callers match on that adjacency);
			// the default hint trails so the field-reset JS can restore the set.
			$is_checked = \in_array( $value, $checked, true ) ? ' checked' : '';
			$is_default = \in_array( $value, $defaults, true ) ? '1' : '0';
			$boxes     .= '<label style="display:block; margin-bottom: 4px;">'
				. '<input type="checkbox" name="' . \esc_attr( $name ) . '" value="' . \esc_attr( $value ) . '"'
				. \esc_attr( $is_checked ) . ' data-nn-reset-default="' . \esc_attr( $is_default ) . '" /> '
				. '<code>' . \esc_html( $value ) . '</code>'
				. '</label>';
		}
		$inner = '<fieldset>' . $boxes . '</fieldset>'
			. '<p class="description">' . \esc_html( $description ) . '</p>';
		return self::reset_wrapper( $mark_name, $inner );
	}
}
