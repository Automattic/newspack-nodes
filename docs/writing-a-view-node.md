# Writing a View Node

A **view node** is the terminal node of a dashboard slice: it receives what
lands on that slice — one command reply per poll, or a stream's records —
parses it into a render model, publishes the model for a React widget, and
forwards nothing. This is the one-page contract; the full walkthrough is
[writing-a-dashboard.md](writing-a-dashboard.md), and the base most views extend
is [`@newspack-nodes/shared/nodes/slice-view-node`](../src/shared/nodes/slice-view-node.js).

## Declare it; subclass only when the view owns more than its slice

A view whose whole content is an empty model and a guard-then-map parse is a
**declaration**, not a class. `registerSliceViews()` builds each declared class
and enters it in the browser interpreter's name table in one call —
`src/topology-console/nodes/register.js` is the pattern:

```js
import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

export const views = registerSliceViews( {
	// The rows or nothing; an empty user_dir means no writable directory.
	TopologyListView: {
		empty: { topologies: null, userDir: '', error: null },
		parse: ( body ) =>
			Array.isArray( body?.topologies )
				? {
						topologies: body.topologies,
						userDir: body.user_dir || '',
						error: null,
				  }
				: null,
	},
} );
```

| Key | What it declares |
|---|---|
| `empty` | The shaped-but-empty model, copied per node so one view's mutation never surfaces in the next. |
| `parse` | The map from reply to model. Returning `null` keeps the model already on screen; omit `parse` when the reply *is* the slice. |
| `json` | That the verb answers a JSON **string**, so `parse` receives the decoded body. A verb answering a struct comes through unencoded — leave it off. |
| `description` | The `help <Name>` description, the only part of the schema a declaration can restate. It reaches no palette tile, because `sliceView()` overrides the description and never the inherited `Hidden` category. |

Omitting `parse` moves the shape guard to the widget. The view then publishes
whatever the verb answered, over the status fields the empty model declares, so
no field of your own shape is guaranteed. The example's `SourceCountsViewNode`
declares neither `loading` nor `error`, which leaves its published model the
decoded JSON wholesale; `<SourceCounts/>` carries the only guard on that path,
reading `slice.sources ?? {}` on top of the `{ sources: {} }` default that covers
the render before the node exists. A widget must default every slice field it
reaches into — `Object.entries( undefined )` throws inside render and unmounts
the React tree.

`registerSliceViews()` returns the classes keyed by name, and a dashboard needs
both halves. A **name** serves TSL, `make_node` typed into the REPL and
`help <Name>`, never the console palette — the palette offers only a class whose
category is neither `Hidden` nor empty, and every slice view inherits `Hidden`.
The **class** is what a hook hands `addSliceFetcher` as its `viewClass`, because
`includeNodes` is a per-bundle static and a hub tab mounted
against another bundle's interpreter cannot resolve a name its own bundle
registered ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)).

`sliceView()` alone returns one class, which is what a view shared across
dashboards wants instead: `CatalogListViewNode` is declared that way in
`src/shared/nodes/catalog-list-view-node.js`, and `useStreamGraph.js` registers
it under the name `CatalogListView`.

Subclass `SliceViewNode` when the view owns more than a slice — its own `fill()`,
a ring buffer, a timer, a teardown. Override `emptySlice()`, returning a fresh
object each call rather than a module-level literal every node would share, and
`_parse()` when the reply payload is not already your model:

```js
import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

export class AccumulatedViewNode extends SliceViewNode {
	// Shaped-but-empty so a render BEFORE the first reply is valid.
	emptySlice() {
		return { accumulated: 0 };
	}
}
```

Register it — `CommandInterpreterNode.registerNodeClasses( { AccumulatedView:
AccumulatedViewNode } )`, importing `CommandInterpreterNode` from
`@newspack-nodes/runtime` — and React reads it with
`useNodeState( 'accumulated:view', 'view' )`.

`examples/example-ai-newsletter`'s three views subclass for that shape alone;
each would read as a declaration carrying `json: true`. A view that earns a
class owns a ring, a timer or its own `fill()`, and one holding a timer cancels
it in `removeNode()` before calling `super.removeNode()`: a torn-down node whose
timer still fires publishes into a graph the dashboard has already replaced.
`WorkerStatusViewNode`, `ProbeStreamViewNode` and `SettingsAuditViewNode` are the
three that cancel one. `WorkerStatusViewNode`'s timer holds a removed segment in
`removingSegments` for 400 ms, so `SegmentBar` can animate it out; that window is
the `segment-slide-out` keyframe's duration in
`src/event-dashboards/styles/worker-status.scss`, and nothing keeps the two in
step. Clear early and the row vanishes mid-slide; clear late and a finished row
lingers. Changing either file means changing the other.

## 3 routing facts

1. **A view node is a terminal — no `target`, no `sink`** (`has_target: false`).
   It receives, parses, publishes, stops. If you catch yourself forwarding out
   of a view, it isn't a view — it's a `Tee` or a transform. A per-slice
   merge or dedup belongs on the receiver-Tee → view edge, which is what
   `addSliceFetcher`'s `transform` slot drops it onto; `WorkerStatusTransform`
   is the shipped example.

2. **You never fetch your own data — the `TO = FROM` reply delivers it.**
   Upstream, a `Timer → Tee → Fetcher` poll sends your slice verb to the service
   CI, stamping **`FROM = your receiver`**. The server replies **`TO = FROM`**, so
   the reply routes back to your receiver `Tee`, which fans it to your view. Your
   `fill()` handles the arriving reply; it never sends the request. A stream
   view sends nothing either: `useStreamGraph` mounts the `RemoteLink` that
   opens the SSE connection and the `Tee` that fans each record in.

3. **One slice per view — replies never cross.** Each slice verb has its own
   Fetcher → receiver → view path, so the `counts` reply lands ONLY on
   `source-counts:view`, never on a sibling. A verb somebody awaits is minted
   from its own node and answered there
   ([ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)),
   so nothing reaching a view needs telling apart from anything else. There is
   no god node holding `{ counts, top, accumulated }` — decompose the command
   *and* the view. A view still sitting at counter `0` in the topology console
   while its widget renders data is not the node receiving it — look upstream
   for the god node that is.

## `setState( 'view', model )`

Publish the model under the **`view`** key — the key
`useNodeState( '<name>:view', 'view' )` reads:

```js
this.setState( 'view', this.model );
```

- **Seed it in the constructor** from `emptySlice()` so a render before the first
  reply is valid (the base does this). A shaped `{ loading: true }` beats
  `undefined`.
- **`setState`, not `notify`.** `setState` caches the latest payload, so a widget
  that mounts *after* the reply still gets the current model (a late `register()`
  replays the cache).
- **The base rebuilds the model, it does not merge into it.** A parsed reply
  publishes `{ ...settled, ...slice }`, where `settled` holds the resting values
  of whichever status fields your empty model declares — `loading: false`,
  `error: null`. That is what retires the previous tick's spinner and error.
  Declare `loading` and `error` in `empty` when the widget renders them; a view
  declaring neither still gets `error` and `loading: false` on a TM_ERROR, and
  the next good reply drops both.

## Controls: a view its own dashboard drives

A dashboard that drives its own slice — a modal opening, a Pause button, a
refused id — fills a control straight into the view instead of waiting for a
reply. Both halves live in
[`@newspack-nodes/shared/helpers/controlMsg`](../src/shared/helpers/controlMsg.js):
`controlMsg( view, value )` mints one and `isControl( view, message )` admits it.

A control is recognised by **who sent it**, never by what its payload looks like
— a reply carrying an `action` field is still a reply, and sniffing for one
swallows whole streams. The view declares the origin it trusts in `controlFrom`,
which the graph builder assigns: `addSliceFetcher` from its own `controlFrom`
option, `useStreamGraph` from the view's own name. A transform on the
receiver-Tee → view edge takes one the same way, through
`transform.controlFrom`, for a dashboard driving the transform rather than the
view. A node that declares none takes no controls, and `controlMsg()` throws
rather than stamp an empty origin, so a forgotten assignment fails loud instead
of leaving a dead button.

`SliceViewNode` handles three verbs off `value.action`, and a subclass handles
its own first, deferring the rest with `super._control( value )`. Every control
republishes the model, so a button re-renders its widget without waiting for a
reply:

| `action` | Effect |
|---|---|
| `loading` | Raises the spinner and clears the error, keeping the data in the model. |
| `clear` | Resets the model to `emptySlice()`. |
| `error` | Stops the spinner and surfaces `value.error` — `Operation failed` when it carries none — keeping the data in the model. |

`LogStreamViewNode` recognises a control the same way and answers eight verbs of
its own, so a stream view's Pause button rides this channel too.

## No throw from `fill()`

`fill()` runs synchronously in the drain, and the Router dispatches it with
`target.fill( message )` — **no per-message try/catch.** A throw there propagates
up and aborts the whole message turn (the poll/dispatch that delivered the
reply). So `fill()` must be *total*: every message shape returns cleanly.

The base `SliceViewNode.fill()` already gives you this — preserve it if you
override:

- **Origin first, then TYPE.** A message from `controlFrom` is a control; a
  `TM_ERROR` is a failure; anything else is this slice's reply.
- **`TM_ERROR` before the parse.** A transport error (the Router's
  `NOT_AVAILABLE`, say) arrives as a bare *string* `VALUE`. The base surfaces it
  as `{ ...this.model, error, loading: false }` and returns, keeping the slice
  and stopping the spinner so nothing loads forever. Whether the widget still
  draws that slice is the widget's call, and the example's three cards do not:
  each tests `slice.error` first and renders the notice alone. What the kept
  model buys is recovery without a reload — the next parsed reply rebuilds from
  `settled`, which carries no `error`, and the card draws its data again on that
  tick.
  `errorMessage()` is what coerces any payload shape to readable text.
- **Garbage keeps the prior slice.** A non-object `VALUE`, or a payload `_parse`
  cannot use, must `return` and leave the last good model in place. `_parse`
  reports that by returning `null`, and the base skips the `setState`.
- **Wrap the parse.** `_parse` receives the reply VALUE's `payload` field. The
  base decodes it only when it is a **string**, try/catching the `JSON.parse`;
  if you parse anything yourself, do the same.

Never `throw` to signal a bad reply — `return`, and either surface an error slice
or keep the prior one.

Count what arrives, too. A terminal node has no sink to count for it, so
`fill()` bumps `this.counter` on every message — including the ones it drops.
That counter is the throughput the topology console and the debug overlay draw.

## The node schema

A view declares itself Hidden and terminal. The base's schema is usually the
whole of it:

```js
static nodeSchema() {
	return {
		category: 'Hidden',
		description: 'Owns one dashboard slice for its React widget.',
		registrations: [ 'view' ],
		arguments: [],
		commands: [],
		has_target: false,
	};
}
```

**Hidden** because a dashboard wires its slice views itself rather than an
operator dropping one from the palette, and **`has_target: false`** because a
view settles its reply and forwards nothing. `registrations` names the state
keys a direct `register()` call may use; `useNodeState` subscribes through
`useNodeEvent`, which seeds a key it does not find, so a view that only React
reads needs none — the stream views declare no `registrations` at all.

## What ships

Every view node in this repo, and which contract it follows. A registered name
is written out by hand where the class is registered — each bundle's
`register.js`, and `useStreamGraph.js` for the one shared view — rather than
derived, though a named class conventionally registers as its own name minus the
trailing `Node`. A `sliceView()` declaration returns an anonymous class, so that
registered name is the only handle TSL and the REPL have on it. A base nothing
registers is an import and nothing more: no TSL line can name it.

| Class | Registers as | Where | Base, and what it owns |
|---|---|---|---|
| `SliceViewNode` | — | `src/shared/nodes/slice-view-node.js` | `Node`; the contract above, plus `sliceView()` and `registerSliceViews()` |
| `CatalogListViewNode` | `CatalogListView` | `src/shared/nodes/catalog-list-view-node.js` | A `sliceView()` declaration; a picker's rows, published under `items` for `useLogCatalog` |
| `LogStreamViewNode` | — | `src/shared/nodes/log-stream-view-node.js` | `Node`; the log-stream base — a newest-first ring capped at `maxLines` (100,000 by default), pause and step, decaying lines/s, seek breadcrumbs, and the `pause` / `step` / `connection` / `browse` / `follow` / `clear` / `filter` / `select` controls. Subclasses implement `shapeRow()` and extend `_control()`, `viewModel()` and `matchesFilter()` |
| — | `ClassCatalogView`, `TopologyListView` | `src/topology-console/nodes/register.js` | `sliceView()` declarations; the palette's classes and formatters, and the OPEN dialog's topologies |
| — | `AggregatorSummaryView`, `AggregatorServersView` | `src/event-aggregator/nodes/register.js` | `sliceView()` declarations, both `json: true`; the header strip and the server cards |
| — | `SessionListView` | `src/sessions/nodes/register.js` | A `sliceView()` declaration; the issued sessions, the TTL ceiling and the scope ladder in one slice |
| — | `VaultListView` | `src/vault/nodes/register.js` | A `sliceView()` declaration; the credential table |
| — | `TopologyManagerView` | `src/event-dashboards/nodes/register.js` | A `sliceView()` declaration, the only one overriding `description`; the Topology Manager list |
| `WorkerStatusViewNode` | `WorkerStatusView` | `src/event-dashboards/nodes/worker-status-view-node.js` | `SliceViewNode`; its slice arrives already parsed, as a TM_STRUCT from `WorkerStatusTransform`, so it dispatches the struct actions itself and defers TM_ERROR to the base. `TreeEntity`'s `LogRows` draws what it publishes, one `SegmentBar` per segment |
| `PartitionViewerViewNode`, `LogViewerViewNode` | `PartitionViewerView`, `LogViewerView` | `src/event-dashboards/nodes/` | `LogStreamViewNode`; `shapeRow()` shapes an SSE envelope into a row carrying all seven positional fields ([ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array)) plus `msgId`, `key`, `struct`, `raw` and a computed `partition` column, clipping `content` and `value` at 1,000 characters and `raw` at 262,144, and returning null on an empty VALUE so the base drops the record without moving the seek breadcrumb. Two controls ride on the base's eight: `select` records the chosen log, resets the seek tracker and empties the ring, and `logs` publishes the catalog, adopting its first entry only while nothing is selected — a later catalog never yanks a live pick. That `select` REPLACES the base's rather than deferring to it, taking a `log` instead of a `dir`, so the base's dir-driven breadcrumb arming never runs and seek tracking stays on for the life of the node. `LogViewerViewNode` inherits all of it and overrides the description alone |
| `ProbeStreamViewNode` | — | `src/event-dashboards/nodes/probe-stream-view-node.js` | `Node`; per-key entries, a ring, a publish throttle, TTL eviction and a 24h prune. Subclasses declare `identitySlot`, `modelKey`, `_fold()` and `_entryView()` |
| `TopicProbeViewNode`, `JobstatsViewNode` | `TopicProbeView`, `JobstatsView` | `src/event-dashboards/nodes/` | `ProbeStreamViewNode`; the consumer series under `consumers`, the job-handler series under `handlers` |
| `SettingsAuditViewNode` | `SettingsAuditView` | `src/event-dashboards/nodes/settings-audit-view-node.js` | `Node`; a throttled newest-first ring of settings-change events |
| `SourceCountsViewNode`, `TopTableViewNode`, `AccumulatedViewNode` | `SourceCountsView`, `TopTableView`, `AccumulatedView` | `examples/example-ai-newsletter/src/dashboard/nodes/` | `SliceViewNode`; one `emptySlice()` each, for the walkthrough's three slices |

`WorkerStatusTransformNode`, registered as `WorkerStatusTransform`, sits beside
them and is **not** a view: it rides the receiver-Tee → view edge, enriching the
reply before the view stores it.

Reading the `consumers` map `TopicProbeViewNode` publishes takes a decision no
card escapes, because an entry is keyed by READER and several readers tail one
source. Two topologies on `firehose.p0` report that one stream twice, so
`globalMsgRate` collapses a source's co-readers to the largest rate and
`probe24hTotals` integrates over the union of their windows. A backlog and an
offsetlog belong to the reader instead, so `backlogTotal` and `cacheSizeTotals`
sum every live reader and dedup nothing. Both rules ship side by side in
`src/event-dashboards/`, and `topicChartSeries` behind the Topics chart SUMS
`msgRate` over the co-readers `globalMsgRate` collapses — the Overview's rate
card and its rate chart read one field two ways. Choose which a new card wants
rather than copying the sibling you happen to read first.

## The one-shot mirror

A view holds a model that keeps arriving — a poll's replies, or a stream's
records. A command with a caller waiting on its answer — a save, a delete, a
test — lands on
[`CommandResultNode`](../src/shared/nodes/command-result-node.js) instead, which
`useCommandOnce` builds.

The two are deliberate opposites. A slice keeps the model it holds when a tick
fails, leaving the widget to choose between a stale render and an error notice;
a one-shot publishes **every** reply on `result`, refusals included, with the
same seven fields either way — `ok`, `args`, `subject`, `payload`, `error`,
`errorData`, `undelivered` — so the caller reads `ok` to branch and never waits
on news that already arrived.

Read the two differently, too. A widget renders a slice through
`useNodeState`, which carries the latest payload. Anything acting once per
one-shot **answer** registers a listener instead, because two replies inside one
React batch cost one re-render and the rendered state shows only the last.
