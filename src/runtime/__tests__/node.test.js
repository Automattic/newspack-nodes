import { Node } from '../node';
import { Core } from '../core';
import { FROM, TO, KEY, VALUE, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'setName registers in Core', () => {
	const n = new Node();
	n.name = 'alice';
	expect( Core.node( 'alice' ) ).toBe( n );
} );

test( 'removeNode clears patron (no dangling back-pointer)', () => {
	const owner = new Node();
	owner.name = 'owner';
	const sib = new Node();
	sib.name = 'sib';
	sib.patron = owner;
	sib.removeNode();
	expect( sib.patron ).toBeNull();
} );

test( 'rename moves the registry slot', () => {
	const n = new Node();
	n.name = 'alice';
	n.name = 'bob';
	expect( Core.node( 'alice' ) ).toBeNull();
	expect( Core.node( 'bob' ) ).toBe( n );
} );

test( 'log_midfix tags each line with the node name', () => {
	const n = new Node();
	n.name = 'mynode';
	expect( n.log_midfix() ).toBe( 'mynode: ' );
	expect( n.log_midfix( 'a\nb' ) ).toBe( 'mynode: a\nmynode: b\n' );
} );

test( 'log_midfix is the empty tag for an unnamed node', () => {
	const n = new Node();
	expect( n.log_midfix() ).toBe( '' );
	expect( n.log_midfix( 'x\n\n' ) ).toBe( 'x\n' );
} );

test( 'stderr emits a prefixed, node-tagged line to recentLog', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const n = new Node();
	n.name = 'logger';
	n.stderr( 'hello' );
	expect( Core.recentLog ).toHaveLength( 1 );
	expect( Core.recentLog[ 0 ] ).toMatch(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC browser: logger: hello\n$/
	);
	spy.mockRestore();
} );

test( 'stderr on an unnamed node carries no node tag', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const n = new Node();
	n.stderr( 'plain' );
	expect( Core.recentLog[ 0 ] ).toMatch( /UTC browser: plain\n$/ );
	spy.mockRestore();
} );

test( 'rename collision throws', () => {
	const a = new Node();
	a.name = 'alice';
	const b = new Node();
	expect( () => ( b.name = 'alice' ) ).toThrow( /already registered/ );
} );

test( 'command stamps FROM with the node name', () => {
	// Mirrors PHP Node::command — a node minting a command tags it with its own
	// name so the issuer is visible. Shell.sendCommand overwrites FROM with the
	// session reply pivot; an overlay node issuing a command keeps its name.
	const n = new Node();
	n.name = 'alice';
	const m = n.command( 'connect_node', 'a b' );
	expect( m[ FROM ] ).toBe( 'alice' );
} );

test( 'fill stamps TO from target when message TO is empty', () => {
	const sink = new Node();
	sink.name = 'sink';
	const captured = [];
	sink.fill = ( m ) => captured.push( [ ...m ] );

	const n = new Node();
	n.sink = sink;
	n.target = 'sink';

	const m = newMessage();
	m[ VALUE ] = 'hi';
	n.fill( m );
	expect( captured[ 0 ][ TO ] ).toBe( 'sink' );
} );

test( 'fill does NOT overwrite an existing TO', () => {
	const sink = new Node();
	const captured = [];
	sink.fill = ( m ) => captured.push( [ ...m ] );

	const n = new Node();
	n.sink = sink;
	n.target = 'sink';

	const m = newMessage();
	m[ TO ] = 'preset';
	n.fill( m );
	expect( captured[ 0 ][ TO ] ).toBe( 'preset' );
} );

test( 'counter increments on each fill', () => {
	const sink = new Node();
	sink.fill = () => {};
	const n = new Node();
	n.sink = sink;
	expect( n.counter ).toBe( 0 );
	n.fill( newMessage() );
	n.fill( newMessage() );
	expect( n.counter ).toBe( 2 );
} );

test( 'stampMessage prepends name to FROM', () => {
	const n = new Node();
	const m = newMessage();
	m[ FROM ] = 'a/b';
	expect( n.stampMessage( m, 'c' ) ).toBe( true );
	expect( m[ FROM ] ).toBe( 'c/a/b' );
} );

test( 'stampMessage empty name returns false', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const n = new Node();
	const m = newMessage();
	expect( n.stampMessage( m, '' ) ).toBe( false );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	spy.mockRestore();
} );

test( 'stampMessage with FROM exceeding MAX_FROM_SIZE returns false', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const n = new Node();
	const m = newMessage();
	m[ FROM ] = 'x'.repeat( 1024 );
	expect( n.stampMessage( m, 'c' ) ).toBe( false );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	spy.mockRestore();
} );

test( 'fill on a Node with no sink throws (mirrors PHP; counter not bumped)', () => {
	const n = new Node();
	expect( () => n.fill( newMessage() ) ).toThrow( /wired sink/ );
	expect( n.counter ).toBe( 0 );
} );

test( 'stampMessage on a message with empty FROM sets FROM to the name (no trailing slash)', () => {
	const n = new Node();
	const m = newMessage();
	expect( n.stampMessage( m, 'c' ) ).toBe( true );
	expect( m[ FROM ] ).toBe( 'c' );
} );

test( 'register requires the event to have been pre-declared', () => {
	const n = new Node();
	expect( () => n.register( 'UNKNOWN', 'listener', () => {} ) ).toThrow(
		/no such event/
	);
} );

test( 'declared event with closure listener fires on notify', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	const seen = [];
	n.register( 'HELLO', 'l1', ( p ) => {
		seen.push( p );
		return true;
	} );
	n.notify( 'HELLO', { v: 42 } );
	expect( seen ).toEqual( [ { v: 42 } ] );
} );

test( 'closure returning false unregisters itself', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	let calls = 0;
	n.register( 'HELLO', 'l1', () => {
		calls += 1;
		return false;
	} );
	n.notify( 'HELLO' );
	n.notify( 'HELLO' );
	expect( calls ).toBe( 1 );
} );

test( 'node-name listener mode forwards a TM_INFO to the named node', () => {
	Core.reset();
	const targetNode = new Node();
	targetNode.name = 'listener';
	const got = [];
	targetNode.fill = ( m ) => got.push( [ ...m ] );

	const n = new Node();
	n.name = 'producer';
	n.registrations.HELLO = {};
	n.register( 'HELLO', 'listener', null );

	n.notify( 'HELLO', 'payload-string' );
	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ KEY ] ).toBe( 'HELLO' );
	expect( got[ 0 ][ VALUE ] ).toBe( 'payload-string' );
	expect( got[ 0 ][ FROM ] ).toBe( 'producer' );
	// Delivered directly to the resolved node with empty TO; stamping TO=listener
	// re-routes through _router — across an SSE pivot it lands where neither the
	// listener nor the emitter exist, logging a spurious NOT_AVAILABLE.
	expect( got[ 0 ][ TO ] ).toBe( '' );
} );

test( 'setState caches payload and replays to late closure registrants', () => {
	const n = new Node();
	n.registrations.STATE = {};
	n.setState( 'STATE', 'cached' );
	const got = [];
	n.register( 'STATE', 'l1', ( p ) => {
		got.push( p );
		return true;
	} );
	expect( got ).toEqual( [ 'cached' ] );
} );

test( 'unregister stops further notifications', () => {
	const n = new Node();
	n.registrations.X = {};
	const got = [];
	n.register( 'X', 'l1', ( p ) => {
		got.push( p );
		return true;
	} );
	n.unregister( 'X', 'l1' );
	n.notify( 'X', 'after' );
	expect( got ).toEqual( [] );
} );

test( 'closure returning truthy stays registered across notifies', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	let calls = 0;
	n.register( 'HELLO', 'l1', () => {
		calls += 1;
		return true;
	} );
	n.notify( 'HELLO' );
	n.notify( 'HELLO' );
	expect( calls ).toBe( 2 );
} );

test( 'multiple closure listeners on the same event all fire', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	const got = [];
	n.register( 'HELLO', 'a', () => {
		got.push( 'a' );
		return true;
	} );
	n.register( 'HELLO', 'b', () => {
		got.push( 'b' );
		return true;
	} );
	n.notify( 'HELLO' );
	expect( got.sort() ).toEqual( [ 'a', 'b' ] );
} );

test( 'notify on an undeclared event is a silent no-op', () => {
	const n = new Node();
	expect( () => n.notify( 'NEVER', 'data' ) ).not.toThrow();
} );

describe( 'Node.registeredListeners', () => {
	it( 'returns node-name listeners only, omitting closures and empty events', () => {
		const n = new Node();
		n.registrations = { EVT: {}, OTHER: {} };
		n.register( 'EVT', 'node_listener' ); // cb null => node-name
		n.register( 'EVT', 'closure_listener', () => {} ); // closure => excluded
		expect( n.registeredListeners() ).toEqual( {
			EVT: [ 'node_listener' ],
		} );
	} );

	it( 'returns an empty object when only closures are registered', () => {
		const n = new Node();
		n.registrations = { EVT: {} };
		n.register( 'EVT', 'closure_only', () => {} );
		expect( n.registeredListeners() ).toEqual( {} );
	} );
} );

test( 'notify prunes a node-name listener whose target was removed', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const target = new Node();
	target.name = 'listener';
	const n = new Node();
	n.name = 'producer';
	n.registrations.EVT = {};
	n.register( 'EVT', 'listener', null );
	Core.unregisterNode( 'listener' );
	n.notify( 'EVT', 'data' );
	expect( n.registrations.EVT.listener ).toBeUndefined();
	spy.mockRestore();
} );

test( 'removeNode clears refs, unregisters from Core, and clears its name', () => {
	const n = new Node();
	n.name = 'doomed';
	n.target = 'somewhere';
	n.sink = new Node();
	n.registrations.EVT = { l1: () => {} };
	n.setStateCache.EVT = 'cached';

	n.removeNode();

	expect( Core.node( 'doomed' ) ).toBeNull();
	expect( n.registrations ).toEqual( {} );
	expect( n.setStateCache ).toEqual( {} );
	expect( n.sink ).toBeNull();
	expect( n.target ).toBe( '' );
	expect( n.name ).toBe( '' );
} );

test( 'removeNode cascade-unregisters the sibling interpreter and clears it', () => {
	const n = new Node();
	n.name = 'parent';
	const interpreter = new Node();
	interpreter.name = 'parent:config';
	n.interpreter = interpreter;

	n.removeNode();

	expect( Core.node( 'parent:config' ) ).toBeNull();
	expect( n.interpreter ).toBeNull();
} );

test( 'removeNode unregisters its OWN name LAST (Core.node sees null, not a half-torn-down self)', () => {
	const n = new Node();
	n.name = 'self-last';
	const interpreter = new Node();
	interpreter.name = 'self-last:config';
	n.interpreter = interpreter;

	let selfWhenInterpreterGone = 'unset';
	// At the moment the interpreter is removed, the parent must still be looked
	// up by name — proving the parent's own unregister happens after the cascade.
	const orig = Core.unregisterNode.bind( Core );
	const spy = jest
		.spyOn( Core, 'unregisterNode' )
		.mockImplementation( ( name ) => {
			if ( 'self-last:config' === name ) {
				selfWhenInterpreterGone = Core.node( 'self-last' );
			}
			return orig( name );
		} );

	n.removeNode();

	expect( selfWhenInterpreterGone ).toBe( n );
	spy.mockRestore();
} );

test( 'connectNode sets the base node string target', () => {
	const n = new Node();
	n.connectNode( 'dest' );
	expect( n.target ).toBe( 'dest' );
} );

test( 'connectNode replaces an existing base node target (single, not fan-out)', () => {
	const n = new Node();
	n.target = 'old';
	n.connectNode( 'new' );
	expect( n.target ).toBe( 'new' );
} );

test( 'disconnectNode clears the base node target', () => {
	const n = new Node();
	n.target = 'somewhere';
	n.disconnectNode();
	expect( n.target ).toBe( '' );
} );

test( 'disconnectNode with an explicit target still clears the base node target', () => {
	const n = new Node();
	n.target = 'somewhere';
	n.disconnectNode( 'somewhere' );
	expect( n.target ).toBe( '' );
} );
