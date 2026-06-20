import {
	Node,
	TIMESTAMP,
	TYPE,
	VALUE,
	TM_ERROR,
} from '@newspack-nodes/runtime';

/**
 * `aggregator:view` — owns the Aggregator Status view model.
 *
 * Post-migration to substrate-canonical wiring, `fill()` receives the raw
 * reply Message that HttpOutNode feeds back from POST /command: the router peels
 * the reply's TO (=`aggregator:view`, stamped from the outbound FROM by the
 * server's reply pivot) and delivers it here. VALUE is the `{ name, payload }`
 * envelope; `payload` is the raw `{ server_id: {} }` snapshot the aggregator
 * verb produced, and TIMESTAMP is the hub's serve clock — the "ago" reference
 * the dashboard renders against. TM_ERROR on TYPE surfaces an error and clears
 * loading; the prior `servers` are preserved (mirrors the old fetchStatus catch).
 *
 * The map→array + connected-count derivation migrated verbatim from
 * AggregatorStatus's render. Every change publishes via `setState('view', model)`,
 * consumed by `useNodeState('aggregator:view','view')`.
 */
export class AggregatorViewNode extends Node {
	constructor() {
		super();
		this.model = {
			servers: null,
			serverNow: null,
			connectedCount: 0,
			totalCount: 0,
			error: null,
			loading: true,
			lastRefresh: null,
		};
		this._publish();
	}

	fill( message ) {
		const type = message[ TYPE ] || 0;
		const value = message[ VALUE ];
		// TM_ERROR reply — surface the error string and clear loading.
		if ( type & TM_ERROR ) {
			const payload =
				value && typeof value === 'object' ? value.payload : value;
			this._applyError(
				typeof payload === 'string' && payload.length > 0
					? payload
					: 'Failed to fetch status'
			);
			this._publish();
			return;
		}
		// Need a structured envelope to do anything useful.
		if ( ! value || typeof value !== 'object' ) {
			return;
		}
		// Unwrap `{ name, payload }` (the substrate command-reply shape).
		const status = value.payload ?? {};
		if ( ! status || typeof status !== 'object' ) {
			return;
		}
		this._applyStatus( status, message[ TIMESTAMP ] ?? null );
		this._publish();
	}

	// Store the error + clear loading; keep prior servers (old catch behavior).
	_applyError( error ) {
		this.model = {
			...this.model,
			error,
			loading: false,
		};
	}

	_publish() {
		this.setState( 'view', this.model );
	}

	// Turn the raw status map into the render model (matches the old fetchStatus
	// success path + the render-time connected-count computation).
	_applyStatus( status, now ) {
		const servers = Object.values( status );
		const connectedCount = servers.filter( ( s ) => {
			const partitions = s.partitions || {};
			return Object.values( partitions ).some(
				( p ) => p?.last_connection_status === 'connected'
			);
		} ).length;
		this.model = {
			...this.model,
			servers,
			serverNow: now,
			connectedCount,
			totalCount: servers.length,
			error: null,
			loading: false,
			lastRefresh: Date.now(),
		};
	}
	// Consume-and-publish view-model terminal: fill() mutates state + publishes
	// via setState, never forwards — no output port.
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Owns the Aggregator Status view model.',
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
