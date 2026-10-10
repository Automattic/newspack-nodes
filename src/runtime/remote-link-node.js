/**
 * RemoteLinkNode — the full-duplex "be the browser" SSE+HTTP channel as one
 * node. The backbone makes ONE RemoteLink per page, `_stream`, where every
 * stream graph would otherwise wire three nodes and the bridge between them:
 *
 * - `<name>:sse-in` is this link's own SseIn child, the inbound EventSource
 *   stream. It is named so `trace` reaches it, and patron-owned so the canvas
 *   skips it.
 * - `_http` is the process-wide HttpOut singleton, the outbound `/command` POST
 *   boundary. This link configures it, and never aliases one per link.
 * - `_heartbeat` is the process-wide Heartbeat singleton, which keeps the
 *   stream's slot lease alive. This link's connection lifecycle arms and stops
 *   it.
 *
 * The last two are shared backbone rather than per-link children: a second
 * RemoteLink configures those same two nodes.
 *
 * The bridge is the fourth piece. The SseIn's `connected` handshake carries the
 * exact slot and lease owner the Heartbeat must keep alive, and
 * `ensureChildren()` registers the handlers that carry one to the other.
 * RemoteIpc extends this class with the worker-relay send and the
 * single-connection steal.
 *
 * A page's shared link carries every stream graph on the page: each
 * `attach()`es its subscription under the node its records go to, and the link
 * routes each record by the stamp its FROM opens with to every graph carrying
 * it, as Tachikoma's ConsumerBroker holds one connection for its Consumers. A
 * graph pausing `park()`s and keeps its place; one unmounting `detach()`es and
 * forgets it. Every change in one tick joins one reconnect.
 *
 * Mirrors the PHP `Remote_Source_Node`, a patron owning an `SSE_In_Node` and an
 * `HTTP_Out_Node`. The durable offsetlog that distinguishes aggregation is a
 * PHP-only concern of its readers — the browser has no durable cursor, so JS
 * ships RemoteLink and RemoteIpc alone.
 */

import { Core } from './core';
import { Node, targetsOf } from './node';
import { ReactBridge } from './react-bridge';
import { SchemaReflection } from './schema-reflection';
import { SseInNode } from './sse-in-node';
import { defaultTransport } from './command-transport';
import { anyCarries, isGlob } from './log-stamp';
import names from './reserved-node-names.json';

/**
 * A resume seed: the next-record `{segment, offset}` for each partition
 * directory the stream has delivered, keyed as SseIn tracks it.
 * Passed back to the server as the `positions=` seek so a reopened stream
 * neither gaps nor replays.
 *
 * @typedef {Object<string,{segment:number,offset:number}>} ResumePositions
 */

/**
 * What a CALLER may seed instead: the same per-dir map, but a value may also be
 * a SEEK sentinel (`SEEK_START` 0 / `SEEK_END` -1) or one of the reader's alias
 * words. Wider than ResumePositions, which only ever holds real positions.
 *
 * @typedef {Object<string,{segment:number,offset:number}|number|string>} SeekSeed
 */

/**
 * One graph riding a shared link, kept under the node its records go to.
 *
 * @typedef {Object} Graph
 * @property {string[]}              subscribe What it streams.
 * @property {boolean}               parked    Whether `park()` paused it.
 * @property {(?SeekSeed|undefined)} seek      The seek the next reopen states.
 */

/**
 * The composed SSE+HTTP channel: one node standing in for an SseIn stream, the
 * shared HttpOut command boundary, and the Heartbeat that keeps the stream's
 * slot lease alive.
 *
 * `subscribe`, the sole positional argument, names what the stream carries.
 * Nothing opens at construction: the first `connect()`, `connectNode()` or
 * `send()` builds the children, and each of those refuses while no
 * subscription has been supplied. Records arrive on the link's own `sink` and
 * `target`, so a consumer wires a RemoteLink exactly as it wires any other
 * source node. A link carrying graphs instead takes its subscription from
 * them: `attach()`, `park()` and `detach()` reopen it on theirs.
 */
export class RemoteLinkNode extends ReactBridge( SchemaReflection( Node ) ) {
	/**
	 * Start unconfigured and childless: `ensureChildren()` builds the stream on
	 * the first call that needs one, and `_assertConfigured()` refuses every
	 * such call until `arguments` has supplied a subscription.
	 */
	constructor() {
		super();
		/**
		 * Transport the shared HttpOut posts through. Left null,
		 * `ensureChildren()` installs `defaultTransport()`.
		 *
		 * @type {?import('./command-transport').CommandTransport}
		 */
		this.client = null;
		/**
		 * This link's own inbound stream, built on first use.
		 *
		 * @type {?SseInNode}
		 */
		this.sseIn = null;
		/**
		 * The shared `_heartbeat`, held from `ensureChildren()` so `close()`
		 * can drop this link's lease without a registry lookup. Backbone, so
		 * this link never tears it down.
		 */
		this.heartbeat = null;
		/** Comma-separated subscription list; empty until `arguments` sets it. */
		this.subscribe = '';
		/**
		 * Optional hook fired with the SseIn's `connected` payload, once the
		 * slot lease has reached the Heartbeat.
		 *
		 * @type {?( ( payload: string ) => void )}
		 */
		this.onConnected = null;
		/**
		 * Optional hook fired at the end of `close()`, so the owner can reset
		 * whatever it keeps tied to the stream that just went away.
		 *
		 * @type {?( () => void )}
		 */
		this.onClose = null;
		/**
		 * Graphs on this link, by the node each one's records go to: what it
		 * streams, whether `park()` has paused it, and the seek the next
		 * reopen states for it (none when undefined, a tail when null). Empty
		 * for a single-target link.
		 *
		 * @type {Map<string,Graph>}
		 */
		this.graphs = new Map();
		// One reopen per tick: later attaches and detaches join a queued one.
		this._restartQueued = false;
		// A place was forgotten, so the next reopen may not skip.
		this._forgot = false;
		// Republished from the SseIn; see ensureChildren().
		this.registrations.UNPARSEABLE_LINES = {};
		/**
		 * Each graph's share of the lines its SseIn skipped, by target: the
		 * sum of the stamps the graph carries.
		 *
		 * @type {Object<string,number>}
		 */
		this.unparseableByTarget = {};
	}

	/**
	 * @return {string[]} The argument tokens last assigned.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Clear the subscription, then let `SchemaReflection` walk the tokens onto
	 * the one declared argument, `subscribe`. The reset first means a
	 * re-assignment cannot inherit the previous subscription.
	 *
	 * @param {string[]} value Positional tokens; the first is the comma-separated subscription list.
	 */
	set arguments( value ) {
		this.subscribe = '';
		super.arguments = value;
	}

	/**
	 * Send out through the ONE `_http` boundary — every browser graph has
	 * exactly one, and that shared buffer is what lets a tick's commands batch
	 * into a single POST regardless of which TO each of them carries. A graph
	 * mid-rebuild has no `_http`, so the message is dropped as `no sink`
	 * rather than vanishing — Tachikoma's word for a node with nowhere to
	 * forward to, where `NOT_AVAILABLE` is the Router's for an address that
	 * resolves to nothing.
	 *
	 * @param {Array} message Positional Message to post.
	 */
	send( message ) {
		this.ensureChildren();
		const h = Core.node( names.HTTP );
		if ( ! h ) {
			this.dropMessage( message, 'no sink' );
			return;
		}
		h.fill( message );
	}

	/**
	 * Tear down OUR SseIn. `close()` runs first because `removeNode()` alone
	 * would leave the EventSource open, and the shared `_http` / `_heartbeat`
	 * backbone is left for the graph to tear down.
	 */
	removeNode() {
		this.graphs.clear();
		this.close();
		// removeNode clears the child's registrations; unregistering is moot.
		this.sseIn?.removeNode();
		this.sseIn = null;
		this.heartbeat = null;
		super.removeNode();
	}

	/**
	 * `connect_node` is a source link's start lifecycle on the canvas: wiring
	 * the output edge also points the stream at it and opens the stream.
	 *
	 * @param {string} target Node path each received record is routed to.
	 */
	connectNode( target ) {
		this._assertConfigured();
		super.connectNode( target );
		if ( this.sseIn ) {
			this.sseIn.target = target;
		}
		if ( ! this.sseIn?.isOpenOrReopening() ) {
			this.connect();
		}
	}

	/**
	 * Open the inbound stream, building the children on first use. It
	 * resumes where it read to, or opens at the tail.
	 */
	connect() {
		this.ensureChildren();
		this.sseIn.start();
	}

	/**
	 * Ride this link: carry `subscribe` and deliver each record whose stamp it
	 * carries to `target`. A second attach for the same target replaces the
	 * first. The stream reopens once this tick's attaches and detaches are all
	 * in, and not at all when they change nothing.
	 *
	 * @param {string[]}   subscribe What it streams.
	 * @param {string}     target    The node its records go to, which names
	 *                               the graph riding.
	 * @param {?SeekSeed=} positions Omitted, its dirs resume where they read
	 *                               to; null tails them; a seed seeks them.
	 * @throws {Error} When `positions` seeks or tails a stamp another graph
	 *                 streams.
	 */
	attach( subscribe, target, positions ) {
		if ( undefined !== positions ) {
			this._assertSeekable(
				target,
				positions ? Object.keys( positions ) : this._tailed( subscribe )
			);
		}
		const was = this.graphs.get( target );
		const same = was?.subscribe.join( ',' ) === subscribe.join( ',' );
		this.graphs.set( target, {
			subscribe,
			parked: false,
			seek: undefined === positions && same ? was.seek : positions,
		} );
		if ( was && ! same ) {
			this._forget( was.subscribe );
		}
		this._queueRestart();
	}

	/**
	 * Stop carrying `target`'s graph for good, as an unmount does. Its seek,
	 * seeds, read positions and skipped-line counts go with it, save those of
	 * a dir another graph carries, so a later graph on its stamps tails.
	 *
	 * @param {string} target The graph leaving, named as it attached.
	 */
	detach( target ) {
		const graph = this.graphs.get( target );
		if ( graph ) {
			this.graphs.delete( target );
			this._forget( graph.subscribe );
			this._queueRestart();
		}
	}

	/**
	 * Stop carrying `target`'s graph for now, as a pause does. A seek not yet
	 * asked for goes; its seeds and read positions stay, so the `attach()`
	 * that plays it resumes where it stopped, or past it where a live graph
	 * read on. A seed the server answered is spent already: the handshake's
	 * cursor outranks it, while a stream refused before then still replays.
	 *
	 * @param {string} target The graph pausing, named as it attached.
	 */
	park( target ) {
		const graph = this.graphs.get( target );
		if ( graph ) {
			graph.parked = true;
			graph.seek = undefined;
			this._queueRestart();
		}
	}

	/**
	 * Forget what `subscribe` alone holds. When that moves a place of a dir
	 * the open stream carries, the next reopen must happen even on the same
	 * set, or a replay one graph asked for runs on into another.
	 *
	 * @param {string[]} subscribe The subscriptions being let go.
	 */
	_forget( subscribe ) {
		const drop = this._orphaned( subscribe );
		const open = this.subscribe.split( ',' );
		if (
			this.sseIn
				?.places()
				.some( ( dir ) => drop( dir ) && anyCarries( open, dir ) )
		) {
			this._forgot = true;
		}
		this.sseIn?.forget( drop );
	}

	/**
	 * Which dirs `subscribe` alone holds: those it carries and no graph on
	 * the link does, live or parked.
	 *
	 * @param {string[]} subscribe The subscriptions being let go.
	 * @return {( dir: string ) => boolean} Whether a dir is held by nothing else.
	 */
	_orphaned( subscribe ) {
		const others = [ ...this.graphs.values() ].map(
			( graph ) => graph.subscribe
		);
		return ( dir ) =>
			anyCarries( subscribe, dir ) &&
			! others.some( ( subs ) => anyCarries( subs, dir ) );
	}

	/**
	 * Refuse a seek on a stamp another graph holds, live or parked: one
	 * stream holds one position per stamp, so the seek would move it too.
	 *
	 * @param {string}   target The graph seeking.
	 * @param {string[]} stamps The stamps the seek moves.
	 * @throws {Error} Naming both graphs and the stamp.
	 */
	_assertSeekable( target, stamps ) {
		for ( const stamp of stamps ) {
			for ( const [ other, graph ] of this.graphs ) {
				if (
					other !== target &&
					anyCarries( graph.subscribe, stamp )
				) {
					throw new Error(
						`RemoteLink: ${ target } cannot seek ${ stamp }, which ${ other } is streaming`
					);
				}
			}
		}
	}

	/**
	 * The stamps a tail moves: each exact subscription, and every dir a glob
	 * among them holds a place for, by a seed or a read position, the seeds
	 * other graphs ask for on the next reopen included.
	 *
	 * @param {string[]} subscribe The subscriptions being tailed.
	 * @return {string[]} The stamps.
	 */
	_tailed( subscribe ) {
		const held = [
			...( this.sseIn?.places() ?? [] ),
			...[ ...this.graphs.values() ].flatMap( ( graph ) =>
				Object.keys( graph.seek ?? {} )
			),
		];
		return [
			...subscribe.filter( ( sub ) => ! isGlob( sub ) ),
			...held.filter( ( dir ) => anyCarries( subscribe, dir ) ),
		];
	}

	/** Reopen once, at the end of this tick. */
	_queueRestart() {
		if ( this._restartQueued ) {
			return;
		}
		this._restartQueued = true;
		queueMicrotask( () => {
			this._restartQueued = false;
			this._restartGraphs();
		} );
	}

	/**
	 * Open the stream on every graph's subscriptions, or close it when none
	 * is left. A stream on the same set with no seek pending is left alone,
	 * open or waiting out its reopen, so a re-render costs no reconnect and
	 * cannot cut a backoff short.
	 */
	_restartGraphs() {
		this._publishShares();
		const subscribed = this._subscribed();
		if ( 0 === subscribed.length ) {
			if ( this.sseIn ) {
				this.close();
			}
			return;
		}
		const joined = subscribed.join( ',' );
		const seeking = this._live().filter(
			( graph ) => undefined !== graph.seek
		);
		if (
			this.sseIn?.isOpenOrReopening() &&
			this.subscribe === joined &&
			0 === seeking.length &&
			! this._forgot
		) {
			return;
		}
		this._forgot = false;
		this.subscribe = joined;
		// Past this class's setter: the value is parsed, so skip the walk.
		super.arguments = [ this.subscribe ];
		this.ensureChildren();
		for ( const graph of seeking ) {
			this.sseIn.reseek( graph.subscribe, graph.seek );
			graph.seek = undefined;
		}
		this.sseIn.arguments = this.arguments;
		this.sseIn.start();
	}

	/**
	 * @return {string[]} Every live graph's subscriptions, each named once,
	 *   sorted so the same set always reads the same.
	 */
	_subscribed() {
		return [
			...new Set( this._live().flatMap( ( graph ) => graph.subscribe ) ),
		].sort();
	}

	/**
	 * Build this link's SseIn, hand the shared `_http` its transport, and
	 * register the handlers bridging the SseIn's `connected` handshake to a
	 * Heartbeat slot lease and republishing its UNPARSEABLE_LINES count on this
	 * link, with each graph's share in `unparseableByTarget`. Idempotent: the
	 * first call that needs a stream builds it, and every later call returns
	 * at once.
	 *
	 * Only the SseIn is created. `_http` and `_heartbeat` are looked up and
	 * configured, because they are backbone every link on the page shares.
	 *
	 * @throws {Error} When no subscription has been supplied.
	 */
	ensureChildren() {
		this._assertConfigured();
		if ( this.sseIn ) {
			return;
		}

		const sse = new SseInNode();
		// Pin a NON-default table before naming, exactly as makeNode does.
		if ( this.registry !== Core.registry ) {
			sse.registry = this.registry;
		}
		// Named so `trace` reaches it; patron keeps it off the canvas.
		sse.name = `${ this.name }:sse-in`;
		sse.patron = this;
		sse.arguments = this.arguments; // `{subscribe}`; baseUrl/nonce from global
		sse.sink = this.sink;
		if ( this.target ) {
			sse.target = this.target;
		}
		sse.routeTo = ( stamp ) => this.targetsFor( stamp );
		this.sseIn = sse;

		// Backbone singletons; configure, never alias per-link.
		const http = Core.node( names.HTTP );
		if ( http ) {
			http.client = this.client || defaultTransport();
		}

		// Not armed here: the connection lifecycle below arms/stops it.
		const hb = Core.node( names.HEARTBEAT );
		this.heartbeat = hb;

		// Each opening/closed stream has no valid lease until CONNECTED.
		const clearLease = () => {
			hb.clearSlot( this );
			return true;
		};
		sse.register( 'CONNECTING', this.name, clearLease );
		sse.register( 'DISCONNECTED', this.name, clearLease );

		// Lease bridge: keep link identity separate from the wire owner token.
		sse.register( 'CONNECTED', this.name, ( payload ) => {
			const slot = sse.slot();
			const leaseOwner = sse.leaseOwner();
			if (
				Number.isInteger( slot ) &&
				slot >= 0 &&
				'string' === typeof leaseOwner
			) {
				hb.setSlot( slot, leaseOwner, this );
			} else {
				hb.clearSlot( this );
			}
			this.onConnected?.( payload );
			return true;
		} );

		// Republish the total on the link, and each graph's share.
		sse.register( 'UNPARSEABLE_LINES', this.name, ( count ) => {
			this.setState( 'UNPARSEABLE_LINES', count );
			this._publishShares();
			return true;
		} );
	}

	/**
	 * Publish every graph's share of the skipped lines, live or parked, from
	 * the counts the SseIn keeps per stamp, unless no share moved.
	 */
	_publishShares() {
		const byStamp = Object.entries( this.sseIn?.unparseableByStamp ?? {} );
		const shares = {};
		for ( const [ target, { subscribe } ] of this.graphs ) {
			shares[ target ] = byStamp
				.filter( ( [ stamp ] ) => anyCarries( subscribe, stamp ) )
				.reduce( ( sum, [ , n ] ) => sum + n, 0 );
		}
		const was = this.unparseableByTarget;
		const keys = Object.keys( shares );
		if (
			keys.length !== Object.keys( was ).length ||
			keys.some( ( target ) => shares[ target ] !== was[ target ] )
		) {
			this.setField( 'unparseableByTarget', shares );
		}
	}

	/**
	 * Where a record stamped `stamp` goes. A link carrying no graphs sends it
	 * to its own target, or keeps its TO when it has none. With graphs, it
	 * goes to each one whose subscription carries the stamp, and to every
	 * graph when its FROM is empty.
	 *
	 * @param {string} stamp The record's stamp.
	 * @return {?string[]} The targets, or null to keep the record's TO.
	 */
	targetsFor( stamp ) {
		if ( 0 === this.graphs.size ) {
			const own = targetsOf( this );
			return own.length ? own : null;
		}
		const targets = [];
		for ( const [ target, graph ] of this.graphs ) {
			if (
				! graph.parked &&
				( '' === stamp || anyCarries( graph.subscribe, stamp ) )
			) {
				targets.push( target );
			}
		}
		return targets;
	}

	/**
	 * @return {Graph[]} The graphs not parked.
	 */
	_live() {
		return [ ...this.graphs.values() ].filter(
			( graph ) => ! graph.parked
		);
	}

	/**
	 * Removing the output edge closes the stream and its heartbeat slot —
	 * a link with nowhere to deliver has no reason to hold one open.
	 *
	 * @param {string} target Edge to drop; the base clears the single target.
	 */
	disconnectNode( target = '' ) {
		super.disconnectNode( target );
		if ( this.sseIn ) {
			this.sseIn.target = '';
		}
		this.close();
	}

	/**
	 * Close the inbound stream, forget this link's heartbeat slot, then fire
	 * the `onClose` hook so the owner can reset stream-tied state.
	 */
	close() {
		this.sseIn?.close();
		this.heartbeat?.clearSlot( this );
		this.onClose?.();
	}

	/**
	 * Refuse every operation that would open a stream until a subscription has
	 * been supplied — an unsubscribed EventSource has nothing to carry.
	 *
	 * @throws {Error} When `subscribe` is still empty.
	 */
	_assertConfigured() {
		if ( '' === this.subscribe ) {
			throw new Error( 'RemoteLink requires an SSE subscription' );
		}
	}

	/**
	 * Where a subscription's stream has read to, for a caller reopening from
	 * there. A non-glob subscription IS its partition directory, which is how
	 * SseIn keys the positions it tracks.
	 *
	 * @param {string} sub The subscription to read.
	 * @return {{segment?:number,offset:number}|undefined} The next-record
	 *   boundary, or undefined before the stream's first record.
	 */
	cursor( sub ) {
		return this.sseIn?.lastPositions?.[ sub ];
	}

	/**
	 * Composite stat delegation: the records arrive on the SseIn child, so its
	 * tally is this link's. Before a stream exists the base counter stands.
	 *
	 * @return {number} Records received.
	 */
	get counter() {
		return this.sseIn ? this.sseIn.counter : super.counter;
	}

	/**
	 * Ignored — the count is derived from the sseIn child, which makes the base
	 * `fill()`'s `counter++` a no-op here.
	 *
	 * @param {number} _v Discarded.
	 */
	set counter( _v ) {}

	/**
	 * @return {number} Bytes the composed stream has received.
	 */
	get bytesRead() {
		return this.sseIn ? this.sseIn.bytesRead : super.bytesRead;
	}

	/**
	 * Egress leaves through the shared `_http`, not this link, so the base
	 * tally stands.
	 *
	 * @return {number} Bytes written.
	 */
	get bytesWritten() {
		return super.bytesWritten;
	}

	/**
	 * @return {number} Largest single frame the composed stream has seen.
	 */
	get largestMsgSent() {
		return this.sseIn ? this.sseIn.largestMsgSent : super.largestMsgSent;
	}

	/**
	 * The command session the live stream carries replies for, confirmed by
	 * the SseIn's `connected` handshake.
	 *
	 * @return {?string} Session handle, or null before the handshake lands.
	 */
	session() {
		return this.sseIn?.session() ?? null;
	}

	/**
	 * Console-palette entry. It borrows SseIn's argument list, since the
	 * subscription is the one thing that configures both.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Full-duplex SSE+HTTP channel: composes a SseIn, HttpOut and Heartbeat as one node.',
			accepts_fill: false,
			has_target: true,
			// @longform Optional where SseIn declares it required: a link whose
			// subscription is CHOSEN builds bare and is refused at the point of
			// use by `_assertConfigured()`. Requiring it at construction only
			// makes a deferred caller invent a placeholder, which moves the
			// failure from loud to silent (ADR-11).
			arguments: SseInNode.nodeSchema().arguments.map( ( argument ) =>
				'subscribe' === argument.name
					? { ...argument, required: false }
					: argument
			),
			commands: [],
		};
	}
}
