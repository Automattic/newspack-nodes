import { FROM, KEY, VALUE, ID } from '../../runtime/message';
import { LogStreamViewNode } from '../../shared/nodes/log-stream-view-node';

const MAX_LINE_LENGTH = 1000;
// Debug-mode raw retention per row (pretty-printable); ~PIPE_BUF x2.
const MAX_RAW_LENGTH = 8192;
const PARTITION_RE = /\.p(\d+)$/;

/**
 * `partition:view` — owns the Partition Viewer view model.
 *
 * A `LogStreamViewNode` subclass: the ring, paused belt + step budget,
 * decaying lps, seek tracking, and the shared control verbs
 * (`pause`/`step`/`connection`/`browse`/`follow`/`clear`) all live in the
 * shared base. This class adds the Partition Viewer's specifics:
 * - the `select` (set + clear) and `logs` (catalog) controls, and the
 *   `{ logs, selected }` view-model fields they publish;
 * - `shapeRow()`: shapes a raw SSE log envelope into a row — `KEY: VALUE`
 *   line clipped at MAX_LINE_LENGTH, the debug trio (`msgId`, `key`, `raw`
 *   clipped at MAX_RAW_LENGTH, `struct`), and the partition column derived
 *   from the first FROM segment with a `.pN` suffix (else a stable
 *   first-seen dir index).
 */
export class PartitionViewerViewNode extends LogStreamViewNode {
	/**
	 * Source directory → column, for streams whose FROM names no partition.
	 * Built on first miss and never cleared, so a directory keeps its column
	 * for the life of the node.
	 *
	 * @type {Map<string, number>|undefined}
	 */
	_partitionIndex;

	/**
	 * @param {number} [maxLines] Buffer cap (base default; injectable for tests).
	 */
	constructor( maxLines ) {
		super( maxLines );
		this.logs = [];
		this.selected = '';
	}

	/**
	 * Shape a raw SSE log envelope into a Partition Viewer row.
	 *
	 * `content` keeps the `KEY: VALUE` prefix the filter matches on, `value`
	 * is the bare column, and `raw` is the debug-mode payload (a struct VALUE
	 * arrives JSON-encoded). All three are clipped.
	 *
	 * @param {Array} message The 7-field positional message.
	 * @return {?{partition: number, msgId: string, key: string, struct: boolean, raw: string, value: string, content: string}} The row, or null when the VALUE is empty.
	 */
	shapeRow( message ) {
		const value = message[ VALUE ];
		if ( value === '' || value === null || value === undefined ) {
			return null;
		}
		const struct = 'string' !== typeof value;
		let raw = struct ? JSON.stringify( value ) : value;
		// Bare VALUE column; `content` keeps the KEY prefix for the filter.
		let bare = raw;
		let line = raw;
		const key = message[ KEY ];
		if ( 'string' === typeof key && '' !== key ) {
			line = `${ key }: ${ line }`;
		}
		if ( line.length > MAX_LINE_LENGTH ) {
			line = line.substring( 0, MAX_LINE_LENGTH ) + '...';
		}
		if ( bare.length > MAX_LINE_LENGTH ) {
			bare = bare.substring( 0, MAX_LINE_LENGTH ) + '...';
		}
		if ( raw.length > MAX_RAW_LENGTH ) {
			raw = raw.substring( 0, MAX_RAW_LENGTH ) + '...';
		}
		return {
			partition: this._partitionFor( message ),
			msgId: 'string' === typeof message[ ID ] ? message[ ID ] : '',
			key: 'string' === typeof key ? key : '',
			struct,
			raw,
			value: bare,
			content: line,
		};
	}

	/**
	 * Resolve the partition column one envelope belongs in.
	 *
	 * The first FROM segment carrying a `.pN` suffix wins. A FROM that names
	 * no partition falls back to a first-seen index per source directory, so
	 * two unrelated dirs never collapse into one column.
	 *
	 * @param {Array} message The 7-field positional message.
	 * @return {number} The column index.
	 */
	_partitionFor( message ) {
		const parts = String( message[ FROM ] || '' ).split( '/' );
		const column = parts.find( ( part ) => PARTITION_RE.test( part ) );
		if ( column ) {
			return parseInt( column.match( PARTITION_RE )[ 1 ], 10 );
		}
		const dir = parts.slice( 0, 2 ).join( '/' );
		const index = ( this._partitionIndex ??= new Map() );
		if ( ! index.has( dir ) ) {
			index.set( dir, index.size );
		}
		return index.get( dir );
	}

	/**
	 * Handle the Partition Viewer's own control verbs, deferring the shared
	 * ones (`pause`/`step`/`connection`/`browse`/`follow`/`clear`) to the base.
	 *
	 * `select` switches the tailed log; `logs` publishes the catalog and
	 * adopts its first entry when nothing is selected yet.
	 *
	 * @param {{action: string, log?: string, logs?: Array<{key: string}>}} value The control payload.
	 */
	_control( value ) {
		const action = value?.action;
		if ( 'select' === action ) {
			this.selected = value.log;
			// A fresh log tails live from a clean slate — drop browse cursor.
			this.seek.select();
			this._clear();
		} else if ( 'logs' === action ) {
			this.logs = value.logs;
			if ( ! this.selected && value.logs.length > 0 ) {
				this.selected = value.logs[ 0 ].key;
			}
		} else {
			super._control( value );
		}
	}

	/**
	 * The published low-frequency model: the shared fields plus the log
	 * catalog and the selected log the picker renders from.
	 *
	 * @return {Object} The render model.
	 */
	viewModel() {
		return {
			...super.viewModel(),
			logs: this.logs,
			selected: this.selected,
		};
	}

	/**
	 * Schema behind the console palette and `help` — the base's, redescribed
	 * for this dashboard.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			...super.nodeSchema(),
			description:
				'Partition Viewer render-model sink (the React view node).',
		};
	}
}
