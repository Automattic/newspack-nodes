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
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;

	constructor( maxEntries ) {
		super();
		this.maxEntries = maxEntries || MAX_ENTRIES;
		// Arrival order; snapshot() sorts newest-first on publish.
		this._entries = [];
		this._seq = 0;
		this._lastPublish = 0;
		this._flushTimer = null;
	}

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

	// Newest-first fresh copy: sort ts desc, arrival-seq (id) desc as tiebreak.
	snapshot() {
		return this._entries
			.slice()
			.sort( ( a, b ) => b.ts - a.ts || b.id - a.id );
	}

	// Leading-edge throttle + trailing flush so a burst's newest entry lands.
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

	_publishNow() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		this._lastPublish = Date.now();
		this.setState( 'view', { entries: this.snapshot() } );
	}

	// Cancel a pending trailing flush so no setState fires after teardown.
	removeNode() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		super.removeNode();
	}

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
