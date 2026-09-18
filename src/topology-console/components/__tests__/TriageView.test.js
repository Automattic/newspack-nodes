/**
 * TriageView tests — the selected consumer/tail/remote-source node's dead-letter
 * queue as a table with requeue + purge actions. It arms a one-shot reply capture
 * on the `_output` Dumper, then dispatches the `dl_*` :config verbs via onAction;
 * the `dl_list` page is read defensively into the table.
 */

import { render, fireEvent, act } from '@testing-library/react';
import TriageView from '../TriageView';
import { Core } from '../../../runtime/core';
import { DumperNode } from '../../../runtime/dumper-node';
import names from '../../../runtime/reserved-node-names.json';
import {
	newMessage,
	TYPE,
	FROM,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../../../runtime/message';

const node = { id: 'firehose-consumer' };

let dumper;
beforeEach( () => {
	Core.reset();
	dumper = new DumperNode();
	dumper.name = names.OUTPUT;
} );

// A worker command reply routed to the verb's OWN receiver node, which is
// where the command was minted FROM.
function reply( name, payload, kind = TM_RESPONSE ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | kind;
	m[ FROM ] = 'worker';
	m[ VALUE ] = { name, payload };
	act( () => Core.node( `_triage:${ name }` )?.fill( m ) );
}

const listPage = ( over = {} ) => ( {
	rows: [
		{
			reason: 'timeout',
			attempts: 3,
			first_crash_ts: 1_777_000_000,
			ts: 1_777_000_123,
			source: '4:88:512',
			locator: '2:40:96',
		},
	],
	total: 1,
	unindexed_segments: 0,
	...over,
} );

test( 'dispatches dl_list at the node on mount and renders the returned records', () => {
	const onAction = jest.fn();
	const { getByTestId } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	expect( onAction ).toHaveBeenCalledWith( 'invoke', 'firehose-consumer', {
		verb: 'dl_list',
		kind: 'command',
		positional: '',
		byName: {},
		replyTo: expect.any( String ),
	} );
	reply( 'dl_list', listPage() );
	const grid = getByTestId( 'triage-grid' );
	// Local `YYYY-MM-DD HH:MM:SS TZ` from ts (DLQ records can be days old),
	// plus reason / attempts / source / locator.
	const d = new Date( 1_777_000_123 * 1000 );
	const expected = `${ d.toLocaleDateString(
		'en-CA'
	) } ${ d.toLocaleTimeString( 'en-US', {
		hour12: false,
		timeZoneName: 'short',
	} ) }`;
	expect( expected ).toMatch( /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/ );
	expect( grid.textContent ).toContain( expected );
	expect( grid.textContent ).toContain( 'timeout' );
	expect( grid.textContent ).toContain( '3' );
	expect( grid.textContent ).toContain( '4:88:512' );
	expect( grid.textContent ).toContain( '2:40:96' );
} );

test( 'renders the empty state when there are no quarantined records', () => {
	const { queryByTestId, getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage( { rows: [], total: 0 } ) );
	expect( queryByTestId( 'triage-grid' ) ).toBeNull();
	expect( getByText( 'No quarantined records.' ) ).not.toBeNull();
} );

test( 'notes older records that predate indexing when unindexed_segments > 0', () => {
	const { getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage( { unindexed_segments: 4 } ) );
	expect( getByText( /4 older records predate indexing/ ) ).not.toBeNull();
} );

test( 'renders an error status when the dl_list reply is a string, even a JSON one', () => {
	const { queryByTestId, getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', JSON.stringify( listPage() ) );
	expect( queryByTestId( 'triage-grid' ) ).toBeNull();
	expect(
		getByText( /Could not read the dead-letter queue/ )
	).not.toBeNull();
} );

test( 'surfaces a TM_ERROR dl_list reply in the status line', () => {
	const { getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', 'error: boom', TM_ERROR );
	expect( getByText( 'error: boom' ) ).not.toBeNull();
} );

test( 'Requeue dispatches dl_requeue with the row locator, then refetches', () => {
	const onAction = jest.fn();
	const { getByText } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	reply( 'dl_list', listPage() );
	onAction.mockClear();
	fireEvent.click( getByText( 'Requeue' ) );
	expect( onAction ).toHaveBeenCalledWith( 'invoke', 'firehose-consumer', {
		verb: 'dl_requeue',
		kind: 'command',
		positional: '2:40:96',
		byName: { locator: '2:40:96' },
		replyTo: expect.any( String ),
	} );
	// The ok/error line surfaces, and the view refetches (a fresh dl_list).
	reply( 'dl_requeue', 'ok: redelivered 2:40:96 (97 bytes) to the sink' );
	expect(
		getByText( 'ok: redelivered 2:40:96 (97 bytes) to the sink' )
	).not.toBeNull();
	expect( onAction ).toHaveBeenCalledWith(
		'invoke',
		'firehose-consumer',
		expect.objectContaining( { verb: 'dl_list' } )
	);
} );

const showRecord = () => ( {
	type: 16,
	type_flags: 'TM_STRUCT',
	timestamp: 1_777_000_000.5,
	from: 'origin-node',
	to: '',
	id: '4:88:512',
	key: 'poison-key-909',
	value: { k: 'job', payload: 'blob-909' },
	size: 133,
} );

test( 'View dispatches dl_show with the row locator and renders the record', () => {
	const onAction = jest.fn();
	const { getByText, getByTestId } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	reply( 'dl_list', listPage() );
	onAction.mockClear();
	fireEvent.click( getByText( 'View' ) );
	expect( onAction ).toHaveBeenCalledWith( 'invoke', 'firehose-consumer', {
		verb: 'dl_show',
		kind: 'command',
		positional: '2:40:96',
		byName: { locator: '2:40:96' },
		replyTo: expect.any( String ),
	} );
	reply( 'dl_show', showRecord() );
	const detail = getByTestId( 'triage-record' );
	expect( detail.textContent ).toContain( '"k": "job"' );
	expect( detail.textContent ).toContain( 'blob-909' );
} );

test( 'View toggles to Hide and closes the open record without a dispatch', () => {
	const onAction = jest.fn();
	const { getByText, queryByTestId } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	reply( 'dl_list', listPage() );
	fireEvent.click( getByText( 'View' ) );
	reply( 'dl_show', showRecord() );
	expect( queryByTestId( 'triage-record' ) ).not.toBeNull();
	onAction.mockClear();
	fireEvent.click( getByText( 'Hide' ) );
	expect( queryByTestId( 'triage-record' ) ).toBeNull();
	expect( onAction ).not.toHaveBeenCalled();
} );

test( 'a dl_show error lands in the status line, not the record panel', () => {
	const { getByText, queryByTestId } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage() );
	fireEvent.click( getByText( 'View' ) );
	reply( 'dl_show', 'error: no dead-letter record at 2:40:96', TM_ERROR );
	expect( queryByTestId( 'triage-record' ) ).toBeNull();
	expect( getByText( /no dead-letter record/ ) ).not.toBeNull();
} );

test( 'a string dl_show reply, even a JSON one, is surfaced as an error', () => {
	const { getByText, queryByTestId } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage() );
	fireEvent.click( getByText( 'View' ) );
	reply( 'dl_show', JSON.stringify( showRecord() ) );
	expect( queryByTestId( 'triage-record' ) ).toBeNull();
	expect( getByText( /unexpected shape/ ) ).not.toBeNull();
} );

test( 'View buttons disable while a dl_show is in flight (single reply slot)', () => {
	// The `_output` capture slot is one-per-verb: a second dl_show armed
	// before the first reply lands would mislabel row A's content as row B's.
	const { getAllByText, getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply(
		'dl_list',
		listPage( {
			rows: [
				{
					reason: 'timeout',
					attempts: 1,
					ts: 1,
					source: 'a',
					locator: '1:0:10',
				},
				{
					reason: 'crash',
					attempts: 2,
					ts: 2,
					source: 'b',
					locator: '2:0:20',
				},
			],
		} )
	);
	fireEvent.click( getAllByText( 'View' )[ 0 ] );
	getAllByText( 'View' ).forEach( ( b ) =>
		expect( b.disabled ).toBe( true )
	);
	reply( 'dl_show', showRecord() );
	// Reply landed: the panel is open and the OTHER row's View re-enables.
	expect( getByText( 'View' ).disabled ).toBe( false );
	expect( getByText( 'Hide' ) ).not.toBeNull();
} );

test( 'Purge is a two-click confirm before it dispatches dl_purge', () => {
	const onAction = jest.fn();
	const { getByText } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	reply( 'dl_list', listPage( { rows: [], total: 0 } ) );
	onAction.mockClear();
	// First click arms the confirm; no verb fires yet.
	fireEvent.click( getByText( 'Purge' ) );
	expect( onAction ).not.toHaveBeenCalled();
	// Second click dispatches dl_purge; the reply surfaces + refetches.
	fireEvent.click( getByText( 'Confirm purge' ) );
	expect( onAction ).toHaveBeenCalledWith( 'invoke', 'firehose-consumer', {
		verb: 'dl_purge',
		kind: 'command',
		positional: '',
		byName: {},
		replyTo: expect.any( String ),
	} );
	reply( 'dl_purge', 'ok: purged 3 of 3 dead-letter segment(s)' );
	expect(
		getByText( 'ok: purged 3 of 3 dead-letter segment(s)' )
	).not.toBeNull();
	expect( onAction ).toHaveBeenCalledWith(
		'invoke',
		'firehose-consumer',
		expect.objectContaining( { verb: 'dl_list' } )
	);
} );

test( 'renders a dash for a record whose ts is not a finite number', () => {
	const { getByTestId } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply(
		'dl_list',
		listPage( {
			rows: [
				{
					reason: 'crash',
					attempts: 1,
					ts: null,
					source: '0:0:0',
					locator: '1:0:8',
				},
			],
		} )
	);
	expect( getByTestId( 'triage-grid' ).textContent ).toContain( '—' );
} );

test( 'treats a page without a rows array as unreadable', () => {
	const { getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', { total: 9 } );
	expect(
		getByText( /Could not read the dead-letter queue/ )
	).not.toBeNull();
} );

test( 'a new onAction identity (a metadata poll) does not re-dispatch dl_list', () => {
	const onAction1 = jest.fn();
	const { rerender } = render(
		<TriageView node={ node } onAction={ onAction1 } />
	);
	// Mount fetches once through the first onAction.
	expect( onAction1 ).toHaveBeenCalledTimes( 1 );
	// The console re-memoizes onAction on every metadata poll; a fresh identity
	// alone must NOT trigger another dl_list (the per-poll refetch race).
	const onAction2 = jest.fn();
	rerender( <TriageView node={ node } onAction={ onAction2 } /> );
	expect( onAction2 ).not.toHaveBeenCalled();
} );

test( 'a verb reply that lands after unmount fires no stray refetch', () => {
	const onAction = jest.fn();
	const { getByText, unmount } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	reply( 'dl_list', listPage() );
	fireEvent.click( getByText( 'Requeue' ) );
	onAction.mockClear();
	unmount();
	// The dl_requeue reply lands after unmount; its callback would refresh()
	// (a stray dl_list) — the mounted guard must drop it.
	reply( 'dl_requeue', 'ok: redelivered 2:40:96 to the sink' );
	expect( onAction ).not.toHaveBeenCalled();
} );

test( 'clicking Requeue disarms an armed Confirm purge', () => {
	const { getByText, queryByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage() );
	fireEvent.click( getByText( 'Purge' ) );
	expect( getByText( 'Confirm purge' ) ).not.toBeNull();
	fireEvent.click( getByText( 'Requeue' ) );
	expect( queryByText( 'Confirm purge' ) ).toBeNull();
	expect( getByText( 'Purge' ) ).not.toBeNull();
} );

test( 'clicking Refresh disarms an armed Confirm purge', () => {
	const { getByText, queryByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage( { rows: [], total: 0 } ) );
	fireEvent.click( getByText( 'Purge' ) );
	expect( getByText( 'Confirm purge' ) ).not.toBeNull();
	fireEvent.click( getByText( 'Refresh' ) );
	expect( queryByText( 'Confirm purge' ) ).toBeNull();
} );

test( 'shows a loading state until the first dl_list reply lands', () => {
	const { getByText, queryByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	expect( getByText( 'Loading…' ) ).not.toBeNull();
	expect( queryByText( '0 quarantined' ) ).toBeNull();
	reply( 'dl_list', listPage( { rows: [], total: 0 } ) );
	expect( getByText( '0 quarantined' ) ).not.toBeNull();
} );

test( 'Refresh re-dispatches dl_list', () => {
	const onAction = jest.fn();
	const { getByText } = render(
		<TriageView node={ node } onAction={ onAction } />
	);
	reply( 'dl_list', listPage() );
	onAction.mockClear();
	fireEvent.click( getByText( 'Refresh' ) );
	expect( onAction ).toHaveBeenCalledWith( 'invoke', 'firehose-consumer', {
		verb: 'dl_list',
		kind: 'command',
		positional: '',
		byName: {},
		replyTo: expect.any( String ),
	} );
} );

describe( 'TriageView reply addressing', () => {
	it( 'gives each verb its own reply node instead of one shared slot', () => {
		// `_output`'s capture slot is a SINGLE field matched by command name,
		// so a second verb overwrote the first's callback — which is why the
		// view carried a `viewPending` guard forbidding a concurrent dl_show.
		// A reply must land on the node that minted it (ADR-7).
		const onAction = jest.fn();
		const { container } = render(
			<TriageView node={ node } onAction={ onAction } />
		);

		const listCall = onAction.mock.calls.find(
			( c ) => c[ 2 ]?.verb === 'dl_list'
		);
		expect( listCall ).toBeTruthy();
		const listReplyTo = listCall[ 2 ].replyTo;
		expect( typeof listReplyTo ).toBe( 'string' );
		expect( Core.node( listReplyTo ) ).toBeTruthy();

		// Deliver the list so the table renders a row with a View button.
		act( () =>
			Core.node( listReplyTo ).fill( commandReply( listPage() ) )
		);

		const view = Array.from( container.querySelectorAll( 'button' ) ).find(
			( b ) => /view/i.test( b.textContent )
		);
		fireEvent.click( view );

		const showCall = onAction.mock.calls.find(
			( c ) => c[ 2 ]?.verb === 'dl_show'
		);
		expect( showCall ).toBeTruthy();
		expect( showCall[ 2 ].replyTo ).not.toBe( listReplyTo );
		expect( Core.node( showCall[ 2 ].replyTo ) ).toBeTruthy();
	} );
} );

// A TM_COMMAND|TM_RESPONSE addressed at a per-verb receiver node.
function commandReply( payload, kind = TM_RESPONSE ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | kind;
	m[ FROM ] = 'worker';
	m[ VALUE ] = { payload };
	return m;
}

const showRecordWithStringValue = ( value ) => ( {
	type: 1,
	type_flags: 'TM_BYTESTREAM',
	timestamp: 1_786_480_953.325_673,
	from: '',
	to: '',
	id: '13:458292:315',
	key: '',
	value,
	size: 413,
} );

const row = () => ( {
	reason: 'timeout',
	attempts: 1,
	first_crash_ts: 1_777_000_000,
	ts: 1_777_000_123,
	source: '13:654256:170',
	locator: '2:40:96',
} );

test( 'an unparseable record shows its VALUE alone — that IS the whole message', () => {
	const raw =
		'16,1786489854.07299,"Bob","Ken","123:456:789","Jerb",{"k":"job"}]';
	const view = render( <TriageView node={ node } onAction={ jest.fn() } /> );
	reply(
		'dl_list',
		listPage( { rows: [ { ...row(), reason: 'unparseable' } ] } )
	);
	fireEvent.click( view.getByText( 'View' ) );
	reply( 'dl_show', showRecordWithStringValue( raw ) );
	expect( view.getByTestId( 'triage-record' ).textContent ).toBe( raw );
} );

test( "any other reason renders the Dumper's Message block, as the REPL does", () => {
	const view = render( <TriageView node={ node } onAction={ jest.fn() } /> );
	reply( 'dl_list', listPage( { rows: [ { ...row(), reason: 'throw' } ] } ) );
	fireEvent.click( view.getByText( 'View' ) );
	reply( 'dl_show', showRecord() );
	const body = view.getByTestId( 'triage-record' ).textContent;
	expect( body ).toMatch( /^Message \{\n/ );
	expect( body ).toContain( '    type:      TM_STRUCT' );
	expect( body ).toContain( '    from:      origin-node' );
	expect( body ).toContain( '    key:       poison-key-909' );
	expect( body ).toContain( 'blob-909' );
	expect( body.trimEnd() ).toMatch( /\}$/ );
	// The bespoke keyed fields never reach the panel.
	expect( body ).not.toContain( 'type_flags' );
	expect( body ).not.toContain( '"size"' );
} );

test( 'no envelope header is rendered for either kind', () => {
	const view = render( <TriageView node={ node } onAction={ jest.fn() } /> );
	reply( 'dl_list', listPage() );
	fireEvent.click( view.getByText( 'View' ) );
	reply( 'dl_show', showRecord() );
	expect( view.queryByTestId( 'triage-record-meta' ) ).toBeNull();
} );

test( 'scrolls only the records, keeping the count and the actions in view', () => {
	// An opened record runs long; the count above it and Refresh / Purge
	// below it must not scroll away with it.
	const { getByTestId, getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage() );
	const records = getByTestId( 'triage-records' );

	expect( records.contains( getByTestId( 'triage-grid' ) ) ).toBe( true );
	expect( records.contains( getByText( 'Refresh' ) ) ).toBe( false );
	expect( records.contains( getByText( '1 quarantined' ) ) ).toBe( false );
} );

test( 'paints the queue verbs as the rows paint theirs', () => {
	// Refresh and Purge act on the queue as Requeue acts on a record, so
	// all three take the compact verb role rather than a dialog's.
	const { getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage() );

	for ( const label of [ 'Refresh', 'Purge', 'Requeue' ] ) {
		expect( getByText( label ).classList.contains( 'is-compact' ) ).toBe(
			true
		);
	}
} );

test( 'a dl_list refusal shows as itself, not as unreadable', () => {
	const { getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', 'not a dead-letter node\n', TM_ERROR );
	expect( getByText( /not a dead-letter node/ ) ).not.toBeNull();
} );

test( 'a dl_show refusal shows as itself, not as undecodable', () => {
	const { getByText } = render(
		<TriageView node={ node } onAction={ jest.fn() } />
	);
	reply( 'dl_list', listPage() );
	fireEvent.click( getByText( 'View' ) );
	reply( 'dl_show', 'no dead-letter record at 2:40:96\n', TM_ERROR );
	expect( getByText( /no dead-letter record at 2:40:96/ ) ).not.toBeNull();
} );
