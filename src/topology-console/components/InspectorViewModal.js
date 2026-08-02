/**
 * InspectorViewModal — the ONE wide modal the Inspector's no-node strip opens.
 * The Inspector rail is too narrow for grids, so the Runtime + Timeline views
 * live here instead. Reuses the shared `ModalShell` (ESC / backdrop / close /
 * portal), sized wide. Each view mounts only while the modal is open: Runtime
 * self-mounts + tears down its poller; Timeline is a parsed render of the SAME
 * `_output` transcript the console already holds.
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

const EMPTY_TRANSCRIPT = [];

// The strip's view keys → modal title. The key also picks the body below.
const VIEW_TITLES = {
	runtime: __( 'Runtime', 'newspack-nodes' ),
	stats: __( 'Profiler', 'newspack-nodes' ),
	timeline: __( 'Event Timeline', 'newspack-nodes' ),
	triage: __( 'Triage', 'newspack-nodes' ),
};

// Timeline-only transcript sub + the Trace toggle (traces feed the timeline).
function TimelineHost( { onAction } ) {
	const transcript =
		useNodeState( names.OUTPUT, 'transcript' ) ?? EMPTY_TRANSCRIPT;
	const metadata = useNodeState( names.METADATA, 'metadata' );
	const serverTraceOn = ( metadata?.nodes ?? [] ).some(
		( n ) => n.debugState > 0
	);
	// Override: agreement clears; one stale reply tolerated; two surrender.
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

// The one body per view key; each self-mounts what it needs while open.
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
 * @param {Object}      props
 * @param {string|null} props.view       'runtime' | 'stats' | 'timeline' | 'triage' | null (closed).
 * @param {Object}      [props.node]     The selected node — Triage's DLQ target.
 * @param {Function}    props.onDismiss  Close the modal.
 * @param {Function}    [props.onAction] Console action dispatcher (Timeline Trace / Triage verbs).
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
