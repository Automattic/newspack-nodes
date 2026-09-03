/**
 * InspectorViewModal — the ONE wide modal every Inspector view too big for the
 * rail opens into: Runtime, Profiler, Event Timeline and Triage. The rail is a
 * narrow column and all four views are grids, so they render here instead of
 * inline. The no-node strip opens the first three; the selected node's pane
 * opens Triage.
 *
 * The modal owns the title and the body switch, nothing else. `ModalShell`
 * supplies the portal, the ESC and backdrop dismissals and the close button,
 * sized wide. Each body then mounts what it needs for as long as the modal is
 * open and no longer: Runtime and Profiler build their own pollers and tear
 * them down on unmount, Timeline re-renders the `_output` transcript the
 * console already holds, and Triage fetches the selected node's dead-letter
 * page through `onAction`.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { ModalShell } from './Modal';
import RuntimeView from './RuntimeView';
import ProfilerView from './ProfilerView';
import TimelineView from './TimelineView';
import TriageView from './TriageView';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';

/**
 * Stand-in for a console that has published no transcript yet. It lives at
 * module scope so every transcript-less render hands `TimelineView` the same
 * array rather than a fresh literal.
 */
const EMPTY_TRANSCRIPT = [];

/**
 * Each view key mapped to its modal title. A key absent here has no title, and
 * a missing title is what closes the modal, so this object doubles as the list
 * of views that exist; the same key picks the body in `ViewBody`. The
 * Profiler's key is `stats`.
 */
const VIEW_TITLES = {
	runtime: __( 'Runtime', 'newspack-nodes' ),
	stats: __( 'Profiler', 'newspack-nodes' ),
	timeline: __( 'Event Timeline', 'newspack-nodes' ),
	triage: __( 'Triage', 'newspack-nodes' ),
};

/**
 * The Timeline body: the transcript subscription plus the all-nodes Trace
 * toggle. Only a traced node emits the `DEBUG:` lines the timeline parses, so
 * the switch that fills the grid sits beside it. The toggle sends `trace * 0`
 * or `trace * 1` and reads tracing as on when any node reports a `debugState`
 * above zero.
 *
 * `_metadata` needs a poll or two to report the new level, so the button holds
 * an optimistic override in the meantime. An agreeing poll clears it. The
 * first disagreeing poll is tolerated, because a reply already in flight when
 * the verb landed still carries the old level. The second surrenders, which is
 * how a refused verb stops the button claiming a state the fleet is not in.
 * The effect keys on `metadata` alone so that each poll costs one tolerance;
 * adding `optimistic` to the deps would spend it on the render that set it.
 *
 * @param {Object}   props
 * @param {Function} [props.onAction] Console action dispatcher; sends the trace verb.
 * @return {import('react').ReactElement} The timeline grid, with the toggle in its filter row.
 */
function TimelineHost( { onAction } ) {
	const transcript =
		useNodeState( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;
	const metadata = useNodeState( names.METADATA, 'metadata' );
	const serverTraceOn = ( metadata?.nodes ?? [] ).some(
		( n ) => n.debugState > 0
	);
	const [ optimistic, setOptimistic ] = useState( null );
	const disagreeRef = useRef( 0 );
	useEffect( () => {
		if ( null === optimistic ) {
			return;
		}
		if ( serverTraceOn === optimistic || disagreeRef.current >= 1 ) {
			disagreeRef.current = 0;
			setOptimistic( null );
			return;
		}
		disagreeRef.current += 1;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ metadata ] );
	const traceOn = null !== optimistic ? optimistic : serverTraceOn;
	const toggleTrace = () => {
		disagreeRef.current = 0;
		setOptimistic( ! traceOn );
		onAction?.( 'trace', '*', traceOn ? 0 : 1 );
	};
	return (
		<TimelineView
			transcript={ transcript }
			actions={
				<button
					type="button"
					className={ `button is-compact${
						traceOn ? ' is-active' : ''
					}` }
					onClick={ toggleTrace }
					title={
						traceOn
							? __(
									'Stop tracing every node — `trace * 0`',
									'newspack-nodes'
							  )
							: __(
									'Trace every node — `trace * 1`',
									'newspack-nodes'
							  )
					}
				>
					{ traceOn
						? __( 'stop trace', 'newspack-nodes' )
						: __( 'trace', 'newspack-nodes' ) }
				</button>
			}
		/>
	);
}

/**
 * The one body per view key. `InspectorViewModal` renders nothing for a key
 * with no title, so the closing fall-through is only ever reached by
 * `timeline`.
 *
 * @param {Object}   props
 * @param {string}   props.view       Which body to render.
 * @param {Object}   [props.node]     The selected node; Triage reads its dead-letter queue.
 * @param {Function} [props.onAction] Console action dispatcher, handed to Timeline and Triage.
 * @return {import('react').ReactElement} The body for this view.
 */
function ViewBody( { view, node, onAction } ) {
	if ( 'runtime' === view ) {
		return <RuntimeView />;
	}
	if ( 'stats' === view ) {
		return <ProfilerView />;
	}
	if ( 'triage' === view ) {
		return <TriageView node={ node } onAction={ onAction } />;
	}
	return <TimelineHost onAction={ onAction } />;
}

/**
 * Render the wide modal around the requested view, or nothing when none is
 * open. The caller keeps the open view in its own state and closes the modal
 * by passing null, so there is one source of truth for what is showing.
 *
 * @param {Object}      props
 * @param {string|null} props.view       Which view to open: `runtime`, `stats`, `timeline` or `triage`; null or an unknown key means closed.
 * @param {Object}      [props.node]     The selected node, whose dead-letter queue Triage reads.
 * @param {() => void}  props.onDismiss  Runs on ESC, backdrop click and the close button.
 * @param {Function}    [props.onAction] Console action dispatcher for Timeline's trace verb and Triage's dead-letter verbs.
 * @return {import('react').ReactElement|null} The modal, or null when closed.
 */
export default function InspectorViewModal( {
	view,
	node,
	onDismiss,
	onAction,
} ) {
	const title = VIEW_TITLES[ view ];
	if ( ! title ) {
		return null;
	}
	return (
		<ModalShell title={ title } onDismiss={ onDismiss } wide>
			<div className="topology-modal__body topology-inspview">
				<ViewBody view={ view } node={ node } onAction={ onAction } />
			</div>
		</ModalShell>
	);
}
