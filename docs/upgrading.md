# Upgrading

Breaking changes that affect a plugin built on the substrate — topology files, Node subclasses, job handlers, dashboards, the wire — with the fix beside each. Start at your installed version and apply everything above it. Internal refactors and fixes are not listed; [CHANGELOG.md](../CHANGELOG.md) has the full story per release.

**Maintenance rule:** a release that changes any consumer-facing contract adds its entry here in the same commit as its CHANGELOG entry. No entry means nothing to do.

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

- **A `Fetcher` keeps ONE ask outstanding at a time.** An ask goes onto the node's
  `outbox` when it is sent and leaves when a reply settles it; a trigger that finds
  one there mints nothing. A dashboard that drove a Fetcher on a fixed refresh no
  longer queues identical asks behind a slow verb. Two valves bound the wait:
  `retry_after_s` (15s) re-arms a read whose answer never came, and `ASK_EXPIRY_S`
  (120s) is the outer bound on how long any ask may stand.

  `FetcherNode.send( args, path, supersede )` is the entry point for a caller with
  an answer to wait on, and `isAsking()` reports whether that subject is still
  outstanding. `useCommandOnce` sends through the same outbox rather than keeping
  a queue of its own, so two writes in one commit ride ONE POST.

- **`addSliceFetcher` fans the receiver `Tee` back to its Fetcher, last.** Tee
  fan-out order is contractual in both ports: a receiver reaches its view before
  the Fetcher that settles the ask, which is what lets a consumer acting once per
  answer read `isAsking()` while the reply renders. A custom fan-out that reorders,
  batches or defers its targets breaks that.

## 2.43.1

- **An `HTTP_Out` transport stamps its own name onto every inbound FROM.** A reply
  from `foo` arrives reading `_http/foo`, which routes; bare `foo` named a node the
  receiving graph does not have. Outbound is untouched — a command going out has
  not been anywhere yet. Anything matching a reply's FROM against a remote node
  name needs the `_http/` prefix, and the `MAX_FROM_SIZE` guard now covers this
  boundary, so a reply looping hub → spoke → hub is dropped by the transport that
  overflowed the path.

  Take 2.43.3 with it. Stamping the transport's name made a Router bounce
  ROUTABLE, so an error the far side could not route was answered with an error
  of its own and the two ends POSTed at each other about twenty times a second
  until the tab closed. Both `HTTP_Out` ports now refuse to send a message the
  Router bounced, keyed on the Router as SENDER rather than on `TM_ERROR` alone —
  an operator composing a message may set the error flag deliberately.

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
  finding surfaces as the `config-keys` result in Site Health and `wp nodes doctor`,
  which report eight checks. Throwing at `plugins_loaded:-10001` would take wp-admin
  down the day a key is renamed, so a misspelled key leaves the real one on its
  default and names itself instead.

- **A TSL `<config:vault>` token is refused.** `vault`, `vault_verify_ssl` and
  `vault_require_ssl` are `ui: false` Fields, and the token resolver refuses
  `Vault::CONFIG_KEY` outright. The `Vault` API is the only way to the encrypted
  credential store.

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
  `fetchLogStatus` / `logStatus` pair is gone with the hand-rolled `log_status` →
  segment-rail plumbing both sides carried; `useSegmentBrowse` resolves its own rail.

- **Four unused surfaces are removed.** `LRU_Cache::get_multi()` and `set_multi()`
  had no caller in any plugin; `CommandInterpreterNode.isCommandInterpreter` had no
  reader, and `dump_config` reaches for `instanceof` as the PHP twin does; and the
  `authGeneration` re-export from `runtime/index.js` goes, though `authGeneration()`
  itself stays and imports from its own module.

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
  seconds, in one POST. ONE offset (`GRID_PHASE_MS`, exported on
  `@newspack-nodes/runtime` as of 2.32.1) serves every cadence — pin your clock to a
  boundary rather than hardcoding a phase. JS only; the PHP `Timer_Node` is unchanged
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
  belongs, and on the four other routing-contract shapes; it is vendored into every
  sibling and wired into `lint:js` and `pre-commit`.

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
  `scope`.** A session's scope is clamped at mint to what the issuing user actually
  holds and lowers the CEILING for one command; it can only ever subtract.
  `Command_Auth::verify()` fails CLOSED on every refusal.

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
  `sse_slot_ttl`; old POINTER keys were written with no expiry and are simply
  orphaned — nothing sweeps them, so they sit, bounded and harmless, until
  cache eviction or a restart.

  Both bounds and the TTL are config keys (`sse_max_streams`, `sse_max_slots`,
  `sse_slot_ttl`). Read [sse-host-budget.md](sse-host-budget.md) before raising any
  of them — an SSE stream holds a php-fpm child for its whole life, and exhausting
  the pool puts the EDGE into auto-defensive mode for 60 seconds for every visitor
  to the site. Two floors are enforced rather than documented: `sse_slot_ttl` is
  raised to the 45s re-auth window if configured below it, and `sse_max_slots` is
  capped at `sse_max_streams`.

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

- **The SSE `positions` wire carries seek sentinels, and a hub upgrades before its
  spokes.** `SSE_In_Node` now always sends a position, using `-1` (`SEEK_END`) when it
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
  per-send work — the equivalent of the console's Compose fields — belongs in
  an unnamed node between the Shell and its sink, not in the caller. Nothing in
  any sibling plugin used either API.

- **A browser graph needs a `_stdout` node, or builtin output goes nowhere.**
  `print`, `status`, `show_parse`, `debug_level` and every usage line now emit
  through `Core.node( '_stdout' )` rather than `_output` — the Dumper renders
  MESSAGES, and a builtin prints text. Mount a `StdoutNode` whose stream writes
  into whatever the host shows; both REPLs hand it
  `{ write: ( text ) => dumper.appendText( text ) }`. Without one, the Shell
  drops the text silently, exactly as PHP does.

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
  (pointer 0) and means a normal reconnect race, not a takeover — a client of
  its own should treat it as routine, as `Remote_Link_Node` now does.

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
  `housekeeping`.** The report was seven results at that version. The new one is
  load-bearing in a way the old one was not: fleet housekeeping — retention,
  orphan partition and IPC reaping, the delayed-jobs sweep, alert emission and
  every `newspack_nodes/periodic` subscriber — now rides the minute cron pass
  alongside cold-start revival, so an install whose `newspack_nodes/reconcile`
  event was vetoed or cleared loses all of it silently. If doctor reports it
  CRITICAL, run
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
  2.11.0 below.

## 2.3.5

- **`wp nodes restart <type>` restarts every partition; `--all-partitions` is
  gone.** Restarting one of six partitions left five running the old code, so
  the safe behaviour is now the default. Drop the flag from any script — it is
  rejected, not ignored. `--partition=<N>` still narrows to one.
- **`wp nodes scaffold node|topology` writes into the current directory**, not
  into `includes/` and `topologies/`. `scaffold plugin` still creates the full
  tree; cd to where you want the file, or move it after.
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
  (`Partition_Node::read_latest_snapshot_cache()`), pass the new required `$node`
  argument and descend `cache[<node>]`. Frames written by 0.50.x skip their snapshot
  restore once on upgrade (state re-accumulates; cursors resume normally).
- **`Job_Router` (event-logger) sheds `stale_timeout`** — staleness is the new
  `Age_Sieve` node's job. Fix: drop Job_Router's positional argument and wire
  `make_node Age_Sieve jobs:sieve 60 1` between it and `jobs:partition`.

## 0.50.0

- **Consumer cursors re-keyed to `{topology}.{source}.pN`.** Offsetlog paths in the
  stock topologies flip from `{source}.{topology}.pN`; no migration shim — on upgrade
  every consumer starts from its `default_offset` (the firehose default is `recent`).
  Fix: nothing to do unless you pinned custom offsetlog paths; then re-key them to
  match and expect one cursor reset.

## 0.48.0

- **Profiling verbs collapsed into one `profile` toggle.** `enable_profiling` and `disable_profiling` are removed (no alias): bare `profile` toggles, `profile on` / `profile off` set idempotently. Anything invoking the old pair gets an unknown-command error. `list_profiles` is unchanged.

- **CommandInterpreter verb `debug_state` renamed to `trace`.** The per-node/interpreter trace toggle is now the `trace` verb (`trace [ <node> [ <level> ] ]`); the old `debug_state` name is gone (no alias). Anything invoking `debug_state` at the REPL or over the wire gets an unknown-command error — use `trace`. The `debug_state` node *property* and the `dump_metadata` `debug_state` field are unchanged.

## 0.47.1

- **Dashboards / hub verbs** — `Aggregator_CI` dropped its dead `status`, `health`, and `servers` verbs. Anything invoking them gets an unknown-verb error; read `summary` and `servers_status` instead.
- **JS runtime** — the `Core.reinit` global is retired; the overlay's Reset-Graph capability is now the `Core.rebuildable` boolean.
- **Node schemas** — a `node_schema()` argument whose `<config:…>` default resolves to no registered key (unknown namespace, unowned key, non-scalar) now throws instead of silently coercing to `''`. If a node stops constructing, its schema default names a key that no longer exists — check the retention keys in particular (`min_segments` / `max_segments` / `min_lifetime` / `max_lifetime`). Topology-line interpolation is unchanged (an unowned token still interpolates to `''`, Tachikoma parity).

## 0.47.0

- **Command envelopes and `arguments()`** — TM_COMMAND `arguments` and node-constructor `arguments` are a flat token array (`list<string>` argv) end to end, no longer a single space-joined string. Verb handlers receive `array $args` and index it; `Node::arguments()` / `parse_schema_args()` take and return token arrays; anything minting a command envelope by hand passes a token list. `Command_Args::parse()` / `format()` speak tokens on both sides; the only join-back-to-a-line lives in `Node::serialize_args()` / JS `serializeArg`. TM_INFO / TM_REQUEST / TM_BYTESTREAM VALUEs are unchanged.
