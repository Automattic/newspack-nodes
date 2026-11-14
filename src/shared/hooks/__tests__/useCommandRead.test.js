/* eslint-env jest */
/**
 * useCommandRead sends its command whenever its arguments change and shows
 * only the answer to the question it is asking now, remembering each answer
 * per group; useCommandWrite sends once per run and hands each reply to its
 * caller.
 */

import {
	render,
	screen,
	fireEvent,
	act,
	waitFor,
} from '@testing-library/react';
import {
	Core,
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_ERROR,
} from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import {
	commandArgs,
	refusalOfSend,
	useCommandRead,
	useCommandWrite,
} from '../useCommandRead';

/** The surface every hook here sends under, distinct from any real one. */
const GROUP = 'kea-7802';

/** A second surface, whose memory must stay apart from the first's. */
const OTHER_GROUP = 'kea-7803';

/** The CI mount every command here lives on unless a write names another. */
const CI = 'tern';

let wire;

/**
 * The `/command` double: each verb answers what the test set, as a payload,
 * an `Error` (a refusal) or a function of the tokens it was sent and the
 * CI it was sent to.
 *
 * @return {{replies: Object, sent: (verb: string) => string[][], sentTo: (verb: string) => string[]}}
 *   The answers by verb; each send's tokens; and the CI each was addressed to.
 */
function replyWire() {
	const replies = {};
	const fake = installFakeCommandWire( ( m ) => {
		const answer = replies[ m[ VALUE ]?.name ];
		return 'function' === typeof answer
			? answer( m[ VALUE ].arguments ?? [], m[ TO ] )
			: answer;
	} );
	const ofVerb = ( verb ) =>
		fake.batches.flat().filter( ( m ) => verb === m[ VALUE ]?.name );
	return {
		replies,
		sent: ( verb ) =>
			ofVerb( verb ).map( ( m ) => m[ VALUE ].arguments ?? [] ),
		sentTo: ( verb ) => ofVerb( verb ).map( ( m ) => m[ TO ] ),
	};
}

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	wire = replyWire();
} );

function Reader( { args } ) {
	const { answer, error, loading } = useCommandRead( {
		group: GROUP,
		ci: CI,
		scope: 'probe:beacon',
		command: 'beacon',
		args,
	} );
	if ( error ) {
		return <p>refused: { error }</p>;
	}
	if ( loading ) {
		return <p>loading</p>;
	}
	return <p>{ answer ? `answer: ${ answer.name }` : 'nothing asked' }</p>;
}

function Writer( { refresh, onRefused, onSent = () => {}, ci = CI } ) {
	const { run, refusal, pending, answer } = useCommandWrite( 'moor_boat', {
		group: GROUP,
		ci,
		refresh,
		onRefused,
	} );
	return (
		<>
			{ pending && <p>pending</p> }
			<button
				type="button"
				className="button"
				onClick={ () => onSent( run( { key: 'light:cape-7811' } ) ) }
			>
				moor
			</button>
			{ refusal && <p>refusal: { refusal }</p> }
			{ answer && <p>answered: { answer.event_id }</p> }
		</>
	);
}

function Dirtier( { command, dirties, refresh, group = GROUP } ) {
	const { run } = useCommandWrite( command, {
		group,
		ci: CI,
		scope: `probe:${ group }:${ command }`,
		dirties,
		refresh,
	} );
	return (
		<button
			type="button"
			className="button"
			onClick={ () => run( { item: 'north-reach:memo' } ) }
		>
			{ command }
		</button>
	);
}

describe( 'useCommandRead', () => {
	it( 'sends its verb with its arguments through its group to its CI and shows the answer', async () => {
		wire.replies.beacon = ( [ key ] ) => ( {
			name: `named ${ key }`,
			available: true,
		} );
		render( <Reader args={ [ 'light:cape-7811' ] } /> );
		expect(
			await screen.findByText( 'answer: named light:cape-7811' )
		).toBeTruthy();
		expect( wire.sent( 'beacon' ) ).toEqual( [ [ 'light:cape-7811' ] ] );
		expect( wire.sentTo( 'beacon' ) ).toEqual( [ CI ] );
		expect( Core.node( 'probe:beacon:fetch' ).target ).toBe(
			'kea-7802:shell/_http/tern'
		);
	} );

	it( 'asks again when its arguments change, showing the new answer', async () => {
		wire.replies.beacon = ( [ key ] ) => ( { name: key, available: true } );
		const { rerender } = render(
			<Reader args={ [ 'light:cape-7811' ] } />
		);
		await screen.findByText( 'answer: light:cape-7811' );
		rerender( <Reader args={ [ 'light:spit-7812' ] } /> );
		expect(
			await screen.findByText( 'answer: light:spit-7812' )
		).toBeTruthy();
	} );

	it( 'shows a refusal as the refusal', async () => {
		wire.replies.beacon = () => new Error( 'no beacon: light:nowhere' );
		render( <Reader args={ [ 'light:nowhere' ] } /> );
		expect(
			await screen.findByText( /refused: no beacon: light:nowhere/ )
		).toBeTruthy();
	} );

	it( 'shows a refusal that echoes no arguments rather than loading forever', async () => {
		render( <Reader args={ [ 'light:cape-7811' ] } /> );
		await waitFor( () =>
			expect( wire.sent( 'beacon' ) ).toHaveLength( 1 )
		);
		const bounce = newMessage();
		bounce[ TYPE ] = TM_ERROR;
		bounce[ TO ] = 'probe:beacon:in';
		bounce[ VALUE ] = 'NOT_AVAILABLE\n';
		await act( async () => {
			Core.node( '_command_interpreter' ).fill( bounce );
		} );
		expect(
			await screen.findByText( /refused: NOT_AVAILABLE/ )
		).toBeTruthy();
	} );

	it( 're-asks a request that went missing, unless it declines retries', async () => {
		function Retrying( { retry } ) {
			useCommandRead( {
				group: GROUP,
				ci: CI,
				scope: `probe:retry-${ retry }`,
				command: 'gauge',
				args: [ 'tide' ],
				...( undefined === retry ? {} : { retry } ),
			} );
			return null;
		}
		render(
			<>
				<Retrying />
				<Retrying retry={ false } />
			</>
		);
		await act( async () => {} );
		expect(
			Core.node( 'probe:retry-undefined:fetch' ).retry_after_s
		).toBeGreaterThan( 0 );
		expect( Core.node( 'probe:retry-false:fetch' ).retry_after_s ).toBe(
			0
		);
	} );
} );

/**
 * A read whose rows say which items it holds, and whether it is stale.
 *
 * @param {Object}   props
 * @param {string}   props.scope     The read's scope.
 * @param {string}   props.command   The read verb.
 * @param {string[]} props.args      Its tokens.
 * @param {string}   [props.group]   The surface it reads under.
 * @param {string}   [props.ci]      The CI it reads from.
 * @param {Function} [props.onState] Handed every state the read returns.
 * @return {import('react').ReactElement} The read's state.
 */
function Lister( { scope, command, args, group = GROUP, ci = CI, onState } ) {
	const read = useCommandRead( { group, ci, scope, command, args } );
	onState?.( read );
	const { answer, error, loading, stale } = read;
	// Every field it is handed renders, so a refusal beside rows would show.
	return (
		<>
			{ error && <p>refused: { error }</p> }
			{ loading && <p>loading</p> }
			{ answer && (
				<>
					<p>{ stale ? 'stale' : 'fresh' }</p>
					<ul>
						{ answer.items.map( ( title ) => (
							<li key={ title }>{ title }</li>
						) ) }
					</ul>
				</>
			) }
		</>
	);
}

/** A reply the suite holds open until it answers it. */
function held() {
	let answer;
	const reply = new Promise( ( resolve ) => ( answer = resolve ) );
	return { reply: () => reply, answer: ( value ) => answer( value ) };
}

describe( 'refusals', () => {
	beforeEach( () => {
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	} );

	it( 'refuses a read option it does not take, naming it', () => {
		function Typo() {
			useCommandRead( {
				group: GROUP,
				ci: CI,
				scope: 'probe:typo',
				command: 'lighthouse',
				args: [ 'tide' ],
				dirtys: [ 'lighthouse:' ],
			} );
			return null;
		}
		expect( () => render( <Typo /> ) ).toThrow( /dirtys/ );
	} );

	it( 'refuses a write option it does not take, naming it', () => {
		function Typo() {
			useCommandWrite( 'log_tide', {
				group: GROUP,
				ci: CI,
				refrsh: () => {},
			} );
			return null;
		}
		expect( () => render( <Typo /> ) ).toThrow( /refrsh/ );
	} );

	it( 'refuses a CI changed under a mounted read', () => {
		function Moored( { ci } ) {
			useCommandRead( {
				group: GROUP,
				ci,
				scope: 'probe:moored',
				command: 'mooring',
				args: [ 'north-reach' ],
			} );
			return null;
		}
		const { rerender } = render( <Moored ci="weka-7804" /> );
		expect( () => rerender( <Moored ci="tui-7805" /> ) ).toThrow(
			/ci changed/
		);
	} );
} );

describe( 'useCommandRead from memory', () => {
	it( 'a cached read paints at once, dated when it landed, and revalidates', async () => {
		wire.replies.lighthouse = { items: [ 'Tide table for North Reach' ] };
		const before = Core.now();
		const first = render(
			<Lister
				scope="probe:tide"
				command="lighthouse"
				args={ [ 'tide' ] }
			/>
		);
		await screen.findByText( 'fresh' );
		const after = Core.now();
		first.unmount();

		const later = held();
		wire.replies.lighthouse = later.reply;
		const states = [];
		render(
			<Lister
				scope="probe:tide"
				command="lighthouse"
				args={ [ 'tide' ] }
				onState={ ( state ) => states.push( state ) }
			/>
		);
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		expect( screen.getByText( 'Tide table for North Reach' ) ).toBeTruthy();
		const { updatedAt } = states[ 0 ];
		expect( updatedAt ).toBeGreaterThanOrEqual( before );
		expect( updatedAt ).toBeLessThanOrEqual( after );
		await waitFor( () =>
			expect( wire.sent( 'lighthouse' ) ).toHaveLength( 2 )
		);
		await act( async () =>
			later.answer( { items: [ 'Spring tide for North Reach' ] } )
		);
		expect( await screen.findByText( 'fresh' ) ).toBeTruthy();
		expect(
			screen.getByText( 'Spring tide for North Reach' )
		).toBeTruthy();
		expect( screen.queryByText( 'Tide table for North Reach' ) ).toBeNull();
		expect( states[ states.length - 1 ].updatedAt ).toBeNull();
	} );

	it( 'the 65th answer evicts the least recently used', async () => {
		wire.replies.buoy = ( [ n ] ) => ( { items: [ `buoy ${ n }` ] } );
		const view = render(
			<Lister scope="probe:buoy" command="buoy" args={ [ '1' ] } />
		);
		await screen.findByText( 'buoy 1' );
		for ( let n = 2; n <= 65; n++ ) {
			view.rerender(
				<Lister
					scope="probe:buoy"
					command="buoy"
					args={ [ `${ n }` ] }
				/>
			);
			await screen.findByText( `buoy ${ n }` );
		}
		view.unmount();

		wire.replies.buoy = held().reply;
		const second = render(
			<Lister scope="probe:buoy" command="buoy" args={ [ '2' ] } />
		);
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		second.unmount();
		render( <Lister scope="probe:buoy" command="buoy" args={ [ '1' ] } /> );
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
	} );

	it( 'nothing the cache holds reaches storage', async () => {
		const stored = jest.spyOn( window.Storage.prototype, 'setItem' );
		wire.replies.logbook = { items: [ 'North Reach restricted memo' ] };
		wire.replies.log_tide = { ok: true };
		const read = render(
			<Lister
				scope="probe:logbook"
				command="logbook"
				args={ [ 'memo' ] }
			/>
		);
		await screen.findByText( 'North Reach restricted memo' );
		read.unmount();
		render(
			<Lister
				scope="probe:logbook"
				command="logbook"
				args={ [ 'memo' ] }
			/>
		);
		const refresh = jest.fn();
		render(
			<Dirtier
				command="log_tide"
				dirties={ [ 'logbook:' ] }
				refresh={ refresh }
			/>
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 1 ) );
		expect( stored ).not.toHaveBeenCalled();
		stored.mockRestore();
	} );

	it( 'a landed write drops the prefixes it dirties', async () => {
		wire.replies.charts = { items: [ 'North Reach chart' ] };
		wire.replies.almanac = { items: [ 'North Reach almanac' ] };
		wire.replies.log_tide = { ok: true, event_id: 'ev-77' };
		const charts = render(
			<Lister scope="probe:charts" command="charts" args={ [] } />
		);
		await screen.findByText( 'North Reach chart' );
		charts.unmount();
		const brief = render(
			<Lister
				scope="probe:almanac"
				command="almanac"
				args={ [ 'signals' ] }
			/>
		);
		await screen.findByText( 'North Reach almanac' );
		brief.unmount();

		const refresh = jest.fn();
		const writer = render(
			<Dirtier
				command="log_tide"
				dirties={ [ 'charts:' ] }
				refresh={ refresh }
			/>
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 1 ) );
		writer.unmount();

		wire.replies.charts = held().reply;
		wire.replies.almanac = held().reply;
		const again = render(
			<Lister scope="probe:charts" command="charts" args={ [] } />
		);
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
		again.unmount();
		render(
			<Lister
				scope="probe:almanac"
				command="almanac"
				args={ [ 'signals' ] }
			/>
		);
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		expect( screen.getByText( 'North Reach almanac' ) ).toBeTruthy();
	} );

	it( 'a landed write re-reads a mounted read it dirties', async () => {
		let chart = 'North Reach chart';
		wire.replies.charts = () => ( { items: [ chart ] } );
		wire.replies.log_tide = { ok: true, event_id: 'ev-78' };
		render( <Lister scope="probe:shelf" command="charts" args={ [] } /> );
		await screen.findByText( 'North Reach chart' );
		chart = 'North Reach chart, two items';
		render( <Dirtier command="log_tide" dirties={ [ 'charts:' ] } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		expect(
			await screen.findByText( 'North Reach chart, two items' )
		).toBeTruthy();
		expect( wire.sent( 'charts' ) ).toHaveLength( 2 );
	} );

	it( 'a read withdrawn and asked again after a write dirtied it never shows the old answer', async () => {
		let chart = 'Kea chart 6101';
		wire.replies.charts = () => ( { items: [ chart ] } );
		wire.replies.log_tide = { ok: true, event_id: 'ev-6101' };
		const view = render(
			<Lister
				scope="probe:shelf"
				command="charts"
				args={ [ 'kea-5532' ] }
			/>
		);
		await screen.findByText( 'Kea chart 6101' );
		view.rerender(
			<Lister scope="probe:shelf" command="charts" args={ null } />
		);
		chart = 'Kea chart 6102';
		render( <Dirtier command="log_tide" dirties={ [ 'charts:' ] } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await act( async () => {} );
		view.rerender(
			<Lister
				scope="probe:shelf"
				command="charts"
				args={ [ 'kea-5532' ] }
			/>
		);
		expect( screen.queryByText( 'Kea chart 6101' ) ).toBeNull();
		expect( await screen.findByText( 'Kea chart 6102' ) ).toBeTruthy();
		expect( screen.getByText( 'fresh' ) ).toBeTruthy();
	} );

	it( 'a mounted read a write dirties keeps its answer, marked stale, until the new one lands', async () => {
		wire.replies.charts = { items: [ 'Tui chart 4417' ] };
		wire.replies.log_tide = { ok: true, event_id: 'ev-4417' };
		render( <Lister scope="probe:shelf" command="charts" args={ [] } /> );
		await screen.findByText( 'Tui chart 4417' );
		const next = held();
		wire.replies.charts = next.reply;
		render( <Dirtier command="log_tide" dirties={ [ 'charts:' ] } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await waitFor( () =>
			expect( wire.sent( 'charts' ) ).toHaveLength( 2 )
		);
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		expect( screen.getByText( 'Tui chart 4417' ) ).toBeTruthy();
		await act( async () => next.answer( { items: [ 'Tui chart 4418' ] } ) );
		expect( await screen.findByText( 'Tui chart 4418' ) ).toBeTruthy();
		expect( screen.getByText( 'fresh' ) ).toBeTruthy();
	} );

	it( 'a revoked grant never shows a stale restricted item', async () => {
		const restricted = 'North Reach restricted board memo';
		const open = 'North Reach open release note';
		wire.replies.soundings = { items: [ open, restricted ] };
		const first = render(
			<Lister
				scope="probe:soundings"
				command="soundings"
				args={ [ 'week' ] }
			/>
		);
		await screen.findByText( restricted );
		first.unmount();

		// The grant is gone: the revalidation answers without the item.
		wire.replies.soundings = { items: [ open ] };
		const narrowed = render(
			<Lister
				scope="probe:soundings"
				command="soundings"
				args={ [ 'week' ] }
			/>
		);
		await screen.findByText( 'fresh' );
		expect( screen.queryByText( restricted ) ).toBeNull();
		narrowed.unmount();

		// Seed the restricted answer again, then refuse its revalidation.
		wire.replies.soundings = { items: [ open, restricted ] };
		const seeded = render(
			<Lister
				scope="probe:soundings"
				command="soundings"
				args={ [ 'month' ] }
			/>
		);
		await screen.findByText( restricted );
		seeded.unmount();
		wire.replies.soundings = () => new Error( 'not permitted: restricted' );
		const refused = render(
			<Lister
				scope="probe:soundings"
				command="soundings"
				args={ [ 'month' ] }
			/>
		);
		expect(
			await screen.findByText( 'refused: not permitted: restricted' )
		).toBeTruthy();
		expect( screen.queryByText( restricted ) ).toBeNull();
		expect( screen.queryByText( open ) ).toBeNull();
		refused.unmount();

		// The refusal evicted the entry: nothing paints from memory.
		wire.replies.soundings = held().reply;
		render(
			<Lister
				scope="probe:soundings"
				command="soundings"
				args={ [ 'month' ] }
			/>
		);
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
		expect( screen.queryByText( restricted ) ).toBeNull();
	} );
} );

describe( 'useCommandRead across scopes', () => {
	it( 'paints a question one scope answered under another, marked stale', async () => {
		wire.replies.mooring = { items: [ 'North Reach berth 7' ] };
		const first = render(
			<Lister
				scope="probe:head"
				command="mooring"
				args={ [ 'north-reach' ] }
			/>
		);
		await screen.findByText( 'fresh' );
		first.unmount();

		wire.replies.mooring = held().reply;
		render(
			<Lister
				scope="probe:block"
				command="mooring"
				args={ [ 'north-reach' ] }
			/>
		);
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		expect( screen.getByText( 'North Reach berth 7' ) ).toBeTruthy();
	} );
} );

describe( 'useCommandRead across groups', () => {
	it( 'remembers each group apart, and a write dirties only its own', async () => {
		wire.replies.mooring = { items: [ 'North Reach berth 9' ] };
		wire.replies.log_tide = { ok: true, event_id: 'ev-79' };
		const first = render(
			<Lister
				scope="probe:kea-mooring"
				command="mooring"
				args={ [ 'north-reach' ] }
			/>
		);
		await screen.findByText( 'fresh' );
		first.unmount();

		// The other group's write lands, dirtying its own `mooring:` reads.
		const refresh = jest.fn();
		const writer = render(
			<Dirtier
				group={ OTHER_GROUP }
				command="log_tide"
				dirties={ [ 'mooring:' ] }
				refresh={ refresh }
			/>
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 1 ) );
		writer.unmount();

		wire.replies.mooring = held().reply;
		const other = render(
			<Lister
				group={ OTHER_GROUP }
				scope="probe:other-mooring"
				command="mooring"
				args={ [ 'north-reach' ] }
			/>
		);
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
		other.unmount();
		render(
			<Lister
				scope="probe:kea-mooring"
				command="mooring"
				args={ [ 'north-reach' ] }
			/>
		);
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		expect( screen.getByText( 'North Reach berth 9' ) ).toBeTruthy();
	} );
} );

describe( 'useCommandRead re-reads by group', () => {
	it( 'a write re-reads only the mounted reads of its own group', async () => {
		wire.replies.mooring = ( [ berth ] ) => ( { items: [ berth ] } );
		wire.replies.log_tide = { ok: true, event_id: 'ev-81' };
		render(
			<>
				<Lister
					scope="probe:kea-7802-mooring"
					command="mooring"
					args={ [ 'north-reach' ] }
				/>
				<Lister
					group={ OTHER_GROUP }
					scope="probe:kea-7803-mooring"
					command="mooring"
					args={ [ 'gull-reef' ] }
				/>
				<Dirtier
					group={ OTHER_GROUP }
					command="log_tide"
					dirties={ [ 'mooring:' ] }
				/>
			</>
		);
		await screen.findByText( 'north-reach' );
		await screen.findByText( 'gull-reef' );
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		const asked = ( berth ) =>
			wire.sent( 'mooring' ).filter( ( [ one ] ) => berth === one );
		await waitFor( () => expect( asked( 'gull-reef' ) ).toHaveLength( 2 ) );
		expect( asked( 'north-reach' ) ).toHaveLength( 1 );
	} );
} );

describe( 'useCommandRead across CIs', () => {
	const ONE_GROUP = 'kea-7803';
	const WEKA = 'weka-7804';
	const TUI = 'tui-7805';

	/**
	 * A mooring read of one CI under the one group.
	 *
	 * @param {string} ci The CI it reads from.
	 * @return {import('react').ReactElement} The read.
	 */
	const mooring = ( ci ) => (
		<Lister
			group={ ONE_GROUP }
			ci={ ci }
			scope={ `probe:${ ci }:mooring` }
			command="mooring"
			args={ [ 'north-reach' ] }
		/>
	);

	it( 'paints each CI its own answer, never the answer of another CI, not even stale', async () => {
		wire.replies.mooring = ( args, ci ) => ( {
			items: [ `${ ci } berth for ${ args[ 0 ] }` ],
		} );
		const both = render(
			<>
				{ mooring( WEKA ) }
				{ mooring( TUI ) }
			</>
		);
		await screen.findByText( 'weka-7804 berth for north-reach' );
		await screen.findByText( 'tui-7805 berth for north-reach' );
		both.unmount();

		const pending = held();
		wire.replies.mooring = pending.reply;
		const tui = render( mooring( TUI ) );
		expect( screen.getByText( 'stale' ) ).toBeTruthy();
		expect(
			screen.getByText( 'tui-7805 berth for north-reach' )
		).toBeTruthy();
		expect( screen.queryByText( /weka-7804/ ) ).toBeNull();
		tui.unmount();

		const weka = render( mooring( WEKA ) );
		expect(
			screen.getByText( 'weka-7804 berth for north-reach' )
		).toBeTruthy();
		expect( screen.queryByText( /tui-7805/ ) ).toBeNull();
		weka.unmount();
	} );

	it( 'a CI never answered paints nothing another CI answered', async () => {
		wire.replies.mooring = { items: [ 'weka-7804 berth only' ] };
		const weka = render( mooring( WEKA ) );
		await screen.findByText( 'weka-7804 berth only' );
		weka.unmount();

		wire.replies.mooring = held().reply;
		render( mooring( TUI ) );
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
		expect( screen.queryByText( 'weka-7804 berth only' ) ).toBeNull();
	} );

	it( 'a verb prefix dirties the answers of every CI, and a verb and CI prefix those of that CI alone', async () => {
		wire.replies.mooring = ( args, ci ) => ( {
			items: [ `${ ci } berth` ],
		} );
		wire.replies.log_tide = { ok: true, event_id: 'ev-80' };
		const both = render(
			<>
				{ mooring( WEKA ) }
				{ mooring( TUI ) }
			</>
		);
		await screen.findByText( 'weka-7804 berth' );
		await screen.findByText( 'tui-7805 berth' );
		both.unmount();

		const refresh = jest.fn();
		const narrow = render(
			<Dirtier
				group={ ONE_GROUP }
				command="log_tide"
				dirties={ [ `mooring:${ WEKA }:` ] }
				refresh={ refresh }
			/>
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 1 ) );
		narrow.unmount();

		wire.replies.mooring = held().reply;
		const weka = render( mooring( WEKA ) );
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
		weka.unmount();
		const tui = render( mooring( TUI ) );
		expect( screen.getByText( 'tui-7805 berth' ) ).toBeTruthy();
		tui.unmount();

		const wide = render(
			<Dirtier
				group={ ONE_GROUP }
				command="log_tide"
				dirties={ [ 'mooring:' ] }
				refresh={ refresh }
			/>
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'log_tide' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 2 ) );
		wide.unmount();
		render( mooring( TUI ) );
		expect( screen.getByText( 'loading' ) ).toBeTruthy();
	} );
} );

describe( 'useCommandWrite', () => {
	it( 'sends its command once per run and refreshes with its answer and its tokens once it lands', async () => {
		wire.replies.moor_boat = { ok: true, event_id: 'ev-41' };
		const refresh = jest.fn();
		render( <Writer refresh={ refresh } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'moor' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 1 ) );
		expect( refresh ).toHaveBeenCalledWith(
			{
				ok: true,
				event_id: 'ev-41',
			},
			[ '--key=light:cape-7811' ]
		);
		expect( wire.sent( 'moor_boat' ) ).toEqual( [
			[ '--key=light:cape-7811' ],
		] );
		expect( screen.getByText( 'answered: ev-41' ) ).toBeTruthy();
	} );

	it( 'holds a refusal until a later send lands', async () => {
		let refuse = true;
		wire.replies.moor_boat = () =>
			refuse
				? new Error( 'no berth: light:cape-7811' )
				: { ok: true, event_id: 'ev-42' };
		const refresh = jest.fn();
		render( <Writer refresh={ refresh } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'moor' } ) );
		expect(
			await screen.findByText( 'refusal: no berth: light:cape-7811' )
		).toBeTruthy();
		expect( refresh ).not.toHaveBeenCalled();
		refuse = false;
		fireEvent.click( screen.getByRole( 'button', { name: 'moor' } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalled() );
		expect( screen.queryByText( /refusal:/ ) ).toBeNull();
	} );

	it( 'answers each run with the tokens it sent, and a refusal with the tokens refused and its own error', async () => {
		wire.replies.moor_boat = () => new Error( 'no berth: light:cape-7811' );
		const onSent = jest.fn();
		const onRefused = jest.fn();
		render( <Writer onSent={ onSent } onRefused={ onRefused } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'moor' } ) );
		expect( onSent ).toHaveBeenCalledWith( [ '--key=light:cape-7811' ] );
		await waitFor( () =>
			expect( onRefused ).toHaveBeenCalledWith(
				[ '--key=light:cape-7811' ],
				'no berth: light:cape-7811'
			)
		);
	} );

	it( 'addresses the CI it names, and is pending until the reply lands', async () => {
		let answer;
		wire.replies.moor_boat = () =>
			new Promise( ( resolve ) => ( answer = resolve ) );
		const refresh = jest.fn();
		render( <Writer ci="workers" refresh={ refresh } /> );
		fireEvent.click( screen.getByRole( 'button', { name: 'moor' } ) );
		expect( screen.getByText( 'pending' ) ).toBeTruthy();
		await waitFor( () =>
			expect( wire.sentTo( 'moor_boat' ) ).toEqual( [ 'workers' ] )
		);
		await act( async () => answer( { ok: true } ) );
		await waitFor( () => expect( refresh ).toHaveBeenCalledTimes( 1 ) );
		expect( screen.queryByText( 'pending' ) ).toBeNull();
	} );
} );

describe( 'commandArgs', () => {
	it( 'names each value given, repeating a list once per member', () => {
		expect(
			commandArgs( {
				key: 'north-reach',
				wind: [ 'gale', 'squall' ],
				days: 21,
				offset: 0,
			} )
		).toEqual( [
			'--key=north-reach',
			'--wind=gale',
			'--wind=squall',
			'--days=21',
			'--offset=0',
		] );
	} );

	it( 'leaves out a blank value and an empty list', () => {
		expect(
			commandArgs( {
				q: '',
				reef: [],
				source: [ 'harbor', '' ],
			} )
		).toEqual( [ '--source=harbor' ] );
	} );

	it( 'leaves out a value not given, never sending it as "null"', () => {
		expect(
			commandArgs( {
				chart: null,
				buoy: undefined,
				by: 'tide',
			} )
		).toEqual( [ '--by=tide' ] );
	} );
} );

describe( 'refusalOfSend', () => {
	const SENT = [ '--name=Heron cove' ];
	const refused = {
		refusal: 'Heron cove is taken',
		answeredArgs: [ '--name=Heron cove' ],
		pending: false,
	};

	it( 'answers the refusal its own send drew', () => {
		expect( refusalOfSend( refused, SENT ) ).toBe( 'Heron cove is taken' );
	} );

	it( 'answers none for another send, no send, or a send still owed', () => {
		expect( refusalOfSend( refused, [ '--name=Gull reef' ] ) ).toBeNull();
		expect( refusalOfSend( refused, null ) ).toBeNull();
		expect(
			refusalOfSend( { ...refused, pending: true }, SENT )
		).toBeNull();
		expect(
			refusalOfSend( { ...refused, refusal: null }, SENT )
		).toBeNull();
	} );
} );
