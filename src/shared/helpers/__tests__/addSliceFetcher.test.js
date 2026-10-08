/**
 * addSliceFetcher tests — the per-slice wiring (`SLICES.forEach` body) as one
 * call. It wires `Fetcher → <target>`, the receiver `Tee`, the view node, and
 * (optionally) a transform node inserted on the receiver-Tee → view edge.
 *
 * The graph it builds, per slice:
 *   tee ─> fetch-x (Fetcher) ─> <target>            (the tick fans out to it)
 *   xIn (Tee) ─> [transform ─>] x:view (viewClass)  (the reply routes back here)
 *             ─> fetch-x                            (…and settles the ask)
 */

import {
	Core,
	Node,
	mountExospine,
	CommandInterpreterNode,
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_RESPONSE,
} from '@newspack-nodes/runtime';
import { addSliceFetcher } from '../addSliceFetcher';
import { egressPath } from '../egressPath';
import { CurrentNode } from '../../nodes/current-node';

// Minimal registered view + transform classes so makeNode can build them.
class FakeViewNode extends Node {}
class FakeTransformNode extends Node {}

const TARGET = egressPath( 'pangolin', 'insights-demo' );

let interpreter;
let tee;
let teardown;

beforeEach( () => {
	Core.reset();
	CommandInterpreterNode.registerNodeClasses( {
		FakeView: FakeViewNode,
		FakeTransform: FakeTransformNode,
	} );
	// A bare backbone + a fan-out Tee for addSliceFetcher to fan fetchers from.
	const spine = mountExospine( ( { interpreter: i } ) => {
		interpreter = i;
		tee = i.makeNode( 'Tee', 'poll:tee' );
	} );
	teardown = spine.teardown;
} );

afterEach( () => {
	teardown();
} );

describe( 'addSliceFetcher — wiring', () => {
	test( 'creates the Fetcher with `<receiver> <command>`, targeting the egress path, sinking into the interpreter', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );

		const f = Core.node( 'counts:fetch' );
		expect( f ).toBeTruthy();
		expect( f.receiver ).toBe( 'counts:in' );
		expect( f.verb ).toBe( 'counts' );
		expect( f.target ).toBe( 'shell:pangolin/_http/insights-demo' );
		expect( f.sink ).toBe( interpreter );
	} );

	test( 'fans the tick from the supplied Tee to the Fetcher', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( tee.target ).toContain( 'counts:fetch' );
	} );

	test( 'creates the receiver Tee, its gate, and the view node', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );

		const recv = Core.node( 'counts:in' );
		expect( recv ).toBeTruthy();
		expect( recv.target ).toContain( 'counts:in:current' );
		// …and back to the Fetcher, which settles the ask the reply answers.
		expect( recv.target ).toContain( 'counts:fetch' );

		const view = Core.node( 'counts:view' );
		expect( view ).toBeTruthy();
		expect( view ).toBeInstanceOf( FakeViewNode );
		expect( view.sink ).toBe( interpreter );
	} );

	test( 'returns the receiver name', () => {
		const receiver = addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( receiver ).toBe( 'counts:in' );
	} );
} );

describe( 'addSliceFetcher — optional argsFn (fire-time getter)', () => {
	test( 'sets the Fetcher command_args to the supplied getter', () => {
		const argsFn = () => '--sort count';
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			argsFn,
		} );
		expect( Core.node( 'urls:fetch' ).command_args ).toBe( argsFn );
	} );

	test( 'without argsFn, command_args stays the static (empty) token array', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( Core.node( 'counts:fetch' ).command_args ).toEqual( [] );
	} );
} );

describe( 'addSliceFetcher — optional transform', () => {
	test( 'with no transform, the gate connects straight to the view', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		// ORDER matters, so `toEqual` and not `arrayContaining`: the Fetcher
		// settles the ask, and a consumer acting once per ANSWER reads
		// `answers()` as the view renders — which only works while it is last.
		expect( Core.node( 'counts:in' ).target ).toEqual( [
			'counts:in:current',
			'counts:fetch',
		] );
		expect( Core.node( 'counts:in:current' ).target ).toEqual( [
			'counts:view',
		] );
	} );

	test( 'with a transform, inserts it on the gate → view edge (Tee → gate → transform → view)', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			transform: {
				name: 'urls:merge',
				nodeClass: 'FakeTransform',
			},
		} );

		// The gate fans to the transform, NOT straight to the view.
		expect( Core.node( 'urls:in' ).target ).toEqual( [
			'urls:in:current',
			'urls:fetch',
		] );
		expect( Core.node( 'urls:in:current' ).target ).toEqual( [
			'urls:merge',
		] );
		// The transform forwards to the view.
		const transform = Core.node( 'urls:merge' );
		expect( transform ).toBeInstanceOf( FakeTransformNode );
		expect( transform.target ).toBe( 'urls:view' );
		expect( transform.sink ).toBe( interpreter );
		// The view still exists, sinking into the interpreter.
		expect( Core.node( 'urls:view' ).sink ).toBe( interpreter );
	} );

	test( 'passes the transform args through to makeNode', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			transform: {
				name: 'urls:merge',
				nodeClass: 'FakeTransform',
				args: [ 'dedup', '30' ],
			},
		} );
		expect( Core.node( 'urls:merge' ).arguments ).toEqual( [
			'dedup',
			'30',
		] );
	} );
} );

// controlFrom is opt-in: a view that takes local controls declares the origin
// it trusts. Stamping every view's own name planted an inert field on the nine
// that own no control path, and the WRONG name on WorkerStatusView, whose
// controls come from its transform.
describe( 'addSliceFetcher — controlFrom', () => {
	test( 'leaves controlFrom alone on a view that declares no control origin', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );

		expect( Core.node( 'counts:view' ).controlFrom ).toBeUndefined();
	} );

	test( 'sets the transform its OWN control origin, for a dashboard that drives it', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			transform: {
				name: 'urls:merge',
				nodeClass: 'FakeTransform',
				controlFrom: 'urls:merge',
			},
		} );

		expect( Core.node( 'urls:merge' ).controlFrom ).toBe( 'urls:merge' );
		// The view's own origin is a separate slot, and stays unset.
		expect( Core.node( 'urls:view' ).controlFrom ).toBeUndefined();
	} );

	test( 'sets the declared control origin, which need not be the view', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'counts:fetch',
			receiver: 'counts:in',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			controlFrom: 'counts:transform',
			tee,
			target: TARGET,
		} );

		expect( Core.node( 'counts:view' ).controlFrom ).toBe(
			'counts:transform'
		);
	} );
} );

// Every slice gates its reply on the Fetcher's outbox: only the answer to a
// question still asked reaches the view, and a refusal goes to the view itself.
describe( 'addSliceFetcher — the gate', () => {
	test( 'names `<receiver>:current` after the Fetcher and the view, ahead of the Fetcher', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			transform: { name: 'urls:merge', nodeClass: 'FakeTransform' },
		} );

		// ORDER matters: the Fetcher settles the ask the gate reads, so it is LAST.
		expect( Core.node( 'urls:in' ).target ).toEqual( [
			'urls:in:current',
			'urls:fetch',
		] );
		const gate = Core.node( 'urls:in:current' );
		expect( gate ).toBeInstanceOf( CurrentNode );
		expect( gate.fetcher ).toBe( 'urls:fetch' );
		expect( gate.view ).toBe( 'urls:view' );
		expect( gate.sink ).toBe( interpreter );
	} );

	test( 'registers the gate as `Current`, the name TSL spells', () => {
		expect( CommandInterpreterNode.includeNodes.Current ).toBe(
			CurrentNode
		);
	} );

	/**
	 * Through the Router.
	 *
	 * @param {Array}  args The tokens the reply echoes.
	 * @param {number} kind TM_RESPONSE or TM_ERROR.
	 */
	const answer = ( args, kind = TM_RESPONSE ) => {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | kind;
		m[ TO ] = 'urls:in';
		m[ VALUE ] = { name: 'urls', arguments: args, payload: {} };
		interpreter.fill( m );
	};

	// @longform End to end through the Router: a live ask re-asked with new
	// arguments, then the late answer to the OLD ones, then the answer to the
	// new. The view hears only the last, and the Fetcher settles on it.
	test( 'lets only the answer to the standing question reach the view', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		const heard = [];
		Core.node( 'urls:view' ).fill = ( m ) =>
			heard.push( m[ VALUE ].arguments );
		const f = Core.node( 'urls:fetch' );
		f.send( [ '--search', 'wombat-4471' ] );
		f.send( [ '--search', 'quokka-8823' ], null, true );

		answer( [ '--search', 'wombat-4471' ] );
		expect( heard ).toEqual( [] );
		expect( f.asks( null, [ '--search', 'quokka-8823' ] ) ).toBe( true );

		answer( [ '--search', 'quokka-8823' ] );
		expect( heard ).toEqual( [ [ '--search', 'quokka-8823' ] ] );
		expect( f.outbox ).toEqual( [] );
	} );

	// A transform shapes data; the view owns the error state.
	test( 'sends a refusal to the view, around the transform', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'urls:fetch',
			receiver: 'urls:in',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			transform: { name: 'urls:merge', nodeClass: 'FakeTransform' },
		} );
		const viewHeard = [];
		const mergeHeard = [];
		Core.node( 'urls:view' ).fill = ( m ) => viewHeard.push( m[ TYPE ] );
		Core.node( 'urls:merge' ).fill = ( m ) => mergeHeard.push( m[ TYPE ] );
		Core.node( 'urls:fetch' ).send( [ '--offset', '700' ] );

		answer( [ '--offset', '700' ], TM_ERROR );

		expect( mergeHeard ).toEqual( [] );
		expect( viewHeard ).toEqual( [ TM_COMMAND | TM_ERROR ] );
	} );
} );
