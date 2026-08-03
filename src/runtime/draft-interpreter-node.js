/**
 * DraftInterpreterNode — the console's edit buffer, as an interpreter.
 *
 * Edit mode and live mode send the SAME commands; the difference is which
 * interpreter they reach, which is a cwd. This is the edit-mode one. It differs
 * from the live interpreter in exactly three ways, each deliberate:
 *
 *   1. **`make_node` stubs.** A server topology names `Partition`, `Topic`,
 *      `Consumer`, `Job_Worker` — no JS implementation. A stub carries the
 *      declared class and arguments so every structural verb still applies.
 *   2. **`move_node` rewrites references.** Live it is `$node->name($new)` and
 *      nothing else, stranding every target that named the old node — faithful
 *      to Tachikoma, and indefensible in an editor.
 *   3. **Document verbs.** `var`, `include`, `remove_include` and `secure`
 *      belong to a FILE, not a graph, and touch no node table. `secure` is a
 *      one-way ratchet live, because that irreversibility is the security
 *      property; here it edits a line, both directions.
 *
 * Its nodes live in its own registry, so a draft `firehose` is not the live
 * one. The interpreter itself is registered normally — the Tachikoma Job shape,
 * where the job's node sits in the parent table and its contents do not.
 */

import { CommandInterpreterNode } from './command-interpreter-node';
import { NodeRegistry } from './node-registry';
import { StubNode } from './stub-node';
import { markLocal } from './command-auth';
import { parseStatements } from './shell-node';
import { newMessage, TYPE, VALUE, TM_COMMAND } from './message';

export class DraftInterpreterNode extends CommandInterpreterNode {
	constructor() {
		super();
		// Its CONTENTS live here; it lives where it is named.
		this.childRegistry = new NodeRegistry();
		this.frontmatter = {};
		this.includes = [];
		this.secureLevel = '';
		// Declared command_node lines per node — what the topology SAYS.
		this._invocations = new Map();
		this.commands( {
			var: ( self, args ) => self._cmdVar( args ),
			include: ( self, args ) => self._cmdInclude( args ),
			remove_include: ( self, args ) => self._cmdRemoveInclude( args ),
			secure: ( self, args ) => self._cmdDraftSecure( args ),
			// `cmd` and `command` canonicalise to this in the tokenizer.
			command_node: ( self, args ) => self._cmdCommandNode( args ),
			set_arguments: ( self, args ) => self._cmdSetArguments( args ),
			set: ( self, args ) => self._cmdSetArguments( args ),
		} );
	}

	/**
	 * Run one TSL statement, as the Shell would.
	 *
	 * @param {string} line A single statement.
	 */
	run( line ) {
		for ( const statement of parseStatements( line ) ) {
			const [ verb, ...values ] = statement.values;
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ VALUE ] = { name: verb, arguments: values };
			this.fill( markLocal( m ) );
		}
	}

	/**
	 * Declared verb invocations for a node, in declaration order.
	 *
	 * @param {string} name Node name.
	 * @return {Array} `{ verb, args }` entries; empty when none.
	 */
	invocationsFor( name ) {
		return this._invocations.get( name ) ?? [];
	}

	/**
	 * One statement form, two readings.
	 *
	 * `command_node <node>:config <verb> [args]` is the normal case — the verb
	 * goes to the node's config sidecar. A bare `<node>` target is how an
	 * INTERPRETER-class node takes verbs directly. The tokenizer canonicalises
	 * `cmd` and `command` to `command_node`, so there is nothing else to catch.
	 *
	 * @param {string[]} args Token array after the verb.
	 * @return {string} The reply line.
	 */
	_cmdCommandNode( args ) {
		const [ path, verb, ...rest ] = args;
		if ( ! path || ! verb ) {
			return 'usage: command_node <node>[:config] <verb> [<args>...]';
		}
		const viaConfig = String( path ).endsWith( ':config' );
		const name = viaConfig ? String( path ).slice( 0, -7 ) : path;
		if ( ! this.childRegistry.node( name ) ) {
			return `unknown node: ${ name }`;
		}
		const list = this._invocations.get( name ) ?? [];
		list.push( { verb, args: rest, viaConfig } );
		this._invocations.set( name, list );
		return 'ok';
	}

	/**
	 * `set_arguments <node> [args…]` — rewrite a node's constructor args.
	 *
	 * Tachikoma's verb, aliased `set`, absent here until now: the one real gap
	 * the interpreter parity triage found. An editor rewriting ctor args needs
	 * exactly this, which is a good sign it is the right shape.
	 *
	 * @param {string[]} args Token array after the verb.
	 * @return {string} The reply line.
	 */
	_cmdSetArguments( args ) {
		const [ name, ...rest ] = args;
		if ( ! name ) {
			return 'usage: set_arguments <node name> [<arguments>...]';
		}
		const node = this.childRegistry.node( name );
		if ( ! node ) {
			return `unknown node: ${ name }`;
		}
		node.arguments = rest;
		return 'ok';
	}

	/**
	 * Replace a node's declared invocations wholesale.
	 *
	 * A METHOD, not a verb, and deliberately: `command_node` only appends, and
	 * a topology file has no way to say "forget the previous cmd lines". So
	 * replacement is an editor operation with no TSL spelling, and giving it
	 * one would put a word in the grammar no topology can contain.
	 *
	 * @param {string} name Node name.
	 * @param {Array}  list `{ verb, args, viaConfig }` entries.
	 */
	replaceInvocations( name, list ) {
		this._invocations.set( name, list.slice() );
	}

	/**
	 * Replace the whole document. Loading is not a verb — see DraftContext.
	 *
	 * @param {string} tsl Topology source.
	 */
	load( tsl ) {
		this.frontmatter = {};
		this.includes = [];
		this.secureLevel = '';
		this._invocations = new Map();
		for ( const name of [ ...this.childRegistry.nodes.keys() ] ) {
			this.childRegistry.node( name )?.removeNode();
		}
		this.run( tsl );
	}

	// A class this runtime cannot build is a node to DESCRIBE, not an error.
	_cmdMakeNode( args ) {
		if ( args.length < 2 ) {
			return super._cmdMakeNode( args );
		}
		const [ type, name ] = args;
		if ( CommandInterpreterNode.resolveClass( type ) ) {
			return super._cmdMakeNode( args );
		}
		const node = new StubNode();
		node.registry = this.childRegistry;
		node.shellName = type;
		node.name = name;
		node.arguments = args.slice( 2 );
		node.sink = this;
		node.defaultSink = this;
		return 'ok';
	}

	_cmdRemove( args ) {
		const result = super._cmdRemove( args );
		for ( const name of args ) {
			this._invocations.delete( name );
		}
		return result;
	}

	// Unlike the live verb, references follow the rename.
	_cmdMove( args ) {
		const [ from, to ] = args;
		const result = super._cmdMove( args );
		if ( 'ok' !== result || ! from || ! to ) {
			return result;
		}
		if ( this._invocations.has( from ) ) {
			this._invocations.set( to, this._invocations.get( from ) );
			this._invocations.delete( from );
		}

		for ( const [ , node ] of this.childRegistry.nodes ) {
			if ( Array.isArray( node.target ) ) {
				node.target = node.target.map( ( t ) =>
					t === from ? to : t
				);
			} else if ( node.target === from ) {
				node.target = to;
			}
		}
		return result;
	}

	_cmdVar( args ) {
		// `var name = value`; the tokenizer keeps `=` as its own token.
		const [ name, , ...rest ] = args;
		if ( ! name ) {
			return 'usage: var <name> = <value>';
		}
		this.frontmatter[ name ] = rest.join( ' ' );
		return 'ok';
	}

	_cmdInclude( args ) {
		const name = args[ 0 ] ?? '';
		if ( ! name ) {
			return 'usage: include <topology>';
		}
		if ( ! this.includes.includes( name ) ) {
			this.includes.push( name );
		}
		return 'ok';
	}

	_cmdRemoveInclude( args ) {
		const name = args[ 0 ] ?? '';
		this.includes = this.includes.filter( ( n ) => n !== name );
		return 'ok';
	}

	// Freely reversible here; the live ratchet is a security property.
	_cmdDraftSecure( args ) {
		this.secureLevel = args[ 0 ] ?? '';
		return 'ok';
	}

	/**
	 * The document as TSL — what `serializeTsl` used to build.
	 *
	 * Not `dump_config`, which groups statements per node. A topology file has
	 * a required order, and `secure` must come last or it disables `make_node`
	 * for everything after it.
	 *
	 * @param {string} [baseline] The TSL this document was loaded from. Edges
	 *                            it declared that we no longer do become
	 *                            explicit `disconnect_node` lines — a Tee's
	 *                            `connect_node` APPENDS, so absolute state
	 *                            cannot express a removal.
	 * @return {string} TSL, or '' for an empty document.
	 */
	dumpDocument( baseline = '' ) {
		const lines = [];
		for ( const [ name, value ] of Object.entries( this.frontmatter ) ) {
			lines.push( `var ${ name } = ${ value }` );
		}
		for ( const name of this.includes ) {
			lines.push( `include ${ name }` );
		}
		const edges = [];
		for ( const [ name, node ] of this.childRegistry.nodes ) {
			lines.push( node.dumpConfig().split( '\n' )[ 0 ] );
			for ( const inv of this.invocationsFor( name ) ) {
				const target = inv.viaConfig ? `${ name }:config` : name;
				lines.push(
					[ 'command_node', target, inv.verb, ...inv.args ].join(
						' '
					)
				);
			}
			const targets = Array.isArray( node.target )
				? node.target
				: [ node.target ].filter( Boolean );
			for ( const t of targets ) {
				edges.push( `connect_node ${ name } ${ t }` );
			}
		}
		// A dropped edge needs saying; an added one is just its own line.
		const have = new Set( edges );
		for ( const was of DraftInterpreterNode._connectLines( baseline ) ) {
			if ( ! have.has( was ) ) {
				lines.push(
					was.replace( /^connect_node /, 'disconnect_node ' )
				);
			}
		}
		lines.push( ...edges );
		if ( this.secureLevel ) {
			lines.push(
				'insecure' === this.secureLevel
					? 'insecure'
					: `secure ${ this.secureLevel }`
			);
		}
		return lines.length ? lines.join( '\n' ) + '\n' : '';
	}

	// The `connect_node` lines a TSL source declares, verbatim.
	static _connectLines( tsl ) {
		if ( ! tsl ) {
			return [];
		}
		return parseStatements( tsl )
			.filter( ( st ) => 'connect_node' === st.verb )
			.map( ( st ) => st.values.join( ' ' ) );
	}
}
