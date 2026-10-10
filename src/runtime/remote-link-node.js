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
 * A page's shared link carries every stream graph on the page as
 * `<stamp>:<target>` pairs, the grammar PHP `Remote_Broker_Node::parse_pair()`
 * reads. It asks the server for the pairs' sources, and hands each record to
 * its stamp's Tee, the hidden sibling `<link>:<kind>`, whose targets are those
 * of every pair claiming the stamp, as `Remote_Source::route()` hands one to
 * its stamp's reader. A view pausing parks its pairs, which keep their claim
 * and their places; one leaving removes them and `forget`s their places.
 * Every change in one tick joins one reconnect.
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
import { anyCarries, isGlob, kindOf, splitPair } from './log-stamp';
import names from './reserved-node-names.json';

/** The sibling slot the link's SseIn takes, as PHP's `SSE_IN_KIND`. */
const SSE_IN_KIND = 'sse-in';

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
 * @property {string[]}  subscribe The sources its pairs name.
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
 * source node. A link carrying views takes its subscription from their pairs
 * instead: `addPairs()` and `removePairs()` reopen it on their sources.
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
		 * The routes this link carries, as `<stamp>:<target>` tokens in the
		 * order they were added. Empty for a single-target link.
		 *
		 * @type {string[]}
		 */
		this.pairs = [];
		/**
		 * The pairs of paused views: they feed no Tee and open no
		 * subscription, but still claim their stamps, so no other view seeks
		 * one and no `forget()` drops its place.
		 *
		 * @type {string[]}
		 */
		this.parked = [];
		/**
		 * Each stamp's Tee, the hidden sibling `<link>:<kind>` built on the
		 * stamp's first record, by stamp.
		 *
		 * @type {Map<string,TeeNode>}
		 */
		this.tees = new Map();
		/**
		 * The seek each view asked for and the next reopen states, by target.
		 *
		 * @type {Map<string,Seek>}
		 */
		this._seeks = new Map();
		// One reopen per tick: later pair changes join a queued one.
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
		this.pairs = [];
		this.parked = [];
		this._seeks.clear();
		this._syncTees();
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
	 * Carry `tokens`, each a `<stamp>:<target>` pair: ask the server for each
	 * source, and route each record a pair claims to its target through the
	 * stamp's Tee. A pair already carried is kept once. The stream reopens
	 * once this tick's changes are in, and not at all when they change
	 * nothing.
	 *
	 * A seek is refused, before anything changes, on a stamp a pair with
	 * another target claims, a parked one included: one stream holds one
	 * place per stamp, so the seek would move that view too. The pairs are
	 * asked rather than the Tees, because a Tee is built on its stamp's first
	 * record and a seek comes before one.
	 *
	 * @param {string[]}   tokens    The pairs; one view's, as a rule.
	 * @param {?SeekSeed=} positions Omitted, their dirs resume where they
	 *                               read to; null tails them; a seed seeks.
	 * @throws {Error} On a token that is no pair, one whose Tee would take the
	 *                 SseIn's slot, or a seek on a stamp another view streams.
	 */
	addPairs( tokens, positions ) {
		const byTarget = new Map();
		for ( const token of tokens ) {
			const { source, target } = this._checkedPair( token );
			byTarget.set( target, [
				...( byTarget.get( target ) ?? [] ),
				source,
			] );
		}
		if ( undefined !== positions ) {
			for ( const [ target, sources ] of byTarget ) {
				for ( const stamp of this._moves( sources, positions ) ) {
					const other = this._targetsOf( stamp, [
						...this.pairs,
						...this.parked,
					] ).find( ( claimant ) => claimant !== target );
					if ( other ) {
						throw new Error(
							`RemoteLink: ${ target } cannot seek ${ stamp }, which ${ other } is streaming`
						);
					}
				}
			}
		}
		this.pairs = [ ...new Set( [ ...this.pairs, ...tokens ] ) ];
		this.parked = this.parked.filter(
			( token ) => ! tokens.includes( token )
		);
		for ( const [ target, sources ] of byTarget ) {
			const pending = this._seeks.get( target );
			if ( undefined !== positions ) {
				this._seeks.set( target, { subscribe: sources, positions } );
			} else if (
				pending?.subscribe.join( ',' ) !== sources.join( ',' )
			) {
				this._seeks.delete( target );
			}
		}
		this._syncTees();
		this._queueRestart();
	}

	/**
	 * Stop carrying `tokens` for now, as a view pausing does: they leave the
	 * Tees and the subscription as `removePairs()` has them leave, and keep
	 * their claim, so the `addPairs()` that plays them resumes where their
	 * stamps' stream read to.
	 *
	 * @param {string[]} tokens The pairs to park; one not carried is ignored.
	 */
	parkPairs( tokens ) {
		const carried = tokens.filter( ( token ) =>
			this.pairs.includes( token )
		);
		this.removePairs( carried );
		this.parked.push( ...carried );
	}

	/**
	 * Stop carrying `tokens` and give up their claim, parked or not, as a
	 * view leaving does. Each Tee loses the edges they gave it and goes with
	 * its last; a stamp no pair carries leaves the subscription and its place
	 * stays until `forget()`. A seek not yet asked for goes with its target's
	 * last pair.
	 *
	 * @param {string[]} tokens The pairs to drop; one not held is ignored.
	 */
	removePairs( tokens ) {
		const gone = tokens.filter(
			( token ) =>
				this.pairs.includes( token ) || this.parked.includes( token )
		);
		if ( 0 === gone.length ) {
			return;
		}
		this.pairs = this.pairs.filter( ( token ) => ! gone.includes( token ) );
		this.parked = this.parked.filter(
			( token ) => ! gone.includes( token )
		);
		const riding = new Set(
			this.pairs.map( ( token ) => splitPair( token ).target )
		);
		for ( const { target } of gone.map( splitPair ) ) {
			if ( ! riding.has( target ) ) {
				this._seeks.delete( target );
			}
		}
		this._syncTees();
		this._queueRestart();
	}

	/**
	 * Forget what the stream holds for the dirs `subscribe` carries and no
	 * pair claims, a parked one included: their seeds, read positions and
	 * skipped-line counts, as a view leaving for good does, so a later view
	 * on them tails. Dropping a place the open stream carries makes the next
	 * reopen happen even on the same set, or a replay one view asked for runs
	 * on into another.
	 *
	 * @param {string[]} subscribe The subscriptions let go.
	 */
	forget( subscribe ) {
		if ( ! this.sseIn || 0 === subscribe.length ) {
			return;
		}
		const claimed = this._sources( [ ...this.pairs, ...this.parked ] );
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
	 * Read one token through `splitPair()`, refusing what PHP
	 * `Remote_Broker_Node::parse_pair()` refuses that a link can meet: an
	 * empty half, and a stamp whose Tee would take the SseIn's slot.
	 *
	 * @param {string} token One pair.
	 * @return {{source:string,target:string}} Its halves.
	 * @throws {Error} Naming the token.
	 */
	_checkedPair( token ) {
		const pair = splitPair( token );
		if ( '' === pair.source || '' === pair.target ) {
			throw new Error(
				`RemoteLink: a pair is <stamp>:<target>, got '${ token }'`
			);
		}
		if ( SSE_IN_KIND === kindOf( pair.source ) ) {
			throw new Error(
				`RemoteLink: a pair's Tee names the slot its SseIn holds: '${ token }'`
			);
		}
		return pair;
	}

	/**
	 * The stamps a view's seek moves: those its seed names, or, for a tail,
	 * each exact source and every dir a glob among them holds a place for, by
	 * a seed or a read position, the seeks others ask for next included.
	 *
	 * @param {string[]}  sources   The sources the view's pairs name.
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

	/**
	 * Point each built Tee at the targets of the pairs claiming its stamp,
	 * retracting one no pair claims any longer.
	 */
	_syncTees() {
		for ( const [ stamp, tee ] of this.tees ) {
			const targets = this._targetsOf( stamp, this.pairs );
			if ( 0 === targets.length ) {
				tee.removeNode();
				this.tees.delete( stamp );
			} else {
				tee.target = targets;
			}
		}
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
	 * Open the stream on every pair's source, or close it when none is left.
	 * A stream on the same set with no seek pending and no place forgotten is
	 * left alone, open or waiting out its reopen, so a re-render costs no
	 * reconnect and cannot cut a backoff short.
	 */
	_restart() {
		const sources = this._sources( this.pairs );
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
	 * @param {string[]} tokens Pairs.
	 * @return {string[]} Each pair's source, named once and sorted, so the
	 *   same set always reads the same.
	 */
	_sources( tokens ) {
		return [
			...new Set( tokens.map( ( token ) => splitPair( token ).source ) ),
		].sort();
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
	 * The SseIn's `onMessage`: hand a record to its stamp's Tee, built on first
	 * sight, as PHP `Remote_Source::route()` hands one to its reader. A link
	 * with no pairs declines every record. Every link declines a reply, which
	 * the server addressed to its minter (TO=FROM, ADR-7): a command reply,
	 * and a TM_RESPONSE or TM_ERROR carrying a TO, as `HttpOut` reads one, so
	 * a Router bounce reaches the node it answers. The SseIn sends a declined
	 * record by its TO. A record no pair claims is dropped, rate-limited, and
	 * the drop line's FROM names its stamp.
	 *
	 * @param {Array}  message The positional Message just received.
	 * @param {string} stamp   The stamp its FROM opens with.
	 * @return {boolean} False to let the SseIn deliver it by its TO.
	 */
	_route( message, stamp ) {
		const type = message[ TYPE ];
		if (
			0 === this.pairs.length ||
			type & TM_COMMAND ||
			( message[ TO ] && type & ( TM_RESPONSE | TM_ERROR ) )
		) {
			return false;
		}
		let tee = this.tees.get( stamp );
		if ( ! tee ) {
			// The reasons stay constant, so one line covers a window's drops.
			if ( SSE_IN_KIND === kindOf( stamp ) ) {
				this.dropMessage(
					message,
					'the stamp names the slot the SseIn holds'
				);
				return true;
			}
			tee = this._buildTee( stamp );
			if ( ! tee ) {
				this.dropMessage( message, 'no pair claims the stamp' );
				return true;
			}
		}
		// The Tee addresses each copy; a stored TO would trail its target.
		message[ TO ] = '';
		tee.fill( message );
		return true;
	}

	/**
	 * Build a stamp's Tee on its first record, or none when no pair claims it.
	 *
	 * @param {string} stamp A record's stamp.
	 * @return {?TeeNode} The Tee.
	 */
	_buildTee( stamp ) {
		const targets = this._targetsOf( stamp, this.pairs );
		if ( 0 === targets.length ) {
			return null;
		}
		const tee = this._publish( kindOf( stamp ), new TeeNode() );
		tee.target = targets;
		this.tees.set( stamp, tee );
		return tee;
	}

	/**
	 * @param {string}   stamp  A record's stamp.
	 * @param {string[]} tokens Pairs.
	 * @return {string[]} The targets of those claiming it, each named once,
	 *   in their order.
	 */
	_targetsOf( stamp, tokens ) {
		return [
			...new Set(
				tokens
					.map( splitPair )
					.filter( ( { source } ) => anyCarries( [ source ], stamp ) )
					.map( ( { target } ) => target )
			),
		];
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
