<?php
/**
 * Reset_Gate: restore a setting's declared default by DELETING its option row.
 *
 * The save-path half of presence-based config. A row is deleted when the field
 * carries a per-field reset mark, or when a blank-deletable field is submitted
 * empty. Both mean "use the declared default", which under presence-based config
 * (see Options_Overlay) is expressed by absence: a stored '' or [] is an override
 * that shadows the default forever. A sanitizer cannot express a delete, since it
 * can only return a value, so the gate runs one filter later on
 * `pre_update_option_{$option}`.
 *
 * The settings admin in newspack-nodes, newspack-event-logger-nodes and
 * newspack-pyrobase each registers the gate with its own Schema's option lists.
 * `Schema::delete_on_blank_options()` supplies the blank-delete subset, which
 * excludes the booleans: an unchecked box is a real value, so a bool resets
 * through its toggle alone.
 *
 * Nothing here may reach for a substrate class. Consumers load this file in
 * hermetic harnesses that never define Core.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

/**
 * The per-field reset decision, wired once per request and consulted from a
 * WordPress filter. Static and stateless: the settings admin passes the two
 * option lists in at registration, so the gate holds nothing between calls.
 */
class Reset_Gate {

	/**
	 * Register the gate on every resettable option's pre_update_option filter.
	 *
	 * One closure serves every option, because the filter hands `resolve()` the
	 * option name as its third argument; per-option bindings would only multiply
	 * the same decision.
	 *
	 * @param string            $mark_field        Hidden-input array name carrying the reset marks (see mark_name()).
	 * @param array<int,string> $all_options       Every resettable option, prefixed (`Schema::setting_option_names()`).
	 * @param array<int,string> $text_like_options Blank-deletable subset (`Schema::delete_on_blank_options()`).
	 */
	public static function register( string $mark_field, array $all_options, array $text_like_options ): void {
		$gate = static fn ( mixed $value, mixed $old_value, string $option ): mixed =>
			self::resolve( $value, $old_value, $option, $mark_field, $text_like_options );
		foreach ( $all_options as $option ) {
			\add_filter( "pre_update_option_{$option}", $gate, 10, 3 );
		}
	}

	/**
	 * Decide a single pre_update_option: delete the row, or pass the value through.
	 *
	 * Returning the OLD value after the delete is what stops WordPress writing the
	 * row back — `update_option()` compares the filtered value against the one it
	 * read and returns early when they match. Returning the new value would
	 * re-insert what the delete just removed.
	 *
	 * @param mixed             $value             The sanitized value being saved.
	 * @param mixed             $old_value         The stored value `update_option()` read before filtering.
	 * @param string            $option            Prefixed option name being saved.
	 * @param string            $mark_field        Hidden-input array name carrying the reset marks.
	 * @param array<int,string> $text_like_options Blank-deletable subset; '', [] and null delete for these.
	 * @return mixed The old value once the row is deleted, else $value untouched.
	 */
	public static function resolve( mixed $value, mixed $old_value, string $option, string $mark_field, array $text_like_options ): mixed {
		$blank = \in_array( $option, $text_like_options, true )
			&& ( '' === $value || [] === $value || null === $value );
		if ( self::is_reset_marked( $option, $mark_field ) || $blank ) {
			\delete_option( $option );
			return $old_value;
		}
		return $value;
	}

	/**
	 * Whether the submitted form carries a reset mark for this option.
	 *
	 * @param string $option     Prefixed option name.
	 * @param string $mark_field Hidden-input array name carrying the reset marks.
	 */
	private static function is_reset_marked( string $option, string $mark_field ): bool {
		// Presence check only; options.php verified the nonce before this.
		// phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$marks = $_POST[ $mark_field ] ?? null;
		return \is_array( $marks ) && isset( $marks[ $option ] );
	}

	/**
	 * The hidden-input name whose presence flags $option for reset on Save.
	 *
	 * `Settings_Renderer` stamps it on the field wrapper and the reset JS injects
	 * the hidden input under that name when the toggle goes on. Composing it here
	 * keeps the name the form emits and the name `is_reset_marked()` looks for in
	 * $_POST from drifting apart.
	 *
	 * @param string $mark_field Hidden-input array name carrying the reset marks.
	 * @param string $option     Prefixed option name to flag.
	 */
	public static function mark_name( string $mark_field, string $option ): string {
		return $mark_field . '[' . $option . ']';
	}
}
