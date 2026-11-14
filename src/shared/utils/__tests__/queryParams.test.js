/* global PopStateEvent */
import {
	getQueryParam,
	getQueryParams,
	holdPop,
	openParam,
	setParam,
	setQueryParam,
	setQueryParams,
	subscribeParam,
} from '../queryParams';

// A user agent holding every character a query string gives meaning to.
const UA = 'ua=Mozilla/5.0 (X11, Linux) a&b+c, d=e';

describe( 'queryParams', () => {
	beforeEach( () => {
		window.history.replaceState( {}, '', '/' );
	} );

	describe( 'getQueryParam', () => {
		it( 'returns the value of a present param', () => {
			window.history.replaceState( {}, '', '/?tab=console' );
			expect( getQueryParam( 'tab' ) ).toBe( 'console' );
		} );

		it( 'returns null for an absent param', () => {
			window.history.replaceState( {}, '', '/?tab=console' );
			expect( getQueryParam( 'log' ) ).toBeNull();
		} );

		it( 'returns null when there is no query string', () => {
			expect( getQueryParam( 'tab' ) ).toBeNull();
		} );

		it( 'reads the right value among several params', () => {
			window.history.replaceState(
				{},
				'',
				'/?page=station&tab=raw-logs&log=firehose'
			);
			expect( getQueryParam( 'log' ) ).toBe( 'firehose' );
		} );
	} );

	describe( 'setQueryParam', () => {
		it( 'sets a new param without touching the rest', () => {
			window.history.replaceState( {}, '', '/?page=station' );
			setQueryParam( 'tab', 'console' );
			expect( getQueryParam( 'page' ) ).toBe( 'station' );
			expect( getQueryParam( 'tab' ) ).toBe( 'console' );
		} );

		it( 'updates an existing param in place', () => {
			window.history.replaceState( {}, '', '/?tab=console&log=x' );
			setQueryParam( 'tab', 'topologies' );
			expect( getQueryParam( 'tab' ) ).toBe( 'topologies' );
			expect( getQueryParam( 'log' ) ).toBe( 'x' );
		} );

		it( 'removes the param when the value is null', () => {
			window.history.replaceState( {}, '', '/?tab=console&log=x' );
			setQueryParam( 'log', null );
			expect( getQueryParam( 'log' ) ).toBeNull();
			expect( getQueryParam( 'tab' ) ).toBe( 'console' );
		} );

		it( 'removes the param when the value is the empty string', () => {
			window.history.replaceState( {}, '', '/?tab=console&log=x' );
			setQueryParam( 'log', '' );
			expect( getQueryParam( 'log' ) ).toBeNull();
		} );

		it( 'uses history.replaceState (not pushState)', () => {
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			const pushSpy = jest.spyOn( window.history, 'pushState' );
			window.history.replaceState( {}, '', '/?page=station' );
			replaceSpy.mockClear();
			setQueryParam( 'tab', 'console' );
			expect( replaceSpy ).toHaveBeenCalled();
			expect( pushSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
			pushSpy.mockRestore();
		} );

		it( 'writes nothing when the URL would not change', () => {
			window.history.replaceState( {}, '', '/?tab=console#graph' );
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParam( 'tab', 'console' );
			setQueryParam( 'log', null );
			expect( replaceSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
		} );

		it( 'keeps the history entry state it replaces', () => {
			window.history.replaceState( { pane: 7 }, '', '/?page=station' );
			setQueryParam( 'tab', 'console' );
			expect( window.history.state ).toEqual( { pane: 7 } );
		} );
	} );

	describe( 'setQueryParams', () => {
		it( 'sets and removes several params in one write, keeping the rest', () => {
			window.history.replaceState(
				{},
				'',
				'/wp-admin/admin.php?page=perf&search=r9&q=feed#top'
			);
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParams( { search: null, url: 'h1', request: 'r9' } );
			expect( replaceSpy ).toHaveBeenCalledTimes( 1 );
			expect( window.location.pathname ).toBe( '/wp-admin/admin.php' );
			expect( window.location.search ).toBe(
				'?page=perf&q=feed&url=h1&request=r9'
			);
			expect( window.location.hash ).toBe( '#top' );
			replaceSpy.mockRestore();
		} );

		it( 'pushes a history entry when asked to', () => {
			window.history.replaceState( {}, '', '/?page=perf' );
			const pushSpy = jest.spyOn( window.history, 'pushState' );
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParams( { url: 'h1' }, { push: true } );
			expect( pushSpy ).toHaveBeenCalledTimes( 1 );
			expect( replaceSpy ).not.toHaveBeenCalled();
			expect( getQueryParam( 'url' ) ).toBe( 'h1' );
			pushSpy.mockRestore();
			replaceSpy.mockRestore();
		} );

		it( 'pushes nothing when the URL would not change', () => {
			window.history.replaceState( {}, '', '/?page=perf&url=h1' );
			const pushSpy = jest.spyOn( window.history, 'pushState' );
			setQueryParams( { url: 'h1', request: null }, { push: true } );
			expect( pushSpy ).not.toHaveBeenCalled();
			pushSpy.mockRestore();
		} );

		it( 'replaces the entry when writing a param a pushing reader holds, and tells the reader', () => {
			window.history.replaceState( {}, '', '/?page=perf' );
			const entry = openParam( 'record', {
				parse: ( raw ) => raw ?? '',
				format: ( value ) => value,
				push: true,
			} );
			let told = 0;
			const release = subscribeParam( entry, () => ( told += 1 ) );
			const entries = window.history.length;
			setQueryParams( { record: '7713' } );
			expect( window.history.length ).toBe( entries );
			expect( entry.value ).toBe( '7713' );
			expect( told ).toBe( 1 );
			release();
		} );
	} );
	describe( 'getQueryParams', () => {
		it( 'returns every value of a repeated param, in order', () => {
			window.history.replaceState(
				{},
				'',
				`/?chip=status_class%3D5xx&page=perf&chip=${ encodeURIComponent(
					UA
				) }`
			);
			expect( getQueryParams( 'chip' ) ).toEqual( [
				'status_class=5xx',
				UA,
			] );
		} );

		it( 'returns an empty list for an absent param', () => {
			window.history.replaceState( {}, '', '/?page=perf' );
			expect( getQueryParams( 'chip' ) ).toEqual( [] );
		} );
	} );

	describe( 'setQueryParams with a list', () => {
		it( 'writes one repeated key per entry, a comma intact', () => {
			window.history.replaceState(
				{},
				'',
				'/?page=perf&chip=old%3D1&url=h1#top'
			);
			setQueryParams( {
				chip: [ 'status_class=5xx', UA ],
			} );
			expect( getQueryParams( 'chip' ) ).toEqual( [
				'status_class=5xx',
				UA,
			] );
			expect( getQueryParam( 'page' ) ).toBe( 'perf' );
			expect( getQueryParam( 'url' ) ).toBe( 'h1' );
			expect( window.location.hash ).toBe( '#top' );
		} );

		it( 'removes the param for an empty list', () => {
			window.history.replaceState(
				{},
				'',
				'/?page=perf&chip=a%3D1&chip=b%3D2'
			);
			setQueryParams( { chip: [] } );
			expect( window.location.search ).toBe( '?page=perf' );
		} );

		it( 'skips an empty entry, as an empty scalar removes the param', () => {
			window.history.replaceState( {}, '', '/?page=perf&url=h1' );
			setQueryParams( { chip: [ 'method=PURGE', '', 'worker=3' ] } );
			expect( getQueryParams( 'chip' ) ).toEqual( [
				'method=PURGE',
				'worker=3',
			] );

			setQueryParams( { chip: [ '' ] } );
			expect( window.location.search ).toBe( '?page=perf&url=h1' );
		} );

		it( 'writes nothing when the list is already there', () => {
			window.history.replaceState(
				{},
				'',
				'/?chip=a%3D1&page=perf&chip=b%3D2'
			);
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParams( { chip: [ 'a=1', 'b=2' ] } );
			expect( replaceSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
		} );
	} );

	describe( 'holdPop on an entry without an index', () => {
		// A navigation key, as page state's bar keys that push declare it.
		const PUSHED = {
			parse: ( raw ) => raw ?? '',
			format: ( value ) => value,
			push: true,
		};
		const release = [];
		let pushSpy;
		let replaceSpy;

		/**
		 * Open a pushing param and subscribe a counting reader to it.
		 *
		 * @param {string} name The param.
		 * @return {{entry: Object, told: () => number}} The param and its count.
		 */
		const reader = ( name ) => {
			const entry = openParam( name, PUSHED );
			let count = 0;
			release.push( subscribeParam( entry, () => ( count += 1 ) ) );
			return { entry, told: () => count };
		};

		/**
		 * Land on an entry as Back does, on an entry the store never stamped:
		 * the bar moves, then popstate.
		 *
		 * @param {string} url The entry's URL.
		 */
		const back = ( url ) => {
			window.history.replaceState( { landed: url }, '', url );
			window.dispatchEvent( new PopStateEvent( 'popstate' ) );
		};

		beforeEach( () => {
			window.history.replaceState( {}, '', '/?page=pb&objid=101' );
		} );

		afterEach( () => {
			release.splice( 0 ).forEach( ( off ) => off() );
			pushSpy?.mockRestore();
			replaceSpy?.mockRestore();
		} );

		const spy = () => {
			pushSpy = jest.spyOn( window.history, 'pushState' );
			replaceSpy = jest.spyOn( window.history, 'replaceState' );
		};

		it( 'tells no reader and puts the shown URL back when a veto holds', () => {
			const objid = reader( 'objid' );
			release.push( holdPop( () => true ) );
			const before = objid.told();
			back( '/?page=pb&objid=7#top' );
			expect( objid.told() ).toBe( before );
			expect( objid.entry.value ).toBe( '101' );
			expect( window.location.search ).toBe( '?page=pb&objid=101' );
			expect( window.location.hash ).toBe( '' );
		} );

		it( 'puts the shown URL back with a replace, never a push', () => {
			reader( 'objid' );
			release.push( holdPop( () => true ) );
			spy();
			back( '/?page=pb&objid=7' );
			expect( pushSpy ).not.toHaveBeenCalled();
			expect( replaceSpy.mock.calls.at( -1 )[ 2 ] ).toBe(
				'/?page=pb&objid=101'
			);
		} );

		it( 'hands the veto the params of the entry Back landed on', () => {
			reader( 'objid' );
			const seen = [];
			release.push(
				holdPop( ( incoming ) => {
					seen.push( incoming.get( 'objid' ) );
					return true;
				} )
			);
			back( '/?page=pb&objid=7' );
			expect( seen ).toEqual( [ '7' ] );
		} );

		it( 'lets the pop through when every veto answers anything but true', () => {
			const objid = reader( 'objid' );
			release.push( holdPop( () => false ) );
			release.push( holdPop( () => undefined ) );
			const before = objid.told();
			back( '/?page=pb&objid=7' );
			expect( objid.told() ).toBe( before + 1 );
			expect( objid.entry.value ).toBe( '7' );
			expect( window.location.search ).toBe( '?page=pb&objid=7' );
		} );

		it( 'finishes a held pop on proceed with a replace of the landed entry', () => {
			const objid = reader( 'objid' );
			let proceed;
			release.push(
				holdPop( ( incoming, go ) => {
					proceed = go;
					return true;
				} )
			);
			back( '/?page=pb&objid=7&chip=a#sec' );
			spy();
			const before = objid.told();
			proceed();
			expect( pushSpy ).not.toHaveBeenCalled();
			expect( replaceSpy.mock.calls[ 0 ] ).toEqual( [
				{ landed: '/?page=pb&objid=7&chip=a#sec' },
				'',
				'/?page=pb&objid=7&chip=a#sec',
			] );
			expect( objid.told() ).toBe( before + 1 );
			expect( objid.entry.value ).toBe( '7' );
		} );

		it( 'restores every pushing param a held multi-step Back moved', () => {
			const cls = reader( 'class' );
			const objid = reader( 'objid' );
			setParam( cls.entry, 'Venue' );
			let proceed;
			release.push(
				holdPop( ( incoming, go ) => {
					proceed = go;
					return true;
				} )
			);
			back( '/?page=pb&class=Event&objid=9' );
			expect( cls.entry.value ).toBe( 'Venue' );
			expect( objid.entry.value ).toBe( '101' );

			proceed();
			expect( cls.entry.value ).toBe( 'Event' );
			expect( objid.entry.value ).toBe( '9' );
			expect( window.location.search ).toBe(
				'?page=pb&class=Event&objid=9'
			);
		} );

		it( 'restores the URL the page last wrote, not the one it loaded on', () => {
			const objid = reader( 'objid' );
			setParam( objid.entry, '205' );
			release.push( holdPop( () => true ) );
			back( '/?page=pb&objid=101' );
			expect( window.location.search ).toBe( '?page=pb&objid=205' );
		} );

		it( 'asks a veto that stands alone, with no reader subscribed', () => {
			const asked = [];
			release.push(
				holdPop( ( incoming ) => {
					asked.push( incoming.get( 'tab' ) );
					return true;
				} )
			);
			back( '/?tab=raw-logs' );
			expect( asked ).toEqual( [ 'raw-logs' ] );
			expect( window.location.search ).toBe( '?page=pb&objid=101' );
		} );

		it( 'asks a released veto no more, and disarms popstate with it', () => {
			const removeSpy = jest.spyOn( window, 'removeEventListener' );
			const asked = [];
			const off = holdPop( () => asked.push( 1 ) && true );
			off();
			expect( removeSpy ).toHaveBeenCalledWith(
				'popstate',
				expect.any( Function )
			);
			removeSpy.mockRestore();
			back( '/?page=pb&objid=7' );
			expect( asked ).toEqual( [] );
			expect( window.location.search ).toBe( '?page=pb&objid=7' );
		} );
	} );

	describe( 'holdPop over indexed history', () => {
		// The key the store stamps each entry's place under in history.state.
		const KEY = 'newspackNodesBar';

		/**
		 * The stamp the store gives the entry at a place in this document.
		 *
		 * @param {number} at The place.
		 * @return {Object} The entry's state.
		 */
		const stamp = ( at ) => ( {
			[ KEY ]: { doc: window.__newspackNodesBar.doc, at },
		} );
		const PUSHED = {
			parse: ( raw ) => raw ?? '',
			format: ( value ) => value,
			push: true,
		};
		const release = [];
		let spies;

		/** Let a traversal and the popstate it queues land. */
		const settle = async () => {
			for ( let i = 0; i < 4; i++ ) {
				await new Promise( ( done ) => setTimeout( done, 0 ) );
			}
		};

		/**
		 * Open a pushing param and subscribe a counting reader to it.
		 *
		 * @param {string} name The param.
		 * @return {{entry: Object, told: () => number}} The param and its count.
		 */
		const reader = ( name ) => {
			const entry = openParam( name, PUSHED );
			let count = 0;
			release.push( subscribeParam( entry, () => ( count += 1 ) ) );
			return { entry, told: () => count };
		};

		/**
		 * Land the page on 101, an entry stamped as the landing is, and push
		 * 205 and then 309 through the store, as a navigation does.
		 *
		 * @return {{entry: Object, told: () => number}} The objid reader.
		 */
		const browse = () => {
			window.history.replaceState(
				{ ...stamp( 0 ), other: 'kept' },
				'',
				'/?page=pb&objid=101'
			);
			const objid = reader( 'objid' );
			setParam( objid.entry, '205' );
			setParam( objid.entry, '309' );
			return objid;
		};

		const spy = () => {
			spies = [ 'go', 'pushState', 'replaceState' ].map( ( method ) =>
				jest.spyOn( window.history, method )
			);
			return Object.fromEntries(
				spies.map( ( one, i ) => [
					[ 'go', 'push', 'replace' ][ i ],
					one,
				] )
			);
		};

		afterEach( () => {
			release.splice( 0 ).forEach( ( off ) => off() );
			( spies ?? [] ).forEach( ( one ) => one.mockRestore() );
			spies = null;
		} );

		it( 'stamps each pushed entry one past the entry it left, keeping the rest of its state', async () => {
			browse();
			expect( window.history.state ).toEqual( stamp( 2 ) );
			window.history.back();
			await settle();
			expect( window.history.state ).toEqual( stamp( 1 ) );
			window.history.back();
			await settle();
			expect( window.history.state ).toEqual( {
				...stamp( 0 ),
				other: 'kept',
			} );
		} );

		it( 'returns from a held Back with one go and writes no entry', async () => {
			const objid = browse();
			let asked = 0;
			release.push(
				holdPop( () => {
					asked += 1;
					return true;
				} )
			);
			const length = window.history.length;
			const before = objid.told();
			const { go, push, replace } = spy();
			window.history.back();
			await settle();
			expect( go.mock.calls ).toEqual( [ [ 1 ] ] );
			expect( push ).not.toHaveBeenCalled();
			expect( replace ).not.toHaveBeenCalled();
			expect( asked ).toBe( 1 );
			expect( objid.told() ).toBe( before );
			expect( objid.entry.value ).toBe( '309' );
			expect( window.location.search ).toBe( '?page=pb&objid=309' );
			expect( window.history.length ).toBe( length );
		} );

		it( 'lands a second Back on the entry the first one reached, then the one before it', async () => {
			const objid = browse();
			let hold = true;
			release.push( holdPop( () => hold ) );
			window.history.back();
			await settle();
			hold = false;

			window.history.back();
			await settle();
			expect( objid.entry.value ).toBe( '205' );
			expect( window.location.search ).toBe( '?page=pb&objid=205' );

			window.history.back();
			await settle();
			expect( objid.entry.value ).toBe( '101' );
		} );

		it( 'returns a held two-step traversal in one go', async () => {
			const objid = browse();
			release.push( holdPop( () => true ) );
			const { go } = spy();
			window.history.go( -2 );
			await settle();
			expect( go.mock.calls ).toEqual( [ [ -2 ], [ 2 ] ] );
			expect( objid.entry.value ).toBe( '309' );
			expect( window.location.search ).toBe( '?page=pb&objid=309' );
		} );

		it( 'proceeds to the entry the user chose with a go, then publishes it', async () => {
			const cls = reader( 'class' );
			const objid = browse();
			let proceed;
			release.push(
				holdPop( ( incoming, go ) => {
					proceed = go;
					return true;
				} )
			);
			setParam( cls.entry, 'Venue' );
			window.history.go( -2 );
			await settle();
			const before = objid.told();
			const { go, push, replace } = spy();
			proceed();
			await settle();
			expect( go.mock.calls ).toEqual( [ [ -2 ] ] );
			expect( push ).not.toHaveBeenCalled();
			expect( replace ).not.toHaveBeenCalled();
			expect( objid.told() ).toBe( before + 1 );
			expect( objid.entry.value ).toBe( '205' );
			expect( cls.entry.value ).toBe( '' );
		} );

		it( 'proceeds even when the answer comes before the return has landed', async () => {
			const objid = browse();
			let asked = 0;
			release.push(
				holdPop( ( incoming, go ) => {
					asked += 1;
					go();
					return true;
				} )
			);
			window.history.back();
			await settle();
			expect( asked ).toBe( 1 );
			expect( objid.entry.value ).toBe( '205' );
			expect( window.location.search ).toBe( '?page=pb&objid=205' );
		} );

		it( 'proceeds to the chosen entry when the answer comes while the return is in flight', async () => {
			const objid = browse();
			let proceed;
			let asked = 0;
			release.push(
				holdPop( ( incoming, go ) => {
					asked += 1;
					proceed = go;
					return true;
				} )
			);
			window.addEventListener( 'popstate', () => proceed(), {
				once: true,
			} );
			const { go } = spy();
			window.history.back();
			await settle();
			await settle();
			expect( go.mock.calls ).toEqual( [ [ 1 ], [ -1 ] ] );
			expect( asked ).toBe( 1 );
			expect( window.history.state ).toEqual( stamp( 1 ) );
			expect( objid.entry.value ).toBe( '205' );
		} );

		it( 'goes nowhere on a second proceed, nor on one from a veto that let the pop through', async () => {
			const objid = browse();
			const proceeds = [];
			let hold = true;
			release.push(
				holdPop( ( incoming, go ) => {
					proceeds.push( go );
					return hold;
				} )
			);
			window.history.back();
			await settle();
			proceeds[ 0 ]();
			await settle();
			hold = false;
			window.history.back();
			await settle();
			expect( objid.entry.value ).toBe( '101' );
			const { go } = spy();
			proceeds[ 0 ]();
			proceeds[ 1 ]();
			await settle();
			expect( go ).not.toHaveBeenCalled();
			expect( objid.entry.value ).toBe( '101' );
		} );

		it( 'returns Forward to the entry a proceeded Back left', async () => {
			const objid = browse();
			let proceed;
			let hold = true;
			release.push(
				holdPop( ( incoming, go ) => {
					proceed = go;
					return hold;
				} )
			);
			window.history.back();
			await settle();
			proceed();
			await settle();
			hold = false;
			expect( objid.entry.value ).toBe( '205' );

			window.history.forward();
			await settle();
			expect( objid.entry.value ).toBe( '309' );
			expect( window.location.search ).toBe( '?page=pb&objid=309' );
		} );

		/**
		 * Chrome's traversals, as measured on a bare page in Chrome 157
		 * (task-C6 report, round 5): a `go` resolves against the newest entry
		 * any earlier traversal reached, ahead of the popstate being handled,
		 * and is dropped when it resolves to the entry the page shows or past
		 * either end of history. Each traversal lands one task after the one
		 * before.
		 *
		 * @param {number} last The highest place the history holds.
		 * @return {jest.SpyInstance} `go`, spied.
		 */
		const chromeTraversals = ( last ) => {
			const real = window.history.go.bind( window.history );
			const place = () => window.history.state[ KEY ].at;
			const targets = [];
			const next = () => {
				if ( targets.length ) {
					window.addEventListener(
						'popstate',
						() => setTimeout( next, 0 ),
						{ once: true }
					);
					real( targets.shift() - place() );
				}
			};
			const go = jest
				.spyOn( window.history, 'go' )
				.mockImplementation( ( delta ) => {
					const target = ( targets.at( -1 ) ?? place() ) + delta;
					if ( target !== place() && 0 <= target && target <= last ) {
						targets.push( target );
						if ( 1 === targets.length ) {
							setTimeout( next, 0 );
						}
					}
				} );
			spies = [ go ];
			return go;
		};

		/** Let a run of traversals land. */
		const settleAll = async () => {
			for ( let i = 0; i < 40; i++ ) {
				await new Promise( ( done ) => setTimeout( done, 0 ) );
			}
		};

		/**
		 * Land on 100, stamped 0, push 101 to 104, then go back to `shown`
		 * with no veto, as browsing to it does.
		 *
		 * @param {number} shown The place to show.
		 * @return {{entry: Object, told: () => number}} The objid reader.
		 */
		const browseFive = async ( shown ) => {
			window.history.replaceState(
				stamp( 0 ),
				'',
				'/?page=pb&objid=100'
			);
			const objid = reader( 'objid' );
			[ '101', '102', '103', '104' ].forEach( ( id ) =>
				setParam( objid.entry, id )
			);
			window.history.go( shown - 4 );
			await settle();
			return objid;
		};

		/**
		 * A veto holding every pop behind one Confirm, as a page keeps the
		 * leave it asks about under one key and shows one dialog for it.
		 *
		 * @return {{opened: () => number, proceed: () => void}} Dialogs opened,
		 *                                                       and the last
		 *                                                       ask's proceed.
		 */
		const confirm = () => {
			let leaving = null;
			let opened = 0;
			release.push(
				holdPop( ( incoming, proceed ) => {
					opened += null === leaving ? 1 : 0;
					leaving = proceed;
					return true;
				} )
			);
			return { opened: () => opened, proceed: () => leaving() };
		};

		it.each( [ 2, 3 ] )(
			'settles %i quick Backs on the shown entry behind one Confirm',
			async ( backs ) => {
				const objid = await browseFive( 3 );
				const dialog = confirm();
				chromeTraversals( 4 );
				for ( let i = 0; i < backs; i++ ) {
					window.history.go( -1 );
				}
				await settleAll();
				expect( dialog.opened() ).toBe( 1 );
				expect( window.history.state ).toEqual( stamp( 3 ) );
				expect( objid.entry.value ).toBe( '103' );
				expect( window.location.search ).toBe( '?page=pb&objid=103' );
			}
		);

		it( 'proceeds after quick Backs to the entry the last one reached', async () => {
			const objid = await browseFive( 3 );
			const dialog = confirm();
			chromeTraversals( 4 );
			window.history.go( -1 );
			window.history.go( -1 );
			await settleAll();
			dialog.proceed();
			await settleAll();
			expect( window.history.state ).toEqual( stamp( 1 ) );
			expect( objid.entry.value ).toBe( '101' );
			expect( window.location.search ).toBe( '?page=pb&objid=101' );
		} );

		it( 'forgets a traversal in flight once the last reader and veto leave', async () => {
			browse();
			let proceed;
			release.push(
				holdPop( ( incoming, go ) => {
					proceed = go;
					return true;
				} )
			);
			window.history.back();
			await settle();
			proceed();
			release.splice( 0 ).forEach( ( off ) => off() );
			await settle();
			window.history.forward();
			await settle();
			expect( window.location.search ).toBe( '?page=pb&objid=309' );

			const again = reader( 'objid' );
			let asked = 0;
			release.push(
				holdPop( () => {
					asked += 1;
					return true;
				} )
			);
			window.history.back();
			await settle();
			expect( asked ).toBe( 1 );
			expect( again.entry.value ).toBe( '309' );
			expect( window.location.search ).toBe( '?page=pb&objid=309' );
		} );

		describe( 'with a second copy of the module on the page', () => {
			let other;

			beforeAll( () => {
				jest.isolateModules( () => {
					other = require( '../queryParams' );
				} );
			} );

			/**
			 * Subscribe a counting reader to a pushing param in the other copy.
			 *
			 * @param {string} name The param.
			 * @return {{entry: Object, told: () => number}} The param and its count.
			 */
			const otherReader = ( name ) => {
				const entry = other.openParam( name, PUSHED );
				let count = 0;
				release.push(
					other.subscribeParam( entry, () => ( count += 1 ) )
				);
				return { entry, told: () => count };
			};

			it( "holds a pop for the other copy's readers", async () => {
				window.history.replaceState(
					stamp( 0 ),
					'',
					'/?page=pb&objid=101'
				);
				const objid = otherReader( 'objid' );
				other.setParam( objid.entry, '205' );
				release.push( holdPop( () => true ) );
				const before = objid.told();
				const { go, replace } = spy();
				window.history.back();
				await settle();
				expect( go.mock.calls ).toEqual( [ [ 1 ] ] );
				expect( replace ).not.toHaveBeenCalled();
				expect( objid.told() ).toBe( before );
				expect( objid.entry.value ).toBe( '205' );
				expect( window.location.search ).toBe( '?page=pb&objid=205' );
			} );

			it( 'returns a held Back by the step the other copy pushed', async () => {
				window.history.replaceState(
					stamp( 0 ),
					'',
					'/?page=pb&objid=101'
				);
				release.push( holdPop( () => true ) );
				const objid = otherReader( 'objid' );
				other.setParam( objid.entry, '205' );
				other.setParam( objid.entry, '309' );
				const { go } = spy();
				window.history.back();
				await settle();
				expect( go.mock.calls ).toEqual( [ [ 1 ] ] );
				expect( window.location.search ).toBe( '?page=pb&objid=309' );
			} );

			it( 'stamps the landing once, whichever copy loads later', () => {
				window.history.replaceState( { foreign: 1 }, '', '/?page=pb' );
				jest.isolateModules( () => require( '../queryParams' ) );
				expect( window.history.state ).toEqual( { foreign: 1 } );
			} );
		} );

		it( 'takes the fallback on an entry stamped by the document before a reload', async () => {
			browse();
			release.splice( 0 ).forEach( ( off ) => off() );
			window.history.replaceState( null, '', window.location.href );
			delete window.__newspackNodesBar;
			let reloaded;
			jest.isolateModules( () => {
				reloaded = require( '../queryParams' );
			} );
			release.push( reloaded.holdPop( () => true ) );
			const { go } = spy();
			window.history.back();
			await settle();
			expect( go ).not.toHaveBeenCalled();
			expect( window.location.search ).toBe( '?page=pb&objid=309' );
		} );

		it( 'loads where crypto.randomUUID is absent, as on plain-HTTP admin', () => {
			const { randomUUID } = window.crypto;
			delete window.__newspackNodesBar;
			window.crypto.randomUUID = undefined;
			try {
				jest.isolateModules( () => require( '../queryParams' ) );
				expect( window.__newspackNodesBar.doc ).toMatch( /\S{8,}/ );
			} finally {
				window.crypto.randomUUID = randomUUID;
			}
		} );

		it( 'writes a param set during a held return onto the shown entry', async () => {
			const objid = browse();
			let hold = true;
			release.push( holdPop( () => hold ) );
			window.addEventListener(
				'popstate',
				() => setParam( objid.entry, '412' ),
				{ once: true }
			);
			window.history.back();
			await settle();
			expect( window.history.state ).toEqual( stamp( 2 ) );
			expect( window.location.search ).toBe( '?page=pb&objid=412' );
			expect( objid.entry.value ).toBe( '412' );

			hold = false;
			window.history.back();
			await settle();
			expect( window.history.state ).toEqual( stamp( 1 ) );
			expect( window.location.search ).toBe( '?page=pb&objid=205' );
		} );

		it( 'falls back to a replace when the landed entry carries no index', async () => {
			const objid = browse();
			release.push( holdPop( () => true ) );
			const { go, replace } = spy();
			window.history.replaceState(
				{ foreign: 1 },
				'',
				'/?page=pb&objid=7'
			);
			window.dispatchEvent( new PopStateEvent( 'popstate' ) );
			await settle();
			expect( go ).not.toHaveBeenCalled();
			expect( replace.mock.calls.at( -1 ) ).toEqual( [
				{ foreign: 1 },
				'',
				'/?page=pb&objid=309',
			] );
			expect( objid.entry.value ).toBe( '309' );
		} );
	} );
} );
