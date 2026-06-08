<?php
/**
 * Reset_Gate: shared per-field "reset → delete the option" gate.
 *
 * Used by every plugin's settings admin. A settings row is DELETED (so the file
 * default resurfaces) when the field was toggled for reset, OR when a text-like
 * field was submitted blank — both mean "use the file default", which under
 * presence-based config (see Options_Overlay) is expressed by absence, never by
 * a stored ''/[]. Selection/boolean fields are excluded from blank-delete (an
 * empty value there is a real override) but still reset via the explicit toggle.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

class Reset_Gate {
	/**
	 * Register the gate on every resettable option's pre_update_option filter.
	 *
	 * @param string            $mark_field         Hidden-input array name carrying reset marks.
	 * @param array<int,string> $all_options        Every resettable option (full reset set).
	 * @param array<int,string> $text_like_options  Subset whose blank save also deletes.
	 */
	public static function register( string $mark_field, array $all_options, array $text_like_options ): void {
		$gate = static fn ( mixed $value, mixed $old_value, string $option ): mixed =>
			self::resolve( $value, $old_value, $option, $mark_field, $text_like_options );
		foreach ( $all_options as $option ) {
			\add_filter( "pre_update_option_{$option}", $gate, 10, 3 );
		}
	}

	/**
	 * Decide a single pre_update_option: delete + short-circuit, or pass through.
	 *
	 * @param array<int,string> $text_like_options Subset whose blank save deletes.
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

	/** The per-field reset toggle marked this option (mark rides the nonce-verified settings POST). */
	private static function is_reset_marked( string $option, string $mark_field ): bool {
		// Presence check only — the marker value is never read or stored, and
		// options.php verifies the settings nonce before any pre_update_option fires.
		// phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$marks = $_POST[ $mark_field ] ?? null;
		return \is_array( $marks ) && isset( $marks[ $option ] );
	}

	/** Hidden-input name that flags $option for per-field reset (deleted on Save). */
	public static function mark_name( string $mark_field, string $option ): string {
		return $mark_field . '[' . $option . ']';
	}
}
