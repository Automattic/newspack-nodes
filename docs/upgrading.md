# Upgrading

Breaking changes that affect a plugin built on the substrate — topology files, Node subclasses, job handlers, dashboards, the wire — with the fix beside each. Start at your installed version and apply everything above it. Internal refactors and fixes are not listed; [CHANGELOG.md](../CHANGELOG.md) has the full story per release.

**Maintenance rule:** a release that changes any consumer-facing contract adds its entry here in the same commit as its CHANGELOG entry. No entry means nothing to do.

## Unreleased

- **`LogStreamViewer` takes no `hasKeyColumn` prop.** Its debug row is always
  ID, KEY and VALUE; a dashboard wanting other debug columns passes its own
  `renderDebugRow` and `renderDebugHeader`.
- **`/messages/stream` refuses every subscription it cannot open before it
  takes a slot.** A name the stream's guard refuses, such as
  `offsets/Kea-1`, answers `400 sse_subscription_invalid` with its
  `invalid subscription: <sub>` message rather than failing after the
  event-stream headers.
- **The Partition Viewer is the Log Viewer.** The station tab is `?tab=log-viewer`
  (old `?tab=partition-viewer` links land on the default tab), its nodes are
  `log-viewer:*`, its view class is `LogViewerViewNode` (`LogViewerView`), and its
  hook is `useLogViewerGraph`. It lists partition dirs and `sources/<name>`
  registry files in one picker. Each viewer's saved column choice and rail fold
  reset once.
- **`HTTP_In_Node::$clock_now_seam` and `HTTP_In_Node::$rate_limit_disabled`
  are gone.** `/command` meters through `Rate_Limit::claim()` in the shared
  cache, so a test that set either assigns an `InMemoryMemcached` to
  `Core::$memd` instead and pins its `clock` to move the window. A door of
  your own meters through `Rate_Limit::claim()` rather than a transient
  counter, and maps `Rate_Limit::UNAVAILABLE` itself: refuse, or
  `Rate_Limit::admit_unmetered()`.
- **`Curl_Node`'s `vault_id` positional is `vault_group`.** `make_node Curl
  <name> <vault_id>` becomes `make_node Curl <name> <vault_group>`, naming a
  Vault group in place of one entry: put the entry in a group, through the
  Vault tab or `vault update <id> --group=<group>`, and name the group. Each
  fetch's VALUE must be an absolute http(s) url, so rewrite a `/path` VALUE as
  the entry's url plus that path. A url on no group entry's origin is fetched
  with no `Authorization`, so a topology that leant on `url outside vault
  origin` to fence its fetches to one host filters them upstream. A url on two
  entries' origin is refused naming both. Match the TM_ERROR
  `vault entries <id>, <id> share origin <origin> <url>` in place of
  `no vault entry <id>`, `no url for vault entry <id>` and
  `url outside vault origin <url>`, which are gone.
- **`Crawler_Node`'s `vault_id` positional is `vault_group`.** `make_node
  Crawler <name> <ttl> <vault_id> …` becomes `make_node Crawler <name> <ttl>
  <vault_group> …`, with the group named as for `Curl_Node`.
- **`Crawler_Node`'s `set_delay_ms` and `set_concurrency` verbs are removed,
  and so is its `{name}:config` interpreter.** Set `delay_ms` and
  `concurrency` on the `make_node` line, and delete any `cmd
  <crawler>:config set_delay_ms` or `set_concurrency` line, which names no
  node.
- **A crawler answers a seed it has already seen.** Target receives a TM_INFO
  `already seen <url>` keyed by the url, so a consumer reading the crawler's
  output by TYPE tells it from a body (TM_BYTESTREAM), a redirect
  (TM_RESPONSE) and a failure (TM_ERROR). A seed whose `ADD` the crawler's
  `{name}:seen` Table refuses or leaves unanswered answers a TM_ERROR
  `ADD to <name>:seen failed <url>`, also keyed by the url, and is not
  fetched; send it again once the Table answers.
- **`Curl_Node` refuses a url carrying userinfo.** `https://user@host/`, and
  any url whose authority holds an `@`, answers the TM_ERROR
  `invalid url carrying userinfo` and is not fetched. Put the credential in a
  Vault entry on the url's origin and name its group.
- **`remove_node` and `move_node` refuse an owned sibling.** A node another
  node published — a Crawler's `{name}:seen` Table, a `Vault_Group` child, a
  `:config` interpreter — answers `refusing to destroy owned node: <name>,
  owned by <owner>` among `remove_node`'s results, and `move_node` throws
  `refusing to rename owned node: <name>, owned by <owner>`. Remove or rename
  the owner, which carries every sibling with it. To drop one `Vault_Group`
  child, take its entry out of the group through the Vault,
  `vault update <id> --group=`, and the group retracts the child on the next
  reload. A script or topology that removed or renamed such a node directly
  does it through the owner or the Vault instead.
- **A `vault_group` argument renders a picker in the topology console.** A
  plugin declaring a Vault group argument types it `vault_group`, as
  `Vault_Group_Node`'s `group` does; `useVaults()` entries carry `group`.
- **A reply settles a `Fetcher` ask by its path AND its echoed arguments.**
  A reply echoing `VALUE.arguments` settles the ask with its remaining TO as
  the path and exactly those tokens; one echoing none settles the first ask
  on its path, as every reply did before. So a reply to a different question
  on the same address, such as a send minted straight from the receiver,
  settles nothing.
- **`FetcherNode#isAsking( path )` is removed.** Read `answers( reply )` to
  judge whether a reply is still wanted, `asks( path, args )` for whether a
  question stands, or `fetcher.outbox.some( ( ask ) => ask.path === path )` to
  know whether a subject still waits.
- **Every `addSliceFetcher` slice is gated.** It inserts a `Current` gate named
  `<receiver>:current` ahead of the transform or view, so delete any node that
  compares a reply's arguments to the Fetcher's `outbox`. The receiver Tee's
  first target is the gate, not the transform or view. A transform no longer
  sees a TM_ERROR, which the gate sends to the view, so delete a transform's
  own pass-through. A send minted straight from a slice's receiver reaches its
  view only when the Fetcher asked the same question; mint it from a receiver
  of its own. Ask a question at once with `fetcher.askNow( args )` rather than
  `send( args, path, true )` followed by a trigger, and pass no path when the
  arguments identify the question.
- **`Cache_Backend::move_salt()` is public.** It rotates the cache salt
  without asking the fleet to restart, for a process no worker serves, such as
  a consumer's test suite flushing its own keys between tests. `rotate_salt()`
  is unchanged. A consumer that calls `move_salt()` needs this release.
- **The TLS posture moved from `HTTP_Out_Node` to `Vault`.**
  `HTTP_Out_Node::verify_ssl()` is now `Vault::verify_ssl()`,
  `HTTP_Out_Node::require_ssl()` is now `Vault::require_ssl()`, and
  `HTTP_Out_Node::https_required( $url )` is now `Vault::https_required( $url )`.
  Each reads the same `vault_verify_ssl` / `vault_require_ssl` setting as
  before; the old names are gone, so rename every call. Build a transfer's
  verify opts with `Vault::tls_opts()`, and read a server's url with
  `Vault::url_of( $entry )`.
- **The Event_Framework owns every cURL transfer.** Start one with
  `Event_Framework::instance()->start_curl( $owner, $opts, $context )`, which
  makes the handle, attaches it and returns it, or null. The owner implements
  `Curl_Owner`, and its `on_curl_done( $handle, $result, $context )` is called
  for CURLMSG_DONE alone, the handle released after it returns.
  `on_curl_message( $info )` is gone; so are `SSE_In_Node::$curl_dispatch` and
  `HTTP_Out_Node::$curl_dispatch`, replaced by the one
  `Event_Framework::$curl_dispatch`. `register_curl_easy( $owner, $easy,
  $context )` now takes the context too, and `handles_of( $owner )` and
  `release_curl( $owner )` are new. `HTTP_Out_Node::MAX_REPLY_BYTES` still
  resolves, declared by the `Curl_Transfer` trait.
- **`SSE_In_Node::configure()` takes TLS opts, not a flag.** Its seventh
  argument is the `Vault::tls_opts()` array where it was the `verify_ssl`
  bool.
- **`Schema_Reflection` supplies `arguments()`.** It runs the tokens through
  `parse_schema_args()` and stores them. A node whose override only did that
  can delete it; an override that derives state still wins over the trait's.
  A node using the trait with no override now stores its tokens through the
  trait, which for a node declaring no arguments is what `Node::arguments()`
  did.

- **`Admin::scale_chip_classes()` is new.** Pyrobase and nuclear-gyrobase
  call it, so each declares a 2.87.0 floor (nuclear) or deploys with it
  (pyrobase). Nothing to change in your plugin unless it styles an ordered
  chip: pass a weight map and put the returned `np-scale-chip--N` class on the
  chip.
- **`applyComposeFields` is gone from `@newspack-nodes/runtime`.** The Compose
  modal mints its own message, so nothing stamps envelope fields onto a Shell
  statement any more. Set FROM, ID, KEY and TIMESTAMP on a message you mint
  yourself, then sign it with `markLocal()`. `OutgoingGateNode.beforeSend` is
  gone with it; its observe-only `onForward` tap is told each forwarded
  message and must not mutate it.
- **`signCommand( message, keepTimestamp )` and `markLocal( message,
  keepTimestamp )` can keep a forged TIMESTAMP.** Without the flag, signing
  stamps the server-aligned now, as before; with it, the TIMESTAMP the message
  carries is signed as forged, and one PHP would not call numeric leaves the
  command unsigned. `ShellNode.envelope()` returns that decision for its
  caller to pass on. The runtime clock stays local: `Core.now()` and
  `newMessage()` never carry the session's offset. `isCommandAsk()` and
  `isRequestCommand()` join the barrel: the first judges a command by TYPE
  alone, the second whether it can be signed.
- **`topicprobe.p0` carries Partition records beside Consumer records.** A
  Partition record leaves `Probe_Record::READER` blank and fills `SOURCE` with
  the log's SSE stamp: bare for a `logs/` dir (`ingest.p0`), `{group}/{dir}`
  under `offsets/` or `deadletter/`, and the path under the runtime base
  elsewhere (`ipc/<worker-id>/output`). A Consumer record's SOURCE stays the
  basename. A Partition record also fills the end pair, `END_BYTES` (8) and
  the new `END_DISK_BYTES` (12); every other slot is 0. A Consumer record
  writes 0 at `END_BYTES` and `END_DISK_BYTES`, and a Consumer with no
  offsetlog sends no record. A reader that assumed every record names a READER
  skips a blank one; a reader of `END_BYTES` off a Consumer record reads the
  Partition record for the log it tails, whose SOURCE is the Consumer's own
  for a `logs/` partition. A record is thirteen slots, so a test counting
  twelve counts thirteen.
- **`Consumer_Node::lag_of()` and `compute_lag()` no longer answer
  `end_bytes`.** Read `Partition_Node::probe_stats()[ Probe_Record::END_BYTES ]`.
- **`get_segments()` skips a segment whose `stat()` fails,** one retention
  deleted between `scandir` and `stat`, where it listed it at size 0. Read a
  log's byte length and allocated disk through `Partition_Node::footprint()`.
- **`Sqlite_Arm::file_sizes()` answers `file => [ 'bytes' => …, 'disk' => … ]`**
  where it answered `file => bytes`. Sum `array_column( $sizes, 'bytes' )`.
  `Tablestats_Record` gains `FILE_DISK_BYTES` (7), null off SQLite.
- **`topic-probe.tsl` declares `topicprobe.p0` with 16 MiB segments**
  (`16777216 2 8 0 86400 86400`), sized for a day of both record kinds. A
  topology of your own that declares `topicprobe.p0` with the old
  `1048576 2 8 0 86400 86400` now conflicts with every `include topic-probe`
  at activation; `include topic-probe` instead.
- **`Partition_Node::read_tail_frames_by()` takes `$max_bytes` with no
  default.** Name the window; `CLI::PROBE_TAIL_BYTES` (512 KiB) is the status
  tail's.
- **The `Partition_Node::write_quarantine_key()` seam is the public
  `identity_path()`.** A subclass overriding it renames the override and makes
  it public; its path under the runtime base names the log's Partition record.
- **A probe record's FROM is `<worker-id>/<probe>`.** `topicprobe.p0`,
  `jobstats.p0` and `tablestats.p0` records carry `job-worker.p2/jobstats` where
  they carried the bare `jobstats`. A probe with no topology or no canonical
  partition bound refuses its arguments, so `make_node` answers a TM_ERROR; a
  test builds one as a worker does — `Core::$var['topology']` and
  `Core::$var['partition']` bound, a `_router` standing — and hands it its
  arguments before it fires. A reader that matched FROM exactly matches its last
  segment, and one that needs the worker reads the segment before it through
  `parseWorkerId()`.
- **A log dir named `logs`, `offsets` or `deadletter` cannot be streamed.** Its
  bare stamp would read back as a group prefix, so `/messages/stream` refuses
  the subscription naming the dir. Rename the Partition's directory.

- **`Ledger_Node` is gone, with `Bootstrap::mount_ledger()`, `Table_Client`'s
  `append()`, `sum()`, `top()` and `ledger_members()`, `Consumer_Node`'s
  `settle()` hook and the `Tick_Housekeeper` interface.** A topology
  declaring `make_node Ledger` no longer loads. Move its data to Tables.
  newspack-event-logger-nodes 0.113.0 already has. Under the fleet hold,
  delete `{base}/ledgers/` and every file in it: nothing reads them.

- **`Table_Node::purge_and_checkpoint()` is `Table_Node::tick()`.** The Router's
  tick calls it for every Table; it purges, checkpoints and writes a traced
  Table's trace line. Call `Table_Node::tick( $now )` where you called
  `Table_Node::purge_and_checkpoint( $now )`; no alias remains.
- **A cli process's reply address is `_output/_cli:<pid>/<reply-node>`.** The
  attached REPL stamps FROM `_output/_cli:<pid>/_output`, where it stamped
  `_output/<pid>`. A consumer reading a REPL command's FROM, or minting a
  command whose reply a `wp nodes cli` session must receive, uses
  `CLI::reply_head( $pid ) . '/<reply-node>'`; a reply addressed the old way
  reaches no session. `HTTP_Filter_Node`'s constructor takes the prefix it
  gates on,
  `new HTTP_Filter_Node( HTTP_Filter_Node::head( Node_Names::SSE, $handle ) )`,
  where it took the handle alone, and passes a broadcast only to its target.
  `CLI::open_channel()` takes the session as a fourth argument, the process
  pid, and returns the gate third; set a target on that gate to receive a
  worker's broadcasts.
- **A worker slot has one state word everywhere: `live`, `stale`, `held`,
  `idle` or `down`.** A `workers dump_graph` `workers[]` row carries `state`
  where it carried `status` (`running`/`dead`) and the booleans `live`,
  `stale` and `idle`; read `'live' === row.state` where you read `live` or
  `'running' === status`, and `'stale' === row.state` or `'idle' === row.state`
  for the other two. The shared status-badge classes follow the word:
  `.running` is `.live`, `.dead` is `.stale` or `.down`, and `.held` joins
  `.idle`. The `aggregator probe` roll-up counts
  `{ total, live, stale, held, idle, down }` in place of `dead`.
  `CLI::worker_state()` is gone: classify a pass with
  `$cli->worker_states( $worker_ids, $topologies, $leftovers )`, which
  answers each id's lock row and state against the active set you read with
  `Bootstrap::get_topologies()`, and every other lock dir after them when
  `$leftovers` is true. `CLI::slot_ids( $topologies )` spells the slots.
  `Workers_CI_Node::collect_dump_metadata( $topologies, $active )`, `$active`
  the pair `Bootstrap::split_readable( $topologies )` answers, and
  `Log_Cleaner::declared_log_partitions( $readable )` take the set their
  caller read. A lock dir with no heartbeat reads `live` inside
  `Lock_Node::ORPHAN_GRACE_S` and `stale` past it.
- **`LRU_Cache::with_timed_rotation()` takes the clock its windows close on.**
  The third argument, `?\Closure $clock`, returns float seconds; null keeps
  the wall. An owner replaying a stream passes the stream's clock, and the
  grid, the gap a restore repays and the boundary `get_state()` carries are
  all on it, so arm it before `restore_state()` as before. A clock reading 0
  has no time yet: the grid arms on its first positive reading, by `set()` or
  `rotate_if_due()`. Nothing changes for a caller passing two arguments. A
  consumer that passes a clock raises its `version_at_least()` floor to
  2.79.1, because an older substrate drops the third argument without a word
  and rotates on the wall. An owner clock that steps back more than a whole
  window re-anchors the grid on it.
- **`on_evict` takes `?float $due` where it took `bool $timed`.** A timed
  eviction hands the grid boundary its window fell due at; a full bucket hands
  null. A callback declaring `bool $timed` raises a `TypeError` on the first
  capacity eviction: declare `?float $due` and test `null !== $due` where you
  tested `$timed`. A callback reading neither may keep two parameters.
- **`Capabilities::require()` is gone.** A verb needs no gate of its own:
  declare its `capability`, and `dispatch()` refuses a caller below it. Code
  outside a verb that must refuse calls `Capabilities::require_verb( $role )`,
  which asks `can()` where a user is logged in and the session's scope alone
  where none is; code that only tests calls `can()`.
- **`SSE_Slot_Pool::user_id()` is `Core::current_user_id()`.**
- **A session listing row has no `live` or `state`.** `sessions list`,
  `Sessions::listing()` and `wp nodes session list` answer
  `{ handle, label, scope, created, expires }`, and only for a session whose
  store row still stands; a revoked, flushed or lapsed session is simply absent.
  A client reading `live` or matching `state` drops that read. A store read that
  fails throws `Session_Store_Unavailable` where it listed every row dead.
- **Re-mint every command session minted before this release.** A session row
  now carries its label and when it was minted, and a row without both is no
  session, so every key minted by 2.79.0 stops verifying: a dashboard re-auths
  on its own, and an MCP client needs a fresh `wp nodes session issue`. The
  listing reads an index in the session Table, not the `newspack_nodes_sessions`
  option, which nothing reads now; `wp option delete newspack_nodes_sessions`
  removes it.
- **`Sessions::all()` and `Sessions::handles_labelled()` are gone.** Read
  `Sessions::listing()`, whose rows carry the `handle`; filter it by `label`
  for a label's handles. `Sessions::OPTION` and `Sessions::MAX_ROWS` are gone
  with the option: no count caps the labelled sessions.
- **`load_session_record()` answers `ttl`, not `expires`.** Read
  `$record['ttl']`, the whole seconds the session's row has left, where you
  subtracted the clock from `expires`. `key`, `scope` and `user` are unchanged;
  `label` and `created` join them. A handle that is not 32 lowercase hex digits
  answers null without a read.
- **`Command_Auth::live_handles()` and `flush_sessions()` are gone.** Resolve
  many handles with `load_session_records( $handles )`, whose keys are the live
  ones; empty the store with `Command_Auth::session_table()->flush()`.
- **`Table_Node::entry_key()` is `Cache_Backend::entry_key()`.** It is a volatile
  arm's key; a durable arm answers `row_key( $key )` over the namespace it
  holds, and `Sqlite_Arm::entry_key()` and `Wpdb_Arm::entry_key()` are gone.
  `new Sqlite_Arm( $path, $namespace, … )` takes the Table's namespace second.
- **A `wpdb` Table keys its rows by the bare key.** Its `namespace` column
  already scopes each row, so a row a `wpdb` Table wrote as `{namespace}:{key}`
  is unreachable and expires on its TTL. Command sessions were already stored
  under the bare handle and survive; no stock topology in any Newspack plugin
  declares a `wpdb` Table.
- **`dispatch()` gates every verb by the role its schema declares (ADR-26).**
  A `:config` verb on your node that declares no `capability` now demands
  MANAGE, where it demanded nothing; a READ or TUNE session reaching it in a
  worker is refused `permission denied: manage capability required`. Declare
  `'capability' => Capabilities::READ` on a verb that only reports, and `TUNE`
  on one a tune session has a reason to call. Delete any role check inside a
  handler: `Service_CI_Node::require_manage_options()` is gone, and calling it
  is an `Error`. Nothing reads `Command_Interpreter_Node::$required_capability`
  any more; assigning it is a dynamic property.
- **Tests that dispatch as a REST request must log a user in.** Where no user
  is current, `Capabilities::require_verb()` reads the session's scope alone,
  so an unscoped command runs at MANAGE whatever the capability map says. A
  test asserting a refusal from missing capabilities sets a nonzero current
  user id, as the substrate's `VerbHarness::fire()` does (`REQUEST_USER`). A
  test calling a handler out of `commands()` bypasses the gate entirely; call
  `dispatch()`.
- **`stats reset` on a Table is `reset_stats`.** `stats` takes no argument and
  declares `read`.
- **A structured request declares `'value' => 'struct'`.** A `requests` entry
  whose VALUE is a structure says so; the console no longer infers
  `TM_REQUEST|TM_STRUCT` from one `json` argument, so an undeclared entry sends
  its argument as a word.
- **`Sessions::record()` and `Sessions::forget()` are gone.** Call
  `Sessions::issue( $label, $scope, $ttl )`, which mints and lists in one step
  and returns the mint, in place of `Command_Auth::mint_session()` followed by
  `record()`; call `Sessions::revoke( $handle )` in place of `forget()`. It
  returns nothing, and throws `\RuntimeException` where `forget()` answered
  `false` (no session held the handle) or `null` (the store did not answer).
- **Re-mint every command session.** Sessions live in a durable wpdb Table
  (`nodes-sessions` in `{base_prefix}newspack_nodes_table`), not the cache, so a
  session minted before this release no longer verifies: a dashboard re-auths on
  its own, and an MCP client or script holding a `handle.secret` bearer mints a
  new one (Settings → Nodes, Sessions tab, or `sessions create`). A site whose
  `$wpdb` cannot create or write that table cannot mint, and says why.
  `wp nodes memcache flush` no longer signs sessions out; `wp nodes tables flush
  nodes-sessions` does. `Command_Auth::store_session()` is gone. A consumer
  suite that mints a session needs a `$wpdb` that runs SQL: its bootstrap
  requires the substrate's `tests/Helpers/WpdbStub.php` and
  `tests/Helpers/SqliteWpdb.php` and installs a `Sqlite_Wpdb`, extending it for
  any method its own code calls — event-logger-nodes adds `esc_like()` and
  `get_col()` — or one test calls `TestCase::use_wpdb()`. The substrate's
  `TestCase::tearDown()` puts the booted `$wpdb` back after every test.
- **Durable Tables restart empty.** A durable Table's keys carry no salt — a
  `sqlite` Table keys its rows `{namespace}:{key}` — so every row written under
  the salted key before this release is unreachable: event-logger-nodes' flame
  stats, URL index and search sets rebuild from new traffic, and the orphaned
  rows expire on their TTL and the tick's purge reclaims them. Code that wrote a
  durable row through `Table_Node::entry_key()` writes through the Table instead.
- **`cmd <table>:config get` and `rm` are gone.** Send the requests:
  `request_node <table> GET <key>` and `request_node <table> RM <key>…`.
  `Table_Node::rm()` is gone too; call `forget()`.
- **`MSET`, `ADD` and `SADD` declare one `json` arg, `map`,** where they
  declared none; a reader of `node_schema()['requests']` sees it.

- **A consumer suite extending the substrate's `Tests\TestCase` names its own
  base in `NEWSPACK_TEST_BASE_DIR`.** Its `tests/bootstrap.php` sets the env
  var before loading anything — `<tmp>/<slug>-test-<pid>`, one per process —
  and its baseline test config reads `base_directory` from it. The substrate
  bootstrap keeps a base already named, and `TestCase::tearDown()` restores the
  `LOCAL_NEWSPACK_NODES_CONF` captured on the first setUp, so the consumer stays
  on its own config and base; the base is the consumer's to remove.
- **Release nodes 2.77.0, event-logger-nodes 0.111.0 and intelligence 0.12.0
  together, and deploy them together.** The binder below hands every
  schema-declared verb its arguments by name, and the two consumers' released
  handlers read tokens, so there is no order in which updating one plugin at a
  time works, and no compat path bridges it. A host that updates only one of
  the three sees these fail until the other two land:
  - nodes alone — event-logger-nodes 0.110.0's Performance verbs (`overview`,
    `urls`, `dump_url`, `url_breakdown`, `search_requests`, `grep_requests`,
    `dump_request`, `ask`, `set`) and `rules delete` answer
    `Call to undefined method Newspack_Nodes\Command_Args::parse()` or
    `Service_CI_Node::require_option_int()` as a TM_ERROR, and
    `request-builder:config set_inflight_target` reads no argument; intelligence
    0.11.0's source verbs (`add_repo`, `add_url`, `set_vault_id`,
    `set_config_version`) and LLM config verbs (`set_api_url`, `set_vault_id`,
    `set_model`, `set_feature`, `add_profile`) read an empty argument, so each
    stores a blank or refuses.
  - event-logger-nodes 0.111.0 or intelligence 0.12.0 alone — the plugin's
    `version_at_least( '2.77.0' )` floor fails against nodes 2.76.0, and it
    stays dormant behind its admin notice, with its verbs and workers down.

  Put all three zips on the host, then restart the workers once.
- **A verb whose schema declares `args` receives them bound, by NAME.**
  `Command_Interpreter_Node::dispatch()` binds the tokens against the declared
  `args` before the handler runs — a service CI's verbs and every `:config`
  verb alike
  ([ADR-25](architecture-decisions.md#adr-25-a-verbs-arguments-are-bound-by-its-schema)).
  The handler is still
  `( Command_Interpreter_Node $interpreter, array $args, array $envelope = [] )`,
  but `$args` is `array<string,mixed>`: one key per declared arg, in declared
  order, holding its typed value (`int`, `float` and `bool` coerced, every
  other type a string), null for an absent optional with no `default`, the
  `default` where one is declared (a `<ns:key>` token default resolved and
  typed), or a list of typed members for an arg declaring
  `'variadic' => true`, which a producer fills by position or by repeating
  `--name=`. Rewrite each handler to read `$args['<name>']` through
  the `Core` coercions, and delete its parsing:
  - `Command_Args::parse()` is gone, and so is the browser's
    `parseCommandArgs()`; `Command_Args::format()` and `formatCommandArgs()`
    stay.
  - `Service_CI_Node::split_first_token()` is gone: declare the blob as its own
    arg (`[ name, body ]`) and read both by name.
  - `Service_CI_Node::require_option_int()` is gone: declare the arg
    `'type' => 'int'`, and the binder refuses a malformed token as
    `<name> wants a whole number, got '<token>'`. Check a bound you need beyond
    non-negative — `> 0`, a ceiling — in the handler.
  - A hand-rolled unknown-option, missing-argument or arity refusal is the
    binder's now; delete it, and match the binder's wording in tests:
    `missing required argument: <name>`, `unknown option --<name>; this verb
    takes --<a>, --<b>`, `too many arguments: <n> given, <m> accepted`, `--<name> given
    twice`, `<name> given both by position and as --<name>`, and
    `--<name> needs a value: write --<name>=<value>`. Each is an
    `\InvalidArgumentException`, not a `\RuntimeException`.
  - Fix any declaration that disagrees with its handler: an arg read as
    required declares `'required' => true`; a list of trailing positionals
    declares its arg `variadic`; an int declares `'type' => 'int'`.
  - A `toggle` or `setter` verb must declare its one arg; one declaring none
    throws `\LogicException` when its node wires its `:config` interpreter.
  - A test that calls a handler closure straight off `commands()` with a token
    list now hands it raw tokens where it expects names; go through
    `$interpreter->dispatch( '<verb>', [ …tokens ] )`, or pass the bound shape.
  - A producer sending an option the verb does not declare, or one token too
    many, is refused where it was ignored. Name every arg the schema declares
    and nothing else.
  - A `secret` arg must be named: `<name> must be named: write --<name>=<value>`.
  - A `bool` arg refuses a word outside `1`, `true`, `yes`, `on`, `0`, `false`,
    `no` and `off`, as a `make_node` bool positional now does too.
  - A blank for a `required` arg is `missing required argument: <name>`. A
    setter that clears its property on a blank declares its arg optional.
  - `Command_Args::unsupplied()` takes the arg's spec, not its type, and
    `Command_Args::default_of( array $spec )` is the one default rule;
    `Schema_Reflection::resolve_default()` is gone.

  A verb with no `args` key still receives its raw tokens. Raise your
  `version_at_least()` floor to 2.77.0: an older substrate hands the new
  handlers raw tokens.
- **`Settings_Sync_Node::add_setting()` takes three strings:**
  `add_setting( string $local, string $to, string $remote )`, where it took a
  token array. The TSL verb is unchanged.
- **`Sessions::forget()` returns `?bool`:** whether it dropped a lease or a
  directory row, or null when the cache did not answer.
  `Command_Auth::revoke_session()` returns `?bool` on the same terms, and
  `Cache_Backend::delete()` does too — true removed, false confirmed absent,
  null when the backend did not answer, as `touch()` answers. A caller
  testing `! $arm->delete( $key )` reads null as a failure still; one
  returning it through a `: bool` signature compares `true ===`. `sessions
  revoke` refuses `no session with handle <h>` where it answered
  `revoked: true` for any string, names a label's handles, and refuses
  `session store did not answer; <h> may still be live` when the cache is
  silent.
- **`Schema_Reflection::truthy()` is gone.** A node that called
  `self::truthy()` declares its arg `'type' => 'bool'` and reads the bound
  value, or calls `Command_Args::typed( $token, 'bool' )`, which answers
  `true`, `false`, or null for a word outside `1/true/yes/on/0/false/no/off`.
- **A `<ns:key>` token whose resolver answers a PHP bool resolves to `1` or
  `0`,** where `false` resolved to `''`. A `bool` arg binds both; a blank
  would read as unsupplied.
- **A `make_node` positional follows the verb placeholder rule.** A blank
  token for a `required` positional is `Missing required argument: <name>`,
  where it assigned `''`, and a blank `bool` positional takes its default, as a
  blank `int` or `float` did. A `bool` positional refuses a word outside
  `1/true/yes/on/0/false/no/off`, where it read false.

- **A durable Table holds set members: `SADD` and `SMEMBERS`, asked through
  `Table_Client::add_members( $table, $sets, $ttl )` and
  `Table_Client::members( $table, $set_keys, $limit, $failed )`.** Nothing
  existing changes shape. A consumer calling either raises its
  `version_at_least()` floor to 2.76.0, and names `sqlite` or `wpdb` for the
  Table: a volatile Table refuses both verbs with
  `TM_ERROR "<VERB>: needs a durable backend; <table> is <backend>"`,
  which the client reads as a failed read and an add that landed nothing. A
  `sqlite` file gains its `members` table when its worker next opens it, so
  restart the workers after deploying; until then a mount reads every set as
  empty. A `wpdb` install gains the
  `{base_prefix}newspack_nodes_members` table the first time a `wpdb` Table
  opens. On `wpdb` a member holds 255 bytes and a set key 255 less its
  scope, `newspack_nodes:v3:<site>:table:<namespace>:` (38 bytes and the
  namespace): store a hash as the member and the long string in its value.
  `SMEMBERS` takes a limit from 1 to `Table_Node::MAX_MEMBERS_LIMIT` (10,000)
  and answers one message per set: its members in member order, or, past the
  limit, `OVER <limit>` and none, which `Table_Client::members()` returns as
  `null` for that set.
- **A structure on any verb but `MSET`, `ADD` and `SADD` is refused as
  `only MSET, ADD and SADD take a structure`,** where it read
  `only MSET and ADD take a structure`. A caller matching the old text
  matches the new.
- **A class extending `Durable_Arm` implements three more hooks:**
  `purge_member_rows()`, `upsert_members()` and `select_members()`, beside
  `purge_rows()`, which `purge()` now calls first within the same limit.
  Nothing outside the substrate extends it.

- **`Bootstrap::mount_table( array $names ): array` drops its `?array &$built`
  out-parameter.** Delete the argument and the bookkeeping that read it: a
  mount now lives for the rest of the request, and a later call keeps it.
  Raise your `version_at_least()` floor to 2.75.0, because a mount no longer
  creates the file.
- **A mount no longer creates a `sqlite` Table's file, and refuses root.** A
  partition whose worker has not written still reads as empty, but no file
  appears on disk until the worker writes it; a test that mounted in order to
  create one seeds the file through a writer first. A mount in a process
  running as root raises a plain `\RuntimeException`, not `Table_Unavailable`,
  so a caller degrading on `Table_Unavailable` fails loud: run the reader as
  the workers' user.
- **A Table no longer answers `SCAN`,** and `Table_Client::scan()`,
  `Cache_Backend::scan()` and `Table_Node::MAX_SCAN` are gone. No consumer
  called them. Name the keys you read: `GET`, `MGET` or
  `Table_Client::get_multi()`. A `SCAN` request draws
  `TM_ERROR "SCAN: unknown verb"`.
- **A Table whose backend cannot open throws `Table_Unavailable`,** a
  `\RuntimeException`, so a catch written for a named backend's old refusal
  still takes it. An `auto` Table on a host with neither memcached nor APCu
  threw `\LogicException( 'Table requires memcached or APCu' )`; it throws
  `Table_Unavailable` now, so a `catch ( \LogicException )` around it catches
  `Table_Unavailable` instead, or the caller guards on
  `Cache_Backend::shared_first()` first. A caller that should degrade when
  the backend is missing — pdo_sqlite absent, a file that will not open, a
  `wpdb` table the server will not create — catches `Table_Unavailable` alone
  and lets a misconfiguration fail loud: an `\InvalidArgumentException` for
  a bad namespace, TTL or backend name, or a plain `\RuntimeException` for a
  Table two topologies declare differently.
- **`Durable_Arm::serializer()` is public.** A caller that repeated its rule,
  reading `Core::$memd`'s `OPT_SERIALIZER`, calls it instead.
- **A Table's TTL is required and at least one second.** `make_node Table
  <name> <namespace> <ttl> [ <backend> ]` refuses a missing TTL, and
  `Table_Node::table( $ns, $ttl )` has no default, so pass the lifetime an
  entry takes when its write names none. A TTL below 1 is refused everywhere a
  Table reads one — `arguments()`, `table()`, `touch()`, the `TOUCH` verb, an
  `MSET` or `ADD` item, and `Bootstrap::node_tables()` — because a Table entry
  always expires. A `Cache_Backend` arm called directly still stores a TTL of
  0 as no expiry.
- **`Cache_Backend::rotate_salt()` asks every live worker to restart,** as
  `ensure_salt()` does when it seeds the first salt, so a caller no longer
  recycles the fleet after either. Both now throw where they reported
  success: `cache salt write refused` when the database refuses the write,
  and a seed throws the refusal of a runtime base that exists but is
  unsafe. A caller that treated either as infallible catches the throw.
  `Memcache_CLI_Command::$restart_workers` is gone with that call.
- **A Table's `GET` of an absent key answers only `TM_INFO "GET 0\n"`,** no
  longer a `TM_ERROR` reading `NOT_FOUND`. A read answers one message per
  value found and then a `TM_INFO` count, and a `TM_ERROR` now means the read
  failed. A caller that read `TM_ERROR` as "absent" reads the count instead,
  or asks through `Table_Client::get_multi()`, which returns the found values
  and sets `$failed` on an error. Every reply echoes the request's ID, and a
  verb the Table cannot answer draws a `TM_ERROR` reading `<VERB>: <why>`
  where it was dropped with no reply.
- **A keyless `TM_STRUCT` or `TM_BYTESTREAM` sent to a Table is refused,** no
  longer passed through, and so is one whose KEY holds whitespace. Route
  keyless traffic around the Table, or give each message the KEY it stores
  under.
- **Every cache write refuses a key that is empty or holds whitespace.**
  `set()`, `add()` and `write_multi()` on every `Cache_Backend` arm return
  false for one, and a batch holding one writes nothing. Spell logical names
  without whitespace before handing them to `site_key()` or `host_key()`.
- **`Cache_Backend` is abstract.** `local_first()` and `shared_first()` return
  a `Memcache_Arm` or an `Apcu_Arm`, so a caller using the contract's methods
  is unaffected; the old class was final with a private constructor, so no
  caller could `new` or extend it. Code comparing `get_class()` of a resolved
  backend with `Cache_Backend::class` compares an arm's class now, and
  `instanceof Cache_Backend` still holds.
- **A `sqlite` Table's name must name a file:** letters, digits, `_`, `.`, `:`
  and `-`, starting with a letter or digit and holding no `..`. Rename a Table
  that names `sqlite` and falls outside that set.
- **Two active topologies declaring the same `sqlite` Table conflict,**
  directly or through an include, because its file has one writer.
  `wp nodes activate` refuses the second, and `Bootstrap::node_tables()`
  refuses two active topologies declaring one Table differently, whatever its
  backend. Declare each `sqlite` Table in one active topology.
- **A request graph reaches a Table only through `topologies mount_tables
  <topology>`,** a MANAGE verb that mounts every Table the topology declares
  as `{table}.p{N}` for reads alone. A client sends it ahead of the request it
  enables in the same POST, as it sends `connect_worker_input` ahead of a
  worker command; PHP mounts through `Bootstrap::mount_table( $names )`.
- **`Table_Node::backed_by()` takes one closure, and `replace_absent()` is
  gone.** A table no longer remembers an absence the backing answered: drop
  the second argument, and call nothing in place of `replace_absent()`,
  since no marker is ever written for it to replace. PHP ignores the extra
  argument rather than refusing it, so PHPStan is what names a call still
  passing one. Then run `wp nodes memcache flush` once. A marker an older
  substrate stored reads back as its own string until it expires, and the
  flush rotates the install's cache salt, orphaning every one at once.
  newspack-event-logger-nodes below 0.108.0 still calls `replace_absent()`
  and fatals on this release, and its version floor cannot catch a substrate
  that is too new: upgrade it in the same deploy.
- **`Spawn_Coordinator::lock_path()` takes the base directory,**
  `lock_path( $base_dir, $type, $partition )`, where it took the locks
  directory. Drop the `/locks` the call site appended;
  `Spawn_Coordinator::locks_dir( $base_dir )` names that directory where one
  is needed on its own.
- **`Spawn_Coordinator::worker_lock_dirs()` is static and takes the base
  directory,** and each entry carries the worker's `id`:
  `Spawn_Coordinator::worker_lock_dirs( $base_dir )` returns
  `path => { id, type, partition }`. Read `$lock['id']` rather than joining
  the type and partition back through `CLI::worker_id()`.
- **`Spawn_Coordinator::wake_sleeping_worker()` takes `( $type, $partition,
  $now )`,** where it took a worker id. A caller that resolves a worker's IPC
  channel calls `Spawn_Coordinator::worker_channel( $base_dir, $worker_id,
  $now )`, which parses the id, wakes a sleeping on-demand worker and returns
  `{ id, type, partition, input, output, sleeping }`, or null. Read
  `$channel['id']` rather than joining it back through `CLI::worker_id()`.
- **`Restart_Planner::request_restarts()`, `request_reloads()` and
  `Spawn_Coordinator::signal_workers()` take the base directory** where they
  took the locks directory: `request_restarts( $restart, $base_dir )`,
  `request_reloads( $base_dir, $consumers )`,
  `signal_workers( $base_dir, $workers, $signal )`. Pass
  `Config::get_base_directory_with_locks()`, which refuses a `{base}/locks`
  that is a symlink or belongs to another uid, as
  `Config::get_locks_directory()` does. The substrate keeps that accessor
  only for nuclear-gyrobase 1.14.x, which calls it; event-logger-nodes'
  `Config::get_locks_directory()` is gone;
  `Spawn_Coordinator::locks_dir( $base_dir )` names the directory, and
  `Spawn_Coordinator::lock_path()` one worker's lock dir within it.
- **`Worker_Base::ipc_dir()` takes the leg,** `ipc_dir( $base_dir, $type,
  $partition, Worker_Base::IPC_INPUT )`, in place of appending `/input` or
  `/output`; `build_ipc_input_consumer()` takes no argument and builds its
  worker's own input reader.
- **An unknown request verb is refused with a `TM_ERROR`,** not answered
  `TM_STRUCT | TM_RESPONSE` with `data.error`. `Job_Worker_Node`'s
  `GET_HEALTH`, and every node answering through
  `Schema_Reflection::answer_request()`, sends VALUE
  `"unknown request verb: <VERB>\n"` to the same address. A caller reading
  `data.error` off the reply tests the reply's TYPE for `TM_ERROR` instead.
- **`CLI::parse_worker_id()` answers `null` for an id it refuses,** where it
  threw `InvalidArgumentException`, and refuses a padded partition
  (`kea.p03`) or a `/` in the type. A caller that caught the throw tests for
  `null`; one that needs the refusal as an exception calls
  `CLI::attach_to_worker()`, which still throws `invalid reader id`.
- **An `$around_dispatch` wrapper receives a fourth argument, `$command`,** a
  `\Closure(): string` rendering the command line — `/<name>> <verb> <args>`,
  tokens quoted, and only the id and the option names of a verb whose schema
  declares any argument `secret`. Call it only when you record it. One composing over an earlier
  wrapper hands it on unrendered — `$inner( $ci, $verb, $run, $command )` —
  or the inner one loses it.
- **A verb argument carrying a credential declares `'secret' => true`,** or
  it is logged verbatim. A declared one logs as `--<name>=<redacted>`. Better, take
  none: a credential belongs in the Vault, and a node names the Vault id.
- **The Vault refuses a `url` carrying userinfo, or one that will not parse,**
  judged after `esc_url_raw()`. Move `user:pass@` out of the URL into `--user`
  and `--password`, and fix a malformed port; an entry stored with either
  refuses every `update` until its URL is fixed.
- **The drop audit quotes a command's tokens** as `serialize_args()` does, so
  a masked `--password=<redacted>` and a spaced token print single-quoted. A
  log reader matching the unquoted form must match the quoted one instead.
- **`Deferred_Clean_Stop` is one bracket: `deferring( \Closure $body )`.**
  `clear_pending_stop()` and `raise_pending_stop()` are gone. Wrap a
  snapshot node's whole per-message work in `$this->deferring( fn () => … )`
  and keep each forward in `guarded()`; the bracket raises when the body
  returns. Outside a bracket, `guarded()` now lets a stop propagate at once.
- **`Lock_Node::request_restart_at()`, `request_stop_at()` and
  `request_reload_at()` throw when the flag will not land.** False still
  means no lock dir, so no worker; a write refused as root or one that
  fails raises a `\RuntimeException` naming the dir and flag. A caller
  that counted false as a refusal catches or lets it escape instead.
  `Restart_Planner::plan()` no longer swallows: an unusable base directory,
  an unreadable active topology or a failed flag reaches the writer, after
  every readable topology's dirs were flagged, and `request_reloads()`
  takes an optional classification, `request_reloads( $base_dir,
  [ 'Remote_Source' ] )`, for a reload narrower than `'all'`.
- **`Worker_Should_Stop::outranks()` is gone; `attempt_each()` returns
  the failures it caught, each under its item's key.** An attempt-all loop
  hands what `attempt_each()` returned to `Worker_Should_Stop::raise()`,
  which ignores the keys, instead of throwing one survivor. Every caught throwable escapes: several failures arrive as
  `Failures` (`all()` lists them), and a stop beside a failure is a plain
  stop carrying it as `getPrevious()`. A reader deciding to commit past a
  message asks `Worker_Should_Stop::is_clean()`, never `instanceof
  Worker_Should_Stop_Clean`, because a clean stop carrying a previous is not
  clean.
- **A `Vault_Group` refusal from several children reads
  `<n> failures: <child>: <reason> | <child>: <reason>`**, where it joined
  the refusals with `; `. A single refusal still reads
  `<child>: <reason>`. A stop from one child and a refusal from another now
  raise together: the stop, carrying the refusal.
- **`Topology_Analyzer::graph_for()` throws on a broken include**, as every
  other reader of the flattened statements already did, and memoizes
  nothing when it does. A caller that read an empty graph as "declares
  nothing" now sees the failure; catch it only to turn it into a result
  your own caller sees. `dump_graph` answers such a topology with a
  TM_ERROR rather than an empty graph.
- **A topology with any failing line fails the load** instead of booting a
  partial graph. That covers a `make_node` the interpreter refuses, a `cmd`
  or `command_node` whose verb throws or whose path names no node
  (`NOT_AVAILABLE: <path> <verb>`), a Shell refusal such as a `usage:` line
  or a bad `var`, a quote left open at end of file, and an `include` that
  names no registered topology, will not open, or cycles. Every line still
  runs; the failures escape together after the last, one as itself and
  several as `Failures`, and the worker releases its slot without
  respawning. Before upgrading, load each of your topologies in a test —
  `Topology_Loader::load()` against a `Command_Interpreter_Node` sinking
  into a `_router` — or read a worker's boot error, then fix or delete the
  failing line. A `cmd` aimed at a node another topology declares needs
  that topology `include`d above it, and a topology including one whose
  providing plugin is dormant must be deactivated with that plugin.
- **A Vault id named `config` fails its `Vault_Group`** as
  `building Vault id config: …`, after every other member built, where it
  was skipped with a line. The group's own `:config` interpreter holds that
  slot; rename the Vault entry.
- **`Vault_Group_Node::update_graph()` raises.** A member that will not
  build — a name collision, a refused argument, a refused replay — is
  retracted and raised as `building Vault id <id>: <reason>`; one that will
  not retract keeps its slot and is raised as
  `retracting Vault id <id>: <reason>`. Every member is still attempted,
  and the failures escape together on the fleet's RELOAD.
- **`Spawn_Coordinator::lock_path()` is static:** it was the instance
  method `lock_path( $type, $partition )`, and needs no coordinator. It
  takes the base directory first; see the entry above.
- **`Bootstrap::node_dirs()` and `node_partitions()` answer from the
  readable active topologies.** A topology that will not read no longer
  fails the call when a readable one declares the node; when none does,
  every unreadable active topology raises, an active name no `.tsl`
  resolves included, where that name returned an empty answer.
- **A log producer template declaring no dir refuses the retention sweep
  out loud.** A template registered through
  `newspack_nodes/registered_log_producers` that resolves under no
  `<config:logs_dir>` dir raises `log producer <template> declares no dir
  under the logs root <root>` from the sweep and `workers dump_cleanup`,
  where it printed a line and skipped. `Log_Cleaner::producer_log_dirs()`
  is private, and `declared_log_partitions()` returns
  `[ $map, $refused ]`, the refusals keyed by template. `dump_graph`
  carries them under `refused_producers`.
- **An unreadable active topology refuses the retention sweep out loud.**
  `Log_Cleaner::cleanup_orphan_partitions()` — the reconcile pass's
  `retention` step and `wp nodes gc` — and the `workers dump_cleanup` verb
  raise its failure, where the sweep skipped with a line; nothing is
  deleted. The `aggregator summary` slice names each such topology under
  `unreadable`, and `wp nodes status` and `types` warn naming it.
- **`Settings_Sync_Node` raises an option it cannot encode**
  (`settings_sync: cannot encode value for <option>`) after pushing the
  rest, where it printed and skipped it. Nothing is sent for that option.
- **`HTTP_Out_Node` raises a malformed reply line** — the
  `Message::unpacked()` refusal — after delivering every other line of the
  body.

- **`Worker_Base::execute()` raises a topology load failure** after the
  teardown and the release, still without a self-respawn, where it returned
  `[ 'status' => 'load_failed', 'error' => … ]`. It returns only `skipped`
  or `ok`; a caller branching on `load_failed` catches the throwable instead.
  Whatever the drain, the shutdown sweep, the cursor handoff, the teardown or
  the release threw escapes the same way, after the slot is handed on.
- **`Job_Delay::sweep_action()` is gone.** `Alerts::emit()` and
  `Job_Delay::sweep()` are steps of the reconcile pass, no longer
  `newspack_nodes/periodic` subscribers; call `Job_Delay::sweep()` directly.
  Every reconcile step runs whatever an earlier one threw, then the pass
  raises them all out of the cron callback after `after_reconcile`.
- **Lock contention is `Write_Lock_Held`.** `Partition_Node::allow_large_writes()`
  raises it when a live writer still holds the lock, and a plain
  `\RuntimeException` naming the cause for any other refusal.
  `Job_Intake::queue()` returns false for contention alone and lets every
  other failure propagate; catch `Write_Lock_Held`, not `\RuntimeException`,
  to keep a boolean contract of your own.
- **A `newspack_nodes/job_worker/after_job` or `before_job` listener that
  throws fails the job.** The listener's failure joins the job's own through
  `Worker_Should_Stop::raise()` and reaches the Consumer, which dead-letters
  it; `after_job` still fires first. A `newspack_nodes/stderr` listener that
  throws escapes `Core::stderr()` after the line is handled. Catch in your
  listener only to turn a failure into a result someone sees.
- **Failures the lifecycle printed now propagate:** a throwing
  `Shutdown_Sweeper`, a node teardown in `Core::cleanup_all_nodes()` (every
  node still torn down), a probe's `probe_stats()` (every node still
  swept), the fleet scan (the worker hands on and raises), a failed
  settings-audit append (into the `update_option()` that fired it), a
  failed Vault reload signal, the cache-flush worker restart, an unreadable
  topology or segment listing in `taillog`, a stale status row whose disk
  read fails, and a `make_node` rollback that throws beside the refusal it
  rolls back.

- **`AreaTimeChart` and `drawAxes` require `yLabel`.** An omitted title used
  to leave the axis bare; `lint:types` now refuses the call, and at runtime
  the axis draws an empty title. Pass the translated name of the quantity the
  chart plots — `Requests`, `Messages`, `Latency` — and leave the unit to the
  ticks. The chart role now inks the title, so a consumer's own `.y-label`
  fill can go once its `version_at_least()` floor reaches this release.
- **`RouterNode.requestTick()` called from inside a tick no longer runs a
  second tick.** The Router serves it before that tick's flush, with one
  more pass firing the timers marked due, so the commands they mint join the
  tick's POST. A caller asking from inside a tick marks its own timer due
  with `markDue()` first, as `useBatchedPoll`'s `pollNow()` does; an
  unmarked timer waits for its cadence.
- **A busy stream's lifetime close now reopens at once.** Just before
  closing a stream that delivered records at `sse_max_lifetime`,
  `SSE_Out_Node` sends a second `retry` event whose VALUE is 0. A hand-rolled
  client keeps the LAST `retry` a connection carried, reads its VALUE as a
  canonical decimal, treats 0 as "reopen now", and forgets the value when the
  connection ends, so a failed reopen falls back to its own backoff. An
  `sse_retry_ms` of 0 no longer sends a `retry` of 0 at open; it sends none.
- **An idle `/messages/stream` or `/log/stream` connection now closes after
  five seconds of no `msg` event, not fifteen.** `sse_idle_timeout` defaults
  to 5. A site that already sets the key in a config file or as a
  `newspack_nodes_sse_idle_timeout` option keeps its own value; only the
  code-level default changed.
- **Upgrade a hub before, or together with, its spokes.** An upgraded spoke's
  `connected` envelope no longer carries `PID`, and a hub on the previous
  release rejects that handshake as `connected envelope missing or invalid
  PID`, so its aggregation pull retries without ever connecting. An upgraded
  hub pulls from a spoke on either release, since it no longer requires the
  field.
- **A browser's attached reply head names its command session.**
  `RemoteIpcNode` writes `_sse:<session handle>/<node>` where it wrote the
  stream's pid. `SseInNode.pid()` and `RemoteLinkNode.pid()` are `session()`, and the
  `connected` envelope's `PID` is `SESSION`, absent without one. A
  `connected` fixture a test dispatches must echo the session its stream
  presented — `SESSION <handle> SLOT …` — or the handshake is rejected as
  `connected envelope names another SESSION`. A test pinning a stream URL
  now sees `&session=<handle>&stream=<node name>` when a session is live.
  PHP's `SSE_In_Node::pid()` is gone; nothing in the tree called it.
- **The slot seams carry the stream's session lease.** A test or application
  that installs its own closures declares
  `$acquire_slot = function ( int $partition, ?array $session )`, where
  `$session` is `{key, ttl}` or null, and
  `$release_slot = function ( array $lease, int $partition, ?string $session )`.
  A closure declaring fewer parameters still loads, because PHP drops extra
  arguments to a closure.
- **`dump_config` omits every published sibling, not only a patron's.** A
  node built through `publish_sibling()` and dumped separately before —
  never patroned — no longer emits its own config line; its publisher's
  line rebuilds it on replay. Read `Node::publisher()` to find who owns it.
- **A fan-out target that stands for members expands to them.**
  `Node::members()` answers null, the node standing for itself; a node
  answering a list — `Vault_Group_Node` answers its children — stands for
  those members, and `Fanout_Targets::live_targets()` expands a
  `connect_node <group>` entry into one delivered target per member, so a
  `dump_metadata` `targets` list or a live delivery carries the members
  rather than the group's own name. A subclass overriding `live_targets()`
  must expand a target whose node answers `members()` itself or lose the
  fan-out.
- **`GET /log/stream` is gone, and `Log_Stream_Out_Node` with it.** Stream a
  `Log_Sources` registry entry from `/messages/stream` as `sources/<name>`:
  `subscribe=sources/php` where you sent `subscribe=php`, with `positions`
  keyed by `sources/php`. Each frame's FROM opens with `sources/<name>`. One
  stream may now carry registry sources beside partitions.
- **The `taillog` verb is gone.** List the registry with `cmd raw-logs list_logs`
  (each source is a `sources/<name>` row), size one with `cmd raw-logs dump_log
  sources/<name>`, and read one record with `cmd raw-logs read_message
  sources/<name> <segment>:<offset>`. The last-N-KB tail has no replacement; the
  Partition Viewer streams the source live. `sources` and `read` are no longer
  reserved as registry names.
- **`raw-logs read_message` answers an empty read as a result and a bad
  position as an error.** A position holding no record answers
  `{ source, message: null, cursor, at_eof }` where it answered the string
  `read_message: no record at <log> <position>`: test `message` for null and
  resume from `cursor`. With `at_eof` false the read consumed a line that would
  not unpack, and `cursor` lies past it. A malformed position answers a
  `TM_ERROR` carrying the same `read_message: invalid position (…)` text, so
  read it on the error path, not off a successful reply.
- **`read_message` and `dump_log` refuse a `log` they cannot place, and never
  read the firehose in its place.** An empty `log` answers `missing required
  argument: log`, an unknown dir `unknown log: "<log>"`, an unknown source
  `unknown log source: "<name>" (known: …)`, and a name the stream refuses
  `invalid subscription: <log>`. Send the `key` of a `list_logs` row.
- **`dump_log` sizes a `sources/<name>` registry source** as
  `{ log_id, segments, segment_count, total_size }`, so pass any `list_logs`
  key. A file source answers one segment, `{ id: <inode>, size: <bytes> }`,
  which is the slot its stream's ID breadcrumbs carry, and none while the file
  is absent or unreadable; read its boundary off `segments` as a partition's.
  `useLogStatusSegments` answers `source: { segments }` with no `bytes`, and
  `browseControl()` reads `segments` alone, so a source row carrying only
  `bytes` follows rather than replays. A `browse` control you build by hand
  passes `knownSegments`, the ids its footprint lists: a replayed record from a
  segment outside them counts as caught up. A row naming no log —
  an active topology that will not read, a dir named outside the stamp grammar —
  carries `label`, `available: false` and `error` but no `key`; offer it
  disabled, never as a pick.
- **The Log Viewer tab is gone.** The Partition Viewer lists registry sources as
  `sources/<name>` beside the dirs; an old `?tab=log-viewer&source=<name>` link
  lands on the default tab. `useStreamGraph` takes no `endpoint`,
  `useSteppedRead` no `argsFor` or `subjectOf`, `useLogCatalog` no `argsFn`, and
  `RemoteLinkNode` and `SseInNode` carry no `endpoint` field. Replace
  `useLogViewerGraph` with `usePartitionViewerGraph`.

## 2.65.6

- **`_http`'s target is `_null`, not `_output`.** A browser graph that read
  `Core.node( '_http' ).target` to find the console's output node reads
  `_output` only while a console is open. `_null` is a new backbone singleton,
  mounted by `mountExospine` and torn down with the rest of it.

## 2.65.5

- **The Router publishes no `NOT_AVAILABLE` state.** `send_error()` fired
  `set_state( 'NOT_AVAILABLE', … )` with a flat `NODE … TYPE … FROM … TO … ID …
  KEY …` payload; both engines have dropped it, and `NOT_AVAILABLE` is gone from
  each Router's declared `registrations`. Nothing in the tree registered for it.
  A watcher that did reads the bounce instead: its FROM names the destination,
  its TO walks back to the sender, and a miss with no FROM to answer leaves the
  `drop_message` audit line, which it always did.
- **`Node::drop_message()` takes two arguments**, and the audit line carries no
  `node: …` field. The unresolved head rides the bounce's FROM. An override or
  a caller still carrying the third argument keeps loading — PHP ignores an
  extra argument and permits a child to declare an extra optional one — so
  nothing fatals and whatever reads that field reads `''`; narrow both.
- **The browser Router drops a miss reached from inside a bounce** as
  `breaking recursion`, matching PHP. A graph that relied on the second bounce
  being minted sees one fewer TM_ERROR.
- **The audit-line throttle keys on the reason alone in the browser**, as it
  already did in PHP and as Tachikoma keys it. TYPE is a bitmask the sender
  picks, so a peer could mint 2,048 keys from one drop site.

## 2.65.3

- **A Router bounce crosses the wire again.** `HTTP_Out_Node::fill()` refused to
  POST any message carrying `TM_ERROR` from the Router; it no longer inspects
  anything. A remote sender that addressed an unroutable node now receives the
  `NOT_AVAILABLE` bounce instead of silence. A spoke that treated the absence of
  a reply as success will start seeing an error it never saw before — that error
  was always true, only undelivered.
- **A bounce's `FROM` is the address that was missing, in both engines.** This
  reverses [2.63.0](#2630) and restores Tachikoma's `$response->[FROM] =
  $message->[TO]`. 2.63.0 stamped the Router's own name so `HTTP_Out`'s loop
  guard could tell a self-minted bounce from a forwarded one; with that guard
  gone the stamp has no reader.

## 2.63.0

- **`Header` is shared surface, imported from
  `@newspack-nodes/shared/components/Header`.** It was
  `topology-console/components/Header`, which no consumer should have been
  reaching across in the first place. `HeaderControls` moved with it. A
  standalone dashboard can now mount the same header the station does.
- **`Header`'s `subtitle` has no default.** It rendered `Topology Console` for
  any host that passed none, which named the wrong surface everywhere but the
  console. Pass the name of the surface the header rides — not the tab open on
  it, since one header outlives every tab: `<Header subtitle={ __( 'Request
  Log', 'my-plugin' ) } />`. Passing none renders the wordmark and the version
  alone.
- **`ConsoleShell` renders no header.** Its `showHeader`, `wrapHeader` and
  `headerProps` props are removed, and passing one is ignored rather than
  honoured. Both hosts already passed `showHeader={ false }`: each owns ONE
  header above its tab bar and the active tab portals its controls into that
  header's slot, which is the shape to follow — render `<Header
  controlsSlotRef={ setSlot } />` beside the shell and hand the slot to the
  body, which places its controls with `HeaderSlot` from
  `@newspack-nodes/shared/components/HeaderSlot`.
- **`LogStreamViewer` renders no source picker below two `pickerOptions`.** A
  single-source log drew a dropdown that could not be changed. A consumer that
  needs the source NAMED beside a lone option prints it itself.
- **A Router bounce's `FROM` is the Router, in both engines.** PHP stamped the
  address that was missing, which reads well and leaves `HTTP_Out`'s loop guard
  — `Node_Names::ROUTER === FROM` — unable to fire, so a bounce it should have
  refused crossed the wire. The address rides the audit line's `node:` instead.
  A node that read the missing address off a bounce's FROM reads the `NODE`
  field of the Router's `NOT_AVAILABLE` state, which has always carried it.
- **`Node::drop_message()` takes a third argument.** `drop_message( $message,
  $error, $node = '' )` names the node the drop turned on; it is optional, so
  an existing call is unaffected. A SUBCLASS that overrides the method must
  widen its signature to match, or PHP fatals on the incompatible override.
- **`LogStreamViewer` no longer takes a `title`.** It rendered an inline
  `<h1>` for an adopter with no header of its own; every host has the shared
  header now, and a page that wants a heading prints one.
- **The shared sheet no longer styles `.newspack-nodes-admin-wrap` or
  `.newspack-nodes-admin-app`.** Their `max-width` and `margin-top` are gone,
  and both class names are inert. A page that relied on either one declares the
  geometry it wants on its own wrapper.

## 2.62.0

- **`Restart_Planner::topologies_for()` returns the active entries keyed by
  name,** each the entry `Bootstrap::get_topologies()` resolved, where it
  returned a list of names. A caller that wants the names reads
  `array_keys( Restart_Planner::topologies_for( $restart ) )`; one that counts
  partitions reads `Bootstrap::partitions_of( $entry )` off each entry rather
  than rebuilding the catalog through `num_partitions_for()`.
  `request_restarts()`, `request_reloads()` and `plan()` still return names.

## 2.61.0

- **`Node.setState()` throws unless its payload is a string or a number.** State
  is lifecycle state, as PHP's `set_state( string, string )` holds it, and an
  object, array or null now throws `<node> setState( <event> ): state is a
  string or a number`. A browser node that published structured data through
  `setState` mixes in `ReactBridge` from `@newspack-nodes/runtime` — `class
  MyView extends ReactBridge( Node )` — and publishes the data as a field named
  after the event: `this.setField( 'view', model );` replaces
  `this.setState( 'view', model );`. `setField()` assigns the field and
  notifies the event with no payload, so a listener reads the field off the
  node. Mix `ReactBridge` in once, at the highest class that publishes; the
  substrate's `SliceViewNode`, `LogStreamViewNode` and `PollerNode` already
  carry it, so a subclass of one of them calls `setField()` as it stands. A
  test that published a stand-in reply calls `node.setField( field, value )`
  on a bridged node.
- **React reads structured data through `useNodeField`.** `useNodeField(
  nodeName, field )`, exported from `@newspack-nodes/runtime`, reads the field
  and re-reads it on each notify of that field. `useNodeState` now reads
  scalar state alone, so a widget calling `useNodeState( '<subject>:view',
  'view' )` gets undefined forever and renders its empty state. Replace it with
  `useNodeField( '<subject>:view', 'view' )`. The substrate's own nodes moved
  the same way, so a consumer reading one of them by name switches hooks:
  `reply` on `PollerNode`, `dmesg` on `DmesgNode`, `metadata` on
  `MetadataNode`, `candidates` on `CompletionNode`, `transcript` on
  `DumperNode` and `catalog` on `TopologyCatalogNode`. `debug_level` and
  `debug_ui` stay state, and `debug_ui` now publishes `1` or `0` rather than a
  boolean.
- **`result` on `CommandResultNode` and `settled` on `FetcherNode` are events,
  not state.** Each notifies its payload — the reply model, the settled ask —
  to the closures registered at that moment, and nothing holds it: a listener
  registering later hears only what follows. Register for them with
  `useNodeEvent()` or `register()`; `useNodeState()` and `useNodeField()` read
  nothing for either.
- **`Node.notify( event )` delivers `''` when given no payload,** as PHP's
  `Node::notify()` does, where it delivered `null`. A closure listener testing
  for `null` tests for `''`, and a node-name listener receives an empty VALUE.
- **`SliceViewNode.model` is `view`.** The field holding a slice view's model,
  and the one `LogStreamViewNode` and the event-dashboards views publish, is
  `view`, the name of the event it announces. A subclass reading or assigning
  `this.model` renames it to `this.view`. `DumperNode._transcript` is likewise
  `transcript`. `LogStreamViewNode._publish()` is gone: a subclass publishes
  with `this.setField( 'view', this.viewModel() )`, and a constructor seeds
  its model with `this.view = this.viewModel()`.
- **`dump_node` prints every field, a function as `(closure)` at any depth.**
  It prints `registrations` and `setStateCache`, and a function anywhere in a
  field renders as `(closure)`: a top-level function field it used to skip now
  prints, and `CommandInterpreterNode`'s `authorize` prints `(closure)` or
  `null` rather than `{...}`. A `ReactBridge` node holding bulk data declares
  `static dumpOmits = [ … ]`, naming only its own fields; the lists merge down
  the class chain, so a subclass drops its `[ ...Parent.dumpOmits, … ]`
  spread. `dump_node <name> <key>` still returns an omitted field whole.
- **`parseSchemaArgs()` is the `SchemaReflection` mixin.** A browser node that
  walked its positional tokens by calling `parseSchemaArgs( this, value )`
  from its own `set arguments` extends `SchemaReflection( <its base> )`
  instead, exported from `@newspack-nodes/runtime`, and deletes the override;
  one that does more around the walk keeps the override and calls
  `super.arguments = value` for the walk. `truthy()` moved with it and is
  still exported from `@newspack-nodes/runtime`.
- **`_router` publishes NOT_AVAILABLE as a flat string.** A browser listener
  on `_router`'s `NOT_AVAILABLE` received a `{ node, from }` object; it now
  receives `NODE <n> TYPE <t> FROM <f> TO <to> ID <id> KEY <k>`, as PHP
  publishes it. A listener reading `payload.node` splits the string instead.
- **The JS logging helpers are camelCase.** `Node.log_midfix()` is
  `logMidfix()`, and `Core.log_prefix()` and `Core.log_prefixed()` are
  `logPrefix()` and `logPrefixed()`. There is no alias, so the old name is
  undefined. `Node.printLessOften()` now prints head and tail as one line,
  keyed on the tagged head through the new `Core.firstInWindow()`, as PHP's
  `Node::print_less_often()` does.

## 2.60.12

- **`Durable_Reader::poll()` returns the records it consumed.** It and the
  phases it dispatches to (`poll_init()`, `poll_active()`, `poll_crawl()`)
  returned nothing; they now return an `int`, counting a forwarded,
  dead-lettered or refused record alike. A reader overriding any of them
  declares `: int` and returns the parent's count. `advance_one_message()` is
  no longer abstract: the trait's own consumes exactly one record per `step`,
  so a reader that implemented it deletes its copy, and one that must react to
  what a step consumed overrides `after_step( int $consumed )` instead.

## 2.60.11

- **The time-travel verbs are lowercase: `pause`, `play`, `step` and
  `seek_frame`.** They were the only upper-case command verbs on the
  substrate, beside `dl_list`, `add_snapshot_node` and every other
  lower-case one. A script or topology sending `PAUSE`, `PLAY`, `STEP` or
  `SEEK_FRAME` to a `{name}:config` interpreter sends the lower-case name
  instead; there is no alias, so the old spelling is an unknown verb.
- **`dl_list`, `dl_show` and `step` reply with structure, not a JSON
  string.** Each handler encoded its result into the reply's `payload` as
  text, so the wire carried JSON inside JSON. `payload` is now the page
  `{ rows, total, unindexed_segments }`, the record `{ type, type_flags,
  timestamp, from, to, id, key, value, size }` and the cursor `{ segment,
  offset, at_eof }` themselves. A caller that decoded the payload drops the
  decode: in PHP,
  [`Durable_Reader::cmd_step()`](../includes/trait-durable-reader.php),
  [`Dead_Letter_Queue::cmd_dl_list()`](../includes/trait-dead-letter-queue.php),
  `cmd_dl_show()` and `show_deadletter()` return arrays, and a browser reply
  handler reads `payload` as an object.
- **A refusing verb replies TM_ERROR, never an `error:` line.** `dl_list`,
  `dl_show`, `dl_requeue`, `dl_purge`, `seek_frame`, the Table's `get` and `rm`
  and Settings_Sync's `add_setting` each answered a refusal as an ordinary reply
  starting `error:`, which every reader that tests TM_ERROR took for success.
  They now throw, as every other verb does, and the interpreter replies TM_ERROR
  with the bare message: `no dead-letter queue configured`, `no frame at segment
  5344`, `usage: add_setting <local_option> <TO> <remote_option>`. A caller that
  matched the `error:` prefix tests the TM_ERROR bit instead; a PHP caller of
  [`requeue_deadletter()`](../includes/trait-dead-letter-queue.php),
  `show_deadletter()`, `purge_deadletter()`, `seek_frame()` or `add_setting()`
  catches `\RuntimeException`.

## 2.57.1

- **`Field_Reset_Assets::highlight_style()` is gone, and a marked reset toggle
  takes the `is-danger` button role.** The inline style it returned painted the
  mark at a specificity the UI sheet's secondary role beat, so on any page
  loading that sheet the toggle never turned red. The paint is now the sheet's
  own danger role, and
  [`Field_Reset_Assets::enqueue()`](../includes/config-system/class-field-reset-assets.php)
  enqueues the `newspack-nodes-ui` sheet by handle beside the module. A
  settings admin that echoed the style deletes that line, calls `enqueue()`
  from its `admin_enqueue_scripts` handler rather than the page body, after
  priority 2 where the handle is registered, and wraps the form in
  `.newspack-nodes-ui`, which is what scopes the sheet. A consumer
  still echoing it against this substrate fatals on its settings page, so
  consumers ship with the substrate.

## 2.57.0

- **The `/auth` and `sessions create` reply names the signing key `secret`, not
  `key`.** The field name IS the redaction: `Core::is_secret_property()` is the
  one rule `Node::redact_secrets()` and the browser's `redactSecrets()` ask, and
  `secret` is a name it masks. A PHP caller of
  [`Command_Auth::mint_session()`](../includes/class-command-auth.php) reads
  `$session['secret']`; a client reading `POST /newspack-nodes/v1/auth` or the
  `sessions create` reply reads `secret` there too, and assembles the Bearer
  credential as `<handle>.<secret>`, unchanged in bytes. The browser session
  object [`CommandSession`](../src/runtime/command-auth.js) carries `secret`, so
  a test double answering `/auth` issues `{ handle, secret, expires_in }`. There
  is no alias: a reader asking for `key` gets null. The internal names stay
  `key`: `Command_Auth::store_session()`, `remember_session()` and the record
  `load_session_record()` returns.

  A hub and its spokes upgrade together: `HTTP_Out_Node` reads the spoke's
  `/auth` reply, so a hub past this release paired with a spoke before it treats
  every session as malformed and refuses to probe.

  Transcripts already stored need no migration. A session key outlives its
  transcript entry by at most `Command_Auth::SESSION_TTL_MAX_S`, and the REPL's
  `clear` builtin empties and re-persists the transcript.

- **A relay or link refuses a message the remote addressed.** The rule for
  every inbound leg of a channel is one: with a target set an addressed message
  is dropped, logging `addressed while target is set`, and with none it passes
  only to a destination this side declared. An unaddressed message takes the
  target, or goes on as it stands. A legitimate firehose record carries no
  `TO`, and a reply self-routes on the `TO` the remote echoed off this side's
  own `FROM`, so a correctly wired channel sees no drops.

  **A `Remote_Source`** drops any addressed line, with a target (`addressed
  while target is set`) or without (`addressed with no target`); the relay
  consults no allowlist. The stock shape declares its destination with
  `connect_node spoke-<id> remote-job-rewrite`; a relay that sees no drops has
  nothing to change.

  **A hand-wired `Remote_Link` with no target** asks the `allow_replies_to`
  list its `<name>:http-out` sibling holds, and drops an addressed frame naming
  nothing declared with the same reason. Declare each destination the remote
  legitimately answers on: `cmd <name>:http-out:config allow_replies_to <path>`.
  The link's own name is declared by `address_null_sink()`, so the heartbeat
  needs no action.

  The refusal consumes the line rather than quarantining it: a `Remote_Source`
  cursor advances past a refused record by its own crumb, so nothing replays and
  no offsetlog or dead-letter migration is needed.

## 2.56.0

- **The DevTools hub is RENAMED the station, and the DevTools tab system the
  tab system, with no alias for any old name.** A hub is the site that pulls
  the spokes' logs; the wp-admin page under the "Nodes" menu is the station.
  The page slug is `newspack-nodes-station` ([`Admin::STATION_MENU_SLUG`](../includes/admin/class-admin.php)),
  so a bookmark or deep link reads `admin.php?page=newspack-nodes-station&tab=<slug>`.
  A plugin contributing a tab bundle filters
  [`newspack_nodes/station_tab_bundles`](API.md#filters), a plugin whose page
  mounts the debug overlay filters `newspack_nodes/overlay_pages` and reads
  [`Admin::overlay_pages()`](../includes/admin/class-admin.php), and a tab
  descriptor declares `host: 'station'` where it declared `'hub'`. The registry
  module is `@newspack-nodes/shared/tabs/tabRegistry`, exporting `registerTab`,
  `getTabs`, `getTabsVersion`, `subscribeTabs` and `resetTabs`, and the host
  component is `@newspack-nodes/shared/tabs/TabHost`; the window singleton is
  `window.__newspackNodesTabs`. The tab bar's classes are
  `nodes-tab-host__tabbar`, `nodes-tab-host__tab` and
  `nodes-tab-host__tab-content`, the page wrapper is `nodes-station`, and the
  tab-host foreground token is `--nodes-tab-host-fg`. The browser keys change
  too: a tab's canvas layout lives under `newspack-nodes:debug:station:<tab>`
  and the Console's transcript under `newspack-nodes:station-transcript`, so a
  layout or transcript saved under the old keys is not read back.

- **`classes list` and `topologies list` are RENAMED to `classes dump` and
  `topologies dump`.** The runtime's own vocabulary is the rule: `list_nodes`
  prints one row per node and `dump_node` prints a node's whole structure. Each
  class in the `classes` reply carries its schema, arguments, commands and
  requests, and each topology in the `topologies` reply carries its frontmatter
  and includes, so both are dumps. The old name is refused as
  `unknown command: list`, with no alias. [`useCatalogSlice`](../src/shared/hooks/useBatchedPoll.js) takes a `command`
  option (`list` by default) — pass `command: 'dump'` for these two CIs, as
  `useClassCatalog` and `useTopologyList` now do — and a `Poller` or Fetcher
  aimed at either CI changes its verb from `'list'` to `'dump'`. `workers list`,
  `vault list` and `sessions list` keep their names, because each row there is
  flat.

- **Three service verbs are RENAMED verb first: `workers cleanup_status` is
  `workers dump_cleanup`, `aggregator servers_status` is `aggregator
  list_servers`, and `raw-logs log_status` is `raw-logs dump_log`.** The
  runtime's own builtins set the grammar (`list_nodes`, `dump_node`,
  `make_node`, `set_sink`), and a query with no verb is a plain noun (`stats`,
  `uptime`); a name with the noun first, or two nouns and no verb, reads as
  neither. Each old name is refused as `unknown command: <name>`, with no alias.
  A Fetcher, `Poller` or `useCommandOnce` aimed at one of the three changes its
  `command` to the new spelling; `useLogPositions`, `useSegmentBrowse` and
  `useAggregatorStatusGraph` already send it, so a dashboard built on those
  shared hooks changes nothing. The event logger's `performance` CI renames
  five of its own in the same pass; its [`docs/upgrading.md`](https://github.com/Automattic/newspack-event-logger-nodes/blob/main/docs/upgrading.md) lists them.

- **The node names the shared stream hooks derive are RENAMED.**
  [`useLogCatalog`](../src/shared/hooks/useStreamGraph.js) and `useLogReaderGraph` name the catalog slice
  `<prefix>-catalog:fetch`, `:in`, `:view`, `:timer` and `:tee` instead of
  `<prefix>:list:*`, `useSteppedRead` defaults its scope to `<prefix>-step`
  instead of `<prefix>:read`, and `useSegmentBrowse` names the refresh Timer
  it arms with no `railName` `log-rail:timer` instead of `lograil:unused`. A
  dashboard reading one of those nodes by name — `useNodeState(
  `${ prefix }:list:view`, 'view' )`, a `connect <prefix>:list:in` typed into
  the console — changes the spelling; one reading the hook's return value
  changes nothing. Every name a dashboard builds is now `<subject>:<role>`,
  the subject naming what the slice shows and never the verb it sends;
  [`docs/writing-a-view-node.md`](writing-a-view-node.md#naming-the-slices-nodes) states the rule, and the [CHANGELOG](../CHANGELOG.md) lists the
  substrate's own renames, none of which a consumer addresses.

- **The `vault` config key is REMOVED.** [`Vault::get_all()`](../includes/class-vault.php) reads the
  `newspack_nodes_vault` option alone; an entry declared under `vault` in
  `newspack-nodes-config.php` or a `LOCAL_NEWSPACK_NODES_CONF` file is ignored,
  and the key is reported as unrecognized. Nothing pins an entry any more, so
  `Vault::is_config_server()` and the `is_config` field of the `vault list` and
  `vault get` public shape are gone too. Re-enter each spoke through
  `wp nodes cli` with `vault add <id> --url=<https url> [--user=<u>] [--password=<p>]`
  or through the Vault tab.

## 2.55.0

- **[`Partition_Node::locate_by()`](../includes/class-partition-node.php)'s key set is REQUIRED.** The signature is
  `locate_by( \Closure $extract, array $wanted )`; the `= []` default is gone.
  A call naming no key set raises `ArgumentCountError` where it used to return
  an empty table. Nothing in the family reached the one-argument form — the only
  caller is event-logger-nodes' [`Flame_Builder_Node`](https://github.com/Automattic/newspack-event-logger-nodes/blob/v0.96.0/includes/class-flame-builder-node.php), whose floor of 2.56.0 is
  past the 2.41.0 that added the parameter — so the default's degrade window had
  already closed, and an optional key set is fail-silent the other way: a caller
  that forgets it resolves nothing and reports success over an empty result.
  Name your keys, as `locate_by( $extract, $urls )` already does.

## 2.54.0

- **The gyrobase legacy-envelope branch is REMOVED from [`Job_Worker_Node::fill()`](../includes/class-job-worker-node.php).**
  An entry with no top-level `id` naming the `evtemplate` handler, whose
  `parameters` held `queue`, `template` and a nested `parameters`, had its
  identity lifted from `parameters['template']` and its parameters replaced by
  that nested value, query-string-decoded. A producer still emitting that
  envelope now hands its handler the OUTER envelope — `queue`, `template` and the
  undecoded nested `parameters` — under the bare identity `evtemplate`: the wrong
  argument rather than a missing one, so the handler runs and renders nothing.
  Emit the flat envelope every current engine emits, `{handler, id, parameters}`
  with the identity in the top-level `id`.

## 2.53.0

- **`Admin\Admin::current_user_allowed()` is REMOVED.** Replace it with
  `\Newspack_Nodes\Capabilities::can( \Newspack_Nodes\Capabilities::MANAGE )`,
  which is what it did — [`Capabilities::can()`](../includes/class-capabilities.php) now applies the `allowed_users`
  allowlist itself, so the wrapper was the same rule written twice. A consumer
  still calling the old name fatals with `Call to undefined method`; there is no
  alias and no deprecation shim.

- **`allowed_users` narrows every capability role, not the admin menus alone.**
  A populated list now governs `/command`, `/auth`, `/messages/stream`,
  `/log/stream`, the spawn endpoint's external path and every capability-gated
  verb. Two consequences for a site that already sets it. Any SERVICE account
  reaching this site over the REST plane — the log aggregator's hub user, an
  `HTTP_Out` credential in another site's Vault — must be added to the list, or
  it starts answering 401. And the list applies to an authenticated actor only:
  WP-CLI without `--user`, workers and WP-Cron carry no login, so nothing there
  is narrowed. A scalar `allowed_users` — a config typo — is read as a
  one-login list rather than as no list at all, where the admin gate used to
  treat it as absent and admit everyone.

## 2.46.1

- **A session minted without a `label` is never recorded in the command-session
  directory.** Automatic `/auth` mints arrive several per dashboard load, and at
  `Sessions::MAX_ROWS` (50) they evicted the sessions an operator issued on
  purpose. The session itself works exactly as before; only its directory row is
  gone, so `sessions list` and the Sessions tab no longer show it, and
  `sessions revoke <handle>` still takes it if you kept the handle. Pass `label`
  on `POST /v1/auth` for any session you mean to find again.

- **A listed session whose lease has gone reads `revoked`, not `expired`.**
  `Sessions::all()` prunes lapsed rows before it lists, so a dead row that
  survives the prune was TAKEN — by `forget()`, or by the salt rotation
  `wp nodes memcache flush` performs. A client matching on `state` needs the new
  word.

## 2.44.0

- **A `Fetcher` mints no new ask while one is outstanding.** An ask goes onto the
  node's `outbox` when it is sent and leaves when a reply settles it, and the
  trigger reads the outbox before minting. A dashboard that drove a Fetcher on a
  fixed refresh no longer queues identical asks behind a slow verb. Two valves
  bound the wait: `retry_after_s` re-arms an ask whose answer never came — 15
  seconds on the node, 5 for a `useCommandOnce` read, 0 for a write, which is
  never re-asked — and `ASK_EXPIRY_S` (120s) is the outer bound on how long any
  ask may stand.

  `FetcherNode.send( args, path, supersede )` is the entry point for a caller with
  an answer to wait on, and `isAsking()` reports whether that subject is still
  outstanding. `useCommandOnce` sends through the same outbox rather than keeping
  a queue of its own, so two writes in one commit ride ONE POST.

- **`addSliceFetcher` fans the receiver `Tee` back to its Fetcher, last.** Tee
  fan-out order is contractual in both ports: a receiver reaches its view before
  the Fetcher that settles the ask, which is what lets a consumer acting once per
  answer read `isAsking()` while the reply renders. A custom fan-out that reorders,
  batches or defers its targets breaks that.

## 2.43.3

- **Neither `HTTP_Out` port sends a message the Router bounced.** Stamping the
  transport's name (2.43.1 below) made a Router bounce ROUTABLE, so an error the
  far side could not route was answered with an error of its own, and the two ends
  POSTed at each other about twenty times a second until the tab closed. The
  refusal is keyed on the Router as SENDER rather than on `TM_ERROR` alone,
  because an operator composing a message may set the error flag deliberately.

## 2.43.1

- **An `HTTP_Out` transport stamps its own NAME onto every inbound FROM.** A reply
  from `foo` arrives reading `<transport>/foo`, which routes, where bare `foo`
  named a node the receiving graph does not have: `_http/foo` in a browser graph,
  `remote:austin/foo` at a PHP transport node named `remote:austin`. Outbound is
  untouched — a command going out has not been anywhere yet. Anything matching a
  reply's FROM against a remote node name needs that prefix, and `MAX_FROM_SIZE`
  now guards this boundary, so a reply looping from hub to spoke and back is
  dropped by the transport that overflowed the path.

## 2.43.0

- **A component that repaints a canonical control fails the build.**
  `scripts/lint-styles.mjs` reads the SCSS and the JSX together — the classes
  riding a `.button` are derived from the markup rather than listed — and
  refuses a selector that names a canonical control, a component-specific class
  and an APPEARANCE property at once. Sizing and placing a shared control is how
  a component fits one in and still passes. Every sibling vendors the gate
  through `scripts/sync-shared-scripts.sh`, so it arrives on the next
  `pre-commit`; a rule that genuinely must paint opts out with `styles-ok:` and
  a reason on the same line.

- **The shared `.button` lays out as `display: inline-flex`.** `.wp-core-ui
  .button` sets `inline-block` two classes deep, so a single-class component
  rule asking for `flex` silently did nothing. Consumers inline this stylesheet,
  so a dashboard picks the change up on its next build; a component that worked
  around the old behaviour by re-declaring `display` on its own button is now
  the second copy the gate above refuses.

## 2.41.0

- **`Partition_Node::locate_by()` takes the key set it should resolve.** The
  signature is `locate_by( \Closure $extract, array $wanted = [] )`, and the key set
  bounds the table, the index walk and the memo alike. Passing nothing reads
  NOTHING — the default exists so a consumer compiled against the one-argument form
  degrades to an empty result instead of an `ArgumentCountError` through
  `Table_Node::lookup_multi()`, which invokes the seam bare. Name your keys:

  ```php
  $rows = $partition->locate_by( $extract, $urls );   // was locate_by( $extract )
  ```

  The old form built one locator per distinct key ever written, so a caller
  resolving a handful of rows paid an allocation that grew with the partition. The
  per-directory memo is discarded whole past `MAX_LOCATOR_MEMO_KEYS` (100000).

## 2.40.0

- **Every substrate config default lives in `Settings_Schema`, and
  `newspack-nodes-config.php` resolves to an empty array.** Each `Field` carries its
  key's built-in value, `Config::load_config_defaults()` starts from
  `Settings_Schema::get()->defaults()`, and the shipped config file lists every key
  commented out beside that default. A deploy preserves the operator's file, so a
  key added later never appears in it — a default that lived only there read as
  null forever on every existing install.

  The four `SSE_Slot_Pool::DEFAULT_*` class constants are deleted. Read a bound
  through `SSE_Slot_Pool::max_slots()`, `reserved_slots()`, `max_streams()` or
  `ttl()`, each of which falls back to what the schema declares.

- **An unrecognized config key is REPORTED, never thrown.** `Config::unknown_keys(
  $config )` is the pure query and `Config::unrecognized_keys()` the live one; the
  finding surfaces as the `config-keys` result in Site Health and `wp nodes doctor`.
  Throwing at `plugins_loaded:-10001` would take wp-admin down the day a key is
  renamed, so a misspelled key leaves the real one on its default and names itself
  instead.

- **A TSL `<config:vault>` token is refused.** `vault`, `vault_verify_ssl` and
  `vault_require_ssl` are `ui: false` Fields, and the token resolver refuses
  `Vault::CONFIG_KEY` outright. The `Vault` API is the only way to the encrypted
  credential store. (Superseded above: the `vault` key is
  gone; the token is still refused by name, so a stale file declaring the key hands nothing to a `.tsl`.)

- **Uninstall removes the runtime tree only when one is explicitly configured.**
  `runtime_base_directory()` in `uninstall-cleanup.php` consults the option,
  `LOCAL_NEWSPACK_NODES_CONF` and an UNCOMMENTED config entry, and returns `''`
  otherwise. With every ledger key commented out it used to resolve to the schema
  default `/tmp/newspack-nodes` — the path every unconfigured install on a host
  shares — and take a sibling's live logs, locks and offsets with it.

## 2.37.1

- **`@longform` inside a docblock is an error.** The tag exempts an INLINE
  comment from the 80-column rule, and a docblock is exempt already — so inside
  one it marks nothing while reading as an opt-out the next editor goes hunting
  for. `scripts/lint-comments.php` and `lint-comments.mjs` both report it, and
  both are vendored into every sibling, so the gate arrives with the next
  `pre-commit`. Delete the tag from any docblock line that opens with it; prose
  that merely names it still passes.

## 2.37.0

- **A node that writes past its own `target` declares those destinations through
  `extra_targets()`.** Override that instead of `target()`, and read the union back
  with `display_targets()`, which drops empties, de-duplicates and puts the routing
  target first:

  ```php
  // before — a target() override appending its own extras
  public function target( $value = null ) { … }
  // after
  protected function extra_targets(): array {
      return [ $this->stats_target, $this->flame_target ];
  }
  ```

  Widening `target()` itself breaks two callers that read an array answer as "this
  node fans out": `disconnect_node` peels an entry out of a Tee rather than clearing
  a scalar, and the topology console decides between appending and replacing on the
  same test. `dump_metadata` therefore carries both keys — `target` is the routing
  value, `targets` the display union — and `parseMetadata` prefers the wire
  `targets`, falling back to normalizing `target` so an older worker still draws its
  edges. A declared destination is presentation only and must never acquire a caller
  in `fill()` ([ADR-19](architecture-decisions.md#adr-19-a-node-may-declare-a-destination-it-writes-without-routing)).
  `Node::target_list()` is the one scalar-or-array-to-list normalization.

- **`LogStreamViewNode` handles the `select` control verb itself.** A subclass that
  declared its own drops it: the base resets the seek tracker, clears the ring, and
  arms breadcrumb tracking on the `dir` the payload names — `''` widens back to a
  glob and disarms. Report the arming from `seekTracking()` rather than implementing
  an abstract hook.

- **`useColumnPicker` takes an `aliases` map, retired key to current.** `restore()`
  keeps stored keys that still exist, which is right for a removed column and wrong
  for a renamed one: without the map, one upgrade turned a rename into a permanent
  loss of that column from every saved layout.

- **`formatTime` and the chart frame helpers are on the shared surface.** Import
  `formatTime` from `@newspack-nodes/shared/utils/formatUtils`, and `openFrame` /
  `drawAxes` from `@newspack-nodes/shared/hooks/useTimeChart`, rather than keeping a
  per-plugin copy of a time axis, its 8-tick cap, its 45-degree label rotation and
  its rotated Y title.

- **A `node_schema()` verb can declare a string `setter`, the twin of `toggle`.**
  Name the property and one closure factory synthesizes both the handler and the
  `dump_config` fragment; a hand-rolled trim-and-assign closure per verb is no
  longer needed. A dumped `toggle` reads `true` rather than `1`, and `truthy()`
  accepts either coming back, so an older dump replays unchanged.

## 2.34.0

- **`LogStreamViewer`'s `pickerOptions` is two values, not three.** `null` used to
  mean "no picker" and `[]` "say the empty label"; empty and absent now mean the
  same thing, and `pickerEmptyLabel` alone decides whether an empty catalog gets
  words. An adopter passing `pickerOptions={ [] }` and expecting a label must pass
  `pickerEmptyLabel`.

- **`useStreamGraph` replaces `useVisibilityGatedLink` and `useGatedSubscription`.**
  Both owned the same mechanism — close the stream while inactive, and on reopen
  choose between the recorded seek, a same-dir resume and a tail — one from the
  mount side with no pause, the other from the pause side with no mount. The one
  hook also builds the RemoteLink → Tee → view graph four dashboards each wrote out
  by hand.

- **`useLogCatalog` is the one polled catalog slice.** `usePartitionViewerGraph`'s
  `fetchLogStatus` / `logStatus` pair is gone, and with it the hand-rolled
  plumbing from `log_status` to the segment rail that both sides carried;
  `useSegmentBrowse` resolves its own rail.

- **Four unused surfaces are removed.** `LRU_Cache::get_multi()` and `set_multi()`
  had no caller in any plugin; `CommandInterpreterNode.isCommandInterpreter` had no
  reader, since both ports suppress a `set_sink` line by the interpreter's NAME
  (`_command_interpreter`); and the `authGeneration` re-export from
  `runtime/index.js` goes, though `authGeneration()` itself stays and imports from
  its own module.

- **A `make_node` line that will not build now refuses at load, loudly.** Three
  places stopped guessing:
  - `Grep_Node` compiles its pattern in `arguments()` and throws
    `InvalidArgumentException` on one that will not compile. `make_node Grep g
    '[unclosed'` used to be taken at face value and then DROP every message behind a
    warning storm.
  - `Schema_Reflection::coerce_argument()` refuses a malformed positional instead of
    casting it. `(int) 'abc'` was 0 and `(int) '9.9'` was 9, and zero is a live value
    for every knob it feeds — `lifetime 0` disables age pruning, `max_segments 0`
    means "derive".
  - `wp nodes restart <type> --partition=abc` is refused rather than restarting
    partition 0 and reporting success. Read an operator flag through
    `CLI::require_flag_int()` or `Service_CI_Node::require_option_int()`, never
    through the lenient `Core::as_int()`.

## 2.33.1

- **`useAskPicker`'s `onNothing` is gone.** It shipped in 2.33.0 and turned a click
  on nothing askable — a routine miss — into a consumer's error channel. The picker
  stays armed and the `?` cursor is what says so. `onAbandon` remains.

## 2.32.0

- **Commands ride the router tick; `useRequestNode`, `useReconcile` and the `Request`
  node class are gone.** A dashboard used to mint its own POST per awaited verb from
  a React callback, outside the `lock`/`flush` bracket the Router opens around each
  tick. Send through a Fetcher fanned from a hitchhiking Timer instead — `useCommandOnce`
  for one verb with an answer to wait on, `useBatchedPoll` for a slice:

  ```js
  // before
  const request = useRequestNode( … );
  // after
  const { run, isPending } = useCommandOnce( { … } );
  ```

  `CommandResultNode` is where a one-shot's reply lands. Every reply publishes,
  refusals included, and each carries the ARGUMENTS it answered and the SUBJECT its
  address named. `RouterNode.requestTick()` asks for a tick NOW, coalesced to one per
  commit, so a click's mutation goes on the tick it asked for.

- **`answerFor( subject )` is gone: the subject rides in the reply ADDRESS.** A
  minter appends what it is asking about to its own FROM — `vault:test:in/spoke-01`
  — the server echoes `TO = FROM`, `_router` peels the receiver, and the answer
  arrives naming the row. So ONE node per verb still serves ten rows: split by JOB,
  never by SUBJECT ([ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)).
  A subject is one path segment, escaped going out and read back on arrival.

- **`RemoteLink::resumePositions()` is gone; reopen with `reconnect()`.**
  A caller that recomputed the seek from outside the stream had only half the
  question. `resumePositions()` returned where the stream had READ, so a reopen
  after a refused connection — the SSE slot pool answering 429 before a single
  frame arrived — handed back null and the reopened stream tailed the log,
  discarding the replay the caller had asked for:

  ```js
  // before
  link.connect( isReconnect ? link.resumePositions() : seek );
  // after — the stream resumes past what it read, and keeps the seek it
  // opened with where it read nothing
  isReconnect ? link.reconnect() : link.connect( seek );
  ```

  `reconnect( subscribe )` also re-points the subscription, which is what a
  paused-then-played browser wants. To READ the cursor rather than reopen — a
  single-record step asks for it as a command argument — use
  `link.cursor( sub )`, which returns that one subscription's
  `{ segment, offset }`.

- **`answerStatus( answer, texts )` takes `busy` as a third argument.**
  The `busy` flag left the answer object: the hook that owns the outbox knows
  which subject is outstanding, so a screen asks it instead of keeping a flag
  beside every call site. `useCommandOnce` returns `isPending( subject )`, and
  an answer now carries only what came back.

  ```js
  // before
  answerStatus( { busy: true, error }, TEXTS );
  // after
  answerStatus( { error }, TEXTS, isPending( subject ) );
  ```

- **A browser Timer fires on a shared wall-clock grid.** `fireCb` fires on
  `nextBoundary( lastFire, interval )` rather than on its own arming time, so
  harmonic cadences meet and batch: 5s, 10s, 15s and 30s all land together every 30
  seconds, in one POST. ONE offset (`GRID_PHASE_MS`) serves every cadence, and the
  grid lives in `TimerNode` alone — a subclass picks a harmonic interval and never
  computes a boundary, which is what `lint-contract.mjs`'s `grid-math` rule
  enforces. A TEST that has to know where a boundary falls imports the offset
  from `@newspack-nodes/runtime` (2.32.1 exports it) and pins its clock FORWARD to
  just past one; moving a clock back reads to every watchdog as a stream gone
  silent. JS only; the PHP `Timer_Node` is unchanged
  ([ADR-17](architecture-decisions.md#adr-17-timers-fire-on-a-shared-wall-clock-grid)).

- **A programmatic builder hands `makeNode` the CLASS, not a registered name.**
  `CommandInterpreterNode.includeNodes` is a per-bundle static, so a name one bundle
  registers does not resolve in another — a devtools-hub tab building its graph
  through another bundle's interpreter finds nothing, with every test green, because
  a test loads one bundle. A NAME stays the TSL and palette surface. `register.js`
  files export their classes as well as registering them, and
  `registerNodeClasses( map )` returns the map so one declaration serves both
  ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)).
  `scripts/lint-contract.mjs` fails the build on a name resolved where a class
  belongs — in a `makeNode` call or a hook option — and on six other contract
  shapes; it is vendored into every sibling and wired into `lint:js` and
  `pre-commit`.

## 2.31.0

- **`POST /v1/command` demands READ at the door, and every verb declares its own
  role.** Authority is cut by BLAST RADIUS: `read` changes nothing, `tune` writes
  values a schema already bounds, `manage` takes the site down or hands out access.
  Declare the role in `node_schema()` (`'capability' => 'read'`); a verb declaring
  none gets MANAGE, the strictest. The base interpreter is pinned to MANAGE by the
  controller, with a READ exception list for the builtins every dashboard drives
  (`taillog`, `dump_metadata`, `list_nodes`, `uptime`, …). All three roles still
  default to `manage_options`, so nothing changes until a site filters
  `newspack_nodes/capability_map` or runs `wp nodes caps install`.

- **`POST /v1/auth` accepts `scope`, `label` and `ttl`, and the response carries
  `scope`.** A scope is a CEILING, so it can only ever subtract: the session is
  granted the highest role the issuing user holds WITHIN the scope it asked for,
  and the response names what was granted rather than what was requested. An
  unrecognised scope is refused outright; `ttl` is clamped to 60..86400 seconds
  and defaults to 3600; `Command_Auth::verify()` fails CLOSED on every refusal.

- **`wp nodes caps <status|install|uninstall>` and `wp nodes hub-user <login>`.**
  `install()` grants all three capabilities to every role that already held
  `manage_options`, so a site with a custom Ops role is not locked out by a
  migration billed as non-breaking. `hub-user` then creates the least-privilege
  aggregator user and issues it an application password, shown once — which retires
  the admin application password a hub used to hold on every spoke to do nothing but
  pull a read-only stream.

## 2.30.0

- **Log-stream filtering is an INGEST gate on the view node.** `LogRowList` loses its
  `filter` and `matchRow` props along with its per-frame scan of the ring;
  `LogStreamViewer` gains `onFilter`, which sends the view's `filter` control. A
  subclass with more searchable fields overrides `matchesFilter( fields, filterLower )`
  on its view node. Filtering at render time meant non-matching rows still consumed
  ring slots, so a rare match aged out while its filter still stood. Changing the
  filter does not clear the ring; `Clear` is the control that empties it, and the
  filter is re-sent on a graph rebuild.

## 2.29.0

- **The SSE slot pool is host-wide, and its methods lost `$user_id` / `$ip_hash`.**
  The pool was keyed per user/IP, so it never bounded a host — each additional
  reader arrived with its own budget. Slots are now one pooled keyspace per
  `machine:site`, sized by the new `sse_max_streams` (default 6). The holder's
  identity moved out of the cache key into the lease VALUE, and `sse_max_slots`
  (default 3, previously a hardcoded 10) became one reader's SHARE of the host
  budget rather than a private pool:

  ```php
  // before
  SSE_Slot_Pool::acquire( $ns, $user_id, $ip_hash, $max_slots, $ttl );
  SSE_Slot_Pool::touch( $ns, $user_id, $ip_hash, $slot, $owner, $ttl );
  // after
  SSE_Slot_Pool::acquire( $ns, SSE_Slot_Pool::identity(), $max_streams, $max_per_identity, $ttl, $reserved );
  SSE_Slot_Pool::touch( $ns, $slot, $owner, $ttl );
  ```

  `check()`, `release()` and `inspect()` drop the same two parameters. Nothing
  changes on the wire: a connection still holds exactly ONE lease, so
  `workers heartbeat <slot> <owner>` is unaffected. Old lease keys expire within
  `sse_slot_ttl`; old POINTER keys were written with no expiry and are orphaned —
  nothing sweeps them, so they sit, bounded and harmless, until cache eviction or
  a restart.

  Both bounds and the TTL are config keys (`sse_max_streams`, `sse_max_slots`,
  `sse_slot_ttl`). Read [sse-host-budget.md](sse-host-budget.md) before raising any
  of them — an SSE stream holds a php-fpm child for its whole life, and exhausting
  the pool has the host refuse readers' requests with 429 while it stays
  exhausted. Two bounds are enforced rather than documented: `sse_slot_ttl` is
  raised to the 45-second re-auth window when configured below it, and
  `sse_max_slots` is capped at `sse_max_streams`.

  Hub operators: a `Remote_Source` pull draws from the spoke's host budget like
  any browser. Set `sse_reserved_slots => 1` on each spoke so dashboard tabs
  cannot starve the pull. It comes out of `sse_max_streams`, so a spoke with 6
  streams and 1 reserved serves 5 browsers and keeps the sixth for the hub.

## 2.28.0

- **`Table_Node` drops the read-through L1.** The third `make_node Table` argument,
  `table()`'s third parameter and the `l1_ttl` TSL token are gone; the node takes
  `<namespace> [ttl]` and `Table_Node::table( $ns, $ttl )` is the whole static
  signature. Drop the third token from any TSL line. It shipped in 2.21.0 and never
  had a consumer.

- **An opt-in accumulator tier replaces it.** `accumulator( $bucket_size,
  $num_buckets )` puts an `LRU_Cache` in front for values a caller is still folding
  into, with `accumulate()` / `accumulated()` / `accumulating()` / `reset()`.
  `accumulated()` reads through to `lookup()` for a cold key, so an evicted entry
  resumes from what was last stored, and `accumulate()` without opting in THROWS
  rather than silently dropping the value.

- **`Table_Node::store()` returns `bool`.** True when the backend accepted the
  write. A caller that shadows its writes durably must not record a set the backend
  refused, or a failed write is resurrected on cold boot as though it had landed.
  Callers ignoring the return are unaffected.

- **`LRU_Cache::without_promotion()` and its `$promote` flag are gone.** The
  read-through L1 was their only consumer: promotion-off is what a cache of storage
  wants and what an accumulator must not have, since eviction there loses counts.

## 2.27.0

- **`before_job` is a FILTER, and `after_job`'s arguments moved.** Every listener on
  `newspack_nodes/job_worker/before_job` now receives the decision as its FIRST
  argument — `( $run, $handler, $id, $message )` — and must return it:

  ```php
  // before
  \add_action( 'newspack_nodes/job_worker/before_job', $cb, 10, 3 );   // ( $handler, $id, $message )
  // after
  \add_filter( 'newspack_nodes/job_worker/before_job', $cb, 10, 4 );   // ( $run, $handler, $id, $message )
  ```

  Returning `false` DECLINES the job: the handler never runs, nothing is counted,
  and no batch is settled. That is how a plugin refuses work addressed to another
  host without the worker opening a request context for it. A listener that returns
  nothing fails open (jobs still run) but **overwrites a decline** made at an earlier
  priority, so return the value you were given — and keep any routing check in the
  handler too, as defense in depth.

  `…/after_job` passes `( $handler, $id, $outcome )`; `$id` moved from third to
  second. Raise `accepted_args` by one for listeners that read `$outcome`.

- **`Job_Intake` takes `$id` second.** `queue()`, `feed()`, `write_job()` and
  `write_feed()` are now `( $handler, $id, $parameters, $key, … )`, matching the
  handler contract `( string $id, array $parameters )` and the hooks above. `$id` has
  no default — pass `null` when a job genuinely has no identity:

  ```php
  Job_Intake::queue( 'evtemplate', $template, $parameters );        // was ( $handler, $parameters, $key, $id )
  $intake->write_job( 'importer', null, $parameters, 'jobintake' );
  ```

- **`Jobstats_Record::KEY` is `Jobstats_Record::IDENTITY`** (`KEY` → `IDENTITY` in the
  `jobstats-record.js` mirror). The field always held `handler:id`, never a partition
  key. Index 0 is unchanged, so no record on disk moves — rename references only.

- **Producers emit `{handler, id, parameters}`.** Presentation only; consumers read by
  key, so nothing to do unless you byte-compare log lines.

## 2.26.1

- **A durable reader's cursor names the next UNREAD record.** A reader booting onto
  a 2.26.0 offsetlog frame that still carries `quarantined` forwards that record
  once, because the key no longer means anything: one duplicate per stuck cursor, no
  data loss. Nothing to change — a dead-lettered record is now committed past rather
  than marked and re-read.

## 2.26.0

- **The SSE `positions` wire carries seek sentinels, so a spoke upgrades before its
  hub.** `SSE_In_Node` now always sends a position, using `-1` (`SEEK_END`) when it
  has none, where it previously OMITTED the parameter to mean the same thing. An
  upgraded hub pulling a spoke that is still on an older substrate sends `-1` to a
  `next_offset()` that does not know the sentinels: it falls through that method's
  `default:` case and seeks to **start**, so the hub replays the spoke's entire
  retained firehose once, per partition, on its first connect after the upgrade.

  Nothing is lost and it self-corrects — the next checkpoint commits a real position
  and the replay does not repeat — but the aggregated volume is a spike, and every
  replayed record dispatches downstream again (at-least-once, so job handlers see
  duplicates). There is no compatibility shim: the fix is ordering.

  **Upgrade spokes before hubs.** A spoke on this version answers `-1` correctly no
  matter what the hub sends, so a spoke-first rollout has no window at all. If a hub
  goes first anyway, expect one replay per spoke partition and let it settle rather
  than restarting workers mid-replay.

## 2.25.0

- **`Tail`'s `source_mode` argument is gone; single-file follow is its own class.**
  The two source shapes are now two classes, the way every other "same spine,
  different source" pair in the substrate already is (`Log extends Partition`,
  `Tap extends Tee`). Nine methods opened with the same
  `if ( MODE_FILE !== $this->source_mode )` preamble, and file mode left the
  inherited `$source` Partition null — a Consumer quietly violating its parent's
  invariant, survivable only because the three parent methods that read it
  happened to be overridden.

  ```tsl
  # before
  make_node Tail debugtail /var/log/debug.log <offsetlog> "" file
  # after
  make_node File_Tail debugtail /var/log/debug.log <offsetlog>
  ```

  Segmented `make_node Tail <name> <source_file> [offsetlog_dir]
  [deadletter_dir]` is unchanged — only the 4th argument is dropped.
  `Tail_Node::MODE_SEGMENTED` / `MODE_FILE` remain as the `Log_Sources` registry's
  mode tokens; `Log_Sources::open_tail( $entry )` is the ONE place a token
  becomes a reader class. In-tree callers (the `taillog read` builtin and the
  `/log/stream` SSE controller) already route through it.

- **`LogStreamViewer` requires `onClear`.** Clear travels as a control message to
  the view node; the fallback that reached past the graph and assigned
  `node.lines = []` — the very thing the control replaced — is gone, so a viewer
  mounted without the prop throws on the first click. Send the view's `clear`
  control from the handler you pass.

- **`DumperNode.captureNextReply()` is gone**, with `CAPTURE_TTL_MS` and the
  `_maybeCapture` machinery. A single-slot pending-reply map keyed by command name,
  living on the shared `_output` node, is the correlation
  [ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies) rules
  out. Mint the command FROM your own receiver node instead: the server echoes
  `TO = FROM`, so the reply lands there and the addressing correlates it.

## 2.24.0

- **The browser `ShellNode` has ONE entry point, `fill( message )`.**
  `sendCommand( path, verb, args )` is gone, and `parse()` / `dispatch()` are
  internals again — a caller that sequenced them (parse, inspect what came
  back, dispatch) no longer can, because a builtin now acts and prints instead
  of returning a `{ kind: 'local' | 'error' }` signal. Send a typed line the
  way the REPLs do:

  ```js
  const line = newMessage();
  line[ TYPE ] = TM_BYTESTREAM;
  line[ VALUE ] = 'connect_node a b';
  shell.fill( line );
  ```

  Anything that sends through a Shell must hold its reference or sink into it;
  the Shell stays unnamed, so no message can reach it by routing. Outbound
  per-send work — the equivalent of the console's reply-path guard — belongs in
  an unnamed node between the Shell and its sink, not in the caller. Nothing in
  any sibling plugin used either API.

- **A browser graph needs a `_stdout` node, or builtin output goes nowhere.**
  `print`, `var`, `status`, `show_parse`, `debug_level` and every usage line now
  emit through `Core.node( '_stdout' )` rather than `_output` — the Dumper renders
  MESSAGES, and a builtin prints text. Mount a `StdoutNode` whose stream writes
  into whatever the host shows; both REPLs hand it
  `{ write: ( text ) => dumper.appendText( text ) }`. Without one, the Shell
  drops the text silently, and the browser has no fallback of its own: PHP's
  `Shell_Node::stdout()` hands the line to `Node::print_less_often()` when
  nothing answers to `_stdout`, so a worker's builtin output and TSL refusals
  still reach the stderr log, rate-limited. The two ports also differ in
  strictness — PHP takes only an `Stdout_Node` instance, the browser whatever
  node holds the name.

- **`debug_level` is Dumper state, not a caller-held ref.** Read it with
  `useNodeState( '_output', 'debug_level' )`. The `debugLevelRef` a consumer
  assigns still drives rendering, but `DumperNode.setDebugLevel()` is the only
  thing that should move it, so a React mirror updated by hand will drift.

## 2.23.0

- **The SSE `id:` line and the whole `Last-Event-ID` chain are gone; `positions`
  is the only resume input.** This reverses the 2.11.0 note below.
  `track_cursor()`, `cursor_token()`, `sanitize_id()`, `resume_positions()`,
  `parse_cursor_token()` and `send_sse_event()`'s `$id` parameter go with it. A
  freshly constructed `EventSource` never sends `Last-Event-ID` — only the
  browser's own in-place retry does — so every path that built a new stream
  (visibility change, nonce renewal, watchdog force) tail-seeked past the window
  the reader had come back for. The `connected` envelope now ends with
  `CURSORS <dir>=<segment>:<offset>`, comma-separated, naming where each
  subscription STARTS, so a stream that closes having delivered nothing still
  leaves a resume point. A hand-rolled client reads that, advances its own
  cursor from each record's FROM and ID breadcrumb, and sends the result back as
  `positions`.

- **The reopen schedule is an `event: retry`, not the protocol `retry:`
  field.** The protocol field arms the browser's own reconnect, and a
  browser-made reconnect is the only thing that sends `Last-Event-ID`. The
  client owns the schedule instead: the JS takes over an `EventSource` entering
  CONNECTING, closes it, and reopens on the server's interval. The value is
  still `sse_retry_ms`; read it off the `retry` event rather than off the field.

## 2.22.0

- **The `commandClient` seam is gone.** Every hook that took it —
  `useBatchedPoll`, `useVaultGraph`, `useTopologyManager`,
  `useAggregatorStatusGraph`, the stream hooks and both Viewers — no longer
  does, and several lost their options object with it. Injecting a client double
  replaced the whole transport subsystem, so a hook test exercising it ran
  neither `HttpOut` nor pack/unpack, the Router or the interpreter. Replace
  `fetch` alone with `installFakeCommandWire`, which records what was POSTED on
  `wire.batches` and leaves the rest as real covered code. `makeFakeCommandClient`
  is deleted, and no `CommandClient` class remains anywhere in the runtime: the
  egress is `HttpOut` plus a lazily-defaulted `commandTransport`.

- **`Probe_To_Graphite_Node` emits `<prefix>.<reader>.<field>`.** The hostname
  and the hardcoded `nodes.topics` segment leave the middle of the path, and the
  prefix carries the whole leading path, defaulting to `nodes.topics` — a
  per-host tree started a fresh series every time a worker moved hosts, and the
  fleet is network-global. This supersedes the path in the 2.11.0 note below.
  `bytes_read_delta` and `cache_size` join `distance` and `msgs_delta`, and the
  default interval drops from 60s to 15s. Re-point any Graphite dashboard that
  names one of these series.

## 2.21.0

- **`Table_Node::lookup()` is an instance method**, and the namespace and TTL
  come from the table rather than from every call:

  ```php
  $value = Table_Node::table( $ns, $ttl )->lookup( $key );   // was Table_Node::lookup( $ns, $key )
  ```

  `store()`, `forget()` and `rm()` are instance methods for the same reason;
  `entry_key()` stays static. This release also gave `table()` a third `l1_ttl`
  argument, removed again in 2.28.0 above.

- **A job handler is called `( string $id, array $parameters )`, and receives no
  `Message`.** `$id` leads because every job has one and it is what the request
  context is named for; a producer that omits it is a bug rather than a
  shorthand. There is no additive intermediate — reversed, a handler declared
  for an array receives a string and dies at the boundary — so the substrate and
  every handler in every consumer ship together. Per-job request context belongs
  to `newspack_nodes/job_worker/before_job` and `…/after_job` alone; listeners on
  those two are unaffected.

## 2.12.0

- **`Bootstrap::supervisor()` is renamed to `Bootstrap::spawn_coordinator()`,
  and `Bootstrap::is_supervisor_enabled()` to `Bootstrap::is_fleet_enabled()`.**
  The test seams follow: `$supervisor_factory` → `$spawn_coordinator_factory`,
  `$supervisor_enabled_override` → `$fleet_enabled_override`. No aliases —
  rewrite each call. The methods never returned a supervisor; the first hands
  back a `Spawn_Coordinator`, and the second gates the whole fleet, including
  `Fleet_Node::fire()`.

- **`$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` on the reconcile pass is now
  `reconcile`, not `supervisor`.** This reverses the 2.11.0 note below. Nothing
  in any plugin compares against the literal — it is a stats dimension, not a
  worker type — so the only effect is that event-logger rows filed under
  `supervisor` stop growing and a `reconcile` series starts beside them. Update
  any saved dashboard filter or query that pinned the old value.

- **The `'supervisor_only'` restart classification is gone; use `[]`.** The two
  were already identical — `Restart_Planner::topologies_for()` resolved both to
  "restart nothing" — while the settings UI printed a different sentence for
  each. A `Field` still carrying the string keeps working (an unknown string
  resolves to no restart), but it now renders under the same label as `[]`.

- **A `settings set` command that does not change the value is a no-op.**
  `Settings_CI`'s `set` verb now compares against the stored value first and
  skips the write, the `Config::reset()`, the restart request and the reload
  request when they match. It still returns the same post-set snapshot, so no
  caller changes. This is what a hub's `Settings_Sync` sweep needs: it re-pushes
  every registered option on its interval whether or not anything moved, and
  acting on those pushes recycled a spoke's whole fleet once per sweep.

- **`Lock_Node::should_restart(): bool` is replaced by
  `Lock_Node::restart_reason(): string`.** `''` means keep running; anything
  else is the reason, and goes verbatim into the worker's stop line. Rewrite
  `if ( $lock->should_restart() )` as `if ( '' !== $lock->restart_reason() )`.
  The three situations that share this channel — an operator's restart flag, a
  vanished heartbeat, a peer that stole the lock — all used to log `restart
  requested`, which sent operators looking for a restart nobody ran.

- **A failed SSE slot heartbeat now names the state it found.** The
  `workers heartbeat` verb still errors with `SSE slot lease not owned`, now
  suffixed with `: pointer_missing`, `: slot_released`,
  `: pointer_owner_mismatch`, `: liveness_missing`, `: backend_read_error` or
  `: recovered_during_inspection`. A client matching on the exact old string
  needs a prefix match instead. `slot_released` is the release tombstone
  (pointer 0) and means a normal reconnect race, not a takeover — treat it as
  routine, as `Remote_Link_Node` does.

## 2.11.0

- **`/messages/stream` and `/log/stream` now END on their own.** A stream that
  carries no `msg` event for `sse_idle_timeout` seconds (default 15) closes,
  after advertising the SSE `retry:` field (`sse_retry_ms`, default 5000) at
  stream start. A browser `EventSource` needs no change — reopening on `retry:`
  is what it is for, and it echoes the `id:` below automatically. A hand-rolled
  client does: treat a clean EOF as a scheduled reconnect, not a failure, and
  resume from the last `id:` (or its own cursor). The close carries NO
  `disconnect` frame; that frame still means the lease was lost. A client that
  cannot be changed keeps the old behavior by setting `sse_idle_timeout` to 0.

- **Every `msg` now carries an SSE `id:`, and `Last-Event-ID` beats
  `positions`.** The id is the whole stream's resume state —
  `name=segment:offset` per live subscription — and a reconnect that presents it
  resumes each subscription exactly where it stopped, overriding the query
  parameter per subscription. Treat it as opaque: the offset is already the next
  read boundary, so adding a record length to it seeks into the middle of a
  record. A client that sends `positions` and no `Last-Event-ID` is unaffected.

- **The `aggregator` `summary` verb gained an `idle` count.** `connected` now
  means actively streaming, `idle` means closed at EOF and due back, and both
  are up — a dashboard that renders `connected / total` will under-report a
  healthy fleet. Add `idle` to the numerator. The per-partition snapshot gained
  `scheduled_reconnect_at` (unix second, null when not waiting on a schedule):
  that is the explicit idle reading, since a null `last_error` also means
  "never attempted".

- **`wp nodes restart supervisor` is gone, because the supervisor is gone.**
  There is no singleton process to restart. Workers revive each other through
  the `_fleet` scan every one of them runs, so restarting a worker is the only
  operation left: `wp nodes restart <type>`, or `wp nodes restart all`. Drop the
  `supervisor` target from any script — it is rejected, not ignored.
- **`wp nodes status` and `wp nodes types` no longer report a supervisor.**
  `status` drops the partition `-1` row that led its table; `types` drops the
  separate "singleton supervisor" line above the topology groups. Anything
  parsing `--format=json` for a row whose partition is `-1`, or for a
  `supervisor` key, finds neither. Every remaining row is an ordinary
  `type.p<N>` worker.
- **`POST /workers/spawn` with `type=supervisor` now returns 400.** The type is
  no longer valid; there is nothing to spawn. Cold start is WP-Cron's single
  pass, not a spawn request.
- **`wp nodes doctor` replaces the `supervisor-liveness` check with
  `housekeeping`.** The new check is load-bearing in a way the old one was not:
  fleet housekeeping — retention, orphan partition and IPC reaping, the
  delayed-jobs sweep, alert emission and every `newspack_nodes/periodic`
  subscriber — now rides the minute cron pass alongside cold-start revival, so an
  install whose `newspack_nodes/reconcile` event was vetoed or cleared loses all of
  it silently. If doctor reports it CRITICAL, run
  `wp cron event schedule newspack_nodes/reconcile now newspack_nodes_minute`
  (visiting wp-admin also re-arms it, on `admin_init`).

- **The cron event, its handler and its lifecycle actions are renamed.**
  `newspack_nodes/supervisor` → `newspack_nodes/reconcile`,
  `Bootstrap::run_supervisor_tick()` → `Bootstrap::reconcile_fleet()`, and
  `newspack_nodes/before_supervisor_run` / `newspack_nodes/after_supervisor_run`
  → `newspack_nodes/before_reconcile` / `newspack_nodes/after_reconcile`. No
  aliases: rewrite each `add_action()` — the callback, priority and argument
  count all stay as they are. Two operator notes:
  - Plugin activation and the `admin_init` self-heal both schedule the new
    event, so nothing stops being revived. But nothing unschedules the OLD
    event either, so an install that carried it keeps firing a hook no code
    listens to, once a minute, forever. Clear it once with
    `wp cron event delete newspack_nodes/supervisor`.
  - `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` is deliberately UNCHANGED at
    `supervisor`. It is the label newspack-event-logger-nodes files this pass's
    per-URL stats row under, and renaming it would only split that row's
    history.

- **Delayed jobs are delivered on the minute, not every 15 seconds.**
  `Job_Delay::sweep_action()` moved to the cron pass with the rest of
  housekeeping, so a job enqueued with `not_before` / `delay` now fires within
  60s of becoming due rather than 15s. `not_before` means *not before*: firing
  late is correct, and firing early would be the bug. If you need tighter
  granularity, run the work on your own `Timer_Node` instead.

- **`Job_Intake::try_queue()` is removed.** It was added in this same release
  for the fleet-sweep enqueue, and that enqueue no longer exists — housekeeping
  runs in the cron pass, not as a job. `Job_Intake::queue()` is the one entry
  point again. If you were calling `try_queue()` from inside a worker's drain
  loop, do the work on a `Timer_Node` in that graph rather than writing to the
  intake from the drain loop.

- **The `TopicProbe` node type is renamed `Topic_Probe`.** The class is
  `Topic_Probe_Node`, matching its sibling `Job_Probe_Node` and ADR-10. There is
  no alias: a topology whose own file says `make_node TopicProbe <name> [interval]`
  fails to resolve a class at load. Rewrite it to `make_node Topic_Probe …`.
  Stock `topic-probe.tsl` is already updated, so an `include topic-probe` needs
  no change, and neither does the node name `topicprobe` or the `topicprobe.p0`
  log path.

- **The `topicprobe.p0` and `jobstats.p0` record layouts changed: counters are
  now per-interval deltas.** A worker recycles every ~595s, so a cumulative
  in-process counter resets six times an hour and any reader differencing
  consecutive records reported a rate of 0 at each reset. Each record now
  carries the work done since that reader's previous sweep plus an `ELAPSED_MS`
  covering it, so you divide ONE record: `rate = DELTA / (ELAPSED_MS / 1000)`,
  guarding `ELAPSED_MS === 0` (two sweeps can share a clock second). Drop any
  prior-record state, reset detection or negative clamping you kept.

  Renames, all at their existing indices — there is no alias, so a reader
  referencing an old constant fails at import:
  - `Probe_Record::MSGS` → `MSGS_DELTA` (index 7)
  - `Jobstats_Record::{RUNS, ERRORS, DURATION_MS, QUEUE_MS, ITEMS_OK,
    ITEMS_ERR}` → the same names with a `_DELTA` suffix (indices 2..7)

  New slots: `Probe_Record::BYTES_READ_DELTA` (10) and `ELAPSED_MS` (11);
  `Jobstats_Record::ELAPSED_MS` (12). If you derived a byte rate by
  differencing `Probe_Record::END_BYTES`, switch to `BYTES_READ_DELTA` —
  `END_BYTES` is the partition's on-disk size and drops when retention deletes
  a segment, which read as a second spurious reset. `END_BYTES` itself is
  unchanged and still the on-disk footprint.

  Backward compatibility was waived: records written before the upgrade decode
  with the new meanings until they age out, and both logs keep 24h.

- **`Consumer_Node::probe_stats()` and `Job_Worker_Node::probe_stats()` are
  DRAINING reads.** Each call returns the window since the last call and
  re-baselines, so calling one twice a tick halves your data. Mount at most one
  `Topic_Probe` and one `Job_Probe` per process — what a stock topology already
  does. If you call `probe_stats()` from your own code for a one-off reading,
  stop; read the log instead.

- **`wp nodes status` renames the consumer table's `Msgs` column to
  `Msgs/int`**, and `Probe_To_Graphite_Node` emits
  `<prefix>.<host>.nodes.topics.<reader>.msgs_delta` where it emitted `.msgs`.
  Both now report per-probe-interval counts rather than a cumulative; the
  renames are there so the change of meaning is visible instead of silent.
  Update any Graphite dashboard or `--format=json` consumer that names them.

- **`buildAlignedSeries`'s RATE aggregate is `agg: 'rate'`, not `agg: 'max'`,
  and its points carry a `weight`.** If you call it directly, pass points shaped
  `{ ts, value, weight }` — `weight` being the denominator `value` is a
  quotient of (seconds for a per-second rate). A point with no weight still
  counts, degrading to a plain mean. Passing `agg: 'max'` is no longer
  recognised and falls through to the rate aggregate.

- **`newspack_nodes/supervisor_periodic` is renamed to
  `newspack_nodes/periodic`, and it fires on the minute.** There is no supervisor
  left to name, and the hook now rides `Bootstrap::reconcile_fleet()` with the rest
  of housekeeping rather than the supervisor's 15-second tick. There is no alias and
  no deprecation shim: a subscriber still on the old name is never called, silently.
  Rewrite each `add_action( 'newspack_nodes/supervisor_periodic', … )` to
  `add_action( 'newspack_nodes/periodic', … )` — the callback, priority and
  argument count all stay as they are. Work that needs a tighter cadence belongs on
  your own `Timer_Node`.

## 2.9.0

- **`max_segments` moved ahead of `min_lifetime` in the retention positionals.**
  `Partition`, `Log` and `Topic` all declare
  `segment_size, min_segments, num_segments, max_segments, min_lifetime, lifetime`.
  The hard cap used to sit in the trailing slot, so a TSL line that passed the
  five other axes and omitted it now reads its `min_lifetime` as `max_segments`
  and its `lifetime` as `min_lifetime`, leaving the age rule off. Pass the slot
  explicitly — `0` derives the cap as `2 × num_segments` through
  `Partition_Node::derive_max_segments()`:

  ```tsl
  # before — max_segments in the trailing slot
  make_node Partition topicprobe:log <path> 1048576 2 8 86400 86400
  # after — max_segments is the fourth axis, derived here
  make_node Partition topicprobe:log <path> 1048576 2 8 0 86400 86400
  ```

- **The stock probe node is `topicprobe`, not `_topicprobe`.** A `connect_node`,
  a `cmd` or a `target` naming the underscored form resolves nothing. The log
  path `topicprobe.p0` is unchanged; the node TYPE was renamed separately in
  2.11.0 above.

- **`wp nodes scaffold node` writes into the plugin's `includes/`, under the
  plugin namespace.** Both doors have to open at once: `scaffold plugin`
  classmaps exactly `includes/` and registers the plugin prefix, so a class
  taking its path AND its namespace from the cwd satisfied neither — run from
  the plugin root the file fell outside the classmap, run from `includes/` the
  namespace came out `Includes`, which `make_node` never resolves. The command
  derives the plugin root from the cwd, creates `includes/` when it is missing,
  and writes the same file from either directory. Only a cwd named `includes`
  puts the class beside you. This narrows the 2.3.5 note below to `scaffold
  topology`.

## 2.3.5

- **`wp nodes restart <type>` restarts every partition; `--all-partitions` is
  gone.** Restarting one of six partitions left five running the old code, so
  the safe behaviour is now the default. Drop the flag from any script — it is
  rejected, not ignored. `--partition=<N>` still narrows to one.
- **`wp nodes scaffold node|topology` writes into the current directory**, not
  into `includes/` and `topologies/`. `scaffold plugin` still creates the full
  tree; cd to where you want the file, or move it after. 2.9.0 above returns
  `scaffold node` to `includes/`, so the rule holds for `scaffold topology`
  alone, which drops a bare `<name>.tsl` wherever you stand.
- **The `runtime_stats` verb is removed.** It bundled `list_timers`,
  `list_handles` and the Router profile table into one struct for the devtools
  views, and its profile third had silently fallen behind the text verb's
  columns. Each of those three verbs now takes `-s`, returning the same rows its
  table is built from: `list_timers -s`, `list_handles -s`, `list_profiles -s`.
- **Verb errors are newline-terminated.** `interpret()` appends `\n` to the
  TM_ERROR payload in both the PHP and JS interpreters, so a REPL that prints
  the payload verbatim does not run the message into the next prompt. Anything
  matching an error payload exactly needs the trailing newline.

## 2.2.4

- **SSE leases now carry an opaque owner token.** The `connected` envelope adds
  `OWNER <positive-decimal>`, and `workers heartbeat` now requires exactly
  `[ slot, owner ]`; the old client-supplied TTL argument is gone. Custom
  `SSE_Out_Node` slot seams must pass the complete `{slot, owner}` lease to
  check, release, and failure inspection. Custom clients must retain OWNER
  exactly as text and send it back with SLOT.
- **This cutover has no mixed-protocol compatibility mode.** A new client
  rejects an old ownerless handshake, while a new server reads an old
  heartbeat's TTL as a non-matching owner. Deploy Nodes 2.2.4 and every plugin
  bundle that inlines its runtime in the same maintenance window, then restart
  the affected workers and aggregators so every connection reconnects on the
  new protocol.
- **A deliberate lease-loss close now sends a terminal `disconnect` SSE
  event.** Its packed Message carries a non-empty machine key and a safe display
  reason; consume that frame and prefer its reason over the transport's later
  generic close event.

## 2.0.0

- **A command sent to `/command` must be signed; the REST boundary no longer
  signs on your behalf.** Before 2.0.0, `HTTP_In` signed whatever request
  passed `manage_options` — reaching the endpoint was enough. As of 2.0.0,
  ingress signs nothing: an unsigned command is refused
  (`verification failed: bad envelope`), and a batch with any refusal answers
  **401** instead of 202. Fix: mint a session first
  (`POST /wp-json/newspack-nodes/v1/auth`), then sign every command with the
  session key before sending it. The runtime's own Shell and dashboard hooks
  already do this via `Node.command()` (JS) or `Command_Auth::sign()` /
  `sign_for()` (PHP) — a hand-built `TM_COMMAND` message that skips this step
  is constructed but never delivered. See
  [API.md → Command Signing](API.md#command-signing).

## 0.53.0

- **The retention axes are renamed.** `max_lifetime` becomes `lifetime` — the
  age rule, `0` disabling it — and `max_segments` becomes `num_segments`, the
  count target the oldest are pruned back to, but only ones older than
  `min_lifetime`. The freed `max_segments` name is now the true hard cap, which
  prunes the oldest UNCONDITIONALLY above its count and closes the
  unbounded-growth hole a partition full of young segments fell through. Rename
  the `<config:max_lifetime>` and `<config:max_segments>` TSL tokens to
  `<config:lifetime>` and `<config:num_segments>`, and the
  `wp nodes ingest --max_segments` flag to `--num_segments`. The positional
  order moved again in 2.9.0 above.

- **Static TSL analysis splits statements on an unquoted `;`,** matching what the
  runtime Shell always did. A `.tsl` whose `;`-joined line the conflict gate,
  the orphan sweep and the console graph had all misread as one malformed
  statement is now parsed as the several statements it builds — so a deployed
  file may surface a real conflict those gates had been missing.

## 0.51.0

- **`set_snapshot_node` deleted; `add_snapshot_node` replaces it.** A Consumer now
  snapshots a LIST of nodes; the offsetlog frame's `cache` is a map keyed by node name.
  Fix: rename the verb in your TSL (repeat the line per node). If you READ frames
  (`Partition_Node::read_latest_snapshot_cache()`), pass the required `$node`
  argument and descend `cache[<node>]`. Frames written by 0.50.x skip their snapshot
  restore once on upgrade (state re-accumulates; cursors resume normally).
- **`Job_Router` (event-logger) sheds `stale_timeout`** — staleness is the
  `Age_Sieve` node's job. Fix: drop Job_Router's positional argument and wire
  `make_node Age_Sieve jobs:sieve 900 1` between it and `jobs:partition`, which
  is what stock `job-router.tsl` ships.

## 0.50.0

- **Consumer cursors re-keyed to `{topology}.{source}.pN`.** Offsetlog paths in the
  stock topologies flip from `{source}.{topology}.pN`; no migration shim — on upgrade
  every consumer starts from its `default_offset`, which is the start of the log for
  a `Consumer` and the end for a `Tail`. Fix: nothing to do unless you pinned custom
  offsetlog paths; then re-key them to match and expect one cursor reset.

## 0.49.0

- **The `newspack_nodes/alert` action is gone; alerts are journaled to
  `alerts.p0`.** `Alerts::emit()` writes one TM_STRUCT record per severity
  TRANSITION into the substrate's own `alerts.p0` partition — KEY is the stable
  condition key, and VALUE carries `m`, `ts` and `severity` (`warning`,
  `critical`, or `resolved` when a condition clears). There is no alias and no
  shim: a subscriber still on the action is never called, silently. Tail
  `alerts.p0` with a Consumer for push delivery, and journal a condition of your
  own with `Alerts::journal_event( $key, $text, $severity )`. `Log_Cleaner` spares
  the directory through the `newspack_nodes/registered_log_producers` filter, so
  it survives on an install where no topology declares it.

## 0.48.0

- **Profiling verbs collapsed into one `profile` toggle.** `enable_profiling` and `disable_profiling` are removed (no alias): bare `profile` toggles, `profile on` / `profile off` set idempotently. Anything invoking the old pair gets an unknown-command error. `list_profiles` is unchanged.

- **CommandInterpreter verb `debug_state` renamed to `trace`.** The per-node/interpreter trace toggle is now the `trace` verb (`trace [ <node> [ <level> ] ]`); the old `debug_state` name is gone (no alias). Anything invoking `debug_state` at the REPL or over the wire gets an unknown-command error — use `trace`. The `debug_state` node *property* and the `dump_metadata` `debug_state` field are unchanged.

## 0.47.1

- **Dashboards / hub verbs** — `Aggregator_CI` dropped its dead `status`, `health`, and `servers` verbs. Anything invoking them gets an unknown-verb error; read `summary` and `servers_status` instead.
- **JS runtime** — the `Core.reinit` global is retired; the overlay's Reset-Graph capability is now the `Core.rebuildable` boolean.
- **Node schemas** — a `node_schema()` argument whose `<config:…>` default resolves to no registered key (unknown namespace, unowned key, non-scalar) now throws instead of silently coercing to `''`. If a node stops constructing, its schema default names a key that no longer exists — check the retention keys in particular (`min_segments` / `max_segments` / `min_lifetime` / `max_lifetime`). Topology-line interpolation is unchanged (an unowned token still interpolates to `''`, Tachikoma parity).

## 0.47.0

- **Command envelopes and `arguments()`** — TM_COMMAND `arguments` and node-constructor `arguments` are a flat token array (`list<string>` argv) end to end, no longer a single space-joined string. Verb handlers receive `array $args` and index it; `Node::arguments()` / `parse_schema_args()` take and return token arrays; anything minting a command envelope by hand passes a token list. `Command_Args::parse()` / `format()` speak tokens on both sides; the only join-back-to-a-line lives in `Node::serialize_args()` / JS `serializeArg`. TM_INFO / TM_REQUEST / TM_BYTESTREAM VALUEs are unchanged.
