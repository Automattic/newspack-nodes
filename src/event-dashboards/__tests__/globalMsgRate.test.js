import { globalMsgRate } from '../globalMsgRate';
import { streamHead } from '../liveSample';
import { TopicProbeViewNode } from '../nodes/topic-probe-view-node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../runtime/message';
import * as Probe from '../../runtime/probe-record';

const HEAD = 1786540928;
const live = ( source, msgRate, age = 4 ) => ( {
	source,
	latest: { ts: HEAD - age, msgRate },
} );

describe( 'globalMsgRate', () => {
	it( 'sums each source’s latest msgRate across distinct sources', () => {
		const consumers = {
			r1: live( 'firehose.p0', 7 ),
			r2: live( 'requests.p0', 3 ),
		};
		expect( globalMsgRate( consumers, HEAD ) ).toBe( 10 );
	} );

	it( 'counts each co-reader of one partition, as the stacked chart does', () => {
		// firehose.p3 read by two topologies in two workers: each counts.
		const consumers = {
			'request-builder.firehose.p3': live( 'firehose.p3', 7 ),
			'job-router.firehose.p3': live( 'firehose.p3', 11 ),
		};
		expect( globalMsgRate( consumers, HEAD ) ).toBe( 18 );
	} );

	it( 'sums across a topic’s distinct per-partition sources', () => {
		// firehose.p0 + firehose.p1 are SEPARATE sources → summed, not deduped.
		const consumers = {
			r1: live( 'firehose.p0', 4 ),
			r2: live( 'firehose.p1', 6 ),
		};
		expect( globalMsgRate( consumers, HEAD ) ).toBe( 10 );
	} );

	it( 'ignores consumers with an empty source or no latest sample', () => {
		const consumers = {
			r1: live( '', 99 ),
			r2: { source: 'requests.p0' },
			r3: live( 'firehose.p0', 4 ),
		};
		expect( globalMsgRate( consumers, HEAD ) ).toBe( 4 );
	} );

	it( 'returns 0 for empty / undefined consumers', () => {
		expect( globalMsgRate( {}, HEAD ) ).toBe( 0 );
		expect( globalMsgRate( undefined, HEAD ) ).toBe( 0 );
	} );

	it( 'counts a sample 30s behind the head and drops one 61s behind', () => {
		const consumers = {
			fresh: live( 'requests.p0', 23, 30 ),
			stale: live( 'firehose.p0', 51000, 61 ),
		};
		expect( globalMsgRate( consumers, HEAD ) ).toBe( 23 );
	} );

	it( 'a dead co-reader’s stale burst never joins the live reader’s rate', () => {
		const consumers = {
			alive: live( 'firehose.p0', 540, 9 ),
			dead: live( 'firehose.p0', 51000, 7200 ),
		};
		expect( globalMsgRate( consumers, HEAD ) ).toBe( 540 );
	} );
} );

function probeMsg( reader, ts, msgs ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = ts;
	const v = [];
	v[ Probe.SOURCE ] = 'firehose.p0';
	v[ Probe.READER ] = reader;
	v[ Probe.MSGS_DELTA ] = msgs;
	v[ Probe.ELAPSED_MS ] = 15000;
	m[ VALUE ] = v;
	return m;
}

describe( 'globalMsgRate over a replayed probe day', () => {
	it( 'reads only the reader probing through to the head after a replay whose co-reader stopped 2h before it on a burst, leaving that reader its series', () => {
		const view = new TopicProbeViewNode();
		const nowS = Math.floor( Date.now() / 1000 );
		const frames = [];
		// alive.p0 probes every 15s through to now at 540 msg/s.
		for ( let ts = nowS - 86370; ts <= nowS; ts += 15 ) {
			frames.push( [ 'alive.p0', ts, 8100 ] );
		}
		// dead.p0 stopped 2h ago on a 51K msg/s catch-up burst.
		let deadCount = 0;
		for ( let ts = nowS - 86363; ts <= nowS - 7200; ts += 15 ) {
			frames.push( [ 'dead.p0', ts, 1500 ] );
			deadCount += 1;
		}
		frames.at( -1 )[ 2 ] = 765000;
		frames.sort( ( a, b ) => a[ 1 ] - b[ 1 ] );
		for ( const [ reader, ts, msgs ] of frames ) {
			view.fill( probeMsg( reader, ts, msgs ) );
		}

		const consumers = view.snapshot();
		expect( consumers[ 'dead.p0' ].latest.msgRate ).toBe( 51000 );
		expect( consumers[ 'dead.p0' ].series.length ).toBe( deadCount );
		expect( globalMsgRate( consumers, streamHead( consumers ) ) ).toBe(
			540
		);
		view.removeNode();
	} );
} );
