import { isLiveSample, liveTotal, streamHead } from '../liveSample';
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

describe( 'isLiveSample', () => {
	it( 'holds a sample live for one minute behind the stream head', () => {
		expect( isLiveSample( { ts: HEAD - 30 }, HEAD ) ).toBe( true );
		expect( isLiveSample( { ts: HEAD - 60 }, HEAD ) ).toBe( true );
		expect( isLiveSample( { ts: HEAD - 61 }, HEAD ) ).toBe( false );
	} );

	it( 'never counts a sample that carries no timestamp', () => {
		expect( isLiveSample( {}, HEAD ) ).toBe( false );
		expect( isLiveSample( undefined, HEAD ) ).toBe( false );
		expect( isLiveSample( { ts: '1786540928' }, HEAD ) ).toBe( false );
	} );
} );

describe( 'streamHead', () => {
	it( "is the newest reader's latest timestamp", () => {
		expect(
			streamHead( {
				a: { latest: { ts: HEAD - 7200 } },
				b: { latest: { ts: HEAD } },
				c: { latest: { ts: HEAD - 15 } },
			} )
		).toBe( HEAD );
	} );

	it( 'skips a reader with no numeric timestamp', () => {
		expect(
			streamHead( {
				a: { latest: { ts: HEAD - 9 } },
				b: { latest: { ts: '9999999999' } },
				c: { latest: { ts: NaN } },
				d: {},
			} )
		).toBe( HEAD - 9 );
	} );

	it( 'is -Infinity for a map with no dated sample', () => {
		expect( streamHead( {} ) ).toBe( -Infinity );
		expect( streamHead( null ) ).toBe( -Infinity );
	} );
} );

describe( 'liveTotal backlog', () => {
	const backlogTotal = ( consumers, head ) =>
		liveTotal( consumers, head, 'backlog' );

	it( "sums each reader's latest backlog (per-READER lag, no source dedup)", () => {
		expect(
			backlogTotal(
				{
					r1: {
						source: 'jobs.p0',
						latest: { ts: HEAD, backlog: 40960 },
					},
					r2: {
						source: 'jobs.p0',
						latest: { ts: HEAD, backlog: 20480 },
					},
					r3: {
						source: 'firehose.p0',
						latest: { ts: HEAD, backlog: 0 },
					},
				},
				HEAD
			)
		).toBe( 61440 );
	} );

	it( 'yields 0 for an empty, null, or latest-less consumers map', () => {
		expect( backlogTotal( {}, HEAD ) ).toBe( 0 );
		expect( backlogTotal( null, HEAD ) ).toBe( 0 );
		expect( backlogTotal( { r1: { source: 'jobs.p0' } }, HEAD ) ).toBe( 0 );
	} );

	// The card is a CURRENT gauge. A reader that died while behind keeps its last
	// sample, and the dashboard's 24h replay re-stamps every entry as freshly seen
	// (liveness is measured from INGEST time, not the record's), so three readers
	// dead for 17 hours reported 528 MB of debt nobody was working off — while
	// `wp nodes status` showed every live reader 0B behind.
	it( 'ignores a reader whose newest sample is stale', () => {
		const consumers = {
			live: {
				source: 'jobs.p0',
				latest: { ts: HEAD - 10, backlog: 1024 },
			},
			dead: {
				source: 'firehose.p0',
				latest: { ts: HEAD - 17 * 3600, backlog: 486539264 },
			},
		};
		expect( backlogTotal( consumers, HEAD ) ).toBe( 1024 );
	} );

	it( 'drops a reader 61s behind the head and keeps one 30s behind', () => {
		const consumers = {
			fresh: {
				source: 'jobs.p0',
				latest: { ts: HEAD - 30, backlog: 2048 },
			},
			stale: {
				source: 'jobs.p0',
				latest: { ts: HEAD - 61, backlog: 77777 },
			},
		};
		expect( backlogTotal( consumers, HEAD ) ).toBe( 2048 );
	} );

	it( 'never counts a sample with no ts, because the card shows only live debt', () => {
		expect(
			backlogTotal( { r: { latest: { backlog: 512 } } }, HEAD )
		).toBe( 0 );
	} );

	it( 'skips a reader that names no source, which no chart plots either', () => {
		expect(
			backlogTotal(
				{
					nameless: {
						source: '',
						latest: { ts: HEAD, backlog: 7777 },
					},
					r1: {
						source: 'jobs.p2',
						latest: { ts: HEAD, backlog: 3131 },
					},
				},
				HEAD
			)
		).toBe( 3131 );
	} );
} );

describe( 'liveTotal cacheSize', () => {
	const cacheSizeTotal = ( consumers, head ) =>
		liveTotal( consumers, head, 'cacheSize' );
	const reader = ( source, cacheSize, age = 5 ) => ( {
		source,
		latest: { ts: HEAD - age, cacheSize },
	} );

	describe( 'cacheSizeTotal', () => {
		it( 'sums each reader latest cache size', () => {
			const consumers = {
				'a.p0': reader( 'a.p0', 1000 ),
				'b.p0': reader( 'b.p0', 3000 ),
			};
			expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 4000 );
		} );

		it( 'counts every reader (offsetlogs are per-reader, not deduped by source)', () => {
			// Two readers of ONE source each keep their OWN offsetlog → both counted.
			const consumers = {
				r1: reader( 'firehose.p0', 500 ),
				r2: reader( 'firehose.p0', 1500 ),
			};
			expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 2000 );
		} );

		it( 'leaves a reader 61s behind the head out of the total', () => {
			const consumers = {
				fresh: reader( 'a.p0', 2400, 30 ),
				stale: reader( 'b.p0', 9100, 61 ),
			};
			expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 2400 );
		} );

		it( 'skips a reader that names no source', () => {
			const consumers = {
				nameless: reader( '', 9000 ),
				r1: reader( 'jobs.p2', 1300 ),
				r2: reader( 'jobs.p3', 700 ),
			};
			expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 2000 );
		} );

		it( 'is zero for no consumers', () => {
			expect( cacheSizeTotal( {}, HEAD ) ).toBe( 0 );
			expect( cacheSizeTotal( null, HEAD ) ).toBe( 0 );
		} );
	} );
} );

describe( 'liveTotal msgRate', () => {
	const globalMsgRate = ( consumers, head ) =>
		liveTotal( consumers, head, 'msgRate' );
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
		it( 'reads only the reader probing through to the head after a replay whose co-reader stopped 2h before it on a burst, leaving that reader its buckets', () => {
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

			const consumers = view.snapshot( 'consumers' );
			expect( consumers[ 'dead.p0' ].latest.msgRate ).toBe( 51000 );
			expect(
				consumers[ 'dead.p0' ].buckets.reduce(
					( n, b ) => n + b.f.msgs.sum,
					0
				)
			).toBe( 1500 * ( deadCount - 1 ) + 765000 );
			expect( globalMsgRate( consumers, streamHead( consumers ) ) ).toBe(
				540
			);
			view.removeNode();
		} );
	} );
} );

describe( 'a backlog no reader can measure', () => {
	const head = 5000;
	const consumers = {
		hub: {
			source: 'remote/okapi-3:firehose.p2',
			latest: { ts: head, backlog: null },
		},
		known: { source: 'firehose.p2', latest: { ts: head, backlog: 70913 } },
		gone: {
			source: 'remote/tapir-8:firehose.p2',
			latest: { ts: head - 600, backlog: null },
		},
		hub2: {
			source: 'remote/kea-41:sources:php',
			latest: { ts: head - 3, backlog: null },
		},
	};

	it( 'sums only the known lag', () => {
		expect( liveTotal( consumers, head, 'backlog' ) ).toBe( 70913 );
	} );
} );
