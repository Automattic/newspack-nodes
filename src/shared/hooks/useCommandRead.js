/**
 * useCommandRead and useCommandWrite — a page's reads and writes, each a
 * `useCommandOnce` riding the batched router tick under the caller's group,
 * so `connect <group>:shell` watches every send.
 *
 * A read is asked again whenever its arguments change and shows only the
 * answer to the question it asks now: the Fetcher's gate drops the answer to
 * a superseded ask, and the arguments a reply echoes say which question it
 * answers (ADR-7). A write is sent once per `run()` and refreshes what it
 * changed once it lands.
 *
 * A send never names a subject: a token may spell a whole URL, past the
 * length a reply address carries, so a subject would be dropped for it. A
 * write's refusal names its send by the arguments it echoes instead.
 *
 * Every answer is remembered in memory per group, keyed by verb, CI and
 * arguments, so a read mounting again paints its last answer at once, marked
 * stale, while it asks afresh, and a write dirties only its own group's
 * answers: a prefix `<verb>:` reaches that verb's answers from every CI, and
 * `<verb>:<ci>:` those from that CI alone. A refusal forgets the answer it
 * would have replaced, so a row a reader may no longer see never paints
 * after the server has said so. The memory lives in the page alone and is
 * never written to browser storage, because an answer may carry what only
 * this reader may see; a page load starts empty.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core, formatCommandArgs } from '@newspack-nodes/runtime';
import { useCommandOnce } from './useCommandOnce';

/** Every send here is about nothing narrower than its verb. */
const NO_SUBJECT = () => null;

/** The most answers a group remembers; the least recently used goes first. */
const CACHE_MAX = 64;

/**
 * What one group keeps: the answers it remembers, `{ answer, at }` by cache
 * key, oldest use first, and its mounted reads' re-asks, each handed the
 * test of whether a write dirtied it.
 *
 * @typedef {Object} Group
 * @property {Map<string, {answer: Object, at: number}>}        answers Its answers.
 * @property {Set<(dirtied: (key: string) => boolean) => void>} reads   Its re-asks.
 */

/**
 * Each page process's groups, by the node registry `Core` boots with, so a
 * page load, or a `Core.reset()`, starts with none.
 *
 * @type {WeakMap<Object, Map<string, Group>>}
 */
const registries = new WeakMap();

/**
 * One group's answers and mounted reads.
 *
 * @param {string} group The surface.
 * @return {Group} What it keeps.
 */
function groupOf( group ) {
	if ( ! registries.has( Core.registry ) ) {
		registries.set( Core.registry, new Map() );
	}
	const groups = registries.get( Core.registry );
	if ( ! groups.has( group ) ) {
		groups.set( group, { answers: new Map(), reads: new Set() } );
	}
	return groups.get( group );
}

/**
 * Refuse an option a hook does not take, naming it: the caller counts on it.
 *
 * @param {string} hook The hook and its command, as the refusal names them.
 * @param {Object} rest The options left once the hook took its own.
 * @throws {TypeError} When any is left.
 */
function refuseUnknown( hook, rest ) {
	const unknown = Object.keys( rest );
	if ( unknown.length ) {
		throw new TypeError(
			`${ hook }: no such option ${ unknown.join( ', ' ) }`
		);
	}
}

/**
 * The key an answer is remembered under, `<verb>:<ci>:<args>`, so two CIs
 * answering one verb never share an answer, and a write dirties a verb's
 * reads from every CI by the prefix `<verb>:`, or from one by `<verb>:<ci>:`.
 *
 * @param {string}   command The read verb.
 * @param {string}   ci      The CI it is read from, '' for an interpreter.
 * @param {string[]} args    Its argument tokens.
 * @return {string} The key.
 */
const cacheKey = ( command, ci, args ) =>
	`${ command }:${ ci }:${ JSON.stringify( args ) }`;

/**
 * Mark a remembered answer as used now, so it is the last to be evicted.
 *
 * @param {string} group The surface.
 * @param {string} key   The cache key.
 */
function touch( group, key ) {
	const memory = groupOf( group ).answers;
	const entry = memory.get( key );
	if ( entry ) {
		memory.delete( key );
		memory.set( key, entry );
	}
}

/**
 * Remember an answer as the newest, evicting the least recently used past
 * `CACHE_MAX`.
 *
 * @param {string} group  The surface.
 * @param {string} key    The cache key.
 * @param {Object} answer The answer.
 */
function remember( group, key, answer ) {
	const memory = groupOf( group ).answers;
	memory.delete( key );
	memory.set( key, { answer, at: Core.now() } );
	if ( CACHE_MAX < memory.size ) {
		memory.delete( memory.keys().next().value );
	}
}

/**
 * Forget every answer of a group whose key starts with one of `prefixes`,
 * and have each of its mounted reads so keyed ask again.
 *
 * @param {string}   group    The surface.
 * @param {string[]} prefixes Cache-key prefixes: `<verb>:` for a verb from
 *                            every CI, `<verb>:<ci>:` from one.
 */
function dirty( group, prefixes ) {
	const dirtied = ( key ) =>
		prefixes.some( ( prefix ) => key.startsWith( prefix ) );
	const memory = groupOf( group ).answers;
	for ( const key of memory.keys() ) {
		if ( dirtied( key ) ) {
			memory.delete( key );
		}
	}
	groupOf( group ).reads.forEach( ( revalidate ) => revalidate( dirtied ) );
}

/**
 * Ask one read command, again whenever `args` changes. Null `args` asks
 * nothing and withdraws the ask outstanding, so its late answer never shows.
 * Until the answer to `args` lands, a remembered one paints, marked stale.
 * An answer counts as current only while it is fresh: withdrawing the read
 * or a write dirtying it ends that, so the same question asked again never
 * shows what a write has since changed. A mounted read a write dirtied keeps
 * its answer, marked stale, until the new one lands.
 *
 * @param {Object}    o         Options.
 * @param {string}    o.group   The surface sending it, whose `<group>:shell`
 *                              Tap it passes and whose memory it reads.
 * @param {string}    [o.ci]    The server CI mount the command lives on;
 *                              omit for an interpreter command.
 * @param {string}    [o.scope] Names this read's nodes, a subject naming what
 *                              the slice shows, so two reads on a page never
 *                              share a Fetcher; `<ci>:<command>` when omitted.
 * @param {string}    o.command The read verb.
 * @param {?string[]} o.args    Its argument tokens, or null to ask nothing.
 * @param {boolean}   [o.retry] False declines re-asking a request that went
 *                              missing; true when omitted.
 * @return {{answer: ?Object, error: ?string, loading: boolean, stale: boolean, updatedAt: ?number, refresh: () => void}}
 *   The answer to `args`, or the refusal alone; `loading` while it is owed
 *   with nothing remembered; `stale` while a remembered answer stands in,
 *   received at `updatedAt` (epoch seconds); and `refresh()`, which asks the
 *   same question again.
 * @throws {TypeError} On an option it does not take, or a group, CI, scope or
 *   command other than its first render's; remount under a React key instead.
 */
export function useCommandRead( {
	group,
	ci = '',
	scope,
	command,
	args,
	retry = true,
	...rest
} ) {
	refuseUnknown( `useCommandRead( { command: '${ command }' } )`, rest );
	const key = JSON.stringify( args );
	const keyRef = useRef( key );
	keyRef.current = key;
	// The question whose last answer is fresh, and when it landed.
	const freshRef = useRef( null );
	const freshAtRef = useRef( null );
	// The question a write dirtied while it was asked, its answer still shown.
	const heldRef = useRef( null );
	const [ , bump ] = useState( 0 );
	const { run, abandon, result, error, answeredArgs } = useCommandOnce( {
		group,
		ci,
		command,
		scope,
		retry,
		subjectOf: NO_SUBJECT,
		onDone: ( { result: landed, error: refused, args: answered } ) => {
			// A bare refusal answers whatever is being asked now.
			const question =
				refused && 0 === answered.length
					? JSON.parse( keyRef.current )
					: answered;
			if ( null === question ) {
				return;
			}
			const entry = cacheKey( command, ci, question );
			freshRef.current = JSON.stringify( question );
			freshAtRef.current = Core.now();
			heldRef.current = null;
			if ( refused ) {
				groupOf( group ).answers.delete( entry );
			} else {
				remember( group, entry, landed );
			}
		},
	} );

	useEffect( () => {
		const question = JSON.parse( key );
		if ( null === question ) {
			freshRef.current = null;
			heldRef.current = null;
			abandon();
			return undefined;
		}
		const entry = cacheKey( command, ci, question );
		touch( group, entry );
		run( question );
		const revalidate = ( dirtied ) => {
			if ( ! dirtied( entry ) ) {
				return;
			}
			if ( key === freshRef.current ) {
				heldRef.current = key;
			}
			freshRef.current = null;
			bump( ( n ) => n + 1 );
			run( question );
		};
		const { reads } = groupOf( group );
		reads.add( revalidate );
		return () => {
			reads.delete( revalidate );
		};
		// The group and CI are fixed for life: useCommandOnce refuses a change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ key, command, run, abandon ] );

	const refresh = useCallback( () => {
		const question = JSON.parse( key );
		if ( null !== question ) {
			run( question );
		}
	}, [ key, run ] );

	const answersKey =
		null !== answeredArgs && JSON.stringify( answeredArgs ) === key;
	// A bare refusal, such as a Router's NOT_AVAILABLE, answers this ask.
	const current =
		key === freshRef.current &&
		( answersKey ||
			( null !== answeredArgs &&
				null !== error &&
				0 === answeredArgs.length ) );
	const held =
		! current && key === heldRef.current && answersKey && null === error;
	const remembered =
		current || held || null === args
			? undefined
			: groupOf( group ).answers.get( cacheKey( command, ci, args ) );
	return {
		answer: current || held ? result : remembered?.answer ?? null,
		error: current ? error : null,
		loading: null !== args && ! current && ! held && ! remembered,
		stale: held || Boolean( remembered ),
		updatedAt: held ? freshAtRef.current : remembered?.at ?? null,
		refresh,
	};
}

/**
 * The tokens naming every value given (`--key=value`), a list once per
 * member, as a command's repeatable option binds them. A blank value, a
 * value not given (null or undefined) and an empty list are left out, so the
 * command reads its own default for them.
 *
 * @param {Object<string, ?(string|number|Array<string>)>} options By name.
 * @return {string[]} The tokens.
 */
export function commandArgs( options ) {
	return Object.entries( options ).flatMap( ( [ name, value ] ) =>
		[]
			.concat( value )
			.filter(
				( one ) => '' !== one && null !== one && undefined !== one
			)
			.flatMap( ( one ) => formatCommandArgs( [], { [ name ]: one } ) )
	);
}

/**
 * One write command, sent once per `run( args )` with every arg named through
 * `commandArgs()`, so a value that begins `--name=` binds as the value it is
 * rather than as an option. `run()` answers the tokens it sent; a landed send
 * hands `refresh` its answer and the tokens its reply echoes, and a refused
 * one hands `onRefused` those tokens, which say which send it was, and its
 * own refusal, which a later reply in the same batch cannot overwrite. A
 * landed send first forgets every answer its group remembers under the
 * prefixes it `dirties`, and every mounted read of the group so keyed asks
 * again. The last reply's answer, its refusal, the arguments it answered and
 * whether a send is still owed its reply are `useCommandOnce`'s own. A send
 * still queued when the hook unmounts or the page is left goes all the same,
 * because a write declares it.
 *
 * @param {string}                                     command       The write verb.
 * @param {Object}                                     o             Options.
 * @param {string}                                     o.group       The surface sending it, whose
 *                                                                   `<group>:shell` Tap it passes and
 *                                                                   whose memory it dirties.
 * @param {string}                                     [o.ci]        The CI the command lives on.
 * @param {string}                                     [o.scope]     Names this write's nodes, a
 *                                                                   subject naming what it is
 *                                                                   for, so two writes of one verb
 *                                                                   on a page never share a Fetcher;
 *                                                                   `<ci>:<command>` when omitted.
 * @param {(answer: Object, tokens: string[]) => void} [o.refresh]   Runs once a send lands, given its answer and the tokens it echoes.
 * @param {string[]}                                   [o.dirties]   Cache-key prefixes a landed send
 *                                                                   forgets and re-reads: `<verb>:`
 *                                                                   for that verb from every CI,
 *                                                                   `<verb>:<ci>:` from one.
 * @param {(tokens: string[], error: string) => void}  [o.onRefused] Runs once a send is refused.
 * @return {{run: (args: Object<string, string|Array<string>>) => string[], answer: ?Object, refusal: ?string, answeredArgs: ?string[], pending: boolean}}
 *   `run()`, the last answer, the last refusal, the arguments the last reply
 *   answered, and whether a send is still owed its reply.
 * @throws {TypeError} On an option it does not take, or a group, CI, scope or
 *   command other than its first render's; remount under a React key instead.
 */
export function useCommandWrite(
	command,
	{ group, ci, scope, refresh, onRefused, dirties = [], ...rest }
) {
	refuseUnknown( `useCommandWrite( '${ command }' )`, rest );
	const {
		run: send,
		result,
		error,
		answeredArgs,
		pending,
	} = useCommandOnce( {
		group,
		ci,
		command,
		scope,
		subjectOf: NO_SUBJECT,
		sendsOnRemoval: true,
		onDone: ( { error: refused, args, result: landed } ) => {
			if ( refused ) {
				onRefused?.( args, refused );
				return;
			}
			dirty( group, dirties );
			refresh?.( landed, args );
		},
	} );
	const run = useCallback(
		( args ) => {
			const tokens = commandArgs( args );
			send( tokens );
			return tokens;
		},
		[ send ]
	);
	return { run, answer: result, refusal: error, answeredArgs, pending };
}

/**
 * The refusal a write's last reply gave the send whose tokens are `sent`,
 * or null: none sent, another send answered, or a send still owed its
 * reply, so a dialog never shows what an earlier send drew.
 *
 * @param {{refusal: ?string, answeredArgs: ?string[], pending: boolean}} write The write.
 * @param {?string[]}                                                     sent  The tokens its own last `run()` answered, or null.
 * @return {?string} The refusal, or null.
 */
export const refusalOfSend = ( write, sent ) =>
	null !== sent &&
	! write.pending &&
	Boolean( write.refusal ) &&
	JSON.stringify( write.answeredArgs ) === JSON.stringify( sent )
		? write.refusal
		: null;
