/**
 * PartitionViewerViewNode — the Partition Viewer's ring and view model.
 * `LogViewerViewNode` extends it, so an edit here reaches both dashboards.
 */

import {
	FROM,
	KEY,
	VALUE,
	ID,
	TYPE,
	TIMESTAMP,
	TO,
} from '../../runtime/message';
import { LogStreamViewNode } from '../../shared/nodes/log-stream-view-node';

/**
 * Longest `content` and `value` a row keeps, past which both are clipped with
 * an ellipsis. A table cell shows one line, so the rest would never be read
 * there; Debug mode renders `raw` instead and clips far later.
 */
const MAX_LINE_LENGTH = 1000;

/**
 * Longest `raw` a row keeps — the payload Debug mode renders. Well past
 * PIPE_BUF on purpose: a non-lifted partition caps a record at 4096 bytes
 * (ADR-4), so this clips only large-write records, the ones Debug mode is the
 * only way to read. The ring holds `raw` per row, which makes this a per-row
 * ceiling on that memory rather than a typical size.
 */
const MAX_RAW_LENGTH = 262144;

/**
 * The `.pN` suffix a FROM path segment carries when it names a partition
 * directory; capture group 1 is the partition number.
 */
const PARTITION_RE = /\.p(\d+)$/;

/**
 * `partition:view` — owns the Partition Viewer's view model.
 *
 * `LogStreamViewNode` holds everything the log-stream dashboards share: the
 * ring, the paused belt and step budget, the decaying lps readout, seek
 * tracking, and the `pause`, `step`, `connection`, `browse`, `follow`,
 * `clear`, `filter` and `select` control verbs. This class adds what belongs
 * to the Partition Viewer alone:
 *
 * - `shapeRow()`, which shapes a raw SSE envelope into a row carrying all
 *   seven positional message fields (ADR-2) — a record IS a Message, so the
 *   Cols picker draws a cell per field — plus the debug trio (`msgId`, `key`,
 *   `raw`) and a partition column;
 * - the `select` and `logs` controls, and the `{ logs, selected }` model
 *   fields the toolbar's log dropdown renders from.
 *
 * The node is terminal: it publishes a model and forwards nothing, which is
 * what `has_target: false` in the schema says.
 */
export class PartitionViewerViewNode extends LogStreamViewNode {
	/**
	 * The column each source directory was assigned, for streams whose FROM
	 * names no partition. Built on first miss and never cleared, so a
	 * directory keeps its column for the life of the node.
	 *
	 * @type {Map<string,number>|undefined}
	 */
	_partitionIndex;

	/**
	 * Seed the two fields this view adds to the base model: the catalog the
	 * log dropdown lists, and the log being tailed. `usePartitionViewerGraph`
	 * reads `selected` off the node to tell whether an arriving catalog just
	 * produced the first selection, and opens a stream only then.
	 *
	 * @param {number} [maxLines] Ring cap; the base's default when omitted,
	 *                            and what a test shrinks to force eviction.
	 */
	constructor( maxLines ) {
		super( maxLines );
		this.logs = [];
		this.selected = '';
	}

	/**
	 * Shape a raw SSE log envelope into a Partition Viewer row.
	 *
	 * `content` carries the `KEY: VALUE` line the ingest filter matches on and
	 * `value` the bare payload, both clipped at MAX_LINE_LENGTH; `raw` carries
	 * the whole payload Debug mode renders, clipped at the far higher
	 * MAX_RAW_LENGTH. A struct VALUE reaches all three JSON-encoded.
	 *
	 * An empty VALUE returns null: there is no payload to render, and the base
	 * then drops the envelope without moving the seek breadcrumb.
	 *
	 * @param {Array} message The 7-field positional message.
	 * @return {?{partition: number, type: number, timestamp: number, from: string, to: string, msgId: string, key: string, struct: boolean, raw: string, value: string, content: string}} The row, or null when the VALUE is empty.
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
			// All seven positional fields; the picker chooses which show.
			type: message[ TYPE ],
			timestamp: message[ TIMESTAMP ],
			from: 'string' === typeof message[ FROM ] ? message[ FROM ] : '',
			to: 'string' === typeof message[ TO ] ? message[ TO ] : '',
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
	 * The first FROM segment carrying a `.pN` suffix wins, so a bare
	 * `firehose.p3` stamp and a grouped `offsets/combined.firehose.p3/reader`
	 * one land in the same column. A FROM naming no partition falls back to a
	 * first-seen index per source directory — its first two path segments — so
	 * two unrelated directories never collapse into one column.
	 *
	 * @param {Array} message The 7-field positional message.
	 * @return {number} The column index, which a debug row stamps as `data-p`.
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
	 * Handle the Partition Viewer's own control verbs, deferring every shared
	 * one (`pause`, `step`, `connection`, `browse`, `follow`, `clear`,
	 * `filter`) to the base.
	 *
	 * `select` records the log now tailed, resets the seek tracker and empties
	 * the ring: rows read under the previous subscription do not belong to the
	 * new one, and a fresh log tails live rather than from the browse cursor
	 * the last one left.
	 *
	 * `logs` publishes the catalog and adopts its first entry when nothing is
	 * selected yet, which is the only way a fresh dashboard reaches a
	 * selection. `usePartitionViewerGraph` opens the stream only when this
	 * adoption is what produced the selection, so a later catalog cannot yank
	 * a reader out of a replay.
	 *
	 * @param {?{action?: string, log?: string, logs?: Array<{key: string}>}} value The control payload; `action` picks the verb.
	 */
	_control( value ) {
		const action = value?.action;
		if ( 'select' === action ) {
			this.selected = value.log;
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
	 * Node metadata behind `help <Type>` and the console's node palette. Keeps
	 * the base's Hidden category, absent target and empty argument list, and
	 * overrides the description alone — otherwise the palette would label this
	 * node the generic log-stream sink.
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
