/**
 * LogViewerViewNode — the Log Viewer's ring and view model.
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
 * Cut a string to `max` characters, marking a cut with an ellipsis.
 *
 * @param {string} s   The text.
 * @param {number} max The longest it may stay.
 * @return {string} `s`, or its first `max` characters and `...`.
 */
const clip = ( s, max ) =>
	s.length > max ? s.substring( 0, max ) + '...' : s;

/**
 * `log-viewer:view` — owns the Log Viewer's view model.
 *
 * `LogStreamViewNode` holds everything the log-stream dashboards share: the
 * ring, the paused belt and step budget, the decaying lps readout, seek
 * tracking, and the `pause`, `step`, `connection`, `browse`, `follow`,
 * `clear`, `filter` and `select` control verbs. This class adds what belongs
 * to the Log Viewer alone:
 *
 * - `shapeRow()`, which shapes a raw SSE envelope into a row carrying all
 *   seven positional message fields (ADR-2) — a record IS a Message, so the
 *   Cols picker draws a cell per field — plus the debug trio (`msgId`, `key`,
 *   `raw`);
 * - the `select` and `logs` controls, and the `{ logs, selected }` model
 *   fields the toolbar's log dropdown renders from.
 *
 * The node is terminal: it publishes a model and forwards nothing, which is
 * what `has_target: false` in the schema says.
 */
export class LogViewerViewNode extends LogStreamViewNode {
	/**
	 * Seed the two fields this view adds to the base model: the catalog the
	 * log dropdown lists, and the log being tailed. `useLogViewerGraph`
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
	 * Shape a raw SSE log envelope into a Log Viewer row.
	 *
	 * `value` carries the bare payload clipped at MAX_LINE_LENGTH, and
	 * `content` the `KEY: VALUE` line the ingest filter matches on, which
	 * prefixes the clipped payload so the KEY survives whole; `raw` carries
	 * the whole payload Debug mode renders, clipped at the far higher
	 * MAX_RAW_LENGTH. A struct VALUE reaches all three JSON-encoded.
	 *
	 * An empty VALUE returns null: there is no payload to render, and the base
	 * then drops the envelope without moving the seek breadcrumb.
	 *
	 * @param {Array} message The 7-field positional message.
	 * @return {?{type: number, timestamp: number, from: string, to: string, msgId: string, key: string, struct: boolean, raw: string, value: string, content: string}} The row, or null when the VALUE is empty.
	 */
	shapeRow( message ) {
		const value = message[ VALUE ];
		if ( value === '' || value === null || value === undefined ) {
			return null;
		}
		const struct = 'string' !== typeof value;
		const raw = struct ? JSON.stringify( value ) : value;
		const bare = clip( raw, MAX_LINE_LENGTH );
		const key = 'string' === typeof message[ KEY ] ? message[ KEY ] : '';
		return {
			// All seven positional fields; the picker chooses which show.
			type: message[ TYPE ],
			timestamp: message[ TIMESTAMP ],
			from: 'string' === typeof message[ FROM ] ? message[ FROM ] : '',
			to: 'string' === typeof message[ TO ] ? message[ TO ] : '',
			msgId: 'string' === typeof message[ ID ] ? message[ ID ] : '',
			key,
			struct,
			raw: clip( raw, MAX_RAW_LENGTH ),
			value: bare,
			content: '' === key ? bare : `${ key }: ${ bare }`,
		};
	}

	/**
	 * Handle the Log Viewer's own control verbs, deferring every shared
	 * one (`pause`, `step`, `connection`, `browse`, `follow`, `clear`,
	 * `filter`, `select`) to the base.
	 *
	 * `select` records the log now tailed, then takes the base's `select`,
	 * which re-arms breadcrumb tracking, resets the seek tracker and empties
	 * the ring: a fresh log tails live rather than from the browse cursor the
	 * last one left.
	 *
	 * `logs` publishes the catalog and, when nothing is selected yet, adopts
	 * its first AVAILABLE row that names a log, else its first such row,
	 * which is the only way a fresh dashboard reaches a selection.
	 * `useLogViewerGraph` opens the stream only when this adoption is what
	 * produced the selection, so a later catalog cannot yank a reader out of
	 * a replay.
	 *
	 * @param {?{action?: string, log?: string, logs?: Array<{key?: string, label: string, available: boolean}>}} value The control payload; `action` picks the verb.
	 */
	_control( value ) {
		const action = value?.action;
		if ( 'logs' === action ) {
			this.logs = value.logs;
			const keyed = value.logs.filter( ( l ) => l.key );
			if ( ! this.selected && keyed.length > 0 ) {
				this.selected = (
					keyed.find( ( l ) => l.available ) ?? keyed[ 0 ]
				).key;
			}
			return;
		}
		if ( 'select' === action ) {
			this.selected = value.log;
		}
		super._control( value );
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
			description: 'Log Viewer render-model sink (the React view node).',
		};
	}
}
