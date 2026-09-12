# Hub and spoke

Every site writes its own firehose. One site, the hub, copies every other site's firehose into its own; the others are spokes. No spoke knows about any other. The hub is the HTTPS client in both directions, firehose in and signed commands out, so a spoke opens no connection of its own.

![Sequence diagram of one spoke's connection to the hub, with the Vault, the Remote_Source, its two hidden nodes and the spoke as lanes and nine numbered hops from the first credential read through the stream, the command session, the reply gate and the reconnect](img/d07.png)

## Pulling a firehose

[Remote_Source](../includes/class-remote-source-node.php) pulls one spoke's firehose. It is a consumer whose log lives on another site. One topology line declares it, with four arguments: the spoke's Vault id, its firehose partition, an offsetlog directory and a dead-letter directory. On its first tick it reads that Vault entry and builds three hidden nodes named after itself: `:sse-in` holds the stream open, `:http-out` posts one signed batch per tick, and `:null` takes unaddressed replies. Every request carries the hub user's WordPress application password as HTTP Basic auth.

The stream is one [`GET /messages/stream`](API.md#sse-stream) request held open as one long HTTP response, one server-sent event per record; a handshake event names the slot leased to this stream, one of a limited set, and the hub's heartbeat keeps the lease. Each record's ID is its segment, byte offset and length in the spoke's log. The source checkpoints that ID to its offsetlog and resumes from it on every reconnect. A record that will not parse is quarantined at that position, in the dead-letter partition. Above 512 KB buffered, `:sse-in` stops reading the socket and the spoke blocks on write; reading resumes under 256 KB. Silence for 45 seconds is a dead stream, and the source reconnects after a delay that doubles from one second to thirty. At startup the sources connect one every half second, so no spoke answers a burst with refusals.

Before its first batch of commands, `:http-out` posts to [`/auth`](API.md#establishing-a-session) once for a command session, a handle and a key held under the spoke's Vault id; the node that mints a command signs it under the key of the spoke it is bound for. One [`POST /command`](API.md#command-dispatch) per tick carries a heartbeat signed under this key every 15 seconds, and any command a minter routes into the link rides the same batch. Commands queued before the session exists are held, and on a 401 the hub forgets the session.

## The reply gate

The reply rides the same response, and the spoke writes every field of it, TO included. The router delivers whatever TO names, so left alone a spoke could address any node in the hub process. Every outbound node therefore carries [`allow_replies_to`](../includes/class-http-out-node.php): a TO on the list, matched as a whole path, is delivered; any other is dropped; an empty TO goes to `:null`. A source lists its own name so its heartbeat replies reach it.

One declaration bounds both inbound legs, because the spoke writes TO on the stream as freely as on the reply. [`Remote_Link_Node::admit_inbound()`](../includes/class-remote-link-node.php) routes the stream leg: a target overwrites whatever TO the remote wrote, and with no target an addressed message passes only when the `:http-out` sibling's `admit_addressed()` admits it — the same test the reply leg applies, though the reply leg stamps a target only on an unaddressed message. A [`Remote_Source`](../includes/class-remote-source-node.php) relays a firehose rather than a reply, and the record it relays carries no TO of its own — [`Log_Manager::message()`](https://github.com/Automattic/newspack-event-logger-nodes/blob/main/includes/class-log-manager.php) sets TYPE, TIMESTAMP, KEY and VALUE and leaves TO empty — so its override consults no list at all: the `connect_node` line that names its target is its whole declaration, and with none an addressed line is refused outright. The refusal consumes the line: the cursor advances past it as it would past a forward, so a spoke cannot wedge the relay by addressing one record.

## The Vault and the hub user

The [Vault](../includes/class-vault.php) is the hub's store of spokes: an HTTPS URL, a username and a password under each short id. Its tab and the `vault` CI verbs write entries to a WordPress option, the only source. Each password is sealed with [libsodium](https://www.php.net/manual/en/book.sodium.php) under a key derived from the site's auth salt and opened only on the way out, so rotating that salt leaves every stored password unopenable. Workers memoize the Vault for life, so a credential change asks each worker holding a Remote_Source to reload and rebuild its hidden nodes.

The hub logs in to a spoke as a user on that spoke, holding only the hub role, the read and tune capabilities from [Commands, capabilities and sessions](commands-capabilities-and-sessions.md). A stolen hub credential buys one spoke's stream and its logger settings, never its fleet or its credentials.

The settings push to every spoke, discovery, the remote-job rewrite and the live hub's topology belong to the event logger, and [hub-control.md](https://github.com/Automattic/newspack-event-logger-nodes/blob/main/docs/hub-control.md) covers them.

## Read more

- [`architecture-guide.md`](architecture-guide.md#other-node-primitives), the remote reader family under [Other Node Primitives](architecture-guide.md#other-node-primitives)
- [`API.md`](API.md#the-substrate-as-client), the section [The substrate as client](API.md#the-substrate-as-client): what `HTTP_Out` and `SSE_In` send and how each bounds itself
- [`architecture-decisions.md`](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies), [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies), the TO=FROM reply the gate filters
- [`newspack-event-logger-nodes/docs/architecture-guide.md`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/docs/architecture-guide.md#hub-vs-spoke-topology), the section ["Hub vs Spoke Topology"](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/docs/architecture-guide.md#hub-vs-spoke-topology)
- [`newspack-event-logger-nodes/topologies/aggregator.tsl`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/topologies/aggregator.tsl), one `Remote_Source` leg per spoke
