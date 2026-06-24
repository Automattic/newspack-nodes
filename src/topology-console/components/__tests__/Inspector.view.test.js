/**
 * Inspector view-mode rendering (edit-mode paths live in a separate file).
 */

import { render, fireEvent } from '@testing-library/react';
import Inspector, { formatActivityWindow } from '../Inspector';

const baseProps = {
	selectedId: null,
	parsed: { nodes: [], edges: [] },
	streamStatus: 'open',
	rateInfo: null,
	onAction: () => {},
	onSelect: () => {},
	onHover: () => {},
	nodeIds: new Set(),
	ssePid: null,
};

describe( 'Inspector (view mode)', () => {
	it( 'renders the empty-state when no node is selected', () => {
		const { container } = render( <Inspector { ...baseProps } /> );
		expect( container.textContent ).toMatch( /Select a node/ );
	} );

	it( 'renders the missing-node state when selectedId is absent from parsed', () => {
		const { container } = render(
			<Inspector { ...baseProps } selectedId="ghost" />
		);
		expect( container.textContent ).toMatch( /no longer present/ );
	} );

	const node = {
		id: 'echo',
		class: 'Echo',
		count: 1234,
		lgstMsg: 4096,
		bytesRead: 0,
		bytesWritten: 1024 * 1024 * 3,
	};
	const parsed = {
		nodes: [ node, { id: 'tee_a', class: 'Tee', target: [] } ],
		edges: [
			{ from: 'echo', to: 'tee_a' },
			{ from: 'echo', to: 'sink' },
		],
	};
	const renderNode = ( extra = {} ) =>
		render(
			<Inspector
				{ ...baseProps }
				selectedId="echo"
				parsed={ parsed }
				nodeIds={ new Set( [ 'echo', 'tee_a' ] ) }
				{ ...extra }
			/>
		);

	it( 'renders the node title + type with LIVE LED', () => {
		const { container } = renderNode();
		expect(
			container.querySelector( '.topology-insp__title' ).textContent
		).toBe( 'echo' );
		expect( container.textContent ).toMatch( /LIVE/ );
	} );

	it( 'shows status uppercased when streamStatus is not open', () => {
		const { container } = renderNode( { streamStatus: 'connecting' } );
		expect( container.textContent ).toMatch( /CONNECTING/ );
	} );

	it( 'live mode renders the targets editor from node.targets; chip × calls onRemoveEdge with the FULL target, dropdown calls onConnect', () => {
		const onConnect = jest.fn();
		const onRemoveEdge = jest.fn();
		// node.targets is the full, uncollapsed runtime target list (NOT the
		// headOf-collapsed / registration-polluted parsed.edges). A path target
		// like `_sse/workers` must disconnect by its full value, not its head.
		const teeParsed = {
			nodes: [
				{
					id: 'tee',
					class: 'Tee',
					target: [ 'a', '_sse/workers' ],
					targets: [ 'a', '_sse/workers' ],
				},
				{ id: 'a', class: 'Echo' },
				{ id: 'b', class: 'Echo' },
			],
			// Deliberately includes a registration edge that must NOT become a chip.
			edges: [
				{ from: 'tee', to: '_sse' },
				{ from: 'tee', to: 'a', registration: true, event: 'EVT' },
			],
		};
		const { getByRole, getByDisplayValue } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee"
				parsed={ teeParsed }
				nodeIds={ new Set( [ 'tee', 'a', 'b' ] ) }
				onConnect={ onConnect }
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.click(
			getByRole( 'button', { name: /Remove _sse\/workers/i } )
		);
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'tee', '_sse/workers' );
		fireEvent.change( getByDisplayValue( '+ add target…' ), {
			target: { value: 'b' },
		} );
		expect( onConnect ).toHaveBeenCalledWith( 'tee', 'b' );
	} );

	it( 'live mode does NOT show the targets editor for a reserved node', () => {
		const onConnect = jest.fn();
		const onRemoveEdge = jest.fn();
		const parsedReserved = {
			nodes: [
				{ id: '_repl', class: 'CommandInterpreter', targets: [ 'a' ] },
				{ id: 'a', class: 'Echo' },
			],
			edges: [ { from: '_repl', to: 'a' } ],
		};
		const { queryByRole } = render(
			<Inspector
				{ ...baseProps }
				selectedId="_repl"
				parsed={ parsedReserved }
				nodeIds={ new Set( [ '_repl', 'a' ] ) }
				onConnect={ onConnect }
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		// A reserved node shows the read-only routing display — no editor combobox
		// (neither the Tee "+ add target…" dropdown nor the single-target select).
		expect( queryByRole( 'combobox' ) ).toBeNull();
	} );

	it( 'hides the Routing section when node.has_target is false', () => {
		const { queryByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="dump"
				parsed={ {
					nodes: [
						{ id: 'dump', class: 'Dumper', has_target: false },
					],
					edges: [],
				} }
				nodeIds={ new Set( [ 'dump' ] ) }
			/>
		);
		expect( queryByText( 'Routing' ) ).toBeNull();
	} );

	it( 'hides the Routing section when the catalog schema says has_target is false', () => {
		const { queryByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="dump"
				parsed={ {
					nodes: [ { id: 'dump', class: 'Dumper' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'dump' ] ) }
				catalog={ [ { shell_name: 'Dumper', has_target: false } ] }
			/>
		);
		expect( queryByText( 'Routing' ) ).toBeNull();
	} );

	it( 'shows the Routing section when has_target is absent (defaults to true)', () => {
		const { queryByText } = renderNode();
		expect( queryByText( 'Routing' ) ).not.toBeNull();
	} );

	it( 'renders LIVE without crashing when streamStatus is undefined (overlay case)', () => {
		// The debug overlay reads the page's own Core synchronously — there is no
		// SSE stream to report, so it omits streamStatus. The Inspector used to
		// crash on `streamStatus.toUpperCase()`; now it treats absent status as
		// live (the graph it is showing literally is the local in-realm graph).
		const { container } = renderNode( { streamStatus: undefined } );
		expect( container.textContent ).toMatch( /LIVE/ );
	} );

	it( 'lists first target under "target →" and the rest under "also →"', () => {
		const { container } = renderNode();
		const rows = container.querySelectorAll( '.topology-field-row__key' );
		const labels = Array.from( rows ).map( ( r ) => r.textContent );
		expect( labels ).toContain( 'target →' );
		expect( labels ).toContain( 'also →' );
	} );

	it( 'renders a dash for routing when there are no edges', () => {
		const { container } = render(
			<Inspector
				{ ...baseProps }
				selectedId="solo"
				parsed={ {
					nodes: [ { id: 'solo', class: 'Echo' } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'solo' ] ) }
			/>
		);
		expect(
			container.querySelector( '.topology-field-row__val--dim' )
		).not.toBeNull();
	} );

	it( 'shows a clickable name link in routing when target is a known node', () => {
		const onSelect = jest.fn();
		const { container } = renderNode( { onSelect } );
		const link = container.querySelector( '.topology-field-row__nav' );
		fireEvent.click( link );
		expect( onSelect ).toHaveBeenCalledWith( 'tee_a' );
	} );

	it( 'reports hover enter/leave for known routing target links', () => {
		const onHover = jest.fn();
		const { container } = renderNode( { onHover } );
		const link = container.querySelector( '.topology-field-row__nav' );
		fireEvent.mouseEnter( link );
		fireEvent.mouseLeave( link );
		expect( onHover.mock.calls ).toEqual( [ [ 'tee_a' ], [ null ] ] );
	} );

	it( 'omits the Activity section when rateInfo has no message/byte signals', () => {
		const { container } = renderNode();
		expect( container.textContent ).not.toMatch( /Activity/ );
	} );

	it( 'shows the Activity section + sparkline row when rateInfo flags it', () => {
		const { container } = renderNode( {
			rateInfo: {
				hasMessages: true,
				history: [ 1, 2, 3 ],
				rate: 5,
			},
		} );
		expect( container.textContent ).toMatch( /Activity/ );
		expect( container.textContent ).toMatch( /messages \/s/ );
	} );

	it( 'formats activity and throughput edge values', () => {
		jest.useFakeTimers();
		jest.setSystemTime( new Date( '2026-01-01T00:00:00Z' ) );
		try {
			const richNode = {
				id: 'echo',
				class: 'Echo',
				count: 0,
				lgstMsg: -1,
				bytesRead: 1024 * 1024 * 1024,
				bytesWritten: 0,
			};
			const { container } = render(
				<Inspector
					{ ...baseProps }
					selectedId="echo"
					parsed={ { nodes: [ richNode ], edges: [] } }
					nodeIds={ new Set( [ 'echo' ] ) }
					rateInfo={ {
						hasMessages: true,
						history: [ 0, 150 ],
						rate: 150,
						hasRead: true,
						readHistory: [ 0 ],
						readRate: 0.5,
						hasWritten: true,
						writtenHistory: [ 0, 1024 * 1024 * 1024 ],
						writtenRate: 1024 * 1024 * 1024,
						lastChangedTs: Date.now() / 1000 - 3600,
					} }
				/>
			);

			expect( container.textContent ).toMatch( /150 \/s/ );
			expect( container.textContent ).toMatch( /0 B\/s/ );
			expect( container.textContent ).toMatch( /1\.0 G\/s/ );
			expect( container.textContent ).toMatch( /1\.0 G/ );
			expect( container.textContent ).toMatch( /1h ago/ );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'renders bytes formatters in Throughput rows', () => {
		const { container } = renderNode();
		// lgstMsg = 4096 → "4.0 K"
		expect( container.textContent ).toMatch( /4\.0 K/ );
		// bytesWritten = 3 MB
		expect( container.textContent ).toMatch( /3\.0 M/ );
	} );

	it( 'formats counter with locale separators', () => {
		const { container } = renderNode();
		expect( container.textContent ).toMatch( /1,234/ );
	} );

	it( 'renders Dump + Send + Trace buttons', () => {
		const { getByText } = renderNode();
		expect( getByText( 'Dump' ) ).not.toBeNull();
		expect( getByText( 'Send' ) ).not.toBeNull();
		expect( getByText( 'Trace' ) ).not.toBeNull();
	} );

	it( 'keeps action buttons enabled even when not live (live graph is hackable)', () => {
		const { getByText } = renderNode( { streamStatus: 'closed' } );
		expect( getByText( 'Dump' ).disabled ).toBe( false );
		expect( getByText( 'Send' ).disabled ).toBe( false );
		expect( getByText( 'Trace' ).disabled ).toBe( false );
	} );

	it( 'flips Trace label when node.debugState > 0', () => {
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="echo"
				parsed={ {
					nodes: [ { ...node, debugState: 1 } ],
					edges: [],
				} }
				nodeIds={ new Set( [ 'echo' ] ) }
			/>
		);
		expect( getByText( 'Stop Trace' ) ).not.toBeNull();
	} );

	it( 'fires onAction("dump", id) when Dump is clicked', () => {
		const onAction = jest.fn();
		const { getByText } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Dump' ) );
		expect( onAction ).toHaveBeenCalledWith( 'dump', 'echo' );
	} );

	it( 'fires trace and Tee tail/disconnect actions from action buttons', () => {
		const traceAction = jest.fn();
		const traceView = renderNode( { onAction: traceAction } );
		fireEvent.click( traceView.getByText( 'Trace' ) );
		expect( traceAction ).toHaveBeenCalledWith( 'trace', 'echo', 1 );
		traceView.unmount();

		const tailAction = jest.fn();
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [],
			targets: [],
		};
		const tailView = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ { nodes: [ teeNode ], edges: [] } }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				onAction={ tailAction }
			/>
		);
		fireEvent.click( tailView.getByText( 'Connect' ) );
		expect( tailAction ).toHaveBeenCalledWith( 'tail', 'tee_a' );
		tailView.unmount();

		const disconnectAction = jest.fn();
		render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [
						{
							...teeNode,
							targets: [ '_output' ],
						},
					],
					edges: [],
					pwd: '_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				onAction={ disconnectAction }
			/>
		);
		fireEvent.click( document.querySelector( 'button.is-active' ) );
		expect( disconnectAction ).toHaveBeenCalledWith(
			'disconnect',
			'tee_a'
		);
	} );

	it( 'shows the tail/tap button for a Tee SUBCLASS driven by the catalog is_tee flag', () => {
		// The tail button keys off the catalog `is_tee` flag, not the runtime
		// target shape — so a Tap (class "Tap", is_tee true) gets the button
		// just like a Tee, even when its target is a bare string.
		const tapAction = jest.fn();
		const tapNode = {
			id: 'tap_a',
			class: 'Tap',
			count: 0,
			target: '',
			targets: [],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tap_a"
				parsed={ { nodes: [ tapNode ], edges: [] } }
				nodeIds={ new Set( [ 'tap_a' ] ) }
				catalog={ [ { shell_name: 'Tap', is_tee: true } ] }
				onAction={ tapAction }
			/>
		);
		fireEvent.click( getByText( 'Connect' ) );
		expect( tapAction ).toHaveBeenCalledWith( 'tail', 'tap_a' );
	} );

	it( 'opens a send modal and fires onAction("send", id, payload) when confirmed', () => {
		const onAction = jest.fn();
		const { getByText, getByDisplayValue, container } = renderNode( {
			onAction,
		} );
		fireEvent.click( getByText( 'Send' ) );
		// A prompt modal appears with a text input.
		const input = container.querySelector( '.topology-modal__input' );
		expect( input ).not.toBeNull();
		fireEvent.change( input, { target: { value: 'hello' } } );
		fireEvent.click(
			getByDisplayValue( 'hello' )
				.closest( '.topology-modal' )
				.querySelector( '.topology-modal__btn--primary' )
		);
		expect( onAction ).toHaveBeenCalledWith( 'send', 'echo', 'hello' );
		// Modal closes after confirm.
		expect( container.querySelector( '.topology-modal' ) ).toBeNull();
	} );

	it( 'does not fire onAction when the send modal is cancelled', () => {
		const onAction = jest.fn();
		const { getByText, container } = renderNode( { onAction } );
		fireEvent.click( getByText( 'Send' ) );
		expect( container.querySelector( '.topology-modal' ) ).not.toBeNull();
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onAction ).not.toHaveBeenCalled();
		expect( container.querySelector( '.topology-modal' ) ).toBeNull();
	} );

	it( 'renders a Connect button on Tee nodes', () => {
		const teeNode = { id: 'tee_a', class: 'Tee', count: 0, target: [] };
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ { nodes: [ teeNode ], edges: [] } }
				nodeIds={ new Set( [ 'tee_a' ] ) }
				ssePid={ 9 }
			/>
		);
		expect( getByText( 'Connect' ) ).not.toBeNull();
	} );

	it( 'flips Connect → Disconnect when parsed.pwd is in the node FULL targets (edges head-collapse to _repl)', () => {
		// parseMetadata collapses the reply-pivot edge to its head `_repl`, so the
		// toggle matches this session's pivot (parsed.pwd) against node.targets.
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [ 'request-builder', '_repl/_output/_sse:9/_output' ],
			targets: [ 'request-builder', '_repl/_output/_sse:9/_output' ],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [
						{ from: 'tee_a', to: 'request-builder' },
						{ from: 'tee_a', to: '_repl' },
					],
					pwd: '_repl/_output/_sse:9/_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
			/>
		);
		expect( getByText( 'Disconnect' ) ).not.toBeNull();
	} );

	it( 'works for the in-browser JS tee where pwd is the bare _output', () => {
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [ '_output' ],
			targets: [ '_output' ],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [],
					pwd: '_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
			/>
		);
		expect( getByText( 'Disconnect' ) ).not.toBeNull();
	} );

	it( 'stays Connect when only ANOTHER session pivot is wired (collapsed _repl edge is shared)', () => {
		// A different browser's pivot also collapses to `_repl`; the toggle must
		// not falsely read as connected for this session (parsed.pwd ≠ that target).
		const teeNode = {
			id: 'tee_a',
			class: 'Tee',
			count: 0,
			target: [ '_repl/_output/_sse:777/_output' ],
			targets: [ '_repl/_output/_sse:777/_output' ],
		};
		const { getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="tee_a"
				parsed={ {
					nodes: [ teeNode ],
					edges: [ { from: 'tee_a', to: '_repl' } ],
					pwd: '_repl/_output/_sse:9/_output',
				} }
				nodeIds={ new Set( [ 'tee_a' ] ) }
			/>
		);
		expect( getByText( 'Connect' ) ).not.toBeNull();
	} );

	it( 'live verb modal node_name select is populated from the live graph', () => {
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{
						name: 'set_target',
						args: [
							{
								name: 'target',
								type: 'node_name',
								required: true,
							},
						],
					},
				],
			},
		];
		const { getByText, container } = renderNode( { catalog } );
		fireEvent.click( getByText( 'set_target' ) ); // opens the arg modal
		const select = container.querySelector( '.topology-modal select' );
		const opts = [ ...select.options ].map( ( o ) => o.value );
		expect( opts ).toContain( 'tee_a' ); // a live node from parsed.nodes
		expect( opts ).not.toContain( 'echo' ); // self excluded
	} );

	it( 'renders TM_REQUEST buttons from the catalog and wires onAction', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				requests: [ { name: 'inspect', description: 'Inspect' } ],
			},
		];
		const { getByText } = renderNode( { catalog, onAction } );
		fireEvent.click( getByText( 'inspect' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'inspect',
			kind: 'request',
			positional: '',
			byName: {},
		} );
	} );

	it( 'renders argless TM_COMMAND verb buttons and fires invoke', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [ { name: 'GET_LAG', description: 'Lag' } ],
			},
		];
		const { getByText } = renderNode( { catalog, onAction } );
		fireEvent.click( getByText( 'GET_LAG' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'GET_LAG',
			kind: 'command',
			positional: '',
			byName: {},
		} );
	} );

	it( 'opens an arg modal for a verb with args; Run fires invoke; Cancel closes silently', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{
						name: 'with_index',
						args: [
							{
								name: 'formatter',
								type: 'string',
								required: true,
							},
						],
					},
				],
			},
		];
		const { getByText, getByLabelText, queryByText } = renderNode( {
			catalog,
			onAction,
		} );

		// Cancel path: open, then dismiss without firing.
		fireEvent.click( getByText( 'with_index' ) );
		expect( queryByText( 'Run' ) ).not.toBeNull();
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onAction ).not.toHaveBeenCalled();
		expect( queryByText( 'Run' ) ).toBeNull();

		// Run path: open, fill the arg, Run.
		fireEvent.click( getByText( 'with_index' ) );
		const field = getByLabelText( /formatter/ );
		fireEvent.change( field, { target: { value: 'json' } } );
		fireEvent.click( getByText( 'Run' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'with_index',
			kind: 'command',
			positional: 'json',
			byName: { formatter: 'json' },
		} );
	} );

	it( 'runs a verb with optional blank args as an empty invocation payload', () => {
		const onAction = jest.fn();
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [
					{
						name: 'optional_arg',
						args: [ { name: 'maybe', type: 'string' } ],
					},
				],
			},
		];
		const { getByText } = renderNode( { catalog, onAction } );
		fireEvent.click( getByText( 'optional_arg' ) );
		fireEvent.click( getByText( 'Run' ) );
		expect( onAction ).toHaveBeenCalledWith( 'invoke', 'echo', {
			verb: 'optional_arg',
			kind: 'command',
			positional: '',
			byName: {},
		} );
	} );

	it( 'clicking a live verb button is a no-op when no action handler is wired', () => {
		const catalog = [
			{
				shell_name: 'Echo',
				commands: [ { name: 'noop', args: [] } ],
			},
		];
		const { getByText } = renderNode( { catalog, onAction: null } );
		expect( () => fireEvent.click( getByText( 'noop' ) ) ).not.toThrow();
	} );

	it( 'hides verb buttons (allow_large_writes, with_index, …) for a reserved spine node', () => {
		// `_repl` is the worker's auto-mounted Partition spine. In live mode,
		// `parseMetadata` doesn't tag spine nodes — the Inspector recognizes
		// them by id (matching the reserved-node-names set). The user's
		// inspection actions (Dump/Send/Trace) still work; only TM_COMMAND /
		// TM_REQUEST verbs on the worker's owned node are blocked.
		const catalog = [
			{
				shell_name: 'Partition',
				commands: [ { name: 'allow_large_writes', args: [] } ],
				requests: [ { name: 'with_index', args: [] } ],
			},
		];
		const { queryByText, getByText } = render(
			<Inspector
				{ ...baseProps }
				selectedId="_repl"
				parsed={ {
					nodes: [
						{
							id: '_repl',
							class: 'Partition',
							count: 1,
						},
					],
					edges: [],
				} }
				nodeIds={ new Set( [ '_repl' ] ) }
				catalog={ catalog }
			/>
		);
		expect( queryByText( 'allow_large_writes' ) ).toBeNull();
		expect( queryByText( 'with_index' ) ).toBeNull();
		// Dump / Send / Trace stay — they're the user's inspection commands.
		expect( getByText( 'Dump' ) ).not.toBeNull();
		expect( getByText( 'Send' ) ).not.toBeNull();
		expect( getByText( 'Trace' ) ).not.toBeNull();
	} );
} );

// The "Activity" sparkline shows RATE_HISTORY_MAX (60) samples, one per poll.
// The poll cadence scales with graph size (computePollIntervalMs), so the real
// window is 60 * interval — the label must reflect that, not a fixed "~60s".
describe( 'formatActivityWindow', () => {
	it( 'reads ~5m for a small graph (poll cadence floored at 5s)', () => {
		// 50 nodes -> floored 5s poll -> 60 * 5s = 300s = 5m.
		expect( formatActivityWindow( 50 ) ).toBe( 'last ~5m' );
	} );

	it( 'scales to minutes for a large graph polled less often', () => {
		// 500 nodes -> 5s poll -> 60 * 5s = 300s = 5m.
		expect( formatActivityWindow( 500 ) ).toBe( 'last ~5m' );
		// 3000 nodes -> 30s poll -> 60 * 30s = 1800s = 30m.
		expect( formatActivityWindow( 3000 ) ).toBe( 'last ~30m' );
	} );
} );
