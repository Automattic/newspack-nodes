<?php
/**
 * The settings-page markup every plugin on the substrate shares.
 *
 * Two surfaces live here. The field controls — number, directory, textarea,
 * checkbox and React mount — each render one setting inside the per-field reset
 * row. The "Effective Configuration" panel renders below the form and reports
 * what the next worker will load. Both take the calling plugin's own Schema and
 * option prefix, so the substrate's settings page and every consumer's draw the
 * same markup from one implementation rather than copying it and drifting.
 *
 * Every control RETURNS escaped HTML instead of echoing it, which is what makes
 * the markup assertable in a test without an output buffer. Escaping is this
 * file's job, so a caller echoes the result unescaped.
 *
 * Substrate-coupled on purpose: the hermetic `Config_System` subset a sibling
 * loads without the runtime excludes this file, so reaching Core, Fleet_Node
 * and Restart_Planner here is legitimate.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

use Newspack_Nodes\Core;
use Newspack_Nodes\Fleet_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * Per-field reset takes three parts, and this class emits the markup. The
 * browser part is `src/admin-field-reset/index.js`; the save part is
 * {@see Reset_Gate}.
 *
 * Every control goes out through `reset_wrapper()`, so the `↺` toggle and the
 * `data-nn-reset` mark name ride along whether or not a renderer thought about
 * reset. A control built outside that wrapper looks right on the page and
 * silently cannot be reset: nothing fails, the button is simply missing.
 */
class Settings_Renderer {

	/**
	 * Array entries printed in full before `format_value()` summarizes instead.
	 *
	 * The panel gives each setting one table cell, and a rules map or an event
	 * allowlist runs to hundreds of entries.
	 */
	private const ARRAY_SAMPLE = 6;

	/**
	 * Print the read-only "Effective Configuration" table below a settings form.
	 *
	 * The one method here that echoes rather than returns, because each plugin
	 * hooks it to its own `settings_after_form` action and an action callback has
	 * no return channel. Every decision it prints is made in
	 * {@see self::effective_config_rows()}, which the tests cover directly.
	 *
	 * @param Schema              $schema    The calling plugin's settings schema.
	 * @param string              $prefix    WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param array<string,mixed> $effective Already-loaded effective config (the caller's Config::load_config()).
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
	 * The panel's data, one row per rendered setting: the stored value, the value
	 * the next worker will load, whether a stored row is overriding the default,
	 * and which topologies a save of that setting restarts.
	 *
	 * The caller passes its already-loaded effective config because each consumer
	 * has its own `Config` class and the substrate renderer cannot name them; the
	 * Schema and prefix arrive the same way, which is what keeps the panel one
	 * implementation across plugins.
	 *
	 * `overlay` is null unless a stored option row exists. Presence is what makes
	 * a row an override (see Options_Overlay), so a stored '', [] or 0 reports as
	 * one, and the column repeats the stored value rather than inventing a second
	 * notion of override that could disagree with the overlay itself.
	 *
	 * @param Schema              $schema    The calling plugin's settings schema.
	 * @param string              $prefix    WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param array<string,mixed> $effective Already-loaded effective config (the caller's Config::load_config()).
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

			// load_config() applied the overlay; fall back if it omits the key.
			$effective_value = $effective[ $key ] ?? $raw_store;
			if ( Options_Overlay::ABSENT === $effective_value ) {
				$effective_value = $field->register_args['default'] ?? '';
			}

			// Override active when this key has a stored row (presence rule).
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
	 * The sentence the panel's "Restart impact" column prints for a Field's
	 * restart classification.
	 *
	 * The `[]` case is the one that reads wrong on the page: it recycles no
	 * process, yet a save still writes every live worker's reload watermark, so
	 * the value lands within one `_fleet` scan instead of at the end of a ~595s
	 * worker lifetime. A classification naming node types that no ACTIVE topology
	 * instantiates reports no consumer, which is the honest answer — nothing will
	 * be restarted. Otherwise the column names the topologies.
	 *
	 * @param array<int,string>|string $restart Restart classification (see Restart_Planner).
	 * @return string Panel text, already translated.
	 */
	private static function restart_impact( array|string $restart ): string {
		if ( [] === $restart ) {
			return \sprintf(
				/* translators: %d: seconds between a worker's config-reload windows. */
				\__( 'No restart (workers re-read within ~%ds)', 'newspack-nodes' ),
				\intdiv( Fleet_Node::SCAN_INTERVAL_MS, 1000 )
			);
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
	 * Render one setting's value as a single line of table text.
	 *
	 * An associative array is summarized by its KEYS and a list by its values,
	 * because an assoc array carries its meaning in the keys: a rules map keyed by
	 * URL pattern reads as the patterns it covers, never as the rule bodies.
	 * Anything past ARRAY_SAMPLE entries collapses to a count plus that sample.
	 * An empty array reads "(none)"; an object or null reads '', since
	 * `Core::as_string` refuses a cast it cannot make.
	 *
	 * @param mixed $value Stored or effective value of one setting.
	 * @return string One line of display text.
	 */
	private static function format_value( mixed $value ): string {
		if ( \is_array( $value ) ) {
			if ( [] === $value ) {
				return \__( '(none)', 'newspack-nodes' );
			}
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
	 * A bounded number field showing the default as its placeholder.
	 *
	 * A value equal to the default renders BLANK, so the field reads as "not
	 * overridden" and a save of it deletes the row through {@see Reset_Gate}
	 * rather than storing a copy of the default. A stored copy would shadow the
	 * declared default forever, including after that default moves.
	 *
	 * @param string     $id          Input element id.
	 * @param string     $name        WP-option name the input posts under.
	 * @param int|string $value       Stored option value ('' when no row exists).
	 * @param int        $default     The default a reset restores; shown as the placeholder.
	 * @param int        $min         Inclusive lower bound (the Field's).
	 * @param int        $max         Inclusive upper bound; over 999 widens the input to `regular-text`.
	 * @param string     $description Text rendered under the input.
	 * @param string     $mark_name   Per-field reset mark (see Reset_Gate::mark_name()).
	 * @return string Escaped markup, wrapped in the reset row.
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

	/**
	 * A path field: a plain text input whose placeholder advertises the default a
	 * reset restores, so a blank field states what it will fall back to.
	 *
	 * @param string $id          Input element id.
	 * @param string $name        WP-option name the input posts under.
	 * @param string $value       Stored option value ('' when no row exists).
	 * @param string $default     The default a reset restores; shown as the placeholder.
	 * @param string $description Text rendered under the input.
	 * @param string $mark_name   Per-field reset mark (see Reset_Gate::mark_name()).
	 * @return string Escaped markup, wrapped in the reset row.
	 */
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

	/**
	 * A multi-line field for a list setting — the memcache servers, the extra log
	 * sources. The caller joins the entries with newlines both ways: the stored
	 * array arrives as text and its sanitizer splits the post back apart.
	 *
	 * @param string $id          Textarea element id.
	 * @param string $name        WP-option name the textarea posts under.
	 * @param string $value       Stored entries, newline-joined ('' when no row exists).
	 * @param string $placeholder Default entries, newline-joined.
	 * @param string $description Text rendered under the textarea.
	 * @param string $mark_name   Per-field reset mark (see Reset_Gate::mark_name()).
	 * @return string Escaped markup, wrapped in the reset row.
	 */
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
	 * A single-boolean toggle: a hidden `value="0"` input, the checkbox, then a
	 * `<label for>`.
	 *
	 * An unchecked box posts nothing, so the hidden sentinel is what lets a save
	 * turn a setting OFF instead of leaving the stored row standing. The checkbox
	 * carries `data-nn-reset-default`, which is what the reset JS restores on `↺`:
	 * without it a bool defaulting to true would reset to unchecked, the one state
	 * the operator did not ask for.
	 *
	 * The `checked` attribute is built inline rather than through `\checked()`,
	 * which echoes; that would make the method print instead of return. It lands
	 * adjacent to `value="1"`, and `SettingsRendererTest` asserts that exact run of
	 * attributes, so inserting another between them fails the suite.
	 *
	 * @api
	 * @param string $id        Checkbox element id (also the label's `for`).
	 * @param string $name      WP-option name, shared by the hidden sentinel and the checkbox.
	 * @param bool   $checked   Whether the box renders checked (the stored or effective value).
	 * @param bool   $default   The declared default, driving `data-nn-reset-default` independently of $checked.
	 * @param string $label     Visible label text.
	 * @param string $mark_name Per-field reset mark (see Reset_Gate::mark_name()).
	 * @return string Escaped markup, wrapped in the reset row.
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
			// The box and its text read as one word without a gap between them.
			. '<label for="' . \esc_attr( $id ) . '" style="margin-left:6px">'
			. \esc_html( $label ) . '</label>';
		return self::reset_wrapper( $mark_name, $inner );
	}

	/**
	 * A field a React tree owns: a hidden JSON carrier plus the mount `<div>` it
	 * reads its `data-field`, `data-values` and `data-default` from.
	 *
	 * The values ride a hidden input because the page is a plain `options.php`
	 * POST and a React tree has no other way to hand its state back. Everything
	 * identifying the mount comes from the caller, so a consumer's component
	 * mounts here without the substrate knowing its selector.
	 *
	 * The reset module skips hidden inputs, so `↺` marks this option for deletion
	 * without touching the tree: a component that wants the toggle to preview the
	 * reset restores `data-default` itself.
	 *
	 * @api
	 * @param string $field        Field short-name, driving `data-field` and the carrier id.
	 * @param string $mount_id     The mount div's id.
	 * @param string $mount_class  The mount div's class (the React tree's selector).
	 * @param string $option_name  WP-option name the hidden JSON input posts under.
	 * @param string $values_json  JSON of the current values.
	 * @param string $default_json JSON of the declared default values (what `↺` restores).
	 * @param string $description  Text rendered under the mount.
	 * @param string $mark_name    Per-field reset mark (see Reset_Gate::mark_name()).
	 * @return string Escaped markup, wrapped in the reset row.
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
	/**
	 * Wrap a control in the flex row the reset JS binds to: the control on the
	 * left, the `↺` toggle on the right.
	 *
	 * `data-nn-reset` carries the exact hidden-input name a Save must post, so the
	 * one built module — `src/admin-field-reset/index.js`, which every settings
	 * admin enqueues through {@see Field_Reset_Assets} — needs no plugin's option
	 * prefix compiled into it.
	 *
	 * $inner is emitted verbatim, so a caller passing unescaped markup writes it
	 * straight into the page; every renderer here escapes before calling.
	 *
	 * @param string $mark_name Per-field reset mark (see Reset_Gate::mark_name()).
	 * @param string $inner     Already-escaped control markup.
	 * @return string The wrapped row.
	 */
	public static function reset_wrapper( string $mark_name, string $inner ): string {
		return '<div style="display: flex; align-items: flex-start; gap: 10px;" data-nn-reset="' . \esc_attr( $mark_name ) . '">'
			. '<div style="flex: 1;">' . $inner . '</div>'
			. self::reset_toggle()
			. '</div>';
	}

	/**
	 * The `↺` button `reset_wrapper()` pairs with each control. It holds no
	 * state: `data-nn-reset-toggle` is the only thing the JS looks for, and the
	 * mark it injects lives on the wrapper.
	 *
	 * @return string The button markup.
	 */
	public static function reset_toggle(): string {
		return '<button type="button" class="button button-secondary" data-nn-reset-toggle'
			. ' title="' . \esc_attr__( 'Reset to default (toggle, then Save)', 'newspack-nodes' ) . '">↺</button>';
	}
}
