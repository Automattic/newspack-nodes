import { Node } from '../../runtime/node';
import { TIMESTAMP, VALUE } from '../../runtime/message';

// Config-audit is low-volume; a day's option-name events fit well under this.
const MAX_ENTRIES = 5000;
// Throttle publish (a full-replay burst thrashes React): leading + trailing.
const PUBLISH_THROTTLE_MS = 500;

/**
 * `settingsaudit:view` — the Config Audit timeline model over settings.p0.
 *
 * Each inbound frame is one settings-change event (`Settings_Event_Writer` writes
 * VALUE = `{ option }` plus, for allowlisted options, `old`/`new` value excerpts;
 * the instant is the Message TIMESTAMP). The view appends `{ id, ts, option, old?,
 * new? }` to a bounded list (oldest dropped past `maxEntries`) and publishes a
 * throttled newest-first snapshot via `setState('view', { entries })`. Nothing is
 * deduped — every change is its own event.
 *
 * @param {number} [maxEntries] Ring cap (defaults to MAX_ENTRIES; injectable for tests).
 */
export class SettingsAuditViewNode extends Node {
	/**
	 * Sizes the ring and zeroes the throttle state.
	 *
	 * @param {number} [maxEntries] Ring cap; MAX_ENTRIES when omitted. Tests pass a
	 *                              small value to exercise the oldest-drop path.
	 */
	constructor( maxEntries ) {
		super();
		this.maxEntries = maxEntries || MAX_ENTRIES;
		// Arrival order; snapshot() sorts newest-first on publish.
		this._entries = [];
		this._seq = 0;
		this._lastPublish = 0;
		this._flushTimer = null;
	}

	/**
	 * Append one settings-change event to the ring, then publish (throttled).
	 *
	 * A frame whose VALUE is not an object carrying a non-empty `option` string is
	 * not a settings-change record and is ignored — the counter still advances, so
	 * the overlay's throughput reflects everything that arrived. `old` and `new`
	 * ride only when the writer's allowlist let the value excerpts through, so both
	 * are copied only when present as strings.
	 *
	 * @param {Array} message The 7-field positional message; VALUE is the event
	 *                        record, TIMESTAMP the instant of the change.
	 * @return {void}
	 */
	fill( message ) {
		// Terminal node (no sink): count here for the overlay's throughput.
		this.counter += 1;

		const value = message[ VALUE ];
		if (
			null === value ||
			'object' !== typeof value ||
			'string' !== typeof value.option ||
			'' === value.option
		) {
			return; // not a settings-change record — ignore.
		}

		this._seq += 1;
		const entry = {
			id: this._seq,
			ts: Number( message[ TIMESTAMP ] ) || 0,
			option: value.option,
		};
		if ( 'string' === typeof value.old ) {
			entry.old = value.old;
		}
		if ( 'string' === typeof value.new ) {
			entry.new = value.new;
		}
		this._entries.push( entry );
		if ( this._entries.length > this.maxEntries ) {
			this._entries.shift();
		}
		this._maybePublish();
	}

	/**
	 * Publish now, or arm a trailing flush when inside the throttle window.
	 *
	 * Leading-edge throttle plus a single trailing timer, so a full-replay burst
	 * publishes once at its start and once more when it settles — the newest entry
	 * always lands without a setState per frame.
	 *
	 * @return {void}
	 */
	_maybePublish() {
		const now = Date.now();
		if ( now - this._lastPublish < PUBLISH_THROTTLE_MS ) {
			if ( null === this._flushTimer ) {
				const wait = PUBLISH_THROTTLE_MS - ( now - this._lastPublish );
				this._flushTimer = setTimeout(
					() => this._publishNow(),
					Math.max( 0, wait )
				);
			}
			return;
		}
		this._publishNow();
	}

	/**
	 * Publish the snapshot immediately and reset the throttle window.
	 *
	 * Cancels any armed trailing flush first, so an entry that arrives just before
	 * a leading-edge publish does not trigger a redundant second one.
	 *
	 * @return {void}
	 */
	_publishNow() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		this._lastPublish = Date.now();
		this.setState( 'view', { entries: this.snapshot() } );
	}

	/**
	 * The published timeline: a newest-first copy of the ring.
	 *
	 * Sorted by timestamp descending, with the arrival sequence (`id`) descending as
	 * the tiebreak, so changes sharing one second still read in the order they
	 * happened. A fresh array every time — React must not see the live ring mutate.
	 *
	 * @return {Array<Object>} Entries shaped `{ id, ts, option, old?, new? }`.
	 */
	snapshot() {
		return this._entries
			.slice()
			.sort( ( a, b ) => b.ts - a.ts || b.id - a.id );
	}

	/**
	 * Tear down, cancelling any armed trailing flush.
	 *
	 * Without the cancel, a pending timer would fire `setState` on a node the graph
	 * has already dropped.
	 *
	 * @return {void}
	 */
	removeNode() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		super.removeNode();
	}

	/**
	 * Hidden from the node palette: the dashboard wires this sink itself, and it
	 * takes no arguments and no target.
	 *
	 * @return {Object} The `node_schema()` descriptor the console and `help` read.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Config Audit render-model sink (option-name timeline).',
			// Terminal receiver: no target → no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
