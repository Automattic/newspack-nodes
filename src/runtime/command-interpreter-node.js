import { Node } from './node';
import { TeeNode } from './tee-node';
import { TapNode } from './tap-node';
import { EchoNode } from './echo-node';
import { FetcherNode } from './fetcher-node';
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

// Alias to canonical, kept in lockstep with the verb table + Shell builtins so
// `help <alias>` resolves to the same topic PHP cmd_help does.
const ALIAS_TO_CANONICAL = {
	ls: 'list_nodes',
	dump: 'dump_node',
	make: 'make_node',
	connect: 'connect_node',
	disconnect: 'disconnect_node',
	remove: 'remove_node',
	rm: 'remove_node',
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
	list_nodes:
		'list_nodes [ -clst ] [ <node name> ]\nlist_nodes -a [ -clst ] [ <regex glob> ]\n    -c show message counters\n    -l show counters and targets\n    -s show sinks\n    -t show targets\n    -a show all nodes matching regex glob\n    alias: ls\n',
	dump_node: 'dump_node <node name> [<keys>]\n    alias: dump\n',
	dump_config:
		'dump_config [ <regex glob> ]\n    note: emits every node as round-trippable make_node / set_sink / connect_node lines; an optional regex glob filters by node name.\n',
	dump_metadata:
		'dump_metadata\n    note: returns a JSON object keyed by node name with `class`, `counter`, `sink`, `target`, `debug_state`, `arguments`.\n',
	debug_state:
		"debug_state [ <node name> [ <level> ] ]\n    no args: toggle this CommandInterpreter's debug_state.\n",
	pwd: 'pwd\n',
	log: 'log <message>\n    note: prints <message> to stderr (server-side debug log).\n',
	dmesg: 'dmesg\n    note: print the recent server-side stderr tail (last 100 lines).\n',
	include: 'include <file>\n',
	uptime: 'uptime\n',
	stats: 'stats [-a] [<regex>]\n    columns: NAME COUNT LGST_MSG READ WRITTEN.\n',
	help: 'help [ <topic> ]\n',

	// Shell-level builtins — Shell intercepts these; listed here so `help` is complete.
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
		'reply_to <node path> <command>\n    note: runs <command> here but routes its reply to <node path> (inverse of command_node).\n',
	ping: 'ping <path>\n',
	show_parse:
		'show_parse\n   note: toggles parsed command dump for every command.\n',
	status: 'status\n    note: local cli mode summary (no command sent).\n',
};

// Split on runs of whitespace, dropping empties (PHP preg_split('/\s+/', trim())).
function splitArgs( args ) {
	const t = String( args ?? '' ).trim();
	return '' === t ? [] : t.split( /\s+/ );
}

/**
 * Verb dispatch over TM_COMMAND messages with empty TO (mirrors PHP
 * CommandInterpreter). Throws wrap as TM_ERROR, returns as TM_RESPONSE;
 * everything else passes through the sink unchanged. Ships the full PHP $C verb
 * set as built-in defaults; commands( table ) merges over them.
 */
export class CommandInterpreterNode extends Node {
	constructor() {
		super();
		// Per-instance authorize override (tests / special cases); null falls back
		// to the static default, then to the built-in LOCAL-provenance check.
		this.authorize = null;
		this._commands = CommandInterpreterNode._defaultCommands();
	}

	// The verb table and the auth closure are internal machinery, not display state and
	// not nodes (so the base instanceof filter wouldn't catch them) — mask them. [96]
	dumpNode() {
		const snapshot = super.dumpNode();
		snapshot._commands = '{...}';
		snapshot.authorize = '{...}';
		return snapshot;
	}

	fill( message ) {
		this.counter += 1;
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

	_interpret( message ) {
		// VALUE is the structured command object directly (no parse needed).
		const cmd = message[ VALUE ];
		if ( ! cmd || typeof cmd !== 'object' || ! cmd.name ) {
			this.stderr( 'WARNING: invalid command struct' );
			return;
		}

		// Authorization gate (every command): the browser tier requires the LOCAL
		// provenance taint a Shell stamps on in-process commands. An SSE-injected
		// command routed here lacks it and is refused before dispatch.
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
		try {
			const result = verb( this, cmd.arguments ?? '', message );
			this._respond( message, cmd.name, result, TM_RESPONSE );
		} catch ( e ) {
			this._respond( message, cmd.name, e.message, TM_ERROR );
		}
	}

	_respond( message, name, payload, kind ) {
		if ( payload === '' || payload === undefined ) {
			return;
		}
		// TM_NOREPLY (Tachikoma CommandInterpreter::send_response): suppress the
		// routed reply, but still surface an error to stderr so a failed boot
		// command (e.g. a bad topology make_node) stays visible in dmesg.
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
		// Response VALUE rides as { name, arguments, payload } directly — `arguments`
		// echoes the request so a targeted reply (e.g. `dump_metadata <node>`) is
		// distinguishable from a full one.
		const reqArgs =
			message[ VALUE ] && typeof message[ VALUE ] === 'object'
				? message[ VALUE ].arguments ?? ''
				: '';
		resp[ VALUE ] = { name, arguments: reqArgs, payload };
		if ( this.sink ) {
			this.sink.fill( resp );
		}
	}

	// `make_node <type> <name> [<ctor_args>...]` — mirrors PHP
	// Command_Interpreter_Node::make_node: split the args on whitespace, the
	// remaining tokens spread straight into the constructor as positional args,
	// then name() + sink($self). The browser builds it locally (no deferring to a
	// worker) so the console graph is live + hackable. A bad/short arg list
	// throws in the constructor — that's fine, breaking is how you learn.
	_cmdMakeNode( args ) {
		const parts = String( args ?? '' )
			.trim()
			.split( /\s+/ )
			.filter( Boolean );
		if ( parts.length < 2 ) {
			return 'usage: make_node <type> <name> [<ctor_args>...]';
		}
		const type = parts.shift();
		// Unknown class returns a string (builds nothing); a name collision still
		// throws out so interpret()'s central catch wraps it as TM_ERROR.
		if ( ! CommandInterpreterNode.includeNodes[ type ] ) {
			return `unknown class: ${ type }`;
		}
		const name = parts.shift();
		this.makeNode( type, name, parts.join( ' ' ) );
		return 'ok';
	}

	// Programmatic graph construction: create a registered class, name + sink it
	// into this interpreter, return the node. The make_node verb delegates here.
	makeNode( type, name, args = '' ) {
		const NodeClass = CommandInterpreterNode.includeNodes[ type ];
		if ( ! NodeClass ) {
			throw new Error( `unknown class: ${ type }` );
		}
		const node = new NodeClass();
		node.name = name;
		node.arguments = String( args ?? '' ).trim();
		node.sink = this;
		if ( ( this.debugState ?? 0 ) > 0 ) {
			node.debugState = this.debugState;
		}
		return node;
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
	 * @param {string} name     Verb name.
	 * @param {string} args     Literal arguments tail.
	 * @param {Array}  envelope Inbound message, or [] for inline calls.
	 * @return {*} Verb result.
	 */
	dispatch( name, args = '', envelope = [] ) {
		const verb = this._commands[ name ];
		if ( typeof verb !== 'function' ) {
			throw new Error( `unknown command: ${ name }` );
		}
		return verb( this, args, envelope );
	}

	// ----- built-in verb table (1:1 with PHP $C) ----------------------------

	static _defaultCommands() {
		return {
			make_node: ( self, args ) => self._cmdMakeNode( args ),
			make: ( self, args ) => self._cmdMakeNode( args ),
			pwd: ( self, args, env ) =>
				CommandInterpreterNode._cmdPwd( args, env ),
			set_sink: ( self, args ) =>
				CommandInterpreterNode._cmdSetSink( args ),
			connect_node: ( self, args, env ) =>
				CommandInterpreterNode._cmdConnect( args, env ),
			connect: ( self, args, env ) =>
				CommandInterpreterNode._cmdConnect( args, env ),
			disconnect_node: ( self, args, env ) =>
				CommandInterpreterNode._cmdDisconnect( args, env ),
			disconnect: ( self, args, env ) =>
				CommandInterpreterNode._cmdDisconnect( args, env ),
			register: ( self, args ) =>
				CommandInterpreterNode._cmdRegister( args ),
			unregister: ( self, args ) =>
				CommandInterpreterNode._cmdUnregister( args ),
			remove_node: ( self, args ) => self._cmdRemove( args ),
			remove: ( self, args ) => self._cmdRemove( args ),
			rm: ( self, args ) => self._cmdRemove( args ),
			list_nodes: ( self, args, env ) => self._cmdList( args, env ),
			ls: ( self, args, env ) => self._cmdList( args, env ),
			log: ( self, args ) => {
				self.stderr( args );
				return '';
			},
			dmesg: () => CommandInterpreterNode._cmdDmesg(),
			dump_node: ( self, args ) =>
				CommandInterpreterNode._cmdDumpNode( args ),
			dump: ( self, args ) => CommandInterpreterNode._cmdDumpNode( args ),
			dump_metadata: ( self, args ) =>
				CommandInterpreterNode._cmdDumpMetadata( args ),
			dump_config: ( self, args ) =>
				CommandInterpreterNode._cmdDumpConfig( args ),
			stats: ( self, args ) => self._cmdStats( args ),
			uptime: () => CommandInterpreterNode._cmdUptime(),
			debug_state: ( self, args ) => self._cmdDebugState( args ),
			help: ( self, args, env ) =>
				CommandInterpreterNode._cmdHelp( args, env ),
			reply_to: ( self, args ) => self._cmdReplyTo( args ),
		};
	}

	// `reply_to <node path> <command>` — run <command> HERE but route its reply to
	// <node path> (inverse of command_node). Mints the sub-command stamped
	// FROM=<path> (interpret replies TO=FROM) + re-enters fill(); LOCAL authorizes
	// the in-process mint. Returns nothing — the output went to <path>.
	_cmdReplyTo( args ) {
		const t = String( args ?? '' ).trim();
		const i1 = t.search( /\s/ );
		const path = -1 === i1 ? t : t.slice( 0, i1 );
		const rest = -1 === i1 ? '' : t.slice( i1 ).trim();
		const i2 = rest.search( /\s/ );
		const verb = -1 === i2 ? rest : rest.slice( 0, i2 );
		const verbArgs = -1 === i2 ? '' : rest.slice( i2 ).trim();
		if ( '' === path || '' === verb ) {
			return 'usage: reply_to <node path> <command>';
		}
		// reply_to is the only verb that re-enters interpret() with a fresh
		// sub-command; refuse to nest it so `reply_to p reply_to p ... <verb>`
		// can't recurse synchronously until the stack blows.
		if ( 'reply_to' === verb ) {
			return 'reply_to cannot invoke reply_to';
		}
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = path;
		m[ VALUE ] = { name: verb, arguments: verbArgs };
		m[ LOCAL ] = true;
		this.fill( m );
		return '';
	}

	// `pwd` to ` <cwd> -> <envelope.from>`.
	static _cmdPwd( args, envelope ) {
		const cwd = '' === String( args ?? '' ).trim() ? '/' : args;
		const from = ( envelope && envelope[ FROM ] ) || '';
		return ` ${ cwd } -> ${ from }`;
	}

	static _cmdSetSink( args ) {
		const parts = splitArgs( args );
		const name = parts[ 0 ] ?? '';
		const target = parts.slice( 1 ).join( ' ' );
		if ( '' === name || '' === target ) {
			return 'usage: set_sink <node> <target>';
		}
		const src = Core.node( name );
		const dst = Core.node( target );
		if ( null === src || null === dst ) {
			return 'unknown node';
		}
		src.sink = dst;
		return 'ok';
	}

	static _cmdConnect( args, envelope = {} ) {
		const parts = splitArgs( args );
		const name = parts[ 0 ] ?? '';
		if ( '' === name ) {
			return 'usage: connect_node <node> [<target>]';
		}
		const src = Core.node( name );
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
		// Every node implements connectNode now (base = single string target; Tee
		// appends to a fan-out array; RemoteLink points its SseIn), so dispatch
		// uniformly — no branch on node type. Matches PHP Node::connect_node.
		src.connectNode( target );
		return 'ok';
	}

	static _cmdDisconnect( args, envelope = {} ) {
		const parts = splitArgs( args );
		const name = parts[ 0 ] ?? '';
		if ( '' === name ) {
			return 'usage: disconnect_node <node> [<target>]';
		}
		const src = Core.node( name );
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
			// Defensive fallback for any node missing disconnectNode: remove the
			// target from the fan-out array directly (PHP Node::disconnect_node).
			src.target = src.target.filter( ( t ) => t !== target );
		} else if ( src.target === target ) {
			src.target = '';
		}
		return 'ok';
	}

	// `register <source> <target> <event>` — source registers target as a
	// node-name listener for event (Tachikoma register; arg order source/target/event
	// but Node.register takes event first). Undeclared events throw out as TM_ERROR.
	static _cmdRegister( args ) {
		const parts = splitArgs( args );
		const source = parts[ 0 ] ?? '';
		if ( '' === source ) {
			return 'usage: register <source name> <target name> <event>';
		}
		const src = Core.node( source );
		if ( null === src ) {
			return `unknown node: ${ source }`;
		}
		const target = parts[ 1 ] ?? '';
		if ( '' === target ) {
			return 'usage: register <source name> <target name> <event>';
		}
		if ( null === Core.node( target ) ) {
			return `unknown node: ${ target }`;
		}
		src.register( parts.slice( 2 ).join( ' ' ), target );
		return 'ok';
	}

	// `unregister <source> <target> <event>` — drop target's node-name
	// registration for event on source (Tachikoma unregister). No target-existence
	// check: a vanished target's registration can still be cleared.
	static _cmdUnregister( args ) {
		const parts = splitArgs( args );
		const source = parts[ 0 ] ?? '';
		if ( '' === source ) {
			return 'usage: unregister <source name> <target name> <event>';
		}
		const src = Core.node( source );
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

	// `remove_node <name>...` or `remove_node -a <regex>`.
	_cmdRemove( argsIn ) {
		let args = String( argsIn ?? '' ).trim();
		if ( '' === args ) {
			return 'usage: remove_node <node name>';
		}

		let listMatches = false;
		if ( args.startsWith( '-a ' ) || '-a' === args ) {
			listMatches = true;
			args = args.slice( 2 ).trim();
			if ( '' === args ) {
				return 'usage: remove_node -a <anchored regex glob>';
			}
		}

		let names;
		if ( listMatches ) {
			names = [];
			let re = null;
			try {
				re = new RegExp( `^${ args }$` );
			} catch ( e ) {
				re = null;
			}
			if ( re ) {
				for ( const candidate of Core.nodes.keys() ) {
					if ( re.test( candidate ) ) {
						names.push( candidate );
					}
				}
			}
			names.sort();
		} else {
			names = args.split( /\s+/ );
		}

		const removed = [];
		const errors = [];
		for ( const name of names ) {
			if ( '' === name ) {
				continue;
			}
			const node = Core.node( name );
			if ( null === node ) {
				errors.push( `can't find node "${ name }"` );
				continue;
			}
			// Full lifecycle teardown (clears refs, cascades the sibling interpreter,
			// unregisters its own name LAST) — matches PHP Node::remove_node.
			node.removeNode();
			removed.push( `removed ${ name }` );
		}

		if ( listMatches && 0 === removed.length && 0 === errors.length ) {
			return 'no matches';
		}
		const out = [ ...removed, ...errors ].join( '\n' );
		return '' === out ? 'ok' : out;
	}

	// `list_nodes` (alias `ls`): default=siblings, `-a [glob]`=all, `<name>`=that sink's children.
	_cmdList( args, env = {} ) {
		// Completion mode: emit bare node names only, ignoring all -clst column
		// flags so the tab-completion parser gets clean candidates.
		const isCompletion = env && env[ KEY ] === 'completion';
		let listMatches = false;
		let showCount = false;
		let showSink = false;
		let showTarget = false;
		const argv = [];

		for ( const tok of splitArgs( args ) ) {
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

		// Completion mode shows bare names only: drop any column flags, and list
		// ALL nodes (like `-a`) so `cd <tab>` can reach _-prefixed nodes too.
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
				if ( null === Core.node( name ) ) {
					return `can't find node "${ name }"`;
				}
			}
		}

		const globs = 0 === argv.length ? [ null ] : argv;
		const allNames = [ ...Core.nodes.keys() ].sort();
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
				const node = Core.node( name );
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

	static _cmdDmesg() {
		const recent = Core.recentLog;
		return Array.isArray( recent ) ? recent.join( '' ) : '';
	}

	// dump_node <name> [<keys>]: class-header + pretty-JSON of the node's state.
	static _cmdDumpNode( args ) {
		const parts = splitArgs( args );
		const name = parts[ 0 ] ?? '';
		if ( '' === name ) {
			return 'no node specified';
		}
		const node = Core.node( name );
		if ( null === node ) {
			return `can't find node "${ name }"`;
		}
		let wanted = parts.slice( 1 );
		const snapshot = node.dumpNode();

		// The class heads the dump (first line); pull it out so it isn't a body key.
		const klass = snapshot.class ?? '';
		delete snapshot.class;
		// `class` is always shown in the header, so requesting it as a key is a no-op.
		wanted = wanted.filter( ( k ) => 'class' !== k );

		// Alphabetical so output is stable across nodes with different ancestors.
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

	// dump_config — every node's round-trippable make_node/set_sink/connect_node
	// lines, skipping the baseline scaffolding. Mirrors PHP cmd_dump_config.
	static _cmdDumpConfig( glob = '' ) {
		const pattern = ( glob || '' ).trim();
		let re = null;
		if ( pattern ) {
			// Tachikoma: the arg is a regex glob on node names. A malformed
			// pattern matches nothing (empty dump), mirroring PHP where a bad
			// preg_match returns false and every node is skipped.
			try {
				re = new RegExp( pattern );
			} catch {
				return '';
			}
		}
		let out = '';
		for ( const [ name, node ] of Core.nodes ) {
			// Skip only the backbone (literals avoid the `names` shadow); _output
			// is a real node now, shown on the canvas and dumpable.
			if ( '_command_interpreter' === name || '_router' === name ) {
				continue;
			}
			if ( re && ! re.test( name ) ) {
				continue; // regex-glob filter — skip names not matching.
			}
			// Omit patron-managed sidecars (a Consumer's :source / :offsetlog): the
			// patron's own config line recreates them, so dumping them separately
			// would duplicate them on replay.
			if ( node.patron ) {
				continue;
			}
			if ( 'function' === typeof node.dumpConfig ) {
				out += node.dumpConfig();
			}
		}
		return out;
	}

	// dump_metadata [<node>] — per-node stats snapshot for the GUI canvas. With a
	// node name, returns just that node (or an empty map if it's gone) so a
	// post-mutation refresh is a one-node round-trip; bare = the full map.
	static _cmdDumpMetadata( args ) {
		return dumpMetadataPayload( String( args ?? '' ).trim() );
	}

	// stats [-a] [<regex>] — tabular per-node counters.
	_cmdStats( args ) {
		let listMatches = false;
		const argv = [];
		for ( const tok of splitArgs( args ) ) {
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
		const allNames = [ ...Core.nodes.keys() ].sort();
		let re = null;
		if ( listMatches && null !== glob ) {
			try {
				re = new RegExp( glob );
			} catch ( e ) {
				re = null;
			}
		}
		for ( const name of allNames ) {
			const node = Core.node( name );
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

	// debug_state [ <node name> [ <level> ] ] — toggle or set a node's debug level.
	_cmdDebugState( args ) {
		const parts = splitArgs( args );
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
				// Match PHP (int) coercion + max(0,…): non-numeric → 0, never negative.
				next = Math.max( 0, parseInt( second, 10 ) || 0 );
			}
			let output = `Setting all nodes to debug_state: ${ next }\n`;
			const allNames = [ ...Core.nodes.keys() ].sort();
			for ( const name of allNames ) {
				const node = Core.node( name );
				node.debugState = next;
				output += `${ name } debug_state: ${ next }\n`;
			}
			return output;
		}
		if ( /^\d+$/.test( first ) && '' === second ) {
			this.debugState = parseInt( first, 10 );
			return `_command_interpreter debug_state: ${ this.debugState }`;
		}

		const node = Core.node( first );
		if ( null === node ) {
			return `unknown node: ${ first }`;
		}
		let next;
		if ( '' === second ) {
			next = ( node.debugState ?? 0 ) > 0 ? 0 : 1;
		} else {
			// Match PHP (int) coercion + max(0,…): non-numeric → 0, never negative.
			next = Math.max( 0, parseInt( second, 10 ) || 0 );
		}
		node.debugState = next;
		return `${ first } debug_state: ${ next }`;
	}

	// help — no args lists command names tabulated; a topic returns that command's help.
	static _cmdHelp( args, env = {} ) {
		// Completion mode: bare sorted verb names, newline-separated — no headers,
		// no per-topic help text — so the tab-completion parser gets clean candidates.
		if ( env && env[ KEY ] === 'completion' ) {
			// Source from the verb dispatch table, not the help-topic table, so
			// aliases (ls, rm, make, ...) are offered alongside the canonicals.
			return Object.keys( CommandInterpreterNode._defaultCommands() )
				.sort()
				.join( '\n' );
		}
		const topic = String( args ?? '' ).trim();
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
		return `no such topic: "${ topic }"`;
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

	// uptime — clock-time + elapsed-since-reset.
	static _cmdUptime() {
		const now = Core.now();
		const init = 'number' === typeof Core.initTime ? Core.initTime : now;
		const uptime = Math.floor( now - init );
		const clock = new Date( now * 1000 ).toISOString().slice( 11, 19 );
		return `${ clock }  up ${ CommandInterpreterNode._formatUptime(
			uptime
		) }\n`;
	}

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
}

// Process-wide default authorization policy. The browser leaves it null (the
// built-in LOCAL check applies). Same shape as PHP CommandInterpreter::$default_authorize.
CommandInterpreterNode.defaultAuthorize = null;

// The `make_node` type→class lookup. Tachikoma resolves `$prefix::$type` by
// require-ing the .pm off @INC ( include_nodes + the default Tachikoma::Nodes );
// the browser has no require-by-name, so this flat table IS that namespace.
// The console extends it with its own node classes (Tachikoma's include_nodes).
// Hook / Router / Callback are intentionally absent — nobody makes a second
// router, or a predicate/closure node, from the shell.
CommandInterpreterNode.includeNodes = {
	Node,
	CommandInterpreter: CommandInterpreterNode,
	Completion: CompletionNode,
	Dmesg: DmesgNode,
	Dumper: DumperNode,
	Echo: EchoNode,
	Fetcher: FetcherNode,
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

// Plugins/dashboards register their own node classes (the `*View`/`*Transform`
// factories, ELN's `Performance*`, etc.) by merging a shell-name→class map into
// includeNodes — mirrors PHP's per-plugin namespace registration.
CommandInterpreterNode.registerNodeClasses = function ( map ) {
	Object.assign( CommandInterpreterNode.includeNodes, map );
};
