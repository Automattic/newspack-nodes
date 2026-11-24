/**
 * Tests for the force graph's untangling: crossing counts and the trades and
 * mirrors that cut them, run on small seeded fixtures.
 */

import { buildModel } from '../model';
import { updateBoxes } from '../forces';
import { COMPARISONS_PER_CALL, MAX_SPANS, createUntangler } from '../untangle';
import { countCrossings } from './countCrossings';

/**
 * A label of the given length; short labels share one rect width.
 *
 * @param {number} length Characters.
 * @return {string} The label.
 */
const word = ( length ) => 'x'.repeat( length );
const node = ( id, extra = {} ) => ( { id, label: word( 1 ), ...extra } );
const group = ( id, parent = null ) => ( { id, parent } );
const link = ( source, target ) => ( { source, target } );
const build = ( nodes, links, groups = [] ) =>
	buildModel( { nodes, links, groups } );

/**
 * Put leaves at [ x, y ] pairs, in node order, and fit the boxes to them.
 * @param {import('../model').Model} model Model to move.
 * @param {number[][]}               spots Positions.
 */
const at = ( model, spots ) => {
	model.leaves.forEach( ( leaf, i ) => {
		[ leaf.x, leaf.y ] = spots[ i ];
	} );
	updateBoxes( model );
};

const spotsOf = ( model ) => model.leaves.map( ( { x, y } ) => [ x, y ] );
const crossings = ( model ) => countCrossings( model.spans );
const lengthOf = ( { source, target } ) =>
	Math.hypot( target.x - source.x, target.y - source.y );

describe( 'countCrossings', () => {
	const span = ( [ ax, ay ], [ bx, by ] ) => ( {
		source: { x: ax, y: ay },
		target: { x: bx, y: by },
	} );

	it( 'counts each pair of spans that cross once', () => {
		const spans = [
			span( [ 13, 17 ], [ 211, 190 ] ),
			span( [ 13, 190 ], [ 211, 17 ] ),
			span( [ 400, 17 ], [ 411, 190 ] ),
		];

		expect( countCrossings( spans ) ).toBe( 1 );
	} );

	it( 'skips spans that share an end or only meet in a box', () => {
		const joined = span( [ 13, 17 ], [ 211, 190 ] );
		const shared = { source: joined.source, target: { x: 300, y: 5 } };
		const apart = span( [ 13, 300 ], [ 211, 400 ] );

		expect( countCrossings( [ joined, shared, apart ] ) ).toBe( 0 );
	} );
} );

describe( 'createUntangler', () => {
	it( 'brings crossed links apart', () => {
		const model = build(
			[ node( 'a' ), node( 'b' ), node( 'c' ), node( 'd' ) ],
			[ link( 'a', 'b' ), link( 'c', 'd' ) ]
		);
		at( model, [
			[ 37, 41 ],
			[ 337, 341 ],
			[ 337, 41 ],
			[ 37, 341 ],
		] );
		expect( crossings( model ) ).toBe( 1 );

		createUntangler( model )();

		expect( crossings( model ) ).toBe( 0 );
	} );

	it( 'trades the whole subtree of both bodies', () => {
		const nodes = [
			node( 'p1', { group: 'top' } ),
			node( 'p2', { group: 'top', label: word( 40 ) } ),
			node( 'p3', { group: 'top', label: word( 40 ) } ),
			node( 'q1', { group: 'low' } ),
			node( 'q2', { group: 'low', label: word( 40 ) } ),
			node( 'q3', { group: 'low', label: word( 40 ) } ),
			node( 'u' ),
			node( 'v' ),
		];
		const model = build(
			nodes,
			[ link( 'p1', 'v' ), link( 'q1', 'u' ) ],
			[ group( 'top' ), group( 'low' ) ]
		);
		// Each branch is symmetric about its linked leaf, and the wide leaves
		// beside it are too large to trade with it.
		const before = [
			[ 13, 47 ],
			[ -17, 47 ],
			[ 43, 47 ],
			[ 13, 311 ],
			[ -17, 311 ],
			[ 43, 311 ],
			[ 503, 47 ],
			[ 503, 311 ],
		];
		at( model, before );
		expect( crossings( model ) ).toBe( 1 );

		createUntangler( model )();

		const drop = 311 - 47;
		expect( spotsOf( model ) ).toEqual( [
			[ 13, 47 + drop ],
			[ -17, 47 + drop ],
			[ 43, 47 + drop ],
			[ 13, 311 - drop ],
			[ -17, 311 - drop ],
			[ 43, 311 - drop ],
			[ 503, 47 ],
			[ 503, 311 ],
		] );
		expect( crossings( model ) ).toBe( 0 );
		expect( model.branches.map( ( { id, y } ) => [ id, y ] ) ).toEqual( [
			[ 'group:top', 311 ],
			[ 'group:low', 47 ],
		] );
	} );

	it( 'shortens links that do not cross', () => {
		const model = build(
			[ node( 'a' ), node( 'b' ), node( 'r' ) ],
			[ link( 'a', 'b' ) ]
		);
		at( model, [
			[ 29, 31 ],
			[ 1029, 31 ],
			[ 929, 81 ],
		] );
		const [ span ] = model.spans;
		const before = lengthOf( span );

		createUntangler( model )();

		expect( lengthOf( span ) ).toBeCloseTo( Math.hypot( 100, 50 ) );
		expect( lengthOf( span ) ).toBeLessThan( before );
		expect( spotsOf( model )[ 0 ] ).toEqual( [ 929, 81 ] );
	} );

	it( 'counts a crossing as worth more than a longer span', () => {
		// Only `a` and `r` are alike in size, so `a` has one partner to trade.
		const model = build(
			[
				node( 'a', { label: word( 100 ) } ),
				node( 'b' ),
				node( 'c', { label: word( 18 ) } ),
				node( 'd', { label: word( 44 ) } ),
				node( 'r', { label: word( 100 ) } ),
			],
			[ link( 'a', 'b' ), link( 'c', 'd' ) ]
		);
		at( model, [
			[ 3, 5 ],
			[ 103, 105 ],
			[ 103, 5 ],
			[ 3, 105 ],
			[ 303, 105 ],
		] );
		expect( crossings( model ) ).toBe( 1 );
		const before = lengthOf( model.spans[ 0 ] );

		createUntangler( model )();

		expect( crossings( model ) ).toBe( 0 );
		expect( lengthOf( model.spans[ 0 ] ) ).toBeGreaterThan( before );
		expect( spotsOf( model )[ 0 ] ).toEqual( [ 303, 105 ] );
	} );

	describe( 'the rounding allowance', () => {
		// Only `a` and `r` can trade for a gain: `b` is too small to meet `r`.
		const fixture = ( rivalX ) => {
			const model = build(
				[
					node( 'a', { label: word( 14 ) } ),
					node( 'b' ),
					node( 'r', { label: word( 20 ) } ),
				],
				[ link( 'a', 'b' ) ]
			);
			at( model, [
				[ 29, 31 ],
				[ 1029, 31 ],
				[ rivalX, 31 ],
			] );
			return model;
		};

		it( 'undoes a trade gaining under 1e-6', () => {
			const model = fixture( 29.0078125 );

			createUntangler( model )();

			expect( spotsOf( model ) ).toEqual( [
				[ 29, 31 ],
				[ 1029, 31 ],
				[ 29.0078125, 31 ],
			] );
		} );

		it( 'keeps a trade gaining more', () => {
			const model = fixture( 79 );

			createUntangler( model )();

			expect( spotsOf( model )[ 0 ] ).toEqual( [ 79, 31 ] );
		} );
	} );

	describe( 'mirroring', () => {
		// A branch of `p` and `s`, with `o` linked to `p` from outside; `s` is
		// too large to trade with `p`, so only a flip can move it.
		const fixture = ( [ ox, oy ] ) => {
			const model = build(
				[
					node( 'p', { group: 'g' } ),
					node( 's', { group: 'g', label: word( 40 ) } ),
					node( 'o' ),
				],
				[ link( 'p', 'o' ) ],
				[ group( 'g' ) ]
			);
			at( model, [
				[ 7, 9 ],
				[ 107, 109 ],
				[ ox, oy ],
			] );
			return model;
		};

		it( 'undoes a worse flip on both axes', () => {
			const model = fixture( [ -293, -291 ] );

			createUntangler( model )();

			expect( spotsOf( model ) ).toEqual( [
				[ 7, 9 ],
				[ 107, 109 ],
				[ -293, -291 ],
			] );
		} );

		it( 'keeps a better flip on both axes', () => {
			const model = fixture( [ 307, 309 ] );

			createUntangler( model )();

			expect( spotsOf( model ).slice( 0, 2 ) ).toEqual( [
				[ 207, 109 ],
				[ 107, 9 ],
			] );
		} );

		it( 'refits the boxes to the leaves before it begins', () => {
			const model = fixture( [ 307, 309 ] );
			for ( const leaf of model.leaves ) {
				leaf.x += 1000;
				leaf.y += 500;
			}

			createUntangler( model )();

			expect( spotsOf( model ).slice( 0, 2 ) ).toEqual( [
				[ 1207, 609 ],
				[ 1107, 509 ],
			] );
		} );

		it( 'never mirrors a hull whose links are all internal', () => {
			const model = build(
				[
					node( 'p', { group: 'g' } ),
					node( 'q', { group: 'g' } ),
					node( 'e1' ),
					node( 'e2' ),
				],
				[ link( 'p', 'q' ), link( 'e1', 'e2' ) ],
				[ group( 'g' ) ]
			);
			// A flip about x would take the inner span out from under the other.
			const before = [
				[ 3, 5 ],
				[ 103, 65 ],
				[ 23, -15 ],
				[ 23, 25 ],
			];
			at( model, before );
			expect( crossings( model ) ).toBe( 1 );

			createUntangler( model )();

			expect( spotsOf( model ) ).toEqual( before );
		} );
	} );

	describe( 'the size ratio', () => {
		const fixture = ( rivalLength ) => {
			const model = build(
				[
					node( 'a' ),
					node( 'b' ),
					node( 'r', { label: word( rivalLength ) } ),
				],
				[ link( 'a', 'b' ) ]
			);
			at( model, [
				[ 29, 31 ],
				[ 1029, 31 ],
				[ 929, 81 ],
			] );
			return model;
		};

		it( 'trades a body with a sibling within twice its size', () => {
			const model = fixture( 1 );

			createUntangler( model )();

			expect( spotsOf( model )[ 0 ] ).toEqual( [ 929, 81 ] );
		} );

		it( 'leaves a sibling over twice its size where it is', () => {
			const model = fixture( 40 );

			createUntangler( model )();

			expect( spotsOf( model ) ).toEqual( [
				[ 29, 31 ],
				[ 1029, 31 ],
				[ 929, 81 ],
			] );
		} );
	} );

	describe( 'the comparison credit', () => {
		/**
		 * Watch span reads and the order bodies are first asked for their
		 * neighbors, which every trade move does once as it starts.
		 * @param {import('../model').Model} model Model to watch.
		 * @return {{reads: function(): number, log: Object[]}} Counters.
		 */
		const watch = ( model ) => {
			let reads = 0;
			const log = [];
			for ( const span of model.spans ) {
				const { source, target } = span;
				Object.defineProperties( span, {
					source: {
						get() {
							reads++;
							return source;
						},
					},
					target: { get: () => target },
				} );
			}
			for ( const { body } of model.movable ) {
				const neighbors = body.neighbors;
				Object.defineProperty( body, 'neighbors', {
					get() {
						log.push( body );
						return neighbors;
					},
				} );
			}
			return { reads: () => reads, log };
		};

		// Twenty leaves linked in every pair: a lap costs far over a tick.
		const crowd = () => {
			const ids = Array.from( { length: 20 }, ( _, i ) => `n${ i }` );
			const links = ids.flatMap( ( a, i ) =>
				ids.slice( i + 1 ).map( ( b ) => link( a, b ) )
			);
			const model = build(
				ids.map( ( id ) => node( id ) ),
				links
			);
			at(
				model,
				ids.map( ( _, i ) => [
					101 + ( ( i * 37 ) % 20 ) * 53,
					103 + ( ( i * 11 ) % 20 ) * 29,
				] )
			);
			return model;
		};

		it( 'stays inside its budget and the next call resumes', () => {
			const model = crowd();
			const { reads, log } = watch( model );
			const untangle = createUntangler( model );
			const bodies = () => new Set( log ).size;

			untangle();
			const first = bodies();
			const last = log[ log.length - 1 ];
			const asked = log.length;

			expect( first ).toBeGreaterThan( 0 );
			expect( first ).toBeLessThan( model.movable.length );
			expect( reads() ).toBeGreaterThanOrEqual( COMPARISONS_PER_CALL );
			expect( reads() ).toBeLessThan( 3 * COMPARISONS_PER_CALL );

			// A body is asked once, as its turn begins, so call two asks the next.
			untangle();
			const order = model.movable.map( ( { body } ) => body.id );
			expect( log[ asked ].id ).toBe(
				order[ ( order.indexOf( last.id ) + 1 ) % order.length ]
			);
			expect( log.filter( ( body ) => body === last ).length ).toBe( 1 );

			for ( let i = 0; i < model.movable.length; i++ ) {
				untangle();
			}
			expect( bodies() ).toBe( model.movable.length );
		} );

		it( 'finishes at most one lap of bodies a call', () => {
			const model = build(
				[ node( 'a' ), node( 'b' ), node( 'c' ) ],
				[ link( 'a', 'b' ), link( 'b', 'c' ) ]
			);
			at( model, [
				[ 11, 13 ],
				[ 211, 113 ],
				[ 111, 313 ],
			] );
			const { log } = watch( model );

			createUntangler( model )();

			// Each body's turn is one run of reads.
			const turns = log.filter( ( body, i ) => body !== log[ i - 1 ] );
			expect( turns.length ).toBe( 3 );
			expect( new Set( turns ).size ).toBe( 3 );
		} );

		it( 'ends a call on a graph with one span', () => {
			const model = build(
				[ node( 'a' ), node( 'b' ) ],
				[ link( 'a', 'b' ) ]
			);
			at( model, [
				[ 11, 13 ],
				[ 211, 113 ],
			] );

			expect( () => createUntangler( model )() ).not.toThrow();
		} );

		describe( 'a hull holding half the spans', () => {
			// Two hulls of 35 leaves linked in every pair, ten links between.
			const hulls = () => {
				const ids = ( tag ) =>
					Array.from( { length: 35 }, ( _, i ) => `${ tag }${ i }` );
				const within = ( list ) =>
					list.flatMap( ( a, i ) =>
						list.slice( i + 1 ).map( ( b ) => link( a, b ) )
					);
				const as = ids( 'a' );
				const bs = ids( 'b' );
				const model = build(
					[
						...as.map( ( id ) => node( id, { group: 'a' } ) ),
						...bs.map( ( id ) => node( id, { group: 'b' } ) ),
					],
					[
						...within( as ),
						...within( bs ),
						...as
							.slice( 0, 10 )
							.map( ( a, i ) => link( a, bs[ i ] ) ),
					],
					[ group( 'a' ), group( 'b' ) ]
				);
				at(
					model,
					model.leaves.map( ( _, i ) => [
						( i < 35 ? 100 : 3100 ) + ( ( i * 37 ) % 35 ) * 41,
						113 + ( ( i * 11 ) % 35 ) * 37,
					] )
				);
				return model;
			};

			it( 'spends no call past a move, repays its debt and runs on', () => {
				const model = hulls();
				expect( model.spans.length ).toBe( 1200 );
				const hull = model.branches.find(
					( { id } ) => 'group:a' === id
				);
				expect( hull.spans.length ).toBe( 605 );
				// A move: two tangles over the hull's spans against all of them.
				const move = 2 * hull.spans.length * model.spans.length;
				const { reads, log } = watch( model );
				const untangle = createUntangler( model );

				const calls = [];
				const rounds = 8;
				for ( let i = 0; i < rounds; i++ ) {
					const before = { reads: reads(), asked: log.length };
					untangle();
					calls.push( {
						reads: reads() - before.reads,
						asked: log.length - before.asked,
					} );
				}

				// Two span reads and a hair more, for each comparison.
				const comparisons = ( n ) => n / 2;
				for ( const call of calls ) {
					expect( comparisons( call.reads ) ).toBeLessThan(
						COMPARISONS_PER_CALL + move * 1.01
					);
				}
				const total = calls.reduce( ( sum, c ) => sum + c.reads, 0 );
				expect( comparisons( total ) ).toBeLessThan(
					( rounds * COMPARISONS_PER_CALL + move ) * 1.01
				);

				// A heavy move leaves a debt: a call in it reads nothing.
				const idle = calls.filter( ( c ) => 0 === c.reads );
				expect( idle.length ).toBeGreaterThan( 0 );
				for ( const call of idle ) {
					expect( call.asked ).toBe( 0 );
				}
				expect( calls[ 0 ].reads ).toBeGreaterThan( 0 );
				expect(
					calls.filter( ( c ) => c.reads > 0 ).length
				).toBeGreaterThan( 1 );
			} );
		} );

		describe( 'cheap bodies, then a heavy one', () => {
			// 600 leaves each with one span and no partner, then `a`, linked
			// to all of them, with eight partners; its trades are all worse.
			const lineup = () => {
				const cs = Array.from( { length: 600 }, ( _, i ) => `c${ i }` );
				const rs = Array.from( { length: 10 }, ( _, i ) => `r${ i }` );
				const model = build(
					[
						...cs.map( ( id ) => node( id ) ),
						node( 'a', { label: word( 40 ) } ),
						...rs.map( ( id ) =>
							node( id, { label: word( 40 ) } )
						),
					],
					cs.map( ( c ) => link( 'a', c ) )
				);
				// `a` sits at the middle of its neighbors, so any move costs.
				const middle = 17 * 299.5;
				at( model, [
					...cs.map( ( _, i ) => [ -1003, 17 * i ] ),
					[ -1003, middle ],
					...rs.map( ( _, j ) => [
						-1003 + 0.001 * ( j + 1 ),
						middle,
					] ),
				] );
				return model;
			};

			it( 'does not spend credit a cheap lap left over', () => {
				const model = lineup();
				const spanCount = model.spans.length;
				// Each moved span skips the moved spans before it, then one
				// span is counted again after the move.
				const move =
					spanCount * spanCount -
					( spanCount * ( spanCount - 1 ) ) / 2 +
					spanCount;
				const { reads } = watch( model );
				const untangle = createUntangler( model );

				const spent = [];
				for ( let i = 0; i < 8; i++ ) {
					const before = reads();
					untangle();
					spent.push( ( reads() - before ) / 2 );
				}

				for ( const comparisons of spent ) {
					expect( comparisons ).toBeLessThan(
						( COMPARISONS_PER_CALL + move ) * 1.01
					);
				}
				expect( Math.max( ...spent ) ).toBeGreaterThan(
					COMPARISONS_PER_CALL
				);
			} );
		} );
	} );

	describe( 'the partners of a body', () => {
		// `a` links to 150 small leaves in a hull and has twelve rivals its
		// size, a larger one nearest of all, and 1,800 spans of filler that
		// make each trade cost a good part of a tick.
		const fixture = ( x = 5003 ) => {
			const cs = Array.from( { length: 150 }, ( _, i ) => `c${ i }` );
			const rs = Array.from( { length: 12 }, ( _, i ) => `r${ i }` );
			const fs = Array.from( { length: 1801 }, ( _, i ) => `f${ i }` );
			const model = build(
				[
					node( 'a', { label: word( 40 ) } ),
					node( 'big', { label: word( 100 ) } ),
					...rs.map( ( id ) => node( id, { label: word( 40 ) } ) ),
					...fs.map( ( id ) => node( id, { label: word( 100 ) } ) ),
					...cs.map( ( id ) => node( id, { group: 'g' } ) ),
				],
				[
					...cs.map( ( c ) => link( 'a', c ) ),
					...fs.slice( 1 ).map( ( f, i ) => link( fs[ i ], f ) ),
				],
				[ group( 'g' ) ]
			);
			at( model, [
				[ x, 7 ],
				[ 43, 11 ],
				...rs.map( ( _, j ) => [ 103 + 60 * j, 5 * j ] ),
				...fs.map( ( _, i ) => [
					50000 + ( ( i * 7919 ) % 1013 ),
					( i * 104729 ) % 997,
				] ),
				...cs.map( ( _, i ) => [ -1000, 17 * i ] ),
			] );
			return { model, rs };
		};

		/**
		 * Untangle through the turn of `a`, and count the reads of each other
		 * body: none for one it never tries, one for a trade it keeps, two
		 * for one it undoes.
		 * @param {Object}   fixed       The fixture.
		 * @param {Object}   fixed.model Its model.
		 * @param {string[]} fixed.rs    Ids of the rivals its size.
		 * @return {{tried: Object, calls: number}} Reads by id, and how many calls the turn spanned.
		 */
		const turnOfA = ( { model, rs } ) => {
			const leafOf = ( id ) => model.byId.get( id );
			const tried = Object.fromEntries(
				[ 'big', ...rs ].map( ( id ) => [ id, 0 ] )
			);
			for ( const id of Object.keys( tried ) ) {
				const leaf = leafOf( id );
				const { leafNodes } = leaf;
				Object.defineProperty( leaf, 'leafNodes', {
					get() {
						tried[ id ]++;
						return leafNodes;
					},
				} );
			}
			// The body after `a` asks for neighbors as its own turn begins.
			let begun = false;
			const next = leafOf( 'f0' );
			const { neighbors } = next;
			Object.defineProperty( next, 'neighbors', {
				get() {
					begun = true;
					return neighbors;
				},
			} );

			const reads = () =>
				Object.values( tried ).reduce( ( n, t ) => n + t, 0 );
			const untangle = createUntangler( model );
			let calls = 0;
			for ( let i = 0; i < 60 && ! begun; i++ ) {
				const before = reads();
				untangle();
				calls += reads() > before ? 1 : 0;
			}
			expect( begun ).toBe( true );
			return { tried, calls };
		};

		it( 'tries each partner once, in a turn spanning calls', () => {
			const fixed = fixture();
			expect( fixed.model.spans.length ).toBeLessThan( MAX_SPANS );
			const { tried, calls } = turnOfA( fixed );

			expect( calls ).toBeGreaterThan( 1 );
			expect( tried ).toEqual( {
				big: 0,
				r0: 1,
				r1: 2,
				r2: 2,
				r3: 2,
				r4: 2,
				r5: 2,
				r6: 2,
				r7: 0,
				r8: 0,
				r9: 0,
				r10: 0,
				r11: 0,
			} );
		} );

		it( 'leaves the body itself out, nearest though it is', () => {
			const { tried } = turnOfA( fixture( -900 ) );

			expect( tried ).toMatchObject( { r0: 2, r6: 2, r7: 0 } );
		} );
	} );

	describe( 'the span cap', () => {
		// A chain of leaves in a deterministic scatter, `spans` links long.
		const chain = ( spans ) => {
			const count = spans + 1;
			const model = build(
				Array.from( { length: count }, ( _, i ) => node( `n${ i }` ) ),
				Array.from( { length: spans }, ( _, i ) =>
					link( `n${ i }`, `n${ i + 1 }` )
				)
			);
			at(
				model,
				model.leaves.map( ( _, i ) => [
					( i * 7919 ) % 1013,
					( i * 104729 ) % 997,
				] )
			);
			return model;
		};

		it( 'leaves a model above 2,000 spans without an untangler', () => {
			expect( createUntangler( chain( MAX_SPANS + 1 ) ) ).toBeNull();
		} );

		it( 'works at 2,000 spans', () => {
			const model = chain( MAX_SPANS );
			const before = spotsOf( model );

			createUntangler( model )();

			expect( spotsOf( model ) ).not.toEqual( before );
		} );
	} );

	it.each( [
		[ 'no node', [], [] ],
		[ 'no link', [ node( 'a' ), node( 'b' ) ], [] ],
		[ 'a link to itself', [ node( 'a' ) ], [ link( 'a', 'a' ) ] ],
	] )( 'is not made for a model with %s', ( _name, nodes, links ) => {
		expect( createUntangler( build( nodes, links ) ) ).toBeNull();
	} );

	it( 'untangles one graph the same way twice', () => {
		const fixture = () => {
			const ids = Array.from( { length: 12 }, ( _, i ) => `n${ i }` );
			const model = build(
				ids.map( ( id, i ) =>
					node( id, { group: i % 3 ? 'g' : undefined } )
				),
				ids.map( ( id, i ) => link( id, ids[ ( i * 5 + 3 ) % 12 ] ) ),
				[ group( 'g' ) ]
			);
			at(
				model,
				ids.map( ( _, i ) => [
					31 + ( ( i * 7 ) % 12 ) * 41,
					37 + ( ( i * 5 ) % 12 ) * 43,
				] )
			);
			return model;
		};
		const run = ( model ) => {
			const untangle = createUntangler( model );
			for ( let i = 0; i < 5; i++ ) {
				untangle();
			}
			return spotsOf( model );
		};

		const one = fixture();
		const start = spotsOf( one );
		const peers = () =>
			one.movable.map( ( { peers: p } ) => p.map( ( { id } ) => id ) );
		const order = peers();
		const first = run( one );
		expect( first ).not.toEqual( start );
		expect( peers() ).toEqual( order );
		expect( run( fixture() ) ).toEqual( first );

		// The same model, set back and run again.
		at( one, start );
		expect( run( one ) ).toEqual( first );
	} );
} );
