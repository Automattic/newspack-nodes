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
 * A link declares its sources, `{ stamp, target }` records, through
 * `addSource()` and `removeSource()`, the handlers of the `add_source` and
 * `remove_source` its `:config` answers. Both fold through the one
 * `foldSource()` the PHP broker and the console's TSL reader fold through:
 * one target per stamp, an identical repeat a no-op, a removal naming no
 * declared source refused, and a source a spoke cannot stream, one taking a
 * kept slot or one naming `{partition}`, which no browser binds, refused. It
 * asks the server for the sources' stamps and sends each record to the
 * target of every source carrying its stamp, where PHP
 * `Remote_Broker_Node::source_for()` hands one to the first alone, so an
 * exact view and a glob view over its stamp both see the record.
 *
 * A page view declares no source of its own. It attaches to a stamp's Tee,
 * the hidden sibling `<link>:<stamp>`, as one of its targets: the first view
 * on a stamp builds the Tee and declares the stamp's source aimed at it, and
 * the last to leave retracts both, so the Tee is where a stamp fans out to
 * every view on it. A view pausing parks, leaving the Tee's targets but
 * keeping its claim and its place; one leaving detaches and `forget`s its
 * places. Every change in one tick joins one reconnect.
 *
 * Mirrors the PHP `Remote_Source_Node`, a patron owning an `SSE_In_Node` and an
 * `HTTP_Out_Node`. The durable offsetlog that distinguishes aggregation is a
 * PHP-only concern of its readers — the browser has no durable cursor, so JS
 * ships RemoteLink and RemoteIpc alone.
 */

import { Core } from './core';
import { Node } from './node';
import { ReactBridge } from './react-bridge';
import { SchemaReflection } from './schema-reflection';
import { SseInNode } from './sse-in-node';
import { TeeNode } from './tee-node';
import { defaultTransport } from './command-transport';
import { TO, TYPE, TM_COMMAND, TM_ERROR, TM_RESPONSE } from './message';
import { anyCarries, isGlob } from './log-stamp';
import { attemptEach, raise } from './failures';
import {
	ADD_SOURCE,
	REMOVE_SOURCE,
	SOURCE_ARGS,
	foldSource,
} from './broker-sources';
import names from './reserved-node-names.json';

/** The sibling slot the link's SseIn takes, as PHP's `SSE_IN_KIND`. */
const SSE_IN_KIND = 'sse-in';

/**
 * A route the link carries, records stamped `stamp` going to `target`; or a
 * view, `target`, on `stamp`'s Tee.
 *
 * @typedef {{stamp:string,target:string}} Source
 */

/** @typedef {import('./broker-sources').DeclaredSource} DeclaredSource */

/**
 * @param {Source[]} sources Sources.
 * @return {DeclaredSource[]} The same, as `foldSource()` reads them.
 */
const declaredOf = ( sources ) =>
	sources.map( ( { stamp, target } ) => ( { source: stamp, target } ) );

/**
 * @param {DeclaredSource[]} declared What `foldSource()` left.
 * @return {Source[]} The same, as the link keeps them.
 */
const sourcesOf = ( declared ) =>
	declared.map( ( { source, target } ) => ( { stamp: source, target } ) );

/**
 * Whether `records` holds `stamp` → `target`.
 *
 * @param {Source[]} records Sources or views.
 * @param {string}   stamp   A stamp or glob.
 * @param {string}   target  A node path.
 * @return {boolean} True when held.
 */
const holds = ( records, stamp, target ) =>
	records.some( ( r ) => r.stamp === stamp && r.target === target );

/**
 * `records` without `stamp` → `target`.
 *
 * @param {Source[]} records Views.
 * @param {string}   stamp   A stamp or glob.
 * @param {string}   target  A node path.
 * @return {Source[]} The rest, in order.
 */
const without = ( records, stamp, target ) =>
	records.filter( ( r ) => ! ( r.stamp === stamp && r.target === target ) );

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
 * A seek one view asked for, which the next reopen states.
 *
 * @typedef {Object} Seek
 * @property {string[]}  subscribe The stamps its view names.
 * @property {?SeekSeed} positions Null tails them; a seed seeks them.
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
 * source node. A link carrying sources takes its subscription from them
 * instead, and reopens it on their stamps as they change.
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
		 * The sources this link declares, one per stamp, in the order they
		 * were added. Empty for a single-target link.
		 *
		 * @type {Source[]}
		 */
		this.sources = [];
		/**
		 * Paused views, `{ stamp, target }` each: off their stamp's Tee, but
		 * still claiming it, so no other view seeks it and no `forget()`
		 * drops its place.
		 *
		 * @type {Source[]}
		 */
		this.parked = [];
		/**
		 * Each viewed stamp's Tee, the hidden sibling `<link>:<stamp>` its
		 * first view builds, by stamp. Its targets are the stamp's live
		 * views.
		 *
		 * @type {Map<string,TeeNode>}
		 */
		this.tees = new Map();
		/**
		 * The seek each view asked for and the next reopen states, by target:
		 * one per view, stated once over every stamp it names.
		 *
		 * @type {Map<string,Seek>}
		 */
		this._seeks = new Map();
		/**
		 * Each record stamp's targets, read on its first record and dropped
		 * whenever a source, a Tee or a view moves.
		 *
		 * @type {Map<string,string[]>}
		 */
		this._routes = new Map();
		// One reopen per tick: later source changes join a queued one.
		this._restartQueued = false;
		// A place the open stream carries was forgotten, so reopen.
		this._moved = false;
		// Republished from the SseIn; see ensureChildren().
		this.registrations.UNPARSEABLE_LINES = {};
		/**
		 * The lines the stream skipped as unparseable, by stamp: a copy of
		 * the SseIn's counts, published afresh on every change.
		 *
		 * @type {Object<string,number>}
		 */
		this.unparseableByStamp = {};
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
		this.sources = [];
		this.parked = [];
		this._seeks.clear();
		this._routes.clear();
		for ( const tee of this.tees.values() ) {
			tee.removeNode();
		}
		this.tees.clear();
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
	 * Attach a view to `stamp`'s Tee as one of its targets, building the Tee
	 * and declaring the stamp's source aimed at it when this is the stamp's
	 * first view. A view already attached is kept once, and a parked one
	 * plays.
	 *
	 * @param {string}     stamp     A stamp or glob.
	 * @param {string}     target    The view's node path.
	 * @param {?SeekSeed=} positions Omitted, its dirs resume where they read
	 *                               to; null tails them; a seed seeks.
	 * @throws {Error} What `checkView()` refuses, before anything changes.
	 */
	attachView( stamp, target, positions ) {
		this.checkView( stamp, target, positions );
		const tee =
			this.tees.get( stamp ) ?? this._publish( stamp, new TeeNode() );
		this.tees.set( stamp, tee );
		this.addSource( stamp, tee.name );
		tee.connectNode( target );
		this.parked = without( this.parked, stamp, target );
		this._noteSeek( stamp, target, positions );
		this._reroute();
	}

	/**
	 * Declare the source `stamp` → `target`: ask the server for the stamp,
	 * and send each record it claims to the target, as PHP
	 * `Remote_Broker_Node::add_source()` declares one through the same
	 * `foldSource()`. An identical repeat changes nothing; a second target
	 * for the stamp is refused. The stream reopens once this tick's changes
	 * are in.
	 *
	 * @param {string} stamp  A stamp or glob.
	 * @param {string} target The node path its records go to.
	 * @throws {Error} What `foldSource()` refuses, before anything changes.
	 */
	addSource( stamp, target ) {
		const declared = declaredOf( this.sources );
		const folded = foldSource( declared, ADD_SOURCE, stamp, target, null );
		if ( folded !== declared ) {
			this.sources = sourcesOf( folded );
			this._reroute();
		}
	}

	/**
	 * Take a view off its stamp's Tee and keep its claim, as a view pausing
	 * does: the stamp's source stays declared, so the `attachView()` that
	 * plays it resumes where its stamp's stream read to. A stamp with no
	 * view left on its Tee leaves the subscription.
	 *
	 * @param {string} stamp  A stamp or glob; a view not attached is ignored.
	 * @param {string} target The view's node path.
	 */
	parkView( stamp, target ) {
		const tee = this.tees.get( stamp );
		if ( ! tee?.target.includes( target ) ) {
			return;
		}
		tee.disconnectNode( target );
		this.parked = [ ...this.parked, { stamp, target } ];
		this._settleSeek( target );
		this._reroute();
	}

	/**
	 * Take a view off its stamp's Tee and give up its claim, parked or not,
	 * as a view leaving does. The stamp's last view retracts the Tee and
	 * removes the source aimed at it; its place stays until `forget()`. A
	 * seek not yet asked for goes with its view's last stamp.
	 *
	 * @param {string} stamp  A stamp or glob; one with no Tee is ignored.
	 * @param {string} target The view's node path.
	 */
	detachView( stamp, target ) {
		const tee = this.tees.get( stamp );
		if ( ! tee ) {
			return;
		}
		// A Tee prunes a view whose node has left, so the view may be gone.
		tee.disconnectNode( target );
		this.parked = without( this.parked, stamp, target );
		this._settleSeek( target );
		if (
			0 === tee.target.length &&
			! this.parked.some( ( view ) => view.stamp === stamp )
		) {
			this.tees.delete( stamp );
			if ( holds( this.sources, stamp, tee.name ) ) {
				this.removeSource( stamp, tee.name );
			}
			tee.removeNode();
		}
		this._reroute();
	}

	/**
	 * Undo the `addSource()` that declared `stamp` → `target`, both as
	 * written, as PHP `Remote_Broker_Node::remove_source()` does. A stamp no
	 * source carries leaves the subscription, and its place stays until
	 * `forget()`.
	 *
	 * @param {string} stamp  The source, as `addSource()` took it.
	 * @param {string} target Its target, as `addSource()` took it.
	 * @throws {Error} When no such source is declared.
	 */
	removeSource( stamp, target ) {
		this.sources = sourcesOf(
			foldSource(
				declaredOf( this.sources ),
				REMOVE_SOURCE,
				stamp,
				target,
				null
			)
		);
		this._reroute();
	}

	/**
	 * Forget what the stream holds for the dirs `subscribe` carries and no
	 * source claims, a paused view's included: their seeds, read positions
	 * and skipped-line counts, as a view leaving for good does, so a later
	 * view on them tails. Dropping a place the open stream carries makes the
	 * next reopen happen even on the same set, or a replay one view asked for
	 * runs on into another.
	 *
	 * @param {string[]} subscribe The subscriptions let go.
	 */
	forget( subscribe ) {
		if ( ! this.sseIn || 0 === subscribe.length ) {
			return;
		}
		const claimed = this._stamps( this.sources );
		const lost = ( dir ) =>
			anyCarries( subscribe, dir ) && ! anyCarries( claimed, dir );
		const open = this.subscribe.split( ',' );
		if (
			this.sseIn
				.places()
				.some( ( dir ) => lost( dir ) && anyCarries( open, dir ) )
		) {
			this._moved = true;
			this._queueRestart();
		}
		this.sseIn.forget( lost );
		this._publishCounts();
	}

	/**
	 * Refuse what `attachView()` refuses, changing nothing, so a caller
	 * attaching several can ask of each before attaching any.
	 *
	 * An empty stamp or target is refused, and whatever `addSource()` would
	 * refuse of the stamp's source aimed at its Tee: a stamp a source
	 * declared to another target, one no spoke can stream and one whose Tee
	 * would take a slot the link keeps. So is a seek on a stamp another view
	 * claims, a paused one included, or a source a verb declared: one stream
	 * holds one place per stamp, so the seek would move that one too.
	 *
	 * @param {string}     stamp     A stamp or glob.
	 * @param {string}     target    The view's node path.
	 * @param {?SeekSeed=} positions The seek, as `attachView()` reads one.
	 * @throws {Error} Naming the stamp, and the view a seek would move.
	 */
	checkView( stamp, target, positions ) {
		if ( '' === stamp || '' === target ) {
			throw new Error(
				`RemoteLink: a view needs a stamp and a target, got '${ stamp }' '${ target }'`
			);
		}
		foldSource(
			declaredOf( this.sources ),
			ADD_SOURCE,
			stamp,
			Node.siblingNameOf( this.name, stamp ),
			null
		);
		if ( undefined === positions ) {
			return;
		}
		const claims = [
			...this._live(),
			...this.parked,
			...this.sources.filter( ( source ) => ! this._teeOf( source ) ),
		];
		for ( const moved of this._moves( [ stamp ], positions ) ) {
			const other = claims.find(
				( view ) =>
					view.target !== target &&
					anyCarries( [ view.stamp ], moved )
			);
			if ( other ) {
				throw new Error(
					`RemoteLink: ${ target } cannot seek ${ moved }, which ${ other.target } is streaming`
				);
			}
		}
	}

	/**
	 * Keep each view's one seek: a view attached with the seek its pending
	 * one holds joins it, so the reopen states it once over every stamp;
	 * another seek replaces it. A view attached with none drops a pending
	 * seek that does not name its stamp, which the view has left.
	 *
	 * @param {string}     stamp     A stamp or glob.
	 * @param {string}     target    The view's node path.
	 * @param {?SeekSeed=} positions The seek it comes with, if any.
	 */
	_noteSeek( stamp, target, positions ) {
		const pending = this._seeks.get( target );
		if ( undefined === positions ) {
			if ( pending && ! pending.subscribe.includes( stamp ) ) {
				this._seeks.delete( target );
			}
			return;
		}
		const kept = pending?.positions === positions ? pending.subscribe : [];
		this._seeks.set( target, {
			subscribe: kept.includes( stamp ) ? kept : [ ...kept, stamp ],
			positions,
		} );
	}

	/**
	 * Drop the seek a view has not stated once it is on no Tee.
	 *
	 * @param {string} target The view's node path.
	 */
	_settleSeek( target ) {
		if ( ! this._live().some( ( view ) => view.target === target ) ) {
			this._seeks.delete( target );
		}
	}

	/**
	 * @return {Source[]} The views on the Tees, stamp by stamp.
	 */
	_live() {
		return [ ...this.tees ].flatMap( ( [ stamp, tee ] ) =>
			tee.target.map( ( target ) => ( { stamp, target } ) )
		);
	}

	/**
	 * The stamps a view's seek moves: those its seed names, or, for a tail,
	 * each exact stamp and every dir a glob among them holds a place for, by
	 * a seed or a read position, the seeks others ask for next included.
	 *
	 * @param {string[]}  sources   The stamps the view names.
	 * @param {?SeekSeed} positions Its seek; null tails.
	 * @return {string[]} The stamps.
	 */
	_moves( sources, positions ) {
		if ( positions ) {
			return Object.keys( positions );
		}
		const held = [
			...( this.sseIn?.places() ?? [] ),
			...[ ...this._seeks.values() ].flatMap( ( seek ) =>
				Object.keys( seek.positions ?? {} )
			),
		];
		return [
			...sources.filter( ( source ) => ! isGlob( source ) ),
			...held.filter( ( dir ) => anyCarries( sources, dir ) ),
		];
	}

	/** Drop every stamp's routes, which a source or a view moved, and reopen. */
	_reroute() {
		this._routes.clear();
		this._queueRestart();
	}

	/** Reopen once, at the end of this tick. */
	_queueRestart() {
		if ( this._restartQueued ) {
			return;
		}
		this._restartQueued = true;
		queueMicrotask( () => {
			this._restartQueued = false;
			this._restart();
		} );
	}

	/**
	 * Open the stream on every streaming source's stamp, or close it when none
	 * is left. A stream on the same set with no seek pending and no place
	 * forgotten is left alone, open or waiting out its reopen, so a re-render
	 * costs no reconnect and cannot cut a backoff short.
	 */
	_restart() {
		const sources = this._stamps( this._streaming() );
		if ( 0 === sources.length ) {
			if ( this.sseIn ) {
				this.close();
			}
			return;
		}
		const joined = sources.join( ',' );
		if (
			this.sseIn?.isOpenOrReopening() &&
			this.subscribe === joined &&
			0 === this._seeks.size &&
			! this._moved
		) {
			return;
		}
		this._moved = false;
		this.subscribe = joined;
		// Past this class's setter: the value is parsed, so skip the walk.
		super.arguments = [ this.subscribe ];
		this.ensureChildren();
		for ( const { subscribe, positions } of this._seeks.values() ) {
			this.sseIn.reseek( subscribe, positions );
		}
		this._seeks.clear();
		this.sseIn.arguments = this.arguments;
		this.sseIn.start();
	}

	/**
	 * @param {Source[]} records Sources.
	 * @return {string[]} Each source's stamp, named once and sorted, so the
	 *   same set always reads the same.
	 */
	_stamps( records ) {
		return [ ...new Set( records.map( ( r ) => r.stamp ) ) ].sort();
	}

	/**
	 * Build this link's SseIn, hand the shared `_http` its transport, and
	 * register the handlers bridging the SseIn's `connected` handshake to a
	 * Heartbeat slot lease and republishing its UNPARSEABLE_LINES count on this
	 * link, with its per-stamp counts in `unparseableByStamp`. Idempotent: the
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

		const sse = this._publish( SSE_IN_KIND, new SseInNode() );
		sse.arguments = this.arguments; // `{subscribe}`; baseUrl/nonce from global
		if ( this.target ) {
			sse.target = this.target;
		}
		sse.onMessage = ( message, stamp ) => this._route( message, stamp );
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

		// Republish the total on the link, and the counts by stamp.
		sse.register( 'UNPARSEABLE_LINES', this.name, ( count ) => {
			this.setState( 'UNPARSEABLE_LINES', count );
			this._publishCounts();
			return true;
		} );
	}

	/**
	 * The SseIn's `onMessage`: send a record to the target of each streaming
	 * source carrying its stamp, each copy addressed by TO, where PHP
	 * `Remote_Broker_Node::source_for()` hands one to the first alone. The
	 * targets come from one lookup in `_routes`, filled on a stamp's first
	 * record and emptied by `_reroute()`. A link with no sources declines
	 * every record. Every link declines a reply, which the server addressed to
	 * its minter (TO=FROM, ADR-7): a command reply, and a TM_RESPONSE or
	 * TM_ERROR carrying a TO, as `HttpOut` reads one, so a Router bounce
	 * reaches the node it answers. The SseIn sends a declined record by its
	 * TO. A record no source claims is dropped, rate-limited, and the drop
	 * line's FROM names its stamp. Every target is tried whatever an earlier
	 * one threw, and what they threw is raised after the last, as a Tee does.
	 *
	 * @param {Array}  message The positional Message just received.
	 * @param {string} stamp   The stamp its FROM opens with.
	 * @return {boolean} False to let the SseIn deliver it by its TO.
	 */
	_route( message, stamp ) {
		const type = message[ TYPE ];
		if (
			0 === this.sources.length ||
			type & TM_COMMAND ||
			( message[ TO ] && type & ( TM_RESPONSE | TM_ERROR ) )
		) {
			return false;
		}
		let targets = this._routes.get( stamp );
		if ( undefined === targets ) {
			targets = [
				...new Set(
					this._streaming()
						.filter( ( source ) =>
							anyCarries( [ source.stamp ], stamp )
						)
						.map( ( source ) => source.target )
				),
			];
			this._routes.set( stamp, targets );
		}
		if ( 0 === targets.length ) {
			// The reason stays constant, so one line covers a window's drops.
			this.dropMessage( message, 'no source claims the stamp' );
			return true;
		}
		raise(
			attemptEach( targets, ( target ) => {
				const copy = message.slice();
				copy[ TO ] = target;
				this.sink.fill( copy );
			} )
		);
		return true;
	}

	/**
	 * @return {Source[]} The sources the stream carries: all but those aimed
	 *   at a Tee whose views have all paused.
	 */
	_streaming() {
		return this.sources.filter( ( source ) => {
			const tee = this._teeOf( source );
			return ! tee || tee.target.length > 0;
		} );
	}

	/**
	 * @param {Source} source A declared source.
	 * @return {TeeNode|undefined} The stamp's Tee, when the source aims at it.
	 */
	_teeOf( { stamp, target } ) {
		const tee = this.tees.get( stamp );
		return tee?.name === target ? tee : undefined;
	}

	/**
	 * Enroll `node` as this link's hidden sibling `<link>:<kind>`: in this
	 * link's table, owned by it, and sinking where it sinks.
	 *
	 * @template {Node} T
	 * @param {string} kind The sibling's suffix.
	 * @param {T}      node The sibling.
	 * @return {T} The sibling, named.
	 */
	_publish( kind, node ) {
		// Pin a NON-default table before naming, exactly as makeNode does.
		if ( this.registry !== Core.registry ) {
			node.registry = this.registry;
		}
		node.patron = this;
		node.name = Node.siblingNameOf( this.name, kind );
		node.sink = this.sink;
		return node;
	}

	/** Publish a fresh copy of the SseIn's per-stamp skipped-line counts. */
	_publishCounts() {
		this.setField( 'unparseableByStamp', {
			...this.sseIn.unparseableByStamp,
		} );
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
	 * subscription is the one thing that configures both, and declares the
	 * `add_source` and `remove_source` its `:config` answers through
	 * `addSource()` and `removeSource()`.
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
			commands: [
				sourceVerb(
					ADD_SOURCE,
					'Route a stamp or glob to a local node. A repeat is a no-op; a second target for the stamp is refused.'
				),
				sourceVerb(
					REMOVE_SOURCE,
					'Stop routing a source add_source gave, named as add_source took it.'
				),
			],
		};
	}
}

/**
 * One of the two source verbs, declared as PHP's broker declares it, whose
 * bound args go to the link's own `addSource()` or `removeSource()`.
 *
 * @param {string} name        `add_source` or `remove_source`.
 * @param {string} description What it does.
 * @return {Object} The schema's command entry.
 */
function sourceVerb( name, description ) {
	return {
		name,
		description,
		args: SOURCE_ARGS,
		// One call per source: the console renders a row each.
		multiple: true,
		handler: ( config, { remote_log: stamp, local_node: target } ) => {
			if ( ADD_SOURCE === name ) {
				config.patron.addSource( stamp, target );
			} else {
				config.patron.removeSource( stamp, target );
			}
			return 'ok';
		},
	};
}
