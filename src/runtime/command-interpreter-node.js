import { markLocal } from './command-auth';
import { Node } from './node';
import { TeeNode } from './tee-node';
import { TapNode } from './tap-node';
import { EchoNode } from './echo-node';
import { FetcherNode } from './fetcher-node';
import { RequestNode } from './request-node';
import { TimerNode } from './timer-node';
import { Core } from './core';
import { dumpMetadataPayload, MetadataNode } from './metadata-node';
import { DumperNode } from './dumper-node';
import { CompletionNode } from './completion-node';
import { UptimeNode } from './uptime-node';
import { DmesgNode } from './dmesg-node';
import { SseInNode } from './sse-in-node';
import { RemoteLinkNode } from './remote-link-node';
import { RemoteIpcNode } from './remote-ipc-node';
import { HttpOutNode } from './http-out-node';
import { HeartbeatNode } from './heartbeat-node';
import { RouterNode } from './router-node';
import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_PING,
	TM_EOF,
	TM_NOREPLY,
	newMessage,
} from './message';

/**
 * One node's raw dispatch-profile record, as `_router` accumulates it.
 *
 * @typedef {Object} ProfileInfo
 * @property {number} time      Total self time, in seconds.
 * @property {number} count     Dispatches recorded.
 * @property {number} avg       Mean self time per dispatch, in seconds.
 * @property {number} oldest    Clock reading of the first dispatch recorded.
 * @property {number} timestamp Clock reading of the most recent dispatch.
 */

/**
 * The derived facts one `list_profiles` row prints.
 *
 * @typedef {Object} ProfileStats
 * @property {number} avg    Mean self time per dispatch, in seconds.
 * @property {number} time   Total self time, in seconds.
 * @property {number} count  Dispatches recorded.
 * @property {number} window Seconds spanned by the records, oldest to newest.
 * @property {number} rate   Dispatches per second over that window; 1 when it cannot be measured.
 * @property {number} age    Whole seconds since the most recent dispatch.
 */

/**
 * A node class as `includeNodes` holds it: the Node constructor itself or a
 * subclass of it — exactly what `resolveClass` verifies — carrying the static
 * `nodeSchema()` the palette and `help` read. `typeof Node` also states the
 * Tachikoma no-arg ctor `makeNode` relies on, naming and `arguments=`-ing the
 * node only after constructing it. The schema is optional: a plugin may
 * register a class that documents nothing, and `help` falls back to an empty
 * schema for it.
 *
 * @typedef {typeof Node & { nodeSchema?: () => Object }} NodeClass
 */

// Alias→canonical; lockstep with verb table + builtins so `help` resolves.
const ALIAS_TO_CANONICAL = {
	ls: 'list_nodes',
	dump: 'dump_node',
	make: 'make_node',
	connect: 'connect_node',
	disconnect: 'disconnect_node',
	remove: 'remove_node',
	rm: 'remove_node',
	move: 'move_node',
	mv: 'move_node',
	chdir: 'cd',
	tell: 'tell_node',
	send: 'send_node',
	command: 'command_node',
	cmd: 'command_node',
	request: 'request_node',
};

// Per-command help text, keyed by canonical verb (mirrors PHP $H).
const HELP = {
	make_node: 'make_node <type> <name> [<arguments>]\n    alias: make\n',
	set_sink: 'set_sink <node> <target>\n',
	connect_node:
		"connect_node <node> [<target>]\n    alias: connect\n    note: <target> defaults to the issuing message's FROM.\n",
	disconnect_node:
		'disconnect_node <node> [<target>]\n    alias: disconnect\n',
	register: 'register <source name> <target name> <event>\n',
	unregister: 'unregister <source name> <target name> <event>\n',
	remove_node:
		'remove_node <node name> [<more names>...]\nremove_node -a <anchored regex glob>\n    aliases: remove, rm\n',
	move_node: 'move_node <node name> <new name>\n    aliases: move, mv\n',
	list_nodes:
		'list_nodes [ -clst ] [ <node name> ]\nlist_nodes -a [ -clst ] [ <regex glob> ]\n    -c show message counters\n    -l show counters and targets\n    -s show sinks\n    -t show targets\n    -a show all nodes matching regex glob\n    alias: ls\n',
	list_timers:
		'list_timers [-s]\n    note: all timers (ACTIVE, INTERVAL ms, MODE, ONESHOT, FIRES, TYPE, NAME).\n    -s: the same rows as a struct, for a view that wants to sort them.\n',
	list_handles:
		'list_handles [-s]\n    note: nodes holding an EventSource (STATE, COUNT msgs, TYPE, NAME).\n    -s: the same rows as a struct, for a view that wants to sort them.\n',
	profile:
		'profile [ on | off ]\n    no args: toggle _router dispatch profiling (per-node self time).\n    on|off:  idempotent set — the form scripts and UI use, since\n             a known desired state never races a stale toggle.\n    note: while on, _router times each dispatch; read the table\n          with list_profiles.\n',
	list_profiles:
		'list_profiles [-s] [ <regex glob> ]\n    note: per-node self-time table, slowest average first; `total`\n          shows only the --total-- row.\n    -s: the same rows as a struct, --total-- included, for a view\n        that wants to sort them.\n',
	dump_node: 'dump_node <node name> [<keys>]\n    alias: dump\n',
	dump_config:
		'dump_config [ <regex glob> ]\n    note: emits every node as round-trippable make_node / set_sink /\n          connect_node lines; an optional regex glob filters by name.\n',
	dump_metadata:
		'dump_metadata\n    note: a JSON object keyed by node name, carrying `class`,\n          `counter`, `sink`, `target`, `debug_state` and `arguments`.\n',
	trace: "trace [ <node name> [ <level> ] ]\n    no args: toggle this CommandInterpreter's debug_state.\n",
	pwd: 'pwd\n',
	log: 'log <message>\n    note: prints <message> to stderr (server-side debug log).\n',
	dmesg: 'dmesg\n    note: print the stderr tail for the current scope (last 100 lines).\n',
	include: 'include <file>\n',
	uptime: 'uptime\n',
	stats: 'stats [-a] [<regex>]\n    columns: NAME COUNT LGST_MSG READ WRITTEN.\n',
	help: 'help [ <topic> ]\n',

	// Shell builtins — Shell intercepts these; listed so `help` is complete.
	cd: 'cd [ <path> ]\n    alias: chdir\n',
	debug_level: 'debug_level [0|1|2]\n',
	tell_node: 'tell_node <path> <info>\n    alias: tell\n',
	send_node: 'send_node <path> <bytes>\n    alias: send\n',
	send_struct: 'send_struct <path> <json>\n',
	send_eof: 'send_eof <path>\n',
	command_node:
		'command_node <path> <verb> [<arguments>]\n    aliases: command, cmd\n',
	request_node: 'request_node <path> [<value>]\n    alias: request\n',
	reply_to:
		'reply_to <node path> <command>\n    note: runs <command> here but routes its reply to <node path>\n          (inverse of command_node).\n',
	ping: 'ping <path>\n',
	show_parse:
		'show_parse\n   note: toggles parsed command dump for every command.\n',
	status: 'status\n    note: local cli mode summary (no command sent).\n',
};

/**
 * Verb dispatch over TM_COMMAND messages with empty TO (mirrors PHP
 * CommandInterpreter). Throws wrap as TM_ERROR, returns as TM_RESPONSE;
 * everything else passes through the sink unchanged. Ships the full PHP $C verb
 * set as built-in defaults; commands( table ) merges over them.
 */
export class CommandInterpreterNode extends Node {
	// dump_config suppresses set_sink to ANY interpreter, not just `_ci`.
	static isCommandInterpreter = true;

	/**
	 * Start with the built-in verb table and no instance authorize override, so
	 * the class default decides who may issue commands.
	 */
	constructor() {
		super();
		// Per-instance authorize override; null → static default → LOCAL check.
		this.authorize = null;
		this._commands = CommandInterpreterNode._defaultCommands();
	}

	/**
	 * Interpret a command addressed to this node; forward everything else.
	 *
	 * A message with a non-empty TO is in transit toward another node, so it
	 * goes to the sink even when it is a command — otherwise every interpreter
	 * on a path would eat commands meant for its downstream peers.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const type = message[ TYPE ];

		// TM_PING / TM_EOF with empty TO bounce back along FROM (RTT / drain).
		if ( type & ( TM_PING | TM_EOF ) && message[ TO ] === '' ) {
			message[ TO ] = message[ FROM ];
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}

		const isCommand = type & TM_COMMAND && ! ( type & TM_RESPONSE );
		if ( ! isCommand || message[ TO ] !== '' ) {
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}
		this._interpret( message );
	}

	/**
	 * Authorize, resolve and run the verb carried in VALUE, then respond.
	 *
	 * A throw from a verb becomes a TM_ERROR reply: the central catch is the
	 * contract, which is why verbs carry no try/catch of their own.
	 *
	 * @param {Array} message TM_COMMAND whose VALUE is `{ name, arguments }`.
	 */
	_interpret( message ) {
		// VALUE is the structured command object directly (no parse needed).
		const cmd = message[ VALUE ];
		if ( ! cmd || typeof cmd !== 'object' || ! cmd.name ) {
			this.stderr( 'WARNING: invalid command struct' );
			return;
		}

		// Auth gate: needs LOCAL taint (Shell stamps it); wire cmds refused.
		const authorize =
			this.authorize ??
			CommandInterpreterNode.defaultAuthorize ??
			( ( m ) => m[ LOCAL ] !== undefined );
		if ( ! authorize( message ) ) {
			this._respond(
				message,
				cmd.name,
				`unauthorized: ${ cmd.name }`,
				TM_ERROR
			);
			return;
		}

		const verb = this._commands[ cmd.name ];
		if ( typeof verb !== 'function' ) {
			this._respond(
				message,
				cmd.name,
				`no such verb: ${ cmd.name }`,
				TM_ERROR
			);
			return;
		}
		// External-compat seam: coerce a non-array `arguments` to [].
		const args = Array.isArray( cmd.arguments ) ? cmd.arguments : [];
		try {
			const result = verb( this, args, message );
			this._respond( message, cmd.name, result, TM_RESPONSE );
		} catch ( e ) {
			// Newline-terminated, as PHP sends it: the payload prints verbatim.
			this._respond( message, cmd.name, `${ e.message }\n`, TM_ERROR );
		}
	}

	/**
	 * Route a verb's result back to whoever asked, as TM_COMMAND|kind.
	 *
	 * An empty result sends nothing. A TM_NOREPLY request gets no message at
	 * all — a failure still reaches stderr, since nobody else would see it.
	 *
	 * @param {Array}  message The request being answered.
	 * @param {string} name    Verb name, echoed in the response VALUE.
	 * @param {*}      payload Verb result: a reply string or a struct.
	 * @param {number} kind    TM_RESPONSE or TM_ERROR.
	 */
	_respond( message, name, payload, kind ) {
		if ( payload === '' || payload === undefined ) {
			return;
		}
		// One terminator per string reply; structs untouched. Mirrors PHP.
		if ( typeof payload === 'string' && ! payload.endsWith( '\n' ) ) {
			payload += '\n';
		}
		// TM_NOREPLY: suppress the routed reply, but surface errors to stderr.
		const inType = message[ TYPE ];
		if ( ( typeof inType === 'number' ? inType : 0 ) & TM_NOREPLY ) {
			if ( kind & TM_ERROR ) {
				this.stderr( `ERROR: from TM_NOREPLY command: ${ payload }` );
			}
			return;
		}
		const resp = newMessage();
		resp[ TYPE ] = TM_COMMAND | kind;
		resp[ TIMESTAMP ] = Core.now();
		resp[ FROM ] = this.name;
		resp[ TO ] = message[ FROM ];
		resp[ ID ] = message[ ID ];
		resp[ KEY ] = message[ KEY ];
		// Response VALUE echoes request `arguments` (targeted vs full reply).
		const rawArgs =
			message[ VALUE ] && typeof message[ VALUE ] === 'object'
				? message[ VALUE ].arguments
				: undefined;
		const reqArgs = Array.isArray( rawArgs ) ? rawArgs : [];
		resp[ VALUE ] = { name, arguments: reqArgs, payload };
		if ( this.sink ) {
			this.sink.fill( resp );
		}
	}

	/**
	 * `make_node <type> <name> [args]` — spread the remaining tokens to the
	 * constructor, then name and sink the node.
	 *
	 * An unknown class answers with a line; a name collision throws, which the
	 * caller turns into TM_ERROR.
	 *
	 * @param {string[]} args Verb tokens: type, name, then constructor args.
	 * @return {string} 'ok', or the usage / unknown-class line.
	 */
	_cmdMakeNode( args ) {
		if ( args.length < 2 ) {
			return 'usage: make_node <type> <name> [<ctor_args>...]';
		}
		const type = args[ 0 ];
		// Unknown class returns a string; a collision throws → TM_ERROR.
		if ( ! CommandInterpreterNode.resolveClass( type ) ) {
			return `unknown class: ${ type }`;
		}
		const name = args[ 1 ];
		this.makeNode( type, name, args.slice( 2 ) );
		return 'ok';
	}

	/**
	 * Programmatic node construction — what the `make_node` verb delegates to.
	 * A node whose arguments throw is torn down before the throw escapes, so a
	 * bad make_node leaves no half-built node behind.
	 *
	 * @param {string}   type   Shell class name, as `make_node` spells it.
	 * @param {string}   name   Name to register the node under.
	 * @param {string[]} [args] Constructor argument tokens.
	 * @return {Node} The constructed node, named and sunk to this interpreter.
	 */
	makeNode( type, name, args = [] ) {
		const NodeClass = CommandInterpreterNode.resolveClass( type );
		if ( ! NodeClass ) {
			throw new Error( `unknown class: ${ type }` );
		}
		const node = new NodeClass();
		// Pin only a NON-default table; else dump_node grows a `registry` row.
		if ( this.childRegistry !== Core.registry ) {
			node.registry = this.childRegistry;
		}
		node.name = name;
		try {
			node.arguments = Array.isArray( args ) ? args : [];
		} catch ( error ) {
			node.removeNode();
			throw error;
		}
		node.sink = this;
		// The sink dump_config may omit: the one make_node wired.
		node._defaultSink = this;
		if ( ( this.debugState ?? 0 ) > 0 ) {
			// Trace level is stamped from outside; no class declares it.
			/** @type {{ debugState?: number }} */ ( node ).debugState =
				this.debugState;
		}
		return node;
	}

	/**
	 * The name table this interpreter's verbs operate on, and that the nodes it
	 * makes register in. Defaults to its OWN registry, so a live interpreter is
	 * unchanged.
	 *
	 * These are two different things and conflating them is a bug: a draft
	 * interpreter lives in Core under one reserved name while its contents live
	 * somewhere Core cannot see — exactly a Tachikoma Job, whose node sits in
	 * the parent's table while its process owns its own.
	 *
	 * @return {Object} The registry.
	 */
	get childRegistry() {
		return this._childRegistry ?? this.registry;
	}

	/**
	 * Point this interpreter's verbs at a name table other than its own.
	 *
	 * @param {Object} registry The registry the verbs operate on.
	 */
	set childRegistry( registry ) {
		this._childRegistry = registry;
	}

	/**
	 * State snapshot for `dump_node`, with the verb table and the authorize
	 * closure masked — both are internal machinery, not state worth printing.
	 *
	 * @return {Object} The snapshot.
	 */
	dumpNode() {
		const snapshot = super.dumpNode();
		snapshot._commands = '{...}';
		snapshot.authorize = '{...}';
		return snapshot;
	}

	/**
	 * Getter/setter for the verb table; passing a table merges (extends) it over
	 * the built-in defaults.
	 *
	 * @param {Object<string,Function>|null} table Verb table to merge, or null to read.
	 * @return {Object<string,Function>} The current verb table.
	 */
	commands( table = null ) {
		if ( table !== null ) {
			this._commands = { ...this._commands, ...table };
		}
		return this._commands;
	}

	/**
	 * Dispatch a verb by name (inline call path, mirrors PHP dispatch()).
	 *
	 * @param {string}   name     Verb name.
	 * @param {string[]} args     Pre-split argument tokens.
	 * @param {Array}    envelope Inbound message, or [] for inline calls.
	 * @return {*} Verb result.
	 */
	dispatch( name, args = [], envelope = [] ) {
		const verb = this._commands[ name ];
		if ( typeof verb !== 'function' ) {
			throw new Error( `unknown command: ${ name }` );
		}
		return verb( this, args, envelope );
	}

	// ----- built-in verb table (1:1 with PHP $C) ----------------------------

	/**
	 * A fresh copy of the built-in verb table, aliases included.
	 *
	 * Each handler takes `( self, args, envelope )`, so a static verb reads the
	 * interpreter it was called on rather than a captured instance.
	 *
	 * @return {Object<string,Function>} Verb name to handler.
	 */
	static _defaultCommands() {
		return {
			make_node: ( self, args ) => self._cmdMakeNode( args ),
			make: ( self, args ) => self._cmdMakeNode( args ),
			pwd: ( self, args, env ) =>
				CommandInterpreterNode._cmdPwd( args, env ),
			set_sink: ( self, args ) =>
				CommandInterpreterNode._cmdSetSink( args, self.childRegistry ),
			connect_node: ( self, args, env ) =>
				CommandInterpreterNode._cmdConnect(
					args,
					self.childRegistry,
					env
				),
			connect: ( self, args, env ) =>
				CommandInterpreterNode._cmdConnect(
					args,
					self.childRegistry,
					env
				),
			disconnect_node: ( self, args, env ) =>
				CommandInterpreterNode._cmdDisconnect(
					args,
					self.childRegistry,
					env
				),
			disconnect: ( self, args, env ) =>
				CommandInterpreterNode._cmdDisconnect(
					args,
					self.childRegistry,
					env
				),
			register: ( self, args ) =>
				CommandInterpreterNode._cmdRegister( args, self.childRegistry ),
			unregister: ( self, args ) =>
				CommandInterpreterNode._cmdUnregister(
					args,
					self.childRegistry
				),
			move_node: ( self, args ) => self._cmdMove( args ),
			move: ( self, args ) => self._cmdMove( args ),
			mv: ( self, args ) => self._cmdMove( args ),
			remove_node: ( self, args ) => self._cmdRemove( args ),
			remove: ( self, args ) => self._cmdRemove( args ),
			rm: ( self, args ) => self._cmdRemove( args ),
			list_nodes: ( self, args, env ) => self._cmdList( args, env ),
			ls: ( self, args, env ) => self._cmdList( args, env ),
			list_timers: ( self, args ) =>
				CommandInterpreterNode._cmdListTimers(
					args.includes( '-s' ),
					self.childRegistry
				),
			list_handles: ( self, args ) =>
				CommandInterpreterNode._cmdListHandles(
					args.includes( '-s' ),
					self.childRegistry
				),
			profile: ( self, args ) =>
				CommandInterpreterNode._cmdProfile(
					args[ 0 ] ?? '',
					self.childRegistry
				),
			list_profiles: ( self, args ) =>
				CommandInterpreterNode._cmdListProfiles(
					args.find( ( a ) => '-s' !== a ) ?? '',
					args.includes( '-s' ),
					self.childRegistry
				),
			log: ( self, args ) => {
				self.stderr( args.join( ' ' ) );
				return '';
			},
			dmesg: () => CommandInterpreterNode._cmdDmesg(),
			dump_node: ( self, args ) =>
				CommandInterpreterNode._cmdDumpNode( args, self.childRegistry ),
			dump: ( self, args ) =>
				CommandInterpreterNode._cmdDumpNode( args, self.childRegistry ),
			dump_metadata: ( self, args ) =>
				CommandInterpreterNode._cmdDumpMetadata(
					args[ 0 ] ?? '',
					self.childRegistry
				),
			dump_config: ( self, args ) =>
				CommandInterpreterNode._cmdDumpConfig(
					args[ 0 ] ?? '',
					self.childRegistry
				),
			stats: ( self, args ) => self._cmdStats( args ),
			uptime: () => CommandInterpreterNode._cmdUptime(),
			trace: ( self, args ) => self._cmdTrace( args ),
			help: ( self, args, env ) =>
				CommandInterpreterNode._cmdHelp( args, env ),
			reply_to: ( self, args ) => self._cmdReplyTo( args ),
		};
	}

	/**
	 * `reply_to <path> <cmd>` — run <cmd> here but route its reply to <path>,
	 * the inverse of command_node. The synthetic command carries FROM=<path>,
	 * and TO=FROM replies do the rest.
	 *
	 * @param {string[]} args Verb tokens: reply path, verb, then the verb's args.
	 * @return {string} '' when it ran, or the usage / refusal line.
	 */
	_cmdReplyTo( args ) {
		const path = args[ 0 ] ?? '';
		const verb = args[ 1 ] ?? '';
		if ( '' === path || '' === verb ) {
			return 'usage: reply_to <node path> <command>';
		}
		// reply_to re-enters interpret(); refuse to nest (stack blowup).
		if ( 'reply_to' === verb ) {
			return 'reply_to cannot invoke reply_to';
		}
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = path;
		m[ VALUE ] = { name: verb, arguments: args.slice( 2 ) };
		markLocal( m );
		this.fill( m );
		return '';
	}

	/**
	 * `pwd` — the current path and the path a reply would travel back along.
	 *
	 * @param {string[]} args     Verb tokens; the first replaces the '/' default.
	 * @param {Array}    envelope The inbound message, read for its FROM.
	 * @return {string} ` <cwd> -> <from>`.
	 */
	static _cmdPwd( args, envelope ) {
		const path = args[ 0 ] ?? '';
		const cwd = '' === path ? '/' : path;
		const from = ( envelope && envelope[ FROM ] ) || '';
		return ` ${ cwd } -> ${ from }`;
	}

	/**
	 * `set_sink <node> <target>` — wire a node's physical next hop.
	 *
	 * @param {string[]} args     Verb tokens: source name, then sink name.
	 * @param {Object}   registry Name table both nodes must live in.
	 * @return {string} 'ok', or the usage / unknown-node line.
	 */
	static _cmdSetSink( args, registry ) {
		const parts = args;
		const name = parts[ 0 ] ?? '';
		const target = parts.slice( 1 ).join( ' ' );
		if ( '' === name || '' === target ) {
			return 'usage: set_sink <node> <target>';
		}
		const src = registry.node( name );
		const dst = registry.node( target );
		if ( null === src || null === dst ) {
			return 'unknown node';
		}
		src.sink = dst;
		return 'ok';
	}

	/**
	 * `connect_node <node> [<target>]` — set the logical TO path a node stamps.
	 *
	 * @param {string[]}     args       Verb tokens: node name, then target path.
	 * @param {Object}       registry   Name table the node lives in.
	 * @param {Array|Object} [envelope] Inbound message; its FROM is the default target.
	 * @return {string} 'ok', or the usage / unknown-node line.
	 */
	static _cmdConnect( args, registry, envelope = {} ) {
		const parts = args;
		const name = parts[ 0 ] ?? '';
		if ( '' === name ) {
			return 'usage: connect_node <node> [<target>]';
		}
		const src = registry.node( name );
		if ( null === src ) {
			return `unknown node: ${ name }`;
		}
		let target = parts.slice( 1 ).join( ' ' );
		// No target defaults to the issuing message's FROM.
		if ( '' === target ) {
			target = ( envelope && envelope[ FROM ] ) || '';
			if ( '' === target ) {
				return 'usage: connect_node <node> [<target>]';
			}
		}
		// Every node implements connectNode; dispatch uniformly, no branch.
		src.connectNode( target );
		return 'ok';
	}

	/**
	 * `disconnect_node <node> [<target>]` — drop a target from a node.
	 *
	 * Omitting the target clears a single-target node, or removes the issuing
	 * FROM from a fan-out node's list.
	 *
	 * @param {string[]}     args       Verb tokens: node name, then target path.
	 * @param {Object}       registry   Name table the node lives in.
	 * @param {Array|Object} [envelope] Inbound message; its FROM is the default target.
	 * @return {string} 'ok', or the usage / unknown-node line.
	 */
	static _cmdDisconnect( args, registry, envelope = {} ) {
		const parts = args;
		const name = parts[ 0 ] ?? '';
		if ( '' === name ) {
			return 'usage: disconnect_node <node> [<target>]';
		}
		const src = registry.node( name );
		if ( null === src ) {
			return `unknown node: ${ name }`;
		}
		let target = parts.slice( 1 ).join( ' ' );
		// For a Tee, no target removes the issuing FROM from the fan-out.
		if ( '' === target && Array.isArray( src.target ) ) {
			target = ( envelope && envelope[ FROM ] ) || '';
			if ( '' === target ) {
				return 'usage: disconnect_node <node> [<target>]';
			}
		}
		if ( 'function' === typeof src.disconnectNode ) {
			// Primary path: base Node + Tee both implement disconnectNode now.
			src.disconnectNode( target );
		} else if ( Array.isArray( src.target ) ) {
			// Fallback if a node lacks disconnectNode: filter from fan-out.
			src.target = src.target.filter( ( t ) => t !== target );
		} else if ( src.target === target ) {
			src.target = '';
		}
		return 'ok';
	}

	/**
	 * `register <source> <target> <event>` — subscribe a node to another node's
	 * event. The verb's argument order is source-first; Node.register() takes
	 * the event first, so the two are not the same order.
	 *
	 * The target is validated in the registry notify() resolves against, not
	 * this one, or the listener would drop silently at delivery time.
	 *
	 * @param {string[]} args     Verb tokens: source, target, then event name.
	 * @param {Object}   registry Name table the source lives in.
	 * @return {string} 'ok', or the usage / unknown-node line.
	 */
	static _cmdRegister( args, registry ) {
		const parts = args;
		const source = parts[ 0 ] ?? '';
		if ( '' === source ) {
			return 'usage: register <source name> <target name> <event>';
		}
		const src = registry.node( source );
		if ( null === src ) {
			return `unknown node: ${ source }`;
		}
		const target = parts[ 1 ] ?? '';
		if ( '' === target ) {
			return 'usage: register <source name> <target name> <event>';
		}
		// Validate where notify() RESOLVES, or a listener drops silently.
		if ( null === src.registry.node( target ) ) {
			return `unknown node: ${ target }`;
		}
		src.register( parts.slice( 2 ).join( ' ' ), target );
		return 'ok';
	}

	/**
	 * `unregister <source> <target> <event>` — drop a listener from a node.
	 *
	 * The target is not checked for existence: dropping the registration of a
	 * node that is already gone is exactly the case worth supporting.
	 *
	 * @param {string[]} args     Verb tokens: source, target, then event name.
	 * @param {Object}   registry Name table the source lives in.
	 * @return {string} 'ok', or the usage / unknown-node line.
	 */
	static _cmdUnregister( args, registry ) {
		const parts = args;
		const source = parts[ 0 ] ?? '';
		if ( '' === source ) {
			return 'usage: unregister <source name> <target name> <event>';
		}
		const src = registry.node( source );
		if ( null === src ) {
			return `unknown node: ${ source }`;
		}
		const target = parts[ 1 ] ?? '';
		if ( '' === target ) {
			return 'usage: unregister <source name> <target name> <event>';
		}
		src.unregister( parts.slice( 2 ).join( ' ' ), target );
		return 'ok';
	}

	/**
	 * `move_node <old> <new>` — rename a node in place. Node's name setter
	 * re-keys the registry and rejects a collision, so this only resolves.
	 *
	 * @param {string[]} args Verb tokens: current name, then new name.
	 * @return {string} 'ok', or the usage line.
	 */
	_cmdMove( args ) {
		const [ name, newName ] = args;
		if ( ! name || ! newName ) {
			return 'usage: move_node <node name> <new name>';
		}
		const node = this.childRegistry.node( name );
		if ( null === node ) {
			throw new Error( `can't find node "${ name }"` );
		}
		node.name = newName;
		return 'ok';
	}

	/**
	 * `remove_node <name>...` or `remove_node -a <regex>` — full teardown of
	 * each named node. An unnamed node is skipped; one that cannot be found is
	 * reported without stopping the rest.
	 *
	 * @param {string[]} args Node names, or `-a` and an anchored regex glob.
	 * @return {string} A line per removal and per failure; 'ok' or 'no matches' when there are none.
	 */
	_cmdRemove( args ) {
		if ( 0 === args.length ) {
			return 'usage: remove_node <node name>';
		}

		let listMatches = false;
		let glob = '';
		if ( '-a' === ( args[ 0 ] ?? '' ) ) {
			listMatches = true;
			glob = args[ 1 ] ?? '';
			if ( '' === glob ) {
				return 'usage: remove_node -a <anchored regex glob>';
			}
		}

		let names;
		if ( listMatches ) {
			names = [];
			let re = null;
			try {
				re = new RegExp( `^${ glob }$` );
			} catch ( e ) {
				re = null;
			}
			if ( re ) {
				for ( const candidate of this.childRegistry.nodes.keys() ) {
					if ( re.test( candidate ) ) {
						names.push( candidate );
					}
				}
			}
			names.sort();
		} else {
			names = args;
		}

		const removed = [];
		const errors = [];
		for ( const name of names ) {
			if ( '' === name ) {
				continue;
			}
			const node = this.childRegistry.node( name );
			if ( null === node ) {
				errors.push( `can't find node "${ name }"` );
				continue;
			}
			// Full teardown, own name LAST (PHP Node::remove_node).
			node.removeNode();
			removed.push( `removed ${ name }` );
		}

		if ( listMatches && 0 === removed.length && 0 === errors.length ) {
			return 'no matches';
		}
		const out = [ ...removed, ...errors ].join( '\n' );
		return '' === out ? 'ok' : out;
	}

	/**
	 * `list_nodes` / `ls` — bare lists this interpreter's own children,
	 * `-a [<glob>]` lists every node, and a name lists the nodes sunk to it.
	 *
	 * A KEY of 'completion' forces bare names over the whole table and ignores
	 * the column flags, which is what `cd <tab>` needs to see `_`-nodes.
	 *
	 * @param {string[]}     args  Verb tokens: `-aclst` flags and name globs.
	 * @param {Array|Object} [env] Inbound message; its KEY selects completion mode.
	 * @return {string} Bare names, or the aligned table once a flag adds a column.
	 */
	_cmdList( args, env = {} ) {
		// Completion mode: bare node names only, ignoring -clst column flags.
		const isCompletion = env && env[ KEY ] === 'completion';
		let listMatches = false;
		let showCount = false;
		let showSink = false;
		let showTarget = false;
		const argv = [];

		for ( const tok of args ) {
			const m = /^-([aclst]+)$/.exec( tok );
			if ( m ) {
				for ( const opt of m[ 1 ] ) {
					if ( 'a' === opt ) {
						listMatches = true;
					}
					if ( 'c' === opt ) {
						showCount = true;
					}
					if ( 'l' === opt ) {
						showCount = true;
						showTarget = true;
					}
					if ( 's' === opt ) {
						showSink = true;
					}
					if ( 't' === opt ) {
						showTarget = true;
					}
				}
				continue;
			}
			argv.push( tok );
		}

		// Completion: bare names, no flags, list ALL so `cd <tab>` sees _nodes.
		if ( isCompletion ) {
			showCount = false;
			showSink = false;
			showTarget = false;
			listMatches = true;
		}

		const dirs = [];
		const header = [];
		const anyExtra = showCount || showSink || showTarget;
		if ( showCount ) {
			dirs.push( 'right' );
			header.push( 'COUNT' );
		}
		dirs.push( 'left' );
		header.push( 'NAME' );
		if ( showSink ) {
			dirs.push( 'left' );
			header.push( 'SINK' );
		}
		if ( showTarget ) {
			dirs.push( 'left' );
			header.push( 'TARGET' );
		}

		if ( ! listMatches && argv.length > 0 ) {
			for ( const name of argv ) {
				if ( null === this.childRegistry.node( name ) ) {
					return `can't find node "${ name }"`;
				}
			}
		}

		const globs = 0 === argv.length ? [ null ] : argv;
		const allNames = [ ...this.childRegistry.nodes.keys() ].sort();
		const rows = [];

		for ( const glob of globs ) {
			let matched = false;
			let re = null;
			if ( listMatches && null !== glob ) {
				try {
					re = new RegExp( glob );
				} catch ( e ) {
					re = null;
				}
			}
			for ( const name of allNames ) {
				const node = this.childRegistry.node( name );
				if ( null === node ) {
					continue;
				}
				const sinkName =
					node.sink && node.sink.name ? node.sink.name : '';
				const targetVal = node.target;
				let targetStr = '';
				if ( Array.isArray( targetVal ) ) {
					targetStr = targetVal.join( ', ' );
				} else if (
					'string' === typeof targetVal &&
					'' !== targetVal
				) {
					targetStr = targetVal;
				}

				if ( listMatches ) {
					if ( null !== glob && ( ! re || ! re.test( name ) ) ) {
						continue;
					}
				} else if ( null === glob ) {
					if ( this.name !== sinkName ) {
						continue;
					}
				} else if ( glob !== sinkName ) {
					continue;
				}

				matched = true;
				const row = [];
				if ( showCount ) {
					row.push( String( node.counter ?? 0 ) );
				}
				row.push( name );
				if ( showSink ) {
					row.push( '' !== sinkName ? `> ${ sinkName }` : '- ' );
				}
				if ( showTarget ) {
					row.push( '' !== targetStr ? `-> ${ targetStr }` : '- ' );
				}
				rows.push( row );
			}
			if ( listMatches && null !== glob && ! matched ) {
				rows.push( [ 'no matches' ] );
			}
		}

		if ( ! anyExtra ) {
			return rows.map( ( r ) => r[ 0 ] ).join( '\n' );
		}
		return CommandInterpreterNode._tabulate( dirs, header, rows );
	}

	/**
	 * `dmesg` — the bounded stderr tail Core keeps for this process.
	 *
	 * @return {string} The recent log lines, each already newline-terminated.
	 */
	static _cmdDmesg() {
		const recent = Core.recentLog;
		return Array.isArray( recent ) ? recent.join( '' ) : '';
	}

	/**
	 * `dump_node <name> [<keys>]` — the class as a header line, then the node's
	 * state as pretty JSON. Keys are sorted so the output stays stable across
	 * nodes with different ancestries; naming keys narrows the body to those.
	 *
	 * @param {string[]} args     Verb tokens: node name, then the keys to keep.
	 * @param {Object}   registry Name table the node lives in.
	 * @return {string} The dump, or the can't-find line.
	 */
	static _cmdDumpNode( args, registry ) {
		const parts = args;
		const name = parts[ 0 ] ?? '';
		if ( '' === name ) {
			return 'no node specified';
		}
		const node = registry.node( name );
		if ( null === node ) {
			return `can't find node "${ name }"`;
		}
		let wanted = parts.slice( 1 );
		const snapshot = node.dumpNode();

		// The class heads the dump (first line); pull it out of the body keys.
		const klass = snapshot.class ?? '';
		delete snapshot.class;
		// `class` always in the header; requesting it as a key is a no-op.
		wanted = wanted.filter( ( k ) => 'class' !== k );

		// Alphabetical so output is stable across differing ancestries.
		const ordered = {};
		for ( const k of Object.keys( snapshot ).sort() ) {
			ordered[ k ] = snapshot[ k ];
		}

		let body = ordered;
		if ( wanted.length > 0 ) {
			for ( const k of wanted ) {
				if ( ! ( k in ordered ) ) {
					return `can't find key "${ k }"`;
				}
			}
			body = {};
			for ( const k of wanted ) {
				body[ k ] = ordered[ k ];
			}
		}

		return `${ klass } ${ JSON.stringify( body, null, 4 ) }`;
	}

	/**
	 * `dump_config [<glob>]` — every node as round-trippable make_node /
	 * set_sink / connect_node lines.
	 *
	 * The backbone is skipped, and so is anything a patron manages: replaying
	 * the patron's own line recreates its sidecars.
	 *
	 * @param {string} glob     Regex filter on node names; '' emits all, and a bad pattern emits none.
	 * @param {Object} registry Name table to walk.
	 * @return {string} The config lines.
	 */
	static _cmdDumpConfig( glob = '', registry ) {
		const pattern = ( glob || '' ).trim();
		let re = null;
		if ( pattern ) {
			// Regex glob on node names; a bad pattern matches nothing.
			try {
				re = new RegExp( pattern );
			} catch {
				return '';
			}
		}
		let out = '';
		for ( const [ name, node ] of registry.nodes ) {
			// Skip only the backbone; _output is a real node now, dumpable.
			if ( '_command_interpreter' === name || '_router' === name ) {
				continue;
			}
			if ( re && ! re.test( name ) ) {
				continue; // regex-glob filter — skip names not matching.
			}
			// Omit patron-managed sidecars; patron's config recreates them.
			if ( node.patron ) {
				continue;
			}
			if ( 'function' === typeof node.dumpConfig ) {
				out += node.dumpConfig();
			}
		}
		return out;
	}

	/**
	 * `dump_metadata [<node>]` — the per-node snapshot the dashboards read.
	 *
	 * @param {string} args     A single node name to narrow to; '' is the full map.
	 * @param {Object} registry Name table to walk.
	 * @return {Object} Metadata keyed by node name.
	 */
	static _cmdDumpMetadata( args, registry ) {
		return dumpMetadataPayload( String( args ?? '' ).trim(), registry );
	}

	/**
	 * `stats [-a] [<regex>]` — per-node counters as an aligned table.
	 *
	 * @param {string[]} args Verb tokens: `-a` and a regex for every match, else a sink name.
	 * @return {string} The rendered table.
	 */
	_cmdStats( args ) {
		let listMatches = false;
		const argv = [];
		for ( const tok of args ) {
			if ( '-a' === tok ) {
				listMatches = true;
				continue;
			}
			argv.push( tok );
		}
		const glob = argv[ 0 ] ?? null;
		const header = [ 'NAME', 'COUNT', 'LGST_MSG', 'READ', 'WRITTEN' ];
		const dirs = [ 'left', 'right', 'right', 'right', 'right' ];
		const rows = [];
		const allNames = [ ...this.childRegistry.nodes.keys() ].sort();
		let re = null;
		if ( listMatches && null !== glob ) {
			try {
				re = new RegExp( glob );
			} catch ( e ) {
				re = null;
			}
		}
		for ( const name of allNames ) {
			const node = this.childRegistry.node( name );
			const sinkName = node.sink && node.sink.name ? node.sink.name : '';
			if ( listMatches ) {
				if ( null !== glob && ( ! re || ! re.test( name ) ) ) {
					continue;
				}
			} else {
				const expected = glob ?? this.name;
				if ( expected !== sinkName ) {
					continue;
				}
			}
			rows.push( [
				name,
				String( node.counter ?? 0 ),
				String( node.largestMsgSent ?? 0 ),
				String( node.bytesRead ?? 0 ),
				String( node.bytesWritten ?? 0 ),
			] );
		}
		return CommandInterpreterNode._tabulate( dirs, header, rows );
	}

	/**
	 * `trace [<node> [<level>]]` — toggle or set a debug_state level.
	 *
	 * No argument toggles this interpreter; a bare number sets it; `*` applies
	 * one level to every node in the table.
	 *
	 * @param {string[]} args Verb tokens: node name, `*`, or a level.
	 * @return {string} The resulting state line.
	 */
	_cmdTrace( args ) {
		const parts = args;
		const first = parts[ 0 ] ?? '';

		if ( '' === first ) {
			const next = ( this.debugState ?? 0 ) > 0 ? 0 : 1;
			this.debugState = next;
			return `_command_interpreter debug_state: ${ next }`;
		}

		const second = parts.slice( 1 ).join( ' ' );
		if ( '*' === first ) {
			let next;
			if ( '' === second ) {
				next = ( this.debugState ?? 0 ) > 0 ? 0 : 1;
			} else {
				// Match PHP (int) + max(0,…): non-numeric → 0, never negative.
				next = Math.max( 0, parseInt( second, 10 ) || 0 );
			}
			let count = 0;
			for ( const [ , node ] of this.childRegistry.nodes ) {
				node.debugState = next;
				count++;
			}
			// Terse summary, not a per-node roster (ls lists them).
			return `debug_state ${ next } on ${ count } nodes`;
		}
		if ( /^\d+$/.test( first ) && '' === second ) {
			this.debugState = parseInt( first, 10 );
			return `_command_interpreter debug_state: ${ this.debugState }`;
		}

		const node = this.childRegistry.node( first );
		if ( null === node ) {
			return `unknown node: ${ first }`;
		}
		let next;
		if ( '' === second ) {
			next = ( node.debugState ?? 0 ) > 0 ? 0 : 1;
		} else {
			// Match PHP (int) + max(0,…): non-numeric → 0, never negative.
			next = Math.max( 0, parseInt( second, 10 ) || 0 );
		}
		node.debugState = next;
		return `${ first } debug_state: ${ next }`;
	}

	/**
	 * `help [<topic>]` — bare tabulates every command name; a topic returns its
	 * help text, or, for a node type, its schema rendered as documentation.
	 *
	 * A KEY of 'completion' returns bare verb names from the dispatch table
	 * rather than the help topics, so aliases are offered too.
	 *
	 * @param {string[]}     args  Verb tokens: the topic to look up.
	 * @param {Array|Object} [env] Inbound message; its KEY selects completion mode.
	 * @return {string} The help text, or the no-such-topic line.
	 */
	static _cmdHelp( args, env = {} ) {
		// Completion: bare sorted verb names, newline-separated, no help text.
		if ( env && env[ KEY ] === 'completion' ) {
			// From verb dispatch table (not help-topic) so aliases are listed.
			return Object.keys( CommandInterpreterNode._defaultCommands() )
				.sort()
				.join( '\n' );
		}
		const topic = args[ 0 ] ?? '';
		if ( '' === topic ) {
			const names = Object.keys( HELP ).sort();
			const rows = [];
			let row = [];
			names.forEach( ( n, i ) => {
				row.push( n );
				if ( 0 === ( i + 1 ) % 4 ) {
					rows.push( row );
					row = [];
				}
			} );
			if ( row.length > 0 ) {
				rows.push( row );
			}
			return [
				'### COMMANDS ###',
				CommandInterpreterNode._tabulate(
					[ 'left', 'left', 'left', 'left' ],
					null,
					rows
				),
			].join( '\n' );
		}
		const key = ALIAS_TO_CANONICAL[ topic ] ?? topic;
		if ( key in HELP ) {
			return HELP[ key ];
		}
		const NodeClass = CommandInterpreterNode.resolveClass( topic );
		if ( NodeClass ) {
			const schema = NodeClass.nodeSchema?.() ?? {
				category: '',
				description: '',
				arguments: [],
				commands: [],
				registrations: [],
				accepts_fill: true,
				has_target: true,
			};
			return CommandInterpreterNode._renderNodeSchema( topic, schema );
		}
		return `no such topic: "${ topic }"`;
	}

	/**
	 * Render a node type's schema as a help block, with the same sections and
	 * alignment as PHP's help. A section with no entries is omitted entirely.
	 *
	 * @param {string} type   Shell class name being documented.
	 * @param {Object} schema The type's nodeSchema() return value.
	 * @return {string} The help block.
	 */
	static _renderNodeSchema( type, schema ) {
		const category =
			null !== schema.category && undefined !== schema.category
				? ` — ${ CommandInterpreterNode._schemaText(
						schema.category
				  ) }`
				: '';
		const out = [ `### ${ type }${ category } ###` ];
		if ( null !== schema.description && undefined !== schema.description ) {
			out.push(
				CommandInterpreterNode._schemaText( schema.description )
			);
		}

		const flags = [];
		for ( const flag of [ 'accepts_fill', 'has_target' ] ) {
			if ( null !== schema[ flag ] && undefined !== schema[ flag ] ) {
				flags.push(
					`${ flag }=${ schema[ flag ] ? 'true' : 'false' }`
				);
			}
		}
		if ( flags.length > 0 ) {
			out.push( flags.join( '  ' ) );
		}

		const argRows = [];
		for ( const arg of CommandInterpreterNode._schemaList(
			schema,
			'arguments'
		) ) {
			if (
				null === arg ||
				'object' !== typeof arg ||
				Array.isArray( arg )
			) {
				continue;
			}
			let spec = '';
			if ( arg.required ) {
				spec = 'required';
			} else if (
				Object.prototype.hasOwnProperty.call( arg, 'default' )
			) {
				spec = `=${ CommandInterpreterNode._renderDefault(
					arg.default
				) }`;
			}
			argRows.push( [
				CommandInterpreterNode._schemaText( arg.name ),
				CommandInterpreterNode._schemaText( arg.type ),
				spec,
				CommandInterpreterNode._schemaText( arg.description ),
			] );
		}
		if ( argRows.length > 0 ) {
			out.push( 'ARGUMENTS' );
			out.push(
				CommandInterpreterNode._tabulate(
					[ 'left', 'left', 'left', 'left' ],
					null,
					argRows
				)
			);
		}

		for ( const [ field, label ] of [
			[ 'commands', 'COMMANDS' ],
			[ 'requests', 'REQUESTS' ],
		] ) {
			const rows = [];
			for ( const entry of CommandInterpreterNode._schemaList(
				schema,
				field
			) ) {
				if (
					null === entry ||
					'object' !== typeof entry ||
					Array.isArray( entry )
				) {
					continue;
				}
				rows.push( [
					CommandInterpreterNode._schemaText( entry.name ),
					CommandInterpreterNode._schemaText( entry.description ),
				] );
			}
			if ( rows.length > 0 ) {
				out.push( label );
				out.push(
					CommandInterpreterNode._tabulate(
						[ 'left', 'left' ],
						null,
						rows
					)
				);
			}
		}

		const registrations = CommandInterpreterNode._schemaList(
			schema,
			'registrations'
		);
		if ( registrations.length > 0 ) {
			out.push(
				`REGISTRATIONS: ${ registrations
					.map( CommandInterpreterNode._schemaText )
					.join( ', ' ) }`
			);
		}
		return out.join( '\n' );
	}

	/**
	 * One list-valued schema section, copied. A section that is missing or not
	 * an array reads as empty, so a partial schema still renders.
	 *
	 * @param {Object} schema The node schema.
	 * @param {string} key    Section name, e.g. 'arguments'.
	 * @return {Array} The section's entries.
	 */
	static _schemaList( schema, key ) {
		return Array.isArray( schema[ key ] ) ? [ ...schema[ key ] ] : [];
	}

	/**
	 * Render a schema argument's declared default for the help table.
	 *
	 * @param {*} value The declared default.
	 * @return {string} Its printable form.
	 */
	static _renderDefault( value ) {
		if ( 'boolean' === typeof value ) {
			return value ? 'true' : 'false';
		}
		if ( Array.isArray( value ) ) {
			return '[]';
		}
		return CommandInterpreterNode._schemaText( value );
	}

	/**
	 * Coerce a schema field to display text. Anything with no useful string
	 * form — object, function, symbol, null — renders empty rather than as
	 * '[object Object]'.
	 *
	 * @param {*} value The schema field.
	 * @return {string} The text.
	 */
	static _schemaText( value ) {
		if ( 'boolean' === typeof value ) {
			return value ? '1' : '';
		}
		if (
			null === value ||
			undefined === value ||
			'object' === typeof value ||
			'function' === typeof value ||
			'symbol' === typeof value
		) {
			return '';
		}
		return String( value );
	}

	/**
	 * Column-aligned table rendering; the last left-aligned column isn't padded.
	 *
	 * @param {Array}  dirs   One per column ('left' or 'right').
	 * @param {?Array} header Optional header row; null skips it.
	 * @param {Array}  rows   Row arrays.
	 * @return {string} Rendered table.
	 */
	static _tabulate( dirs, header, rows ) {
		const ncols = dirs.length;
		const max = new Array( ncols ).fill( 0 );
		if ( null !== header ) {
			header.forEach( ( val, col ) => {
				max[ col ] = Math.max( max[ col ], String( val ).length );
			} );
		}
		for ( const row of rows ) {
			row.forEach( ( val, col ) => {
				if ( col >= ncols ) {
					return;
				}
				max[ col ] = Math.max( max[ col ], String( val ).length );
			} );
		}

		const formatRow = ( row ) => {
			const parts = [];
			for ( let col = 0; col < ncols; col++ ) {
				const val = String( row[ col ] ?? '' );
				const dir = dirs[ col ] ?? 'left';
				const last = col === ncols - 1;
				if ( 'right' === dir ) {
					parts.push( val.padStart( max[ col ], ' ' ) );
				} else if ( last ) {
					parts.push( val );
				} else {
					parts.push( val.padEnd( max[ col ], ' ' ) );
				}
			}
			return parts.join( ' ' );
		};

		let out = '';
		if ( null !== header ) {
			out += formatRow( header ) + '\n';
		}
		for ( const row of rows ) {
			out += formatRow( row ) + '\n';
		}
		return out.replace( /\n+$/, '' );
	}

	/**
	 * `list_timers [-s]` — every Timer node in the table. MODE tells an own
	 * event-framework slot apart from a router hitchhike.
	 *
	 * @param {boolean} [structured] Return the rows themselves, for a view that sorts them.
	 * @param {Object}  [registry]   Name table to walk; Core's by default.
	 * @return {string|Array<Object>} The table, or the rows when structured.
	 */
	static _cmdListTimers( structured = false, registry = Core.registry ) {
		if ( structured ) {
			return CommandInterpreterNode._timerRows( registry );
		}
		const rows = CommandInterpreterNode._timerRows( registry ).map(
			( r ) => [
				r.active ? 'yes' : 'no',
				String( r.interval_ms ),
				r.mode,
				r.oneshot ? 'yes' : 'no',
				String( r.fires ),
				r.type,
				r.name,
			]
		);
		rows.sort( ( a, b ) => a[ 6 ].localeCompare( b[ 6 ] ) );
		return CommandInterpreterNode._tabulate(
			[ 'right', 'right', 'right', 'right', 'right', 'right', 'left' ],
			[
				'ACTIVE',
				'INTERVAL',
				'MODE',
				'ONESHOT',
				'FIRES',
				'TYPE',
				'NAME',
			],
			rows
		);
	}

	/**
	 * `list_handles [-s]` — the nodes holding an EventSource. STATE is that
	 * source's readyState, which is how a stuck stream shows itself.
	 *
	 * @param {boolean} [structured] Return the rows themselves, for a view that sorts them.
	 * @param {Object}  [registry]   Name table to walk; Core's by default.
	 * @return {string|Array<Object>} The table, or the rows when structured.
	 */
	static _cmdListHandles( structured = false, registry = Core.registry ) {
		if ( structured ) {
			return CommandInterpreterNode._handleRows( registry );
		}
		const rows = CommandInterpreterNode._handleRows( registry ).map(
			( r ) => [
				r.id, // the EventSource readyState label (CONNECTING/OPEN/CLOSED)
				String( r.count ),
				r.type,
				r.name,
			]
		);
		rows.sort( ( a, b ) => a[ 3 ].localeCompare( b[ 3 ] ) );
		return CommandInterpreterNode._tabulate(
			[ 'right', 'right', 'right', 'left' ],
			[ 'STATE', 'COUNT', 'TYPE', 'NAME' ],
			rows
		);
	}

	/**
	 * The seven facts `list_profiles` prints, derived from one raw record. The
	 * text table and `-s` both render THIS derivation, so the two can never
	 * disagree about what a row means.
	 *
	 * @param {ProfileInfo} info One node's raw profile record.
	 * @param {number}      now  Clock reading `age` is measured back from.
	 * @return {ProfileStats} The derived stats.
	 */
	static _profileStats( info, now ) {
		const window = info.timestamp - info.oldest;
		return {
			avg: info.avg,
			time: info.time,
			count: info.count,
			window,
			rate: window > 0 && info.count > 1 ? info.count / window : 1,
			age: Math.trunc(
				info.timestamp > 0 ? Math.max( 0, now - info.timestamp ) : 0
			),
		};
	}

	/**
	 * The `--total--` record: summed time and count over the widest
	 * timestamp..oldest span any of the records covers.
	 *
	 * @param {ProfileInfo[]} infos The matched raw records.
	 * @return {ProfileInfo} A synthetic record standing for all of them.
	 */
	static _profileTotal( infos ) {
		let time = 0;
		let count = 0;
		let timestamp = 0;
		let oldest = 0;
		for ( const info of infos ) {
			time += info.time;
			count += info.count;
			timestamp = Math.max( timestamp, info.timestamp );
			oldest =
				0 === oldest ? info.oldest : Math.min( oldest, info.oldest );
		}
		return {
			avg: count > 0 ? time / count : 0,
			time,
			count,
			timestamp,
			oldest,
		};
	}

	/**
	 * Keyed rows for `list_timers`, one per Timer node; `next_ms` is always
	 * null, since nothing here records when a timer next fires.
	 *
	 * @param {Object} [registry] Name table to walk; Core's by default.
	 * @return {Array<Object>} The rows.
	 */
	static _timerRows( registry = Core.registry ) {
		const rows = [];
		for ( const [ name, node ] of registry.nodes ) {
			if ( ! ( node instanceof TimerNode ) ) {
				continue;
			}
			rows.push( {
				id: null,
				active: 'inactive' !== node.mode,
				interval_ms: node.interval_ms ?? 0,
				mode: node.mode,
				next_ms: null,
				oneshot: !! node.oneshot,
				fires: node.fireCount ?? 0,
				type: node.constructor.name,
				name,
			} );
		}
		return rows;
	}

	/**
	 * Keyed rows for `list_handles`, one per node holding an EventSource; `id`
	 * carries that source's readyState as its label.
	 *
	 * @param {Object} [registry] Name table to walk; Core's by default.
	 * @return {Array<Object>} The rows.
	 */
	static _handleRows( registry = Core.registry ) {
		const states = [ 'CONNECTING', 'OPEN', 'CLOSED' ];
		const rows = [];
		for ( const [ name, node ] of registry.nodes ) {
			if ( ! node._es ) {
				continue;
			}
			rows.push( {
				id:
					states[ node._es.readyState ] ??
					String( node._es.readyState ),
				count: node.counter ?? 0,
				type: node.constructor.name,
				name,
			} );
		}
		return rows;
	}

	/**
	 * profile [on|off] — toggle or set _router dispatch profiling.
	 *
	 * Bare `profile` toggles (Tachikoma's `debug_state`-precedent); explicit
	 * `on`/`off` is an idempotent set the form scripts + UI use, so a caller
	 * that knows its desired state never races a stale toggle. A deliberate
	 * single-verb divergence from Tachikoma's enable/disable pair.
	 *
	 * @param {string} arg        '' (toggle), 'on', or 'off'.
	 * @param {Object} [registry] Graph to check for a router; Core's default.
	 * @return {string} The reply line.
	 */
	static _cmdProfile( arg, registry = Core.registry ) {
		// Process-wide, so only a graph that OWNS the router may toggle it.
		if ( null === registry.node( '_router' ) ) {
			throw new Error( "can't find _router" );
		}
		const on = null !== RouterNode.profiles();
		let want;
		if ( '' === arg ) {
			want = ! on;
		} else if ( 'on' === arg ) {
			want = true;
		} else if ( 'off' === arg ) {
			want = false;
		} else {
			return 'usage: profile [ on | off ]\n';
		}
		if ( want === on ) {
			return want
				? 'profiling already enabled\n'
				: 'profiling already disabled\n';
		}
		RouterNode.profiles( want ? {} : null );
		return want ? 'profiling enabled\n' : 'profiling disabled\n';
	}

	/**
	 * `list_profiles [-s] [<glob>]` — the per-node self-time table, slowest
	 * average first, closed by a `--total--` row. The glob `total` shows only
	 * that row, over every profile.
	 *
	 * @param {string}  glob         Regex filter on node names; '' matches every profile.
	 * @param {boolean} [structured] Return the rows themselves, `--total--` included.
	 * @param {Object}  [registry]   Name table that must own `_router`.
	 * @return {string|Array<Object>} The table, or the rows when structured.
	 */
	static _cmdListProfiles(
		glob,
		structured = false,
		registry = Core.registry
	) {
		if ( null === registry.node( '_router' ) ) {
			throw new Error( "can't find _router" );
		}
		// Core.now() (not wall time) so a shadowed clock stays deterministic.
		const start = Core.now();
		const profiles = RouterNode.profiles() ?? {};
		const matched = Object.entries( profiles ).filter(
			( [ key ] ) =>
				'' === glob ||
				'total' === glob ||
				new RegExp( glob ).test( key )
		);
		const stats = ( info ) =>
			CommandInterpreterNode._profileStats( info, start );
		const totals = stats(
			CommandInterpreterNode._profileTotal(
				matched.map( ( e ) => e[ 1 ] )
			)
		);

		const listed =
			'total' === glob
				? []
				: matched
						.map(
							( [ key, info ] ) =>
								/** @type {[string, ProfileStats]} */ ( [
									key,
									stats( info ),
								] )
						)
						.sort( ( a, b ) => b[ 1 ].avg - a[ 1 ].avg );
		if ( structured ) {
			return listed
				.map( ( [ key, r ] ) => ( { ...r, what: key } ) )
				.concat( [ { ...totals, what: '--total--' } ] );
		}
		const rows = listed.map( ( [ key, r ] ) =>
			CommandInterpreterNode._profileRow( r, key )
		);
		rows.push( CommandInterpreterNode._profileRow( totals, '--total--' ) );

		return (
			CommandInterpreterNode._tabulate(
				[
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'left',
				],
				[ 'AVERAGE', 'TIME', 'COUNT', 'WINDOW', 'RATE', 'AGE', 'WHAT' ],
				rows
			) +
			`\nreturned ${ listed.length } profiles in ${ (
				Core.now() - start
			).toFixed( 4 ) } seconds\n`
		);
	}

	/**
	 * One `list_profiles` row: the shared stats struct, formatted.
	 *
	 * @param {ProfileStats} r    Derived stats for one profile.
	 * @param {string}       what The node name, or '--total--'.
	 * @return {string[]} The row's cells, in header order.
	 */
	static _profileRow( r, what ) {
		return [
			r.avg.toFixed( 6 ),
			r.time.toFixed( 2 ),
			String( r.count ),
			r.window.toFixed( 2 ),
			r.rate.toFixed( 2 ),
			String( r.age ),
			what,
		];
	}

	/**
	 * `uptime` — the wall clock, plus how long since Core's baseline was set.
	 *
	 * @return {string} `HH:MM:SS  up <elapsed>`.
	 */
	static _cmdUptime() {
		const now = Core.now();
		const init = 'number' === typeof Core.initTime ? Core.initTime : now;
		const uptime = Math.floor( now - init );
		const clock = new Date( now * 1000 ).toISOString().slice( 11, 19 );
		return `${ clock }  up ${ CommandInterpreterNode._formatUptime(
			uptime
		) }\n`;
	}

	/**
	 * Render an elapsed count the way `uptime` does, coarsening as it grows:
	 * seconds, then minutes, then hours, then days and a clock.
	 *
	 * @param {number} seconds Whole seconds elapsed.
	 * @return {string} The formatted duration.
	 */
	static _formatUptime( seconds ) {
		const pad = ( n ) => String( n ).padStart( 2, '0' );
		if ( seconds < 60 ) {
			return `${ pad( seconds ) }s`;
		}
		if ( seconds < 3600 ) {
			const m = Math.floor( seconds / 60 );
			return `${ m }m ${ pad( seconds % 60 ) }s`;
		}
		if ( seconds < 86400 ) {
			const h = Math.floor( seconds / 3600 );
			const m = Math.floor( ( seconds % 3600 ) / 60 );
			return `${ h }h ${ pad( m ) }m`;
		}
		const d = Math.floor( seconds / 86400 );
		const rem = seconds - d * 86400;
		const clock = new Date( rem * 1000 ).toISOString().slice( 11, 19 );
		return `${ d }d ${ clock }`;
	}

	/**
	 * Resolve a shell class name to its Node class — the flat-table stand-in
	 * for Tachikoma's `@INC` require.
	 *
	 * The own-property check keeps an inherited name such as `constructor` from
	 * resolving, and anything that is not Node or a Node subclass is refused
	 * rather than constructed.
	 *
	 * @param {string} type Shell class name, as `make_node` spells it.
	 * @return {?NodeClass} The class, or null when nothing valid is registered.
	 */
	static resolveClass( type ) {
		if (
			! Object.prototype.hasOwnProperty.call(
				CommandInterpreterNode.includeNodes,
				type
			)
		) {
			return null;
		}
		const NodeClass = CommandInterpreterNode.includeNodes[ type ];
		if (
			'function' !== typeof NodeClass ||
			( Node !== NodeClass && ! ( NodeClass.prototype instanceof Node ) )
		) {
			return null;
		}
		return NodeClass;
	}

	/**
	 * Schema for the console palette. Hidden, because an interpreter is placed
	 * implicitly beside the node it serves rather than dragged onto a canvas.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Command dispatch — placed implicitly as sibling of patron nodes; not draggable.',
			arguments: [],
			commands: [],
			accepts_fill: false,
			has_target: false,
		};
	}
}

// Process-wide default authorize policy; browser leaves it null (LOCAL check).
CommandInterpreterNode.defaultAuthorize = null;

// `make_node` type→class lookup — flat table for Tachikoma's @INC require.
CommandInterpreterNode.includeNodes = {
	Node,
	CommandInterpreter: CommandInterpreterNode,
	Completion: CompletionNode,
	Dmesg: DmesgNode,
	Dumper: DumperNode,
	Echo: EchoNode,
	Fetcher: FetcherNode,
	Request: RequestNode,
	Heartbeat: HeartbeatNode,
	HttpOut: HttpOutNode,
	Metadata: MetadataNode,
	RemoteIpc: RemoteIpcNode,
	RemoteLink: RemoteLinkNode,
	SseIn: SseInNode,
	Tap: TapNode,
	Tee: TeeNode,
	Timer: TimerNode,
	Uptime: UptimeNode,
};

// Plugins register node classes by merging a name→class map into includeNodes.
CommandInterpreterNode.registerNodeClasses = function ( map ) {
	Object.assign( CommandInterpreterNode.includeNodes, map );
};
