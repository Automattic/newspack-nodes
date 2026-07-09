<?php
/**
 * Settings_Renderer: the shared settings-field markup.
 *
 * One home for the per-field reset wrapper (`data-nn-reset` flex row + the `↺`
 * toggle) and the generic controls (number / directory / textarea / checkbox
 * list). Each method RETURNS escaped HTML (pure + testable); the caller echoes it.
 *
 * The checkbox list emits a `data-nn-reset-default` hint per box, so the
 * field-reset JS restores the SHIPPED default set on ↺ instead
 * of clearing every box (see src/admin-field-reset/index.js `clear()`).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

use Newspack_Nodes\Core;

\defined( 'ABSPATH' ) || exit;

class Settings_Renderer {

	/** Small arrays render in full; larger ones collapse so a 400-entry hook list can't dominate the row. */
	private const ARRAY_SAMPLE = 6;

	/**
	 * Render the read-only "Effective Configuration" table below a settings form.
	 * Each plugin hooks this to its own `settings_after_form` action.
	 *
	 * @param Schema               $schema    The plugin's settings schema.
	 * @param string               $prefix    WP-option name prefix.
	 * @param array<string,mixed>  $effective Already-loaded effective config.
	 */
	public static function render_effective_config_section( Schema $schema, string $prefix, array $effective ): void {
		$rows = self::effective_config_rows( $schema, $prefix, $effective );
		?>
		<h2><?php \esc_html_e( 'Effective Configuration', 'newspack-nodes' ); ?></h2>
		<p class="description"><?php \esc_html_e( 'What the next worker will load, and which topologies a save restarts.', 'newspack-nodes' ); ?></p>
		<table class="widefat">
			<thead>
				<tr>
					<th scope="col"><?php \esc_html_e( 'Setting', 'newspack-nodes' ); ?></th>
					<th scope="col"><?php \esc_html_e( 'Stored', 'newspack-nodes' ); ?></th>
					<th scope="col"><?php \esc_html_e( 'Effective', 'newspack-nodes' ); ?></th>
					<th scope="col"><?php \esc_html_e( 'Overlay override', 'newspack-nodes' ); ?></th>
					<th scope="col"><?php \esc_html_e( 'Restart impact', 'newspack-nodes' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php foreach ( $rows as $row ) : ?>
					<tr>
						<td><?php echo \esc_html( $row['label'] ); ?></td>
						<td><?php echo \esc_html( $row['stored'] ); ?></td>
						<td><?php echo \esc_html( $row['effective'] ); ?></td>
						<td><?php echo \esc_html( null === $row['overlay'] ? '—' : $row['overlay'] ); ?></td>
						<td><?php echo \esc_html( $row['restart'] ); ?></td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	/**
	 * Pure data for the "Effective Configuration" panel: one row per rendered
	 * setting, reporting the stored value, the value the next worker will load,
	 * any active per-request overlay override, and the live restart impact.
	 *
	 * Plugin-agnostic — the caller passes its own Schema, WP-option prefix, and
	 * already-loaded effective config (each plugin's own `Config::load_config()`,
	 * which the substrate renderer can't call directly because the consumers each
	 * have a different `Config`).
	 *
	 * @param Schema               $schema    The plugin's settings schema.
	 * @param string               $prefix    WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param array<string,mixed>  $effective Already-loaded effective config (the caller's Config::load_config()).
	 * @return array<int,array{key:string,label:string,stored:string,effective:string,overlay:?string,restart:string}>
	 */
	public static function effective_config_rows( Schema $schema, string $prefix, array $effective ): array {
		$rows = [];
		foreach ( $schema->fields() as $field ) {
			if ( ! $field->is_setting() ) {
				continue;
			}
			$key       = $field->key;
			$raw_store = Options_Overlay::stored_value( $prefix, $key );
			$stored    = Options_Overlay::ABSENT === $raw_store
				? \__( '— (file default)', 'newspack-nodes' )
				: self::format_value( $raw_store );

			// Every setting overlays the config file, so the operative value is the
			// overlay-resolved load_config() entry.
			$effective_value = $effective[ $key ] ?? $raw_store;
			if ( Options_Overlay::ABSENT === $effective_value ) {
				$effective_value = $field->register_args['default'] ?? '';
			}

			// Override active when this key has a stored row (Options_Overlay's presence rule).
			$overlay = Options_Overlay::ABSENT !== $raw_store
				? self::format_value( $raw_store )
				: null;

			$rows[] = [
				'key'       => $key,
				'label'     => $field->label(),
				'stored'    => $stored,
				'effective' => self::format_value( $effective_value ),
				'overlay'   => $overlay,
				'restart'   => self::restart_impact( $field->restart ),
			];
		}
		return $rows;
	}

	/**
	 * Display a config value: empty array → "(none)", small array joined with ', ',
	 * large array summarized as "<n> values: <first 6>, … (+<rest> more)", scalars
	 * cast, everything else ''.
	 */
	private static function format_value( mixed $value ): string {
		if ( \is_array( $value ) ) {
			if ( [] === $value ) {
				return \__( '(none)', 'newspack-nodes' );
			}
			// An associative array (e.g. custom_events {event => true}) carries its meaning in the keys; a list, in the values.
			$source = \array_is_list( $value ) ? $value : \array_keys( $value );
			$items  = \array_map( [ Core::class, 'as_string' ], $source );
			$n     = \count( $items );
			if ( $n <= self::ARRAY_SAMPLE ) {
				return \implode( ', ', $items );
			}
			return \sprintf(
				/* translators: 1: total count, 2: comma-separated sample of the first values, 3: count of remaining values. */
				\__( '%1$d values: %2$s, … (+%3$d more)', 'newspack-nodes' ),
				$n,
				\implode( ', ', \array_slice( $items, 0, self::ARRAY_SAMPLE ) ),
				$n - self::ARRAY_SAMPLE
			);
		}
		return Core::as_string( $value );
	}

	/**
	 * Human-readable restart impact for a Field's restart classification.
	 *
	 * @param array<int,string>|string $restart Restart classification (see Restart_Planner).
	 */
	private static function restart_impact( array|string $restart ): string {
		if ( 'supervisor_only' === $restart ) {
			return \__( 'Applies on next supervisor tick', 'newspack-nodes' );
		}
		if ( [] === $restart ) {
			return \__( 'Takes effect immediately', 'newspack-nodes' );
		}
		$topologies = Restart_Planner::topologies_for( $restart );
		if ( [] === $topologies ) {
			return \__( 'Restarts: (no active consumer)', 'newspack-nodes' );
		}
		return \sprintf(
			/* translators: %s: comma-separated topology names. */
			\__( 'Restarts: %s', 'newspack-nodes' ),
			\implode( ', ', $topologies )
		);
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
