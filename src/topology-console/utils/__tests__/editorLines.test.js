/**
 * The Inspector's edits, as TSL.
 *
 * Both defects here are silent: the canvas shows what the operator typed and
 * the saved file says something else.
 */

import {
	setArgumentsLine,
	verbInvocationArgs,
	verbUsesConfig,
	isConfigurableVerb,
} from '../editorLines';
import { DraftInterpreterNode } from '../../../runtime/draft-interpreter-node';

describe( 'setArgumentsLine', () => {
	it( 'writes the empty slots before the edited one, keeping its position', () => {
		// A sparse array joined naively drops the holes, and the value lands
		// in slot 0 — a Partition whose segment size becomes its filename.
		const args = [];
		args[ 2 ] = 'aardvark';

		expect( setArgumentsLine( 'p', args, [] ) ).toBe(
			"set_arguments p '' '' aardvark"
		);
	} );

	it( 'leaves an untouched span alone instead of re-quoting it', () => {
		const current = [ 'x', "'foo bar'" ];

		const line = setArgumentsLine( 'p', [ 'y', "'foo bar'" ], current );

		expect( line ).toBe( "set_arguments p y 'foo bar'" );
	} );

	it( 'keeps a quote whose job is to DEFER interpolation', () => {
		// The Inspector renders each slot through `argDisplayValue`, which
		// tokenizes — so an untouched slot comes back WITHOUT its quotes and
		// never equals the stored span. Re-emitted bare, `'<config:x>'` stops
		// deferring and the loader expands it at parse time.
		const current = [ "'<config:partitions>'", 'old' ];

		const line = setArgumentsLine(
			'p',
			[ '<config:partitions>', 'new' ],
			current
		);

		expect( line ).toBe( "set_arguments p '<config:partitions>' new" );
	} );

	it( 'survives repeated edits without accreting quotes', () => {
		const d = new DraftInterpreterNode();
		d.load( "make_node Echo p x 'foo bar'" );

		for ( const value of [ 'y', 'z' ] ) {
			const current = d.childRegistry.node( 'p' ).arguments;
			d.run( setArgumentsLine( 'p', [ value, current[ 1 ] ], current ) );
		}

		expect( d.dumpDocument() ).toBe( "make_node Echo p z 'foo bar'\n" );
	} );

	it( 'quotes a newly-typed value that needs it', () => {
		expect( setArgumentsLine( 'p', [ 'a b' ], [ 'x' ] ) ).toBe(
			"set_arguments p 'a b'"
		);
	} );
} );

describe( 'verbUsesConfig', () => {
	it( 'keeps the form the file used', () => {
		expect(
			verbUsesConfig( { verb: 'help', viaConfig: false }, undefined )
		).toBe( false );
	} );

	it( 'sends a new verb through :config unless the class is an interpreter', () => {
		expect(
			verbUsesConfig( { verb: 'set_x' }, { is_interpreter: false } )
		).toBe( true );
		expect(
			verbUsesConfig( { verb: 'help' }, { is_interpreter: true } )
		).toBe( false );
	} );
} );

describe( 'setArgumentsLine — schema defaults', () => {
	const spec = [
		{ name: 'file', type: 'string' },
		{ name: 'segment_size', type: 'int', default: 4096 },
		{ name: 'min_segments', type: 'int', default: 2 },
	];

	it( 'fills an unset earlier slot from its default, not with an empty token', () => {
		// PHP `parse_schema_args` tests `isset()`, and `''` IS set — so an
		// empty token skips the declared default and coerces to 0. Editing one
		// argument would silently zero every earlier unset one.
		const args = [ '/x.log' ];
		args[ 2 ] = '9';

		expect( setArgumentsLine( 'p', args, [ '/x.log' ], spec ) ).toBe(
			'set_arguments p /x.log 4096 9'
		);
	} );

	it( 'drops trailing empties rather than writing them out', () => {
		expect(
			setArgumentsLine(
				'p',
				[ '/x.log', '', '' ],
				[ '/x.log' ],
				[
					{ name: 'file', type: 'string' },
					{ name: 'a', type: 'string' },
					{ name: 'b', type: 'string' },
				]
			)
		).toBe( 'set_arguments p /x.log' );
	} );
} );

describe( 'verbInvocationArgs', () => {
	const spec = [
		{ name: 'window', type: 'int', default: 300 },
		{ name: 'label', type: 'string' },
	];

	it( 'fills a slot the verb toggle seeded empty from its default', () => {
		// The Inspector's toggle seeds `args: cspec.args.map( () => \'\' )`.
		// Written out bare those are SET as far as PHP is concerned, so the
		// declared default is skipped and an int coerces to 0.
		expect( verbInvocationArgs( [ '', '' ], spec ) ).toEqual( [ '300' ] );
	} );

	it( 'keeps an author value after a defaulted slot', () => {
		expect( verbInvocationArgs( [ '', 'x' ], spec ) ).toEqual( [
			'300',
			'x',
		] );
	} );

	it( 'passes through when there is no schema', () => {
		expect( verbInvocationArgs( [ 'a', 'b' ], null ) ).toEqual( [
			'a',
			'b',
		] );
	} );
} );

/**
 * A verb that DOES something — purge a cache, delete an entry — is not
 * configuration. The topology editor renders each config verb as a checkbox
 * whose toggle serializes `cmd <node>:config <verb>` into the .tsl, so an
 * action offered there runs on EVERY worker boot. It stays a verb, invocable
 * at runtime; it just must not be offered as a persisted setting.
 */
describe( 'isConfigurableVerb', () => {
	it( 'offers a plain setter', () => {
		expect( isConfigurableVerb( { name: 'set_errors_target' } ) ).toBe(
			true
		);
	} );

	it( 'withholds a verb marked as an action', () => {
		expect( isConfigurableVerb( { name: 'purge', action: true } ) ).toBe(
			false
		);
	} );

	it( 'still withholds schema-plumbing verbs marked hidden', () => {
		expect( isConfigurableVerb( { name: 'x', hidden: true } ) ).toBe(
			false
		);
	} );
} );
