import { Node } from './node';
import { Core } from './core';
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
	newMessage,
} from './message';

// Baseline scaffolding `remove_node` / `dump_config` refuse to touch. Mirrors
// PHP Node_Names::{COMMAND_INTERPRETER,ROUTER,OUTPUT}.
const PROTECTED_NODES = [ '_command_interpreter', '_router', '_output' ];

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
	remove_node:
		'remove_node <node name> [<more names>...]\nremove_node -a <anchored regex glob>\n    aliases: remove, rm\n',
	list_nodes:
		'list_nodes [ -clst ] [ <node name> ]\nlist_nodes -a [ -clst ] [ <regex glob> ]\n    -c show message counters\n    -l show counters and targets\n    -s show sinks\n    -t show targets\n    -a show all nodes matching regex glob\n    alias: ls\n',
	dump_node: 'dump_node <node name> [<keys>]\n    alias: dump\n',
	dump_config: 'dump_config\n',
	dump_metadata:
		'dump_metadata\n    note: returns a JSON object keyed by node name with `class`, `counter`, `sink`, `target`, `debug_state`, `arguments`.\n',
	debug_state:
		"debug_state [ <node name> [ <level> ] ]\n    no args: toggle this CommandInterpreter's debug_state.\n",
	pwd: 'pwd\n',
	log: 'log <message>\n    note: prints <message> to stderr (server-side debug log).\n',
	dmesg: 'dmesg\n    note: print the recent server-side stderr tail (last 100 lines).\n',
	help: 'help [ <topic> ]\n',
	cd: 'cd [ <path> ]\n    alias: chdir\n',
	status: 'status\n',
	tell_node: 'tell_node <path> <info>\n    alias: tell\n',
	send_node: 'send_node <path> <bytes>\n    alias: send\n',
	send_eof: 'send_eof <path>\n',
	command_node:
		'command_node <path> <verb> [<arguments>]\n    aliases: command, cmd\n',
	request_node: 'request_node <path> [<value>]\n    alias: request\n',
	ping: 'ping <path>\n',
	include: 'include <file>\n',
	uptime: 'uptime\n',
	stats: 'stats [-a] [<regex>]\n    columns: NAME COUNT LGST_MSG READ WRITTEN.\n',
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
export class CommandInterpreter extends Node {
	constructor() {
		super();
		// Per-instance authorize override (tests / special cases); null falls back
		// to the static default, then to the built-in LOCAL-provenance check.
		this.authorize = null;
		this._commands = CommandInterpreter._defaultCommands();
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

	// Register a Node subclass under its shell name for make_node.
	static registerClass( shellName, ctor ) {
		CommandInterpreter.classMap[ shellName ] = ctor;
	}

	/**
	 * Construct a registered Node subclass, name it, sink it to this CI.
	 *
	 * @param {string} type     Shell name registered via registerClass.
	 * @param {string} name     Unique name for the new node.
	 * @param {...*}   ctorArgs Positional constructor arguments.
	 * @return {?Node} Null when the shell-name isn't registered.
	 */
	makeNode( type, name, ...ctorArgs ) {
		const Ctor = CommandInterpreter.classMap[ type ];
		if ( typeof Ctor !== 'function' ) {
			return null;
		}
		const node = new Ctor( ...ctorArgs );
		node.setName( name );
		node.sink = this;
		const level = this.debugState ?? 0;
		if ( level > 0 ) {
			node.debugState = level;
		}
		return node;
	}

	fill( message ) {
		this.counter += 1;
		const type = message[ TYPE ];

		// TM_PING / TM_EOF with empty TO bounce back along FROM (RTT / drain).
		// eslint-disable-next-line no-bitwise
		if ( type & ( TM_PING | TM_EOF ) && message[ TO ] === '' ) {
			message[ TO ] = message[ FROM ];
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}

		// eslint-disable-next-line no-bitwise
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
			Core.stderr( `invalid command struct on ${ this.name }` );
			return;
		}

		// Authorization gate (every command): the browser tier requires the LOCAL
		// provenance taint a Shell stamps on in-process commands. An SSE-injected
		// command routed here lacks it and is refused before dispatch.
		const authorize =
			this.authorize ??
			CommandInterpreter.defaultAuthorize ??
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
		const resp = newMessage();
		// eslint-disable-next-line no-bitwise
		resp[ TYPE ] = TM_COMMAND | kind;
		resp[ TIMESTAMP ] = Core.now();
		resp[ FROM ] = this.name;
		resp[ TO ] = message[ FROM ];
		resp[ ID ] = message[ ID ];
		resp[ KEY ] = message[ KEY ];
		// Response VALUE rides as the { name, payload } object directly.
		resp[ VALUE ] = { name, payload };
		if ( this.sink ) {
			this.sink.fill( resp );
		}
	}

	// ----- built-in verb table (1:1 with PHP $C) ----------------------------

	static _defaultCommands() {
		return {
			make_node: ( self, args ) => self._cmdMakeNode( args ),
			make: ( self, args ) => self._cmdMakeNode( args ),
			pwd: ( self, args, env ) => CommandInterpreter._cmdPwd( args, env ),
			set_sink: ( self, args ) => CommandInterpreter._cmdSetSink( args ),
			connect_node: ( self, args, env ) =>
				CommandInterpreter._cmdConnect( args, env ),
			connect: ( self, args, env ) =>
				CommandInterpreter._cmdConnect( args, env ),
			disconnect_node: ( self, args, env ) =>
				CommandInterpreter._cmdDisconnect( args, env ),
			disconnect: ( self, args, env ) =>
				CommandInterpreter._cmdDisconnect( args, env ),
			remove_node: ( self, args ) => self._cmdRemove( args ),
			remove: ( self, args ) => self._cmdRemove( args ),
			rm: ( self, args ) => self._cmdRemove( args ),
			list_nodes: ( self, args ) => self._cmdList( args ),
			ls: ( self, args ) => self._cmdList( args ),
			log: ( self, args ) => CommandInterpreter._cmdLog( args ),
			dmesg: () => CommandInterpreter._cmdDmesg(),
			dump_node: ( self, args ) =>
				CommandInterpreter._cmdDumpNode( args ),
			dump: ( self, args ) => CommandInterpreter._cmdDumpNode( args ),
			dump_config: () => CommandInterpreter._cmdDumpConfig(),
			dump_metadata: () => CommandInterpreter._cmdDumpMetadata(),
			stats: ( self, args ) => self._cmdStats( args ),
			uptime: () => CommandInterpreter._cmdUptime(),
			debug_state: ( self, args ) => self._cmdDebugState( args ),
			help: ( self, args ) => CommandInterpreter._cmdHelp( args ),
		};
	}

	// `make_node <type> <name> [<ctor_args>...]`.
	_cmdMakeNode( args ) {
		const parts = splitArgs( args );
		if ( parts.length < 2 ) {
			return 'usage: make_node <type> <name> [<ctor_args>...]';
		}
		const type = parts.shift();
		const name = parts.shift();
		const node = this.makeNode( type, name, ...parts );
		return null === node ? `unknown class: ${ type }` : 'ok';
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
		if ( 'function' === typeof src.connectNode ) {
			src.connectNode( target );
		} else {
			// Base node: a single string target (matches PHP Node::connect_node;
			// only Tee overrides to append to a fan-out array).
			src.target = target;
		}
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
			src.disconnectNode( target );
		} else if ( Array.isArray( src.target ) ) {
			// No disconnectNode() on the node (Tee lacks it): remove the target
			// from the fan-out array directly, matching PHP Node::disconnect_node.
			src.target = src.target.filter( ( t ) => t !== target );
		} else if ( src.target === target ) {
			src.target = '';
		}
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
			if ( node === this ) {
				errors.push( 'refusing to destroy interpreter' );
				continue;
			}
			if ( PROTECTED_NODES.includes( name ) ) {
				errors.push(
					`refusing to destroy baseline scaffolding: ${ name }`
				);
				continue;
			}
			Core.unregisterNode( name );
			removed.push( `removed ${ name }` );
		}

		if ( listMatches && 0 === removed.length && 0 === errors.length ) {
			return 'no matches';
		}
		const out = [ ...removed, ...errors ].join( '\n' );
		return '' === out ? 'ok' : out;
	}

	// `list_nodes` (alias `ls`): default=siblings, `-a [glob]`=all, `<name>`=that sink's children.
	_cmdList( args ) {
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
		return CommandInterpreter._tabulate( dirs, header, rows );
	}

	static _cmdLog( args ) {
		Core.stderr( args );
		return '';
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
		const snapshot = CommandInterpreter._nodeSnapshot( node );

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

	static _cmdDumpConfig() {
		let out = '';
		for ( const [ name, node ] of Core.nodes ) {
			if ( PROTECTED_NODES.includes( name ) ) {
				continue;
			}
			if ( 'function' === typeof node.dumpConfig ) {
				out += node.dumpConfig();
			}
		}
		return out;
	}

	// dump_metadata — single-round-trip per-node stats snapshot for the GUI canvas.
	static _cmdDumpMetadata() {
		const out = {};
		for ( const [ name, node ] of Core.nodes ) {
			// Patron-linked nodes are plumbing; the canvas shouldn't render them.
			if ( node.patron !== null && node.patron !== undefined ) {
				continue;
			}
			out[ name ] = {
				class: node.constructor?.name ?? 'Node',
				counter: node.counter ?? 0,
				sink: node.sink && node.sink.name ? node.sink.name : '',
				target: node.target ?? '',
				debug_state: node.debugState ?? 0,
				arguments: node.arguments ?? '',
				lgst_msg: node.largestMsgSent ?? 0,
				bytes_read: node.bytesRead ?? 0,
				bytes_written: node.bytesWritten ?? 0,
			};
		}
		return out;
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
		return CommandInterpreter._tabulate( dirs, header, rows );
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
		return `${ first } debug_state: ${ node.debugState }`;
	}

	// help — no args lists command names tabulated; a topic returns that command's help.
	static _cmdHelp( args ) {
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
				'### SHELL BUILTINS ###',
				'  debug_level [0|1|2]            — local Dumper verbosity',
				'  ping [<path>]                  — TM_PING (RTT measured locally)',
				'  tell <path> <bytes>            — TM_INFO',
				'  send <path> <bytes>            — TM_BYTESTREAM',
				'  send_eof <path>                — TM_EOF',
				'  request <path> <args>          — TM_REQUEST',
				'  cmd <path> <verb> [<args>]     — TM_COMMAND at <path>',
				'### SERVER COMMANDS ###',
				CommandInterpreter._tabulate(
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

	// Build a serializable state snapshot of a node (class header + scalar state).
	static _nodeSnapshot( node ) {
		const snapshot = { class: node.constructor?.name ?? 'Node' };
		for ( const key of Object.keys( node ) ) {
			const val = node[ key ];
			// Match PHP: the sink renders as the sink node's name (not skipped).
			if ( 'sink' === key ) {
				snapshot.sink = val && val.name ? val.name : '';
				continue;
			}
			// Skip live node references and internal structures — display-only scalars.
			if (
				'patron' === key ||
				'interpreter' === key ||
				'registrations' === key ||
				'setStateCache' === key ||
				'_commands' === key ||
				'authorize' === key
			) {
				continue;
			}
			if ( 'function' === typeof val ) {
				continue;
			}
			snapshot[ key ] = val;
		}
		return snapshot;
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
		return `${ clock }  up ${ CommandInterpreter._formatUptime(
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

// shell-name to constructor registry for make_node.
CommandInterpreter.classMap = {};

// Process-wide default authorization policy. The browser leaves it null (the
// built-in LOCAL check applies). Same shape as PHP CommandInterpreter::$default_authorize.
CommandInterpreter.defaultAuthorize = null;
