/**
 * addSliceFetcher tests — the per-slice wiring (`SLICES.forEach` body) as one
 * call. It wires `Fetcher → <target>`, the receiver `Tee`, the view node, and
 * (optionally) a transform node inserted on the receiver-Tee → view edge.
 *
 * The graph it builds, per slice:
 *   tee ─> fetch-x (Fetcher) ─> <target>            (the tick fans out to it)
 *   xIn (Tee) ─> [transform ─>] x:view (viewClass)  (the reply pivots back here)
 */

import {
	Core,
	Node,
	mountExospine,
	CommandInterpreterNode,
} from '@newspack-nodes/runtime';
import { addSliceFetcher } from '../addSliceFetcher';

// Minimal registered view + transform classes so makeNode can build them.
class FakeViewNode extends Node {}
class FakeTransformNode extends Node {}

const TARGET = '_shell/_http/insights-demo';

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
			fetcher: 'fetch-counts',
			receiver: 'countsIn',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );

		const f = Core.node( 'fetch-counts' );
		expect( f ).toBeTruthy();
		expect( f.receiver ).toBe( 'countsIn' );
		expect( f.command ).toBe( 'counts' );
		expect( f.target ).toBe( TARGET );
		expect( f.sink ).toBe( interpreter );
	} );

	test( 'fans the tick from the supplied Tee to the Fetcher', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'fetch-counts',
			receiver: 'countsIn',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( tee.target ).toContain( 'fetch-counts' );
	} );

	test( 'creates the receiver Tee connected to the view node, and the view node', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'fetch-counts',
			receiver: 'countsIn',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );

		const recv = Core.node( 'countsIn' );
		expect( recv ).toBeTruthy();
		expect( recv.target ).toContain( 'counts:view' );

		const view = Core.node( 'counts:view' );
		expect( view ).toBeTruthy();
		expect( view ).toBeInstanceOf( FakeViewNode );
		expect( view.sink ).toBe( interpreter );
	} );

	test( 'returns the receiver name', () => {
		const receiver = addSliceFetcher( interpreter, {
			fetcher: 'fetch-counts',
			receiver: 'countsIn',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( receiver ).toBe( 'countsIn' );
	} );
} );

describe( 'addSliceFetcher — optional argsFn (fire-time getter)', () => {
	test( 'sets the Fetcher command_args to the supplied getter', () => {
		const argsFn = () => '--sort count';
		addSliceFetcher( interpreter, {
			fetcher: 'fetch-urls',
			receiver: 'urlsIn',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			argsFn,
		} );
		expect( Core.node( 'fetch-urls' ).command_args ).toBe( argsFn );
	} );

	test( 'without argsFn, command_args stays the static (empty) string', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'fetch-counts',
			receiver: 'countsIn',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( Core.node( 'fetch-counts' ).command_args ).toBe( '' );
	} );
} );

describe( 'addSliceFetcher — optional transform', () => {
	test( 'with no transform, the receiver Tee connects directly to the view', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'fetch-counts',
			receiver: 'countsIn',
			command: 'counts',
			view: 'counts:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
		} );
		expect( Core.node( 'countsIn' ).target ).toEqual( [ 'counts:view' ] );
	} );

	test( 'with a transform, inserts it on the receiver-Tee → view edge (Tee → transform → view)', () => {
		addSliceFetcher( interpreter, {
			fetcher: 'fetch-urls',
			receiver: 'urlsIn',
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

		// The receiver Tee fans to the transform, NOT straight to the view.
		expect( Core.node( 'urlsIn' ).target ).toEqual( [ 'urls:merge' ] );
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
			fetcher: 'fetch-urls',
			receiver: 'urlsIn',
			command: 'urls',
			view: 'urls:view',
			viewClass: 'FakeView',
			tee,
			target: TARGET,
			transform: {
				name: 'urls:merge',
				nodeClass: 'FakeTransform',
				args: 'dedup 30',
			},
		} );
		expect( Core.node( 'urls:merge' ).arguments ).toBe( 'dedup 30' );
	} );
} );
