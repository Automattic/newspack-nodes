import { processStats } from '../processStats';

describe( 'processStats', () => {
	it( 'sums source counters as messages-in, sink counters as messages-out', () => {
		const nodes = [
			// Source: emits (has_target) but does not accept fill → produced.
			{ id: 'src', count: 10, has_target: true, accepts_fill: false },
			// Sink: accepts fill but does not emit → consumed.
			{ id: 'snk', count: 7, has_target: false, accepts_fill: true },
			// Through node (both ports) counts toward neither.
			{ id: 'mid', count: 99, has_target: true, accepts_fill: true },
		];
		const s = processStats( nodes );
		expect( s.messagesIn ).toBe( 10 );
		expect( s.messagesOut ).toBe( 7 );
	} );

	it( 'sums bytes read + written across every node', () => {
		const nodes = [
			{ id: 'a', bytesRead: 100, bytesWritten: 200 },
			{ id: 'b', bytesRead: 50, bytesWritten: 25 },
		];
		const s = processStats( nodes );
		expect( s.bytesRead ).toBe( 150 );
		expect( s.bytesWritten ).toBe( 225 );
	} );

	it( 'is zero-safe for an empty / missing node list', () => {
		expect( processStats( [] ) ).toEqual( {
			messagesIn: 0,
			messagesOut: 0,
			bytesRead: 0,
			bytesWritten: 0,
		} );
		expect( processStats( undefined ).messagesIn ).toBe( 0 );
	} );
} );
