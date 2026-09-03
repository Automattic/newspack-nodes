/**
 * TopologySettingsPanel — the edit-mode editor for everything in a topology
 * file that is not a node: its `var name = value` frontmatter and its `secure`
 * line.
 *
 * `num_partitions`, `stale_timeout` and `on_demand_idle` get typed inputs
 * whose placeholder is the value the config falls back to, so an author sees
 * what a key inherits without leaving the panel. Every other var is a generic
 * name/value row.
 *
 * Edits go back through the draft's `replaceFrontmatter`, the editor operation
 * `DraftContext` documents for this case: TSL sets one entry per line, an
 * editor holds them all, so the panel dispatches the whole map. The secure
 * level is a STATEMENT rather than frontmatter, so it rides the interpreter's
 * own `secure` / `insecure` verbs and `clearSecure` instead.
 */

import { useRef, useState, createPortal } from '@wordpress/element';
import { useDismissable } from '@newspack-nodes/shared/hooks/useDismissable';
import { useDraft } from '../DraftContext';
import { __, sprintf } from '@wordpress/i18n';

/**
 * The frontmatter keys the substrate itself reads, each with a typed input of
 * its own above the generic rows.
 *
 * A key listed here is kept out of the generic rows and refused as a new name,
 * so no key is ever editable from two controls at once.
 */
export const RECOGNIZED_KEYS = [
	'num_partitions',
	'stale_timeout',
	'on_demand_idle',
];

/**
 * The name shape a saved file reads back as frontmatter.
 * `Topology_Analyzer::frontmatter()` skips a `var` line whose name is anything
 * else, and the Shell's `var` verb refuses a `:` outright — that character is
 * reserved for token namespaces like `<config:logs_dir>`. `replaceFrontmatter`
 * writes the map without passing through the `var` verb, so this is the only
 * check a name added here gets.
 */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * The `num_partitions` ceiling, mirroring `Spawn_Coordinator::MAX_PARTITIONS`.
 * `Bootstrap` clamps to it while expanding workers, so a larger declared count
 * spawns nothing extra and only misleads whoever reads the file.
 */
const MAX_PARTITIONS = 16;

/**
 * The frontmatter map as `[ name, value ]` pairs, in the map's own order.
 *
 * The rows render from this array and `setValue` replaces an entry in place,
 * which is what keeps an edited row where the author found it.
 *
 * @param {?Object<string,*>} frontmatter The draft's map; a missing one is empty.
 * @return {Array<[string,string]>} Pairs, every value a string.
 */
function toEntries( frontmatter ) {
	return Object.entries( frontmatter || {} ).map( ( [ name, value ] ) => [
		name,
		String( value ),
	] );
}

/**
 * Read a number field into the string a frontmatter value is.
 *
 * Empty and non-numeric input both give '', which `commit` drops from the map,
 * so half-typed input unsets the key and the placeholder shows the inherited
 * value again rather than a stray one reaching the file.
 *
 * @param {string} raw   The input's value.
 * @param {number} min   Lower bound; a smaller number is raised to it.
 * @param {number} [max] Upper bound; unbounded above when omitted.
 * @return {string} The clamped integer, or '' to leave the key unset.
 */
function clampInt( raw, min, max ) {
	const trimmed = String( raw ).trim();
	if ( '' === trimmed ) {
		return '';
	}
	const n = parseInt( trimmed, 10 );
	if ( ! Number.isFinite( n ) ) {
		return '';
	}
	const floored = Math.max( min, n );
	return String( undefined === max ? floored : Math.min( max, floored ) );
}

/**
 * Strip what would end the line a frontmatter value is written on.
 *
 * A value is saved as one `var name = value` line, and the Shell ends a
 * statement at a newline or a `;`. Removing both keeps the value on its own
 * line without depending on the dumper's quoting to put it back together.
 *
 * @param {string} v The raw input value.
 * @return {string} The value with CR, LF and `;` removed.
 */
function sanitizeValue( v ) {
	return String( v ).replace( /[\r\n;]/g, '' );
}

/**
 * Where the panel mounts: the devtools hub's root, else the document body.
 *
 * Rendered in place it would stack inside the canvas frame's context, which no
 * z-index lifts over the header and tab bar the panel drops from. The body
 * fallback is outside the console's theme provider as well, which is why the
 * panel carries the skin classes itself there.
 *
 * @return {?Element} The mount point, or null where there is no document.
 */
function getPortalTarget() {
	if ( typeof document === 'undefined' ) {
		return null;
	}
	return document.querySelector( '.nodes-devtools-hub' ) || document.body;
}

/**
 * The panel itself, portaled clear of the canvas so it stacks over the header
 * it drops from. Frontmatter is seeded once per mount and every edit
 * dispatches the whole map, so a caller keys the element by the topology being
 * edited — reusing one element across two topologies would leave the first
 * one's vars on screen.
 *
 * @param {Object}     props                           Component props.
 * @param {number}     [props.configDefaultPartitions] Partition count the config falls back to when `num_partitions` is unset; shown as the input's placeholder. Default 1.
 * @param {number}     [props.configStaleTimeout]      Seconds the substrate falls back to when `stale_timeout` is unset. Default 60.
 * @param {number}     [props.configOnDemandIdle]      Idle window the config falls back to when `on_demand_idle` is unset; 0 keeps the workers resident. Default 0.
 * @param {() => void} props.onClose                   Dismiss the panel; the × button, ESC and a click outside all fire it.
 * @return {import('react').ReactElement} The panel, portaled when a target exists.
 */
export default function TopologySettingsPanel( {
	configDefaultPartitions = 1,
	configStaleTimeout = 60,
	configOnDemandIdle = 0,
	onClose,
} ) {
	const { graph: draft, run, replaceFrontmatter, clearSecure } = useDraft();
	const frontmatter = draft.frontmatter || {};
	const secureLevel = draft.secureLevel || '';
	// Seeded once per mount (the panel mounts on open, keyed by editing name).
	const [ entries, setEntries ] = useState( () => toEntries( frontmatter ) );
	const [ newName, setNewName ] = useState( '' );
	const [ newValue, setNewValue ] = useState( '' );
	const [ addError, setAddError ] = useState( '' );

	// ESC and a click outside, as every other dialog in the console closes.
	const panelRef = useRef( null );
	useDismissable( panelRef, onClose );

	/**
	 * One key's current value.
	 *
	 * @param {string} key Frontmatter name.
	 * @return {string} Its value, or '' when the map carries no such key.
	 */
	const valueOf = ( key ) => {
		const hit = entries.find( ( [ n ] ) => n === key );
		return hit ? hit[ 1 ] : '';
	};

	/**
	 * Adopt an entry list and dispatch it as the whole frontmatter map.
	 *
	 * An empty value is dropped rather than written: absence is how a key says
	 * "inherit the config default", and it is what the placeholder shows.
	 *
	 * @param {Array<[string,string]>} next The entry list to adopt.
	 */
	const commit = ( next ) => {
		setEntries( next );
		const map = {};
		for ( const [ n, v ] of next ) {
			const tv = String( v ).trim();
			if ( '' !== tv ) {
				map[ n ] = tv;
			}
		}
		replaceFrontmatter( map );
	};

	/**
	 * Declare, or undeclare, the topology's secure level.
	 *
	 * "Undeclared" has no TSL spelling — a bare `secure` climbs one level and
	 * `insecure` declares a third state — so clearing goes through the draft's
	 * `clearSecure` instead of running the verb with an empty level.
	 *
	 * @param {string} level '', `insecure`, `secure`, or a numeric level.
	 */
	const setSecure = ( level ) => {
		if ( '' === level ) {
			clearSecure();
			return;
		}
		run(
			'insecure' === level || 'secure' === level
				? level
				: `secure ${ level }`
		);
	};

	/**
	 * Set one key, recognized or generic, leaving its row where it is.
	 *
	 * An empty value for a key the map does not carry is a no-op: appending it
	 * only for `commit` to filter it back out would dispatch a map that never
	 * changed.
	 *
	 * @param {string} key   Frontmatter name.
	 * @param {string} value Its new value; '' removes a key that exists.
	 */
	const setValue = ( key, value ) => {
		const existed = entries.some( ( [ n ] ) => n === key );
		if ( '' === value && ! existed ) {
			return;
		}
		commit(
			existed
				? entries.map( ( e ) =>
						e[ 0 ] === key ? [ key, value ] : e
				  )
				: [ ...entries, [ key, value ] ]
		);
	};

	/**
	 * Drop one generic var, from its row's × button.
	 *
	 * @param {string} key Frontmatter name.
	 */
	const removeKey = ( key ) =>
		commit( entries.filter( ( [ n ] ) => n !== key ) );

	/**
	 * Add the pending name/value pair as a new generic var.
	 *
	 * Refuses a name the file would not read back, a name already in use — the
	 * recognized keys included, since those have inputs of their own — and an
	 * empty value, which `commit` would drop to no key at all. The refusal
	 * lands in `addError` under the row.
	 */
	const addVar = () => {
		const name = newName.trim();
		if ( ! NAME_RE.test( name ) ) {
			setAddError(
				__(
					'Name must start with a letter or underscore and use only letters, numbers, and underscores.',
					'newspack-nodes'
				)
			);
			return;
		}
		const taken =
			RECOGNIZED_KEYS.includes( name ) ||
			entries.some( ( [ n ] ) => n === name );
		if ( taken ) {
			setAddError(
				sprintf(
					// translators: %s: variable name.
					__( '"%s" is already in use.', 'newspack-nodes' ),
					name
				)
			);
			return;
		}
		if ( '' === newValue.trim() ) {
			setAddError( __( 'Value cannot be empty.', 'newspack-nodes' ) );
			return;
		}
		commit( [ ...entries, [ name, sanitizeValue( newValue ) ] ] );
		setNewName( '' );
		setNewValue( '' );
		setAddError( '' );
	};

	/** The vars with no input of their own, one name/value row each. */
	const genericRows = entries.filter(
		( [ n ] ) => ! RECOGNIZED_KEYS.includes( n )
	);
	const target = getPortalTarget();
	/**
	 * Whether the panel landed on the body, outside the console's theme
	 * provider: there it carries the skin classes itself, and inside the hub it
	 * must not repeat what an ancestor already applies.
	 */
	const isBodyPortal =
		typeof document !== 'undefined' && target === document.body;

	const panel = (
		<div
			ref={ panelRef }
			className={ `newspack-nodes-card newspack-nodes-card--elevated topology-settings-panel${
				isBodyPortal
					? ' newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
					: ''
			}` }
			role="dialog"
			aria-label={ __( 'Topology settings', 'newspack-nodes' ) }
		>
			<div className="topology-settings-panel__head">
				<span>{ __( 'Topology settings', 'newspack-nodes' ) }</span>
				<button
					type="button"
					className="button is-plain topology-settings-panel__close"
					onClick={ onClose }
					aria-label={ __( 'Close', 'newspack-nodes' ) }
				>
					×
				</button>
			</div>

			<label
				className="topology-settings-field"
				htmlFor="ts-num-partitions"
			>
				<span>{ __( 'Partitions', 'newspack-nodes' ) }</span>
				<input
					id="ts-num-partitions"
					type="number"
					min={ 1 }
					max={ MAX_PARTITIONS }
					value={ valueOf( 'num_partitions' ) }
					placeholder={ String( configDefaultPartitions ) }
					onChange={ ( e ) =>
						setValue(
							'num_partitions',
							clampInt( e.target.value, 1, MAX_PARTITIONS )
						)
					}
				/>
				<small>
					{ sprintf(
						// translators: %d: configured default partition count.
						__(
							'Empty = config default (%d). Max 16.',
							'newspack-nodes'
						),
						configDefaultPartitions
					) }
				</small>
			</label>

			<label
				className="topology-settings-field"
				htmlFor="ts-stale-timeout"
			>
				<span>{ __( 'Stale timeout (s)', 'newspack-nodes' ) }</span>
				<input
					id="ts-stale-timeout"
					type="number"
					min={ 1 }
					value={ valueOf( 'stale_timeout' ) }
					placeholder={ String( configStaleTimeout ) }
					onChange={ ( e ) =>
						setValue(
							'stale_timeout',
							clampInt( e.target.value, 1 )
						)
					}
				/>
				<small>
					{ sprintf(
						// translators: %d: default stale timeout in seconds.
						__( 'Empty = default (%d).', 'newspack-nodes' ),
						configStaleTimeout
					) }
				</small>
			</label>

			<label
				className="topology-settings-field"
				htmlFor="ts-on-demand-idle"
			>
				<span>{ __( 'Idle window (s)', 'newspack-nodes' ) }</span>
				<input
					id="ts-on-demand-idle"
					type="number"
					min={ 0 }
					value={ valueOf( 'on_demand_idle' ) }
					placeholder={ String( configOnDemandIdle ) }
					onChange={ ( e ) =>
						setValue(
							'on_demand_idle',
							clampInt( e.target.value, 0 )
						)
					}
				/>
				<small>
					{ __(
						'0 = resident. Above 0, the worker exits after that long with every reporter idle, and a write to a partition it tails brings it back.',
						'newspack-nodes'
					) }
				</small>
			</label>

			<label
				className="topology-settings-field"
				htmlFor="ts-secure-level"
			>
				<span>{ __( 'Secure level', 'newspack-nodes' ) }</span>
				<select
					id="ts-secure-level"
					value={ secureLevel }
					onChange={ ( e ) => setSecure( e.target.value ) }
				>
					<option value="">
						{ __( 'Not declared', 'newspack-nodes' ) }
					</option>
					<option value="insecure">
						{ __( 'insecure — no restrictions', 'newspack-nodes' ) }
					</option>
					<option value="secure">
						{ __( 'secure — climb one level', 'newspack-nodes' ) }
					</option>
					<option value="1">
						{ __( '1 — no graph construction', 'newspack-nodes' ) }
					</option>
					<option value="2">
						{ __( '2 — also no reply_to', 'newspack-nodes' ) }
					</option>
					<option value="3">
						{ __( '3 — also no re-wiring', 'newspack-nodes' ) }
					</option>
				</select>
				<small>
					{ __(
						'Written as the last line. Undeclared logs a warning each tick.',
						'newspack-nodes'
					) }
				</small>
			</label>

			<div className="topology-settings-vars">
				<div className="topology-settings-vars__title">
					{ __( 'Other variables', 'newspack-nodes' ) }
				</div>
				{ genericRows.map( ( [ name, value ] ) => (
					<div key={ name } className="topology-settings-var-row">
						<span className="topology-settings-var-row__name">
							{ name }
						</span>
						<input
							type="text"
							value={ value }
							aria-label={ sprintf(
								// translators: %s: variable name.
								__( 'Value for %s', 'newspack-nodes' ),
								name
							) }
							onChange={ ( e ) =>
								setValue(
									name,
									sanitizeValue( e.target.value )
								)
							}
						/>
						<button
							type="button"
							className="button button-small button-link-delete"
							onClick={ () => removeKey( name ) }
							aria-label={ sprintf(
								// translators: %s: variable name.
								__( 'Remove %s', 'newspack-nodes' ),
								name
							) }
						>
							×
						</button>
					</div>
				) ) }
				<div className="topology-settings-var-row topology-settings-var-row--add">
					<input
						type="text"
						value={ newName }
						placeholder={ __( 'name', 'newspack-nodes' ) }
						aria-label={ __(
							'New variable name',
							'newspack-nodes'
						) }
						onChange={ ( e ) => setNewName( e.target.value ) }
					/>
					<input
						type="text"
						value={ newValue }
						placeholder={ __( 'value', 'newspack-nodes' ) }
						aria-label={ __(
							'New variable value',
							'newspack-nodes'
						) }
						onChange={ ( e ) => setNewValue( e.target.value ) }
					/>
					<button
						type="button"
						className="button button-small"
						onClick={ addVar }
					>
						{ __( 'Add', 'newspack-nodes' ) }
					</button>
				</div>
				{ addError && (
					<div className="topology-settings-error" role="alert">
						{ addError }
					</div>
				) }
			</div>
		</div>
	);

	return target ? createPortal( panel, target ) : panel;
}
