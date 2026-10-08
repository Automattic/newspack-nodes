import { FetcherNode } from '../fetcher-node';
import {
	ensureSession,
	forgetSession,
	hasSession,
	__setAuthFetch,
} from '../command-auth';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_BYTESTREAM,
	TM_STRUCT,
} from '../message';

test( 'arguments parses receiver + command with no command args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'counts:in', 'counts' ];
	expect( f.receiver ).toBe( 'counts:in' );
	expect( f.verb ).toBe( 'counts' );
	expect( f.command_args ).toEqual( [] );
} );

test( 'arguments parses receiver + command + variadic command args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'top:in', 'rank', '--limit', '10' ];
	expect( f.receiver ).toBe( 'top:in' );
	expect( f.verb ).toBe( 'rank' );
	expect( f.command_args ).toEqual( [ '--limit', '10' ] );
} );

test( 'fill emits ONE TM_COMMAND with FROM=receiver and the configured command VALUE', () => {
	const f = new FetcherNode();
	f.arguments = [ 'top:in', 'rank', '--limit', '10' ];
	f.target = '_http/ci';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	const trigger = newMessage();
	trigger[ TYPE ] = TM_BYTESTREAM;
	trigger[ VALUE ] = '1750000000';
	f.fill( trigger );

	expect( sent ).toHaveLength( 1 );
	const m = sent[ 0 ];
	expect( m[ TYPE ] & TM_COMMAND ).toBe( TM_COMMAND );
	expect( m[ FROM ] ).toBe( 'top:in' );
	expect( m[ VALUE ] ).toMatchObject( {
		name: 'rank',
		arguments: [ '--limit', '10' ],
	} );
	expect( m[ TO ] ).toBe( '_http/ci' );
} );

test( 'fill ignores the trigger payload — a struct trigger carrying its own command changes nothing', () => {
	const f = new FetcherNode();
	f.arguments = [ 'counts:in', 'counts' ];
	f.target = '_shell';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	const trigger = newMessage();
	trigger[ TYPE ] = TM_STRUCT;
	trigger[ FROM ] = 'someClock';
	trigger[ VALUE ] = { name: 'EVIL', arguments: 'rm -rf' };
	f.fill( trigger );

	expect( sent ).toHaveLength( 1 );
	const m = sent[ 0 ];
	expect( m[ FROM ] ).toBe( 'counts:in' );
	expect( m[ VALUE ] ).toMatchObject( { name: 'counts', arguments: [] } );
	expect( m[ TO ] ).toBe( '_shell' );
} );

test( 'fill on an empty trigger still emits the configured command', () => {
	const f = new FetcherNode();
	f.arguments = [ 'counts:in', 'counts' ];
	f.target = '_shell';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'counts',
		arguments: [],
	} );
} );

test( 'command_args may be a FUNCTION, called at fire time to get current args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'urls:in', 'urls' ];
	f.target = '_http/perf';
	let live = [ '--sort', 'count' ];
	f.command_args = () => live;
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'urls',
		arguments: [ '--sort', 'count' ],
	} );

	// The ask that reply settled is done; the next one reads the getter again.
	const answer = newMessage();
	answer[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	answer[ VALUE ] = { arguments: [ '--sort', 'count' ] };
	f.fill( answer );
	live = [ '--sort', 'avg_ms', '--order', 'asc' ];
	f.fill( newMessage() );
	expect( sent[ 1 ][ VALUE ] ).toMatchObject( {
		name: 'urls',
		arguments: [ '--sort', 'avg_ms', '--order', 'asc' ],
	} );
} );

test( 'a function command_args returning a non-array coerces to empty args', () => {
	const f = new FetcherNode();
	f.arguments = [ 'urls:in', 'urls' ];
	f.command_args = () => 'not-a-token-array';
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };
	f.fill( newMessage() );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'urls',
		arguments: [],
	} );
} );

test( 'static string command_args still works byte-identically (no getter)', () => {
	const f = new FetcherNode();
	f.arguments = [ 'top:in', 'rank', '--limit', '10' ];
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };
	f.fill( newMessage() );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'rank',
		arguments: [ '--limit', '10' ],
	} );
} );

test( 'counter bumps per ask', () => {
	const f = new FetcherNode();
	f.arguments = [ 'counts:in', 'counts' ];
	f.sink = { fill: () => {} };
	f.fill( newMessage() );
	// A trigger arriving on an outstanding ask sends nothing, so counts nothing.
	f.fill( newMessage() );
	expect( f.counter ).toBe( 1 );
} );

test( "makeNode('Fetcher', name) resolves the registered class", () => {
	const ci = new CommandInterpreterNode();
	ci.name = '_ci_fetcher_test';
	const node = ci.makeNode( 'Fetcher', 'myFetcher', [
		'counts:in',
		'counts',
	] );
	expect( node ).toBeInstanceOf( FetcherNode );
	expect( node.receiver ).toBe( 'counts:in' );
	expect( node.verb ).toBe( 'counts' );
} );

/**
 * A poll tick that finds no session must also ASK for one. Skipping alone
 * leaves the page dead after an eviction or a server restart: the session is
 * gone, every tick skips, and nothing ever re-auths. ensureSession() carries
 * its own backoff, so this costs one /auth per window, not one per tick.
 */
test( 'a poll tick with no session re-authenticates', async () => {
	forgetSession();
	let issued = 0;
	__setAuthFetch( async () => {
		issued++;
		return {
			handle: 'bbbb2222bbbb2222bbbb2222bbbb2222',
			secret: 'key-after-eviction',
			expires_in: 3600,
			now: 1771000000,
		};
	} );

	const f = new FetcherNode();
	f.arguments = [ 'top:in', 'rank' ];
	f.sink = { fill: () => {} };

	const trigger = newMessage();
	trigger[ TYPE ] = TM_BYTESTREAM;
	f.fill( trigger );
	await Promise.resolve();
	await Promise.resolve();

	expect( issued ).toBe( 1 );
	expect( hasSession() ).toBe( true );

	forgetSession();
	__setAuthFetch( null );
} );

test( 'keeps the inherited command() minting helper', async () => {
	forgetSession();
	__setAuthFetch( async () => ( {
		handle: 'cccc3333cccc3333cccc3333cccc3333',
		secret: 'key-for-mint-helper',
		expires_in: 3600,
		now: 1771000000,
	} ) );

	const f = new FetcherNode();
	f.name = 'spline-fetcher';
	f.arguments = [ 'splineIn', 'reticulate', '--depth', '7' ];

	// The configured verb must not displace Node#command, which six sibling
	// nodes call and any generic `Core.node(x)?.command(...)` walk expects.
	expect( typeof f.command ).toBe( 'function' );

	f.sink = { fill: () => {} };
	const trigger = newMessage();
	trigger[ TYPE ] = TM_BYTESTREAM;
	f.fill( trigger );
	await Promise.resolve();
	await Promise.resolve();

	const m = f.command( 'reticulate', [ '--depth', '7' ] );
	expect( m[ VALUE ] ).toMatchObject( {
		name: 'reticulate',
		arguments: [ '--depth', '7' ],
	} );
	// It signs, too — the helper is whole, not merely present.
	expect( m[ VALUE ].auth ).toMatchObject( {
		handle: 'cccc3333cccc3333cccc3333cccc3333',
	} );

	forgetSession();
	__setAuthFetch( null );
} );

// A one-shot rides the tick like everything else: it holds its arguments until
// the next fan-out, sends once, and has nothing to say on the ticks between.
// Without this a mutation would have to fire off-cadence, outside the router's
// lock/flush bracket — its own POST, which is what the batch exists to avoid.
test( 'a function command_args returning null sends NOTHING that tick', () => {
	const f = new FetcherNode();
	f.arguments = [ 'save:in', 'save' ];
	let pending = null;
	f.command_args = () => pending;
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );
	expect( sent ).toHaveLength( 0 );

	pending = [ 'wombat-4471' ];
	f.fill( newMessage() );
	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'save',
		arguments: [ 'wombat-4471' ],
	} );
} );

// A one-shot's arguments are TAKEN as they are read, so reading them before
// deciding whether we can send at all drops the command on the floor: a tick
// that lands mid-re-auth ate the save, and nothing ever sent it.
test( 'an unauthenticated tick does not consume the pending arguments', () => {
	forgetSession();
	const f = new FetcherNode();
	f.arguments = [ 'save:in', 'save' ];
	let pending = [ 'wombat-4471' ];
	f.command_args = () => {
		const args = pending;
		pending = null;
		return args;
	};
	const sent = [];
	f.sink = { fill: ( m ) => sent.push( m ) };

	f.fill( newMessage() );
	expect( sent ).toHaveLength( 0 );
	// Untouched: the arguments are still there to send once authenticated.
	expect( pending ).toEqual( [ 'wombat-4471' ] );

	__setAuthFetch( async () => ( {
		handle: 'aaaa1111aaaa1111aaaa1111aaaa1111',
		secret: 'fetcher-auth-key',
		expires_in: 3600,
		now: Math.floor( Date.now() / 1000 ),
	} ) );
	return ensureSession().then( () => {
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [ 'wombat-4471' ] );
	} );
} );

/**
 * Whether an ask about `path` still waits in the outbox, whatever it asked.
 *
 * @param {FetcherNode} f    The Fetcher.
 * @param {string}      path The subject, as `send()` was given it.
 * @return {boolean} True while that ask stands.
 */
const waiting = ( f, path ) => f.outbox.some( ( ask ) => ask.path === path );

/**
 * @param {string}   path  The reply's remaining TO — the subject it answers.
 * @param {string[]} args  The argument tokens it echoes, as both interpreters do.
 * @param {Object}   value The rest of the reply VALUE.
 * @return {Array} A positional reply message, as the server's echo delivers it.
 */
const replyNaming = ( path = '', args = [], value = {} ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ TO ] = path;
	m[ VALUE ] = { arguments: args, ...value };
	return m;
};

/**
 * The outbox: one ask outstanding at a time.
 *
 * A dashboard on a one-second refresh used to put a command on the wire every
 * second whether or not the last one had been answered, so a slow verb built a
 * queue of identical asks the server was still working through. An ask now
 * stands in the Fetcher's outbox until its reply settles it, and a trigger that
 * finds one there mints nothing.
 */
describe( 'FetcherNode — the outbox', () => {
	const mount = ( verb = 'counts' ) => {
		const f = new FetcherNode();
		f.arguments = [ 'counts:in', verb ];
		f.target = '_http/ci';
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		return { f, sent };
	};

	it( 'asks once and stays quiet while the ask is outstanding', () => {
		const { f, sent } = mount();
		f.fill( newMessage() );
		f.fill( newMessage() );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
	} );

	it( 'asks again once the reply settles the ask', () => {
		const { f, sent } = mount();
		f.fill( newMessage() );
		f.fill( replyNaming() );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 2 );
	} );

	it( 'reads the live args again on the ask AFTER the reply', () => {
		const { f, sent } = mount( 'urls' );
		let live = [ '--sort', 'count' ];
		f.command_args = () => live;
		f.fill( newMessage() );
		live = [ '--sort', 'avg_ms' ];
		f.fill( replyNaming( '', [ '--sort', 'count' ] ) );
		f.fill( newMessage() );
		expect( sent[ 1 ][ VALUE ].arguments ).toEqual( [
			'--sort',
			'avg_ms',
		] );
	} );

	it( 'asks again when the answer never came and the window elapsed', () => {
		const { f, sent } = mount();
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.fill( newMessage() );
		at.mockReturnValue( 1771000014 );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
		at.mockReturnValue( 1771000015 );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 2 );
		at.mockRestore();
	} );

	/**
	 * A re-ask must read the getter AGAIN. Replaying the args the ask was made
	 * with asks yesterday's question: a poll whose reply went missing re-sends
	 * the filter the operator has since changed, and the stale answer renders
	 * into a table already marked loading for the new one.
	 */
	it( 're-reads the live args when it asks again, rather than replaying', () => {
		const { f, sent } = mount( 'urls' );
		let live = [ '--search', 'wombat-4471' ];
		f.command_args = () => live;
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.fill( newMessage() );

		live = [ '--search', 'quokka-8823' ];
		at.mockReturnValue( 1771000015 );
		f.fill( newMessage() );

		expect( sent ).toHaveLength( 2 );
		expect( sent[ 1 ][ VALUE ].arguments ).toEqual( [
			'--search',
			'quokka-8823',
		] );
		at.mockRestore();
	} );

	it( 'drops a live ask whose getter has since gone quiet', () => {
		const { f, sent } = mount( 'urls' );
		let live = [ '--hash', 'abc' ];
		f.command_args = () => live;
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.fill( newMessage() );

		// The modal closed: nothing to ask about any more.
		live = null;
		at.mockReturnValue( 1771000015 );
		f.fill( newMessage() );

		expect( sent ).toHaveLength( 1 );
		expect( f.outbox ).toEqual( [] );
		at.mockRestore();
	} );

	// Never, for as long as the ask stands — and `ASK_EXPIRY_S` is how long
	// that can be, which the queued-ask suite pins separately.
	it( 'never re-asks while the ask stands, when the window is disabled', () => {
		const { f, sent } = mount( 'save' );
		f.retry_after_s = 0;
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.fill( newMessage() );
		at.mockReturnValue( 1771000119 );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
		at.mockRestore();
	} );

	it( 'settles nothing on a reply about another subject', () => {
		const { f, sent } = mount();
		f.fill( newMessage() );
		f.fill( replyNaming( 'quokka-8823' ) );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
	} );

	it( 'counts the answer it settles', () => {
		const { f } = mount();
		f.fill( newMessage() );
		f.fill( replyNaming() );
		expect( f.counter ).toBe( 2 );
	} );

	it( 'sends nothing on a reply alone', () => {
		const { f, sent } = mount();
		f.fill( replyNaming() );
		expect( sent ).toHaveLength( 0 );
	} );

	// A transport refusal never reached the verb, so the ask is unanswered:
	// asking again is the recovery, and waiting out the window is not.
	it( 're-asks on the next trigger when the batch never landed', () => {
		const { f, sent } = mount();
		f.fill( newMessage() );
		f.fill( replyNaming( '', [], { undelivered: true } ) );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 2 );
	} );
} );

/**
 * `send()` is the write side of the same outbox: a caller with an answer to
 * wait on parks its arguments, and the next trigger puts them on the wire. Two
 * rows deleted in the same second are two commands that both have to go, so a
 * queued ask never displaces another unless the caller says so.
 */
describe( 'FetcherNode — queued asks', () => {
	const mount = () => {
		const f = new FetcherNode();
		f.arguments = [ 'vault:delete:in', 'delete' ];
		f.target = '_http/vault';
		// A one-shot: the trigger mints nothing, `send()` supplies every ask.
		f.command_args = () => null;
		f.retry_after_s = 0;
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		return { f, sent };
	};

	it( 'sends a queued ask on the next trigger, addressed by its subject', () => {
		const { f, sent } = mount();
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ FROM ] ).toBe( 'vault:delete:in/wombat-4471' );
		expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [ 'wombat-4471' ] );
	} );

	it( 'sends BOTH queued asks in one trigger', () => {
		const { f, sent } = mount();
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.send( [ 'quokka-8823' ], 'quokka-8823' );
		f.fill( newMessage() );
		expect( sent.map( ( m ) => m[ VALUE ].arguments[ 0 ] ) ).toEqual( [
			'wombat-4471',
			'quokka-8823',
		] );
	} );

	it( 'settles the ask the reply names and leaves the other outstanding', () => {
		const { f } = mount();
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.send( [ 'quokka-8823' ], 'quokka-8823' );
		f.fill( newMessage() );
		f.fill( replyNaming( 'quokka-8823', [ 'quokka-8823' ] ) );
		expect( waiting( f, 'wombat-4471' ) ).toBe( true );
		expect( waiting( f, 'quokka-8823' ) ).toBe( false );
	} );

	it( 'displaces what is waiting when the caller supersedes', () => {
		const { f, sent } = mount();
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.send( [ 'quokka-8823' ], 'quokka-8823', true );
		f.fill( newMessage() );
		expect( sent.map( ( m ) => m[ VALUE ].arguments[ 0 ] ) ).toEqual( [
			'quokka-8823',
		] );
	} );

	/**
	 * A write is never re-asked — an unanswered one may already have applied —
	 * but it must not sit in the outbox for ever either. `useCommandOnce`
	 * derives `pending` straight from it, so a reply lost without a fabricated
	 * refusal (a graph rebuild mid-flight) left the row's spinner turning and
	 * its button disabled for the life of the page.
	 */
	it( 'gives up on an ask nothing ever answered, so nobody waits for ever', () => {
		const { f } = mount();
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.fill( newMessage() );
		expect( waiting( f, 'wombat-4471' ) ).toBe( true );

		at.mockReturnValue( 1771000119 );
		f.fill( newMessage() );
		expect( waiting( f, 'wombat-4471' ) ).toBe( true );

		at.mockReturnValue( 1771000121 );
		f.fill( newMessage() );
		expect( waiting( f, 'wombat-4471' ) ).toBe( false );
		at.mockRestore();
	} );

	it( 'settles a write the transport refused rather than sending it twice', () => {
		const { f, sent } = mount();
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.fill( newMessage() );
		f.fill(
			replyNaming( 'wombat-4471', [ 'wombat-4471' ], {
				undelivered: true,
			} )
		);
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 1 );
	} );

	it( 'notifies `settled` with the ask the reply answered', () => {
		const { f } = mount();
		const settled = [];
		f.registrations.settled ??= {};
		f.register( 'settled', 'spy', ( ask ) => {
			settled.push( ask.path );
			return true;
		} );
		f.send( [ 'wombat-4471' ], 'wombat-4471' );
		f.fill( newMessage() );
		f.fill( replyNaming( 'wombat-4471', [ 'wombat-4471' ] ) );
		expect( settled ).toEqual( [ 'wombat-4471' ] );
	} );

	it( '`settled` is an event: no field holds it, and a late listener hears nothing', () => {
		const { f } = mount();
		f.send( [ 'quokka-3390' ], 'quokka-3390' );
		f.fill( newMessage() );
		f.fill( replyNaming( 'quokka-3390', [ 'quokka-3390' ] ) );
		const late = [];
		f.registrations.settled ??= {};
		f.register( 'settled', 'late', ( ask ) => {
			late.push( ask );
			return true;
		} );
		expect( late ).toEqual( [] );
		expect( f ).not.toHaveProperty( 'settled' );
		expect( f.setStateCache.settled ).toBeUndefined();
	} );
} );

/**
 * `answers()` is the one test of whether a reply is still wanted: an ask in
 * the outbox carries that path AND exactly those argument tokens. Settling,
 * the transport re-arm and every gate downstream read it, so a reply to a
 * question the outbox no longer asks cannot pass for the answer to one it does.
 */
describe( 'FetcherNode — answers', () => {
	const mount = () => {
		const f = new FetcherNode();
		f.arguments = [ 'urls:in', 'urls' ];
		f.target = '_http/perf';
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		return { f, sent };
	};

	it( 'names an ask by its path and its argument tokens together', () => {
		const { f } = mount();
		f.send( [ '--search', 'wombat-4471' ], 'row-17' );
		expect( f.asks( 'row-17', [ '--search', 'wombat-4471' ] ) ).toBe(
			true
		);
		expect( f.asks( 'row-17', [ '--search', 'quokka-8823' ] ) ).toBe(
			false
		);
		expect( f.asks( 'row-18', [ '--search', 'wombat-4471' ] ) ).toBe(
			false
		);
		expect( f.asks( null, [ '--search', 'wombat-4471' ] ) ).toBe( false );
	} );

	it( 'compares token by token, so a space inside one is not two', () => {
		const { f } = mount();
		f.send( [ 'wombat 4471' ] );
		expect( f.asks( null, [ 'wombat', '4471' ] ) ).toBe( false );
		expect( f.asks( null, [ 'wombat 4471' ] ) ).toBe( true );
		expect( f.asks( null, [ 'wombat 4471', '' ] ) ).toBe( false );
	} );

	it( 'reads a token as both interpreters echo it, a string', () => {
		const { f } = mount();
		f.send( [ 'offset', 300 ] );
		expect( f.asks( null, [ 'offset', '300' ] ) ).toBe( true );
	} );

	it( 'answers a reply by its remaining TO and the arguments it echoes', () => {
		const { f } = mount();
		f.send( [ '--search', 'wombat-4471' ], 'row-17' );
		expect(
			f.answers( replyNaming( 'row-17', [ '--search', 'wombat-4471' ] ) )
		).toBe( true );
		expect(
			f.answers( replyNaming( 'row-17', [ '--search', 'quokka-8823' ] ) )
		).toBe( false );
	} );

	it( 'answers nothing for a reply that echoes no arguments', () => {
		const { f } = mount();
		f.send( [] );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ VALUE ] = { payload: 'kea-ok' };
		expect( f.answers( m ) ).toBe( false );
		m[ TYPE ] = TM_ERROR;
		m[ VALUE ] = 'NOT_AVAILABLE\n';
		expect( f.answers( m ) ).toBe( false );
	} );

	/**
	 * A live ask re-asked past its window re-reads the getter, so the ask
	 * standing is the NEW question. The late answer to the old one must not
	 * settle it: that leaves the fresh answer finding nothing standing, and a
	 * gate reading the outbox drops it, so the view skips a refresh.
	 */
	it( 'leaves a refreshed ask standing for the late answer to its old args', () => {
		const { f, sent } = mount();
		let live = [ '--search', 'wombat-4471' ];
		f.command_args = () => live;
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.fill( newMessage() );
		live = [ '--search', 'quokka-8823' ];
		at.mockReturnValue( 1771000015 );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 2 );

		f.fill( replyNaming( '', [ '--search', 'wombat-4471' ] ) );
		expect( f.asks( null, [ '--search', 'quokka-8823' ] ) ).toBe( true );

		f.fill( replyNaming( '', [ '--search', 'quokka-8823' ] ) );
		expect( f.outbox ).toEqual( [] );
		at.mockRestore();
	} );

	it( 'leaves a refreshed ask armed when the OLD ask comes back undelivered', () => {
		const { f, sent } = mount();
		let live = [ '--search', 'wombat-4471' ];
		f.command_args = () => live;
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.fill( newMessage() );
		live = [ '--search', 'quokka-8823' ];
		at.mockReturnValue( 1771000015 );
		f.fill( newMessage() );

		f.fill(
			replyNaming( '', [ '--search', 'wombat-4471' ], {
				undelivered: true,
			} )
		);
		f.fill( newMessage() );
		// The refreshed ask is on the wire; a refusal of another is not its.
		expect( sent ).toHaveLength( 2 );
		at.mockRestore();
	} );
} );

/**
 * A reply that echoes no arguments — the Router's bare `NOT_AVAILABLE\n`
 * bounce — settles by its address alone, the oldest ask on that path, so a
 * write to a missing CI hears the refusal instead of standing until it
 * expires.
 */
describe( 'FetcherNode — a reply that echoes no arguments', () => {
	/**
	 * @param {string} path  The remaining TO.
	 * @param {*}      value The bounce's VALUE.
	 * @return {Array} A bare TM_ERROR, as the Router bounces a miss.
	 */
	const bounce = ( path, value = 'NOT_AVAILABLE\n' ) => {
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ TO ] = path;
		m[ VALUE ] = value;
		return m;
	};
	const mountWrite = () => {
		const f = new FetcherNode();
		f.arguments = [ 'vault:remove:in', 'remove' ];
		f.command_args = () => null;
		f.retry_after_s = 0;
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		return { f, sent };
	};

	it( 'settles the write a NOT_AVAILABLE bounce names', () => {
		const { f } = mountWrite();
		const settled = [];
		f.registrations.settled ??= {};
		f.register( 'settled', 'spy', ( ask ) => {
			settled.push( ask.args );
			return true;
		} );
		f.send( [ 'spoke-4471' ], 'spoke-4471' );
		f.fill( newMessage() );

		f.fill( bounce( 'spoke-4471' ) );

		expect( waiting( f, 'spoke-4471' ) ).toBe( false );
		expect( settled ).toEqual( [ [ 'spoke-4471' ] ] );
	} );

	it( 'settles the oldest ask on its path, and only that one', () => {
		const { f } = mountWrite();
		f.send( [ 'spoke-4471', 'rev-3' ], 'spoke-4471' );
		f.send( [ 'spoke-4471', 'rev-9' ], 'spoke-4471' );
		f.send( [ 'spoke-0932' ], 'spoke-0932' );
		f.fill( newMessage() );

		f.fill( bounce( 'spoke-4471' ) );

		expect( f.outbox.map( ( ask ) => ask.args ) ).toEqual( [
			[ 'spoke-4471', 'rev-9' ],
			[ 'spoke-0932' ],
		] );
	} );

	it( 're-arms a read it names when the batch never landed', () => {
		const f = new FetcherNode();
		f.arguments = [ 'counts:in', 'counts' ];
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		f.fill( newMessage() );

		f.fill( bounce( '', { undelivered: true } ) );
		f.fill( newMessage() );

		expect( sent ).toHaveLength( 2 );
	} );
} );

/**
 * `withdraw()` is how a view stops wanting an answer without asking anew: the
 * operator emptied the search box, so there is no newer question to supersede
 * the old one. It sends nothing and cancels nothing on the wire; the request
 * completes, and its answer finds no ask standing.
 */
describe( 'FetcherNode — withdraw', () => {
	const mount = () => {
		const f = new FetcherNode();
		f.arguments = [ 'search:in', 'search' ];
		f.command_args = () => null;
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		return { f, sent };
	};

	it( 'withdraws every standing ask, so none is asked any more', () => {
		const { f, sent } = mount();
		f.send( [ 'kakapo-3317' ], 'kakapo-3317' );
		f.send( [ 'takahe-0912' ], 'takahe-0912' );
		f.fill( newMessage() );
		expect( sent ).toHaveLength( 2 );

		f.withdraw();

		expect( f.outbox ).toEqual( [] );
		expect( f.asks( 'kakapo-3317', [ 'kakapo-3317' ] ) ).toBe( false );
		expect( f.asks( 'takahe-0912', [ 'takahe-0912' ] ) ).toBe( false );
		expect( sent ).toHaveLength( 2 );
	} );

	it( 'notifies `settled` for each ask it withdraws', () => {
		const { f } = mount();
		const settled = [];
		f.registrations.settled ??= {};
		f.register( 'settled', 'spy', ( ask ) => {
			settled.push( ask.path );
			return true;
		} );
		f.send( [ 'kakapo-3317' ], 'kakapo-3317' );
		f.send( [ 'takahe-0912' ], 'takahe-0912' );

		f.withdraw();

		expect( settled ).toEqual( [ 'kakapo-3317', 'takahe-0912' ] );
	} );

	it( 'never sends an ask withdrawn before its trigger', () => {
		const { f, sent } = mount();
		f.send( [ 'kakapo-3317' ] );
		f.withdraw();
		f.fill( newMessage() );
		expect( sent ).toEqual( [] );
	} );

	it( 'settles nothing when the late answer lands, and asks nothing again', () => {
		const { f, sent } = mount();
		f.retry_after_s = 5;
		const at = jest.spyOn( Core, 'now' );
		at.mockReturnValue( 1771000000 );
		f.send( [ 'kakapo-3317' ] );
		f.fill( newMessage() );
		f.withdraw();

		f.fill( replyNaming( '', [ 'kakapo-3317' ] ) );
		f.fill( replyNaming( '', [ 'kakapo-3317' ], { undelivered: true } ) );
		at.mockReturnValue( 1771000060 );
		f.fill( newMessage() );

		expect( f.outbox ).toEqual( [] );
		expect( sent ).toHaveLength( 1 );
		at.mockRestore();
	} );
} );

/**
 * `askNow()` asks a question at once: it supersedes every older ask and sends
 * in the same breath, rather than waiting for the next trigger.
 */
describe( 'FetcherNode — askNow', () => {
	it( 'replaces what stands and puts the new question on the wire', () => {
		const f = new FetcherNode();
		f.arguments = [ 'urls:in', 'urls' ];
		f.command_args = () => [ '--search', 'wombat-4471' ];
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };
		f.fill( newMessage() );

		const ask = f.askNow( [ '--search', 'quokka-8823' ] );

		expect( sent ).toHaveLength( 2 );
		expect( sent[ 1 ][ FROM ] ).toBe( 'urls:in' );
		expect( sent[ 1 ][ VALUE ].arguments ).toEqual( [
			'--search',
			'quokka-8823',
		] );
		expect( f.outbox ).toEqual( [ ask ] );
		expect( f.asks( null, [ '--search', 'wombat-4471' ] ) ).toBe( false );
	} );

	it( 'addresses the ask by the path it is given', () => {
		const f = new FetcherNode();
		f.arguments = [ 'vault:test:in', 'test' ];
		f.command_args = () => null;
		const sent = [];
		f.sink = { fill: ( m ) => sent.push( m ) };

		f.askNow( [ 'spoke-0417' ], 'spoke-0417' );

		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ FROM ] ).toBe( 'vault:test:in/spoke-0417' );
		expect( f.asks( 'spoke-0417', [ 'spoke-0417' ] ) ).toBe( true );
	} );
} );

test( 'declares its trailing command_args as the one variadic argument', () => {
	const declared = FetcherNode.nodeSchema().arguments;

	expect( declared.map( ( a ) => a.name ) ).toEqual( [
		'receiver',
		'command',
		'command_args',
	] );
	expect( declared.filter( ( a ) => a.variadic ) ).toEqual( [
		expect.objectContaining( { name: 'command_args' } ),
	] );
} );

/**
 * TM_INFO carries a scalar, and `settled` carries the ask object, so it is an
 * event for closures alone (`useNodeEvent` declares it), never a node-name
 * registration a `register` verb could reach.
 */
test( 'settled is not a declared node-name registration', () => {
	expect( FetcherNode.nodeSchema().registrations ?? [] ).not.toContain(
		'settled'
	);
} );
