<?php
/**
 * Vault_Group_Node: one child node per Vault server in a group.
 *
 * `make_node Vault_Group <name> <child_type> <group> [child args…]` builds
 * `make_node <child_type> <name>:<id> <id> <child args>` for every id
 * `Vault::in_group()` returns, with `{id}` in the child args replaced by the id.
 * Adding a spoke is adding a Vault entry: `update_graph()` runs on the fleet's
 * RELOAD, building new members and retracting departed ones, the way
 * Tachikoma's ConsumerBroker keeps its consumers (ADR-21).
 *
 * The children are published siblings — rename, sink and teardown cascade, and
 * `dump_config` replays only the group — but NOT patroned: each keeps its own
 * `:config` interpreter and draws on the canvas like a hand-written node. The
 * sibling map is the one list of them; `members()` reads it.
 *
 * The group's `:config` answers the CHILD class's verbs: a command reaches
 * every child's interpreter and the reply maps each child's name to its answer,
 * while a refusal from any child throws, naming each one that refused. A
 * command every child accepted and that changed some child's `dump_config()`
 * — configuration, not a read — is recorded, last write winning, replayed to
 * each later child and dumped on the group; so is one sent while the group has
 * no children. A child `toggle` or `setter` verb keeps one record, its latest.
 * A verb sent straight to one child's own `:config` is live-only.
 * `connect_node` and `debug_state` on the group reach every child; a message
 * filled into the group is dropped, since only a fan-out source reaches them.
 * `expand()` spells a child's arguments once, for this node and for
 * Topology_Analyzer's flatten alike.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Keeps one child per Vault server in its group.
 */
final class Vault_Group_Node extends Node {
	use Schema_Reflection;

	/** The placeholder a child argument carries for its Vault id. */
	public const ID_TOKEN = '{id}';

	/** The Vault id no child takes: the group's `:config` interpreter's slot. */
	private const RESERVED_ID = 'config';

	/** Shell type of the children, resolved like any `make_node` type. */
	protected string $child_type = '';

	/** @var class-string<Node> The class `child_type` resolved to. */
	private string $child_class = Node::class;

	/** Vault group whose servers this node keeps. */
	protected string $group = '';

	/** @var list<string> Child argument templates, after the Vault id. */
	private array $child_args = [];

	/** @var list<array{0:string,1:list<string>}> Recorded configuration verbs, in order. */
	private array $commands = [];

	/**
	 * Parse the child type and group, wire the forwarding interpreter, build the
	 * members and subscribe to RELOAD. A replay with other arguments retracts
	 * every child and the interpreter first: the child type, and with it the
	 * verbs, may have changed. The tokens are checked and the child type
	 * resolved before anything is assigned, so a refusal leaves the group as
	 * it was.
	 *
	 * @api Dynamic entrypoint.
	 * @param list<string>|null $args Positional tokens, or null to read them.
	 * @return list<string>
	 * @throws \InvalidArgumentException When the child type resolves to no node class.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$values      = $this->schema_values( $args );
		$type        = Core::as_string( $values['child_type'] );
		$child_class = Command_Interpreter_Node::resolve_class( $type )
			?? throw new \InvalidArgumentException( \esc_html( "Vault_Group: unknown child type {$type}" ) );
		$previous    = $this->arguments;
		$this->assign_schema_args( $args, $values );
		$this->child_class = $child_class;
		$this->child_args  = \array_slice( $args, 2 );
		if ( [] !== $previous && $previous !== $args ) {
			$this->retract_all();
		}
		$this->wire_interpreter( $this->forwarding_verbs() );
		$this->update_graph();
		$this->subscribe( Node_Names::FLEET, 'RELOAD', $this->update_graph( ... ) );
		return $args;
	}

	/**
	 * Drop the message: the group relays nothing, because a command signed for
	 * one spoke verifies at that spoke alone. A fan-out source connected to the
	 * group delivers to each child instead.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		$from = Core::as_string( $message[ Message::FROM ] );
		$type = \implode( '|', Message::type_labels( Core::as_int( $message[ Message::TYPE ] ) ) );
		$this->print_less_often( 'ERROR: Vault_Group relays nothing; connect a fan-out source to it', " (dropped {$type} from {$from})" );
	}

	/**
	 * Tear down every child and the forwarding interpreter, dropping the verbs
	 * they were configured with. A child whose teardown refused keeps its slot,
	 * and so its id, until a later retraction succeeds.
	 */
	private function retract_all(): void {
		foreach ( \array_keys( $this->children() ) as $id ) {
			$this->retract_child( (string) $id );
		}
		$this->retract_sibling( self::RESERVED_ID );
		$this->interpreter = null;
		$this->commands    = [];
	}

	/**
	 * The child class's own verbs, each forwarded to every child. No envelope
	 * rides along, so a live child takes each verb exactly as a later one
	 * replays it. A verb the child declares a `toggle` or `setter` holds one
	 * value, so its record replaces rather than adds.
	 *
	 * @return array<string,callable>
	 */
	private function forwarding_verbs(): array {
		$schema   = $this->child_class::node_schema();
		$settings = [];
		foreach ( Core::arr( $schema['commands'] ?? [] ) as $declared ) {
			if ( \is_array( $declared ) && ( '' !== Core::as_string( $declared['toggle'] ?? '' ) || '' !== Core::as_string( $declared['setter'] ?? '' ) ) ) {
				$settings[ Core::as_string( $declared['name'] ?? '' ) ] = true;
			}
		}
		$verbs = [];
		foreach ( \array_keys( self::verbs_with_handlers( $schema ) ) as $verb ) {
			$by_verb        = isset( $settings[ $verb ] );
			$verbs[ $verb ] = fn ( Command_Interpreter_Node $ci, array $args ): array => $this->forward( $verb, $args, $by_verb );
		}
		return $verbs;
	}

	/**
	 * Build members the group gained and retract members it lost, Tachikoma's
	 * ConsumerBroker `update_graph()`. The Vault memo is current here: the
	 * fleet resets it before announcing RELOAD.
	 *
	 * @api Fleet RELOAD.
	 */
	public function update_graph(): void {
		$wanted = Vault::get_instance()->in_group( $this->group );
		$have   = \array_map( 'strval', \array_keys( $this->children() ) );
		foreach ( \array_diff( $have, $wanted ) as $gone ) {
			$this->retract_child( $gone );
		}
		$new   = \array_values( \array_diff( $wanted, $have ) );
		$built = self::expand( $new, $this->child_args );
		foreach ( \array_diff( $new, \array_map( 'strval', \array_keys( $built ) ) ) as $reserved ) {
			$this->print_less_often( "ERROR: skipping Vault id {$reserved}: ", 'reserved sibling slot' );
		}
		foreach ( $built as $id => [ $tokens ] ) {
			$this->build_child( (string) $id, $tokens );
		}
	}

	/**
	 * Every child a group declares: id => one token list per template list,
	 * each the id followed by its templates. The reserved `config` id declares
	 * none, since the group's interpreter owns that slot.
	 *
	 * @api Topology_Analyzer flattens a group's values and spans through this.
	 * @param list<string> $ids          Vault ids, in order.
	 * @param list<string> ...$templates Template lists carrying `{id}`.
	 * @return array<array-key,list<list<string>>> Keyed by id; PHP keys an all-digit id as an int.
	 */
	public static function expand( array $ids, array ...$templates ): array {
		$out = [];
		foreach ( $ids as $id ) {
			if ( self::RESERVED_ID === $id ) {
				continue;
			}
			foreach ( $templates as $list ) {
				$out[ $id ][] = [ $id, ...\str_replace( self::ID_TOKEN, $id, $list ) ];
			}
		}
		return $out;
	}

	/**
	 * Build, name, configure and wire one child the way `make_node` does. A
	 * refusal skips that id alone, with a rate-limited error naming the
	 * recorded command it refused, if any.
	 *
	 * @param string       $id     Vault id; also the sibling slot.
	 * @param list<string> $tokens The child's argument tokens.
	 */
	private function build_child( string $id, array $tokens ): void {
		$replaying = '';
		try {
			$child = new ( $this->child_class )();
			$this->publish_sibling( $id, $child );
			$child->arguments( $tokens );
			$child->sink( $this->sink );
			$child->debug_state( $this->debug_state );
			foreach ( Node::target_list( $this->target ) as $target ) {
				$child->connect_node( $target );
			}
			foreach ( $this->commands as [ $verb, $args ] ) {
				$replaying = "replaying {$verb} " . self::serialize_args( $args ) . ': ';
				$child->interpreter()?->dispatch( $verb, $args );
			}
		} catch ( Worker_Should_Stop $e ) {
			throw $e;
		} catch ( \Throwable $e ) {
			$this->print_less_often( "ERROR: skipping Vault id {$id}: ", $replaying, $e->getMessage() );
			$this->retract_child( $id );
		}
	}

	/**
	 * Retract one child's slot, handing its cursor off first as an operational
	 * stop does. A failure is logged, never raised into the drain loop, and
	 * leaves the child in its slot, still a member.
	 *
	 * @param string $id The child's Vault id.
	 */
	private function retract_child( string $id ): void {
		try {
			( $this->siblings()[ $id ] ?? null )?->hand_off_cursor();
			$this->retract_sibling( $id );
		} catch ( Worker_Should_Stop $e ) {
			throw $e;
		} catch ( \Throwable $e ) {
			$this->print_less_often( "ERROR: retracting Vault id {$id}: ", $e->getMessage() );
		}
	}

	/**
	 * Dispatch one verb to every child and answer with each child's reply. Every
	 * child is attempted, a stop included (ADR-14); after the loop the stop
	 * `outranks()` keeps is raised, else a refusal from any child throws,
	 * naming each child that refused. Record the command when every child took
	 * it and it changed some child's configuration, or when there is no child
	 * yet. It replaces every earlier record of the verb when $by_verb, and of
	 * an identical command otherwise, so the last write wins on replay.
	 *
	 * @param string                 $verb The child verb.
	 * @param array<array-key,mixed> $args    Its argument tokens.
	 * @param bool                   $by_verb Whether the verb holds one value.
	 * @return array<string,mixed> Child name => that child's answer.
	 * @throws Worker_Should_Stop When any child raised a stop.
	 * @throws \RuntimeException When any child refused the verb.
	 */
	private function forward( string $verb, array $args, bool $by_verb ): array {
		$tokens   = \array_values( \array_map( static fn ( $arg ): string => Core::as_string( $arg ), $args ) );
		$children = $this->children();
		$answers  = [];
		$refusals = [];
		$stop     = null;
		$changed  = [] === $children;
		foreach ( $children as $child ) {
			$before = $child->dump_config();
			try {
				$answers[ $child->name() ] = $child->interpreter()?->dispatch( $verb, $tokens );
			} catch ( Worker_Should_Stop $e ) {
				$stop = Worker_Should_Stop::outranks( $e, $stop ) ? $e : $stop;
				continue;
			} catch ( \Throwable $e ) {
				$refusals[] = \esc_html( $child->name() ) . ': ' . $e->getMessage();
				continue;
			}
			$changed = $changed || $before !== $child->dump_config();
		}
		if ( null !== $stop ) {
			throw $stop;
		}
		if ( [] !== $refusals ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- each child's refusal arrives escaped.
			throw new \RuntimeException( \implode( '; ', $refusals ) );
		}
		if ( $changed ) {
			$command        = [ $verb, $tokens ];
			$this->commands = [ ...\array_filter( $this->commands, static fn ( array $recorded ): bool => $by_verb ? $recorded[0] !== $verb : $recorded !== $command ), $command ];
		}
		return $answers;
	}

	/**
	 * Set every child's target along with the group's own.
	 *
	 * @param string $target Path stamped into an empty TO.
	 */
	public function connect_node( string $target ): void {
		parent::connect_node( $target );
		foreach ( $this->members() as $child ) {
			$child->connect_node( $target );
		}
	}

	/**
	 * Clear every child's target along with the group's own.
	 *
	 * @param string $target The entry to remove.
	 */
	public function disconnect_node( string $target = '' ): void {
		parent::disconnect_node( $target );
		foreach ( $this->members() as $child ) {
			$child->disconnect_node( $target );
		}
	}

	/**
	 * Set the trace level on the group and every child, as `make_node` hands
	 * its own to each node it builds.
	 *
	 * @param int|null $level New level (null = pure getter).
	 * @return int The level now in force.
	 */
	public function debug_state( ?int $level = null ): int {
		$state = parent::debug_state( $level );
		if ( null !== $level ) {
			foreach ( $this->members() as $child ) {
				$child->debug_state( $state );
			}
		}
		return $state;
	}

	/**
	 * The children, in the order the group built them.
	 *
	 * @return list<Node>
	 */
	public function members(): array {
		return \array_values( $this->children() );
	}

	/**
	 * The children by Vault id, in the order the group built them: every
	 * published sibling but the interpreter's slot.
	 *
	 * @return array<array-key,Node> PHP keys an all-digit id as an int.
	 */
	private function children(): array {
		$children = $this->siblings();
		unset( $children[ self::RESERVED_ID ] );
		return $children;
	}

	/**
	 * The group's line, its target, then every recorded verb in order.
	 *
	 * @return string Newline-terminated TSL lines.
	 */
	public function dump_config(): string {
		$out = parent::dump_config();
		foreach ( $this->commands as [ $verb, $args ] ) {
			$out .= $this->config_line( $verb, ...$args );
		}
		return $out;
	}

	/**
	 * Palette entry and configuration form: the child type and the group. Every
	 * later token is a child argument template, which the schema cannot declare
	 * as a list; the verbs are the child class's, so none are declared here.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'One child per Vault server in a group; forwards config verbs and edges to each, and follows the Vault on reload.',
			'arguments'   => [
				[ 'name' => 'child_type', 'type' => 'string', 'required' => true, 'description' => 'Node type built once per server, e.g. HTTP_Out or Remote_Source; each child is named <name>:<vault id>.' ],
				[ 'name' => 'group', 'type' => 'string', 'required' => true, 'description' => 'Vault group whose servers become children. Later tokens are child arguments after the vault id, with {id} replaced by it.' ],
			],
			'commands'    => [],
		];
	}
}
