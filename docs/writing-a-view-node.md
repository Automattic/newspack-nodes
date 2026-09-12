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
[`src/topology-console/nodes/register.js`](../src/topology-console/nodes/register.js) is the pattern:

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
`includeNodes` is a per-bundle static and a station tab mounted
against another bundle's interpreter cannot resolve a name its own bundle
registered ([ADR-16](architecture-decisions.md#adr-16-js-node-class-resolution--names-are-the-tsl-surface-classes-are-the-api)).

`sliceView()` alone returns one class, which is what a view shared across
dashboards wants instead: `CatalogListViewNode` is declared that way in
[`src/shared/nodes/catalog-list-view-node.js`](../src/shared/nodes/catalog-list-view-node.js), and [`useStreamGraph.js`](../src/shared/hooks/useStreamGraph.js) registers
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
[`src/event-dashboards/styles/worker-status.scss`](../src/event-dashboards/styles/worker-status.scss), and nothing keeps the two in
step. Clear early and the row vanishes mid-slide; clear late and a finished row
lingers. Changing either file means changing the other.

## 3 routing facts

![A slice drawn three ways, every node named <subject>:<role>. A polled slice runs <subject>:timer, :tee and :fetch, which sends the verb to the server CI with FROM = <subject>:in; the reply comes back TO = FROM to the :in receiver Tee, through an optional :transform, to the :view, whose setState reaches the React widget through useNodeState. A one-shot, useCommandOnce under the default scope <ci>:<command>, runs vault:add:fetch, vault:add:in and vault:add:result, a CommandResultNode. A stream, useStreamGraph under a prefix, runs <prefix>:link (a RemoteLink opening the SSE connection), <prefix>:stream and <prefix>:view, a LogStreamViewNode, beside the <prefix>-catalog:* and <prefix>-step:* slices. Beneath: the subject is the noun and never the verb, the three routing facts, and the rule that a node playing none of the fixed roles is a second slice with a subject of its own.](img/wvn-slice-path.png)

1. **A view is a terminal — no `target`, no `sink`** (`has_target: false`). A
   per-slice merge or dedup rides the receiver-Tee → view edge, in
   `addSliceFetcher`'s `transform` slot; `WorkerStatusTransform` is the shipped
   example.

2. **The `TO = FROM` reply delivers your data.** `fill()` handles it and never
   sends the request; a stream view sends nothing either.

3. **One slice per view — replies never cross.** Each slice verb has its own path from a Fetcher
through a receiver to a view, so a `counts` reply lands only on
   `source-counts:view`. A verb somebody awaits is minted from its own node and
   answered there
   ([ADR-7](architecture-decisions.md#adr-7-sink-vs-target-and-tofrom-replies)),
   so nothing reaching a view needs telling apart. There is no god node holding
   `{ counts, top, accumulated }`: decompose the command *and* the view. A view
   still sitting at counter `0` in the topology console while its widget renders
   data is not the node receiving it — look upstream for the god node that is.

## Naming the slice's nodes

Every node a dashboard builds in the browser is named **`<subject>:<role>`**,
and the sheet above carries the rule: the subject names what the slice shows,
never the verb it sends; the roles are a fixed set; a node playing none of them
is a second slice with a subject of its own; and a one-shot verb is the one
exception. `hook-catalog`, `error-log` and `partition` are subjects under the
same rule. The shared hooks derive every name from the subject you hand them:
`scope` in `useCatalogSlice` and `useCommandOnce`, `prefix` in `useStreamGraph`.

## `setState( 'view', model )`

![The base SliceViewNode.fill() as a decision chain. Every message first bumps this.counter. A message whose FROM is controlFrom goes to _control(), where loading raises the spinner and clears the error, clear resets to emptySlice(), error stops the spinner with value.error or 'Operation failed', and an unknown verb changes nothing. Otherwise a TM_ERROR becomes { ...model, error, loading: false }, keeping the slice on screen. Otherwise an object VALUE goes to _parse( value.payload ), which JSON-decodes a string in a try/catch and runs a declared parse; a slice becomes model = { ...settled, ...slice }, rebuilt rather than merged, while null or a non-object VALUE returns and keeps the prior slice. Every publishing branch ends in setState( 'view', model ), which caches the payload for a widget that mounts late. Beneath: preserve origin-then-TYPE order in an override, garbage keeps the prior slice, recovery needs no reload, and CommandResultNode, the one-shot mirror, publishes every reply on result with the same seven fields.](img/wvn-fill-branches.png)

Publish the model under the **`view`** key — the key
`useNodeState( '<subject>:view', 'view' )` reads:

```js
this.setState( 'view', this.model );
```

Seed it in the constructor from `emptySlice()`, as the base does: a shaped
`{ loading: true }` beats `undefined`. Use `setState`, not `notify`, so a widget
mounting after the reply still gets the current model. Declare `loading` and
`error` in `empty` when the widget renders them; a view declaring neither still
gets `error` and `loading: false` on a TM_ERROR, and the next good reply drops
both.

## Controls: a view its own dashboard drives

A dashboard that drives its own slice — a modal opening, a Pause button, a
refused id — fills a control straight into the view instead of waiting for a
reply. Both halves live in
[`@newspack-nodes/shared/helpers/controlMsg`](../src/shared/helpers/controlMsg.js):
`controlMsg( view, value )` mints one and `isControl( view, message )` admits it.

A control is recognised by **who sent it**, never by what its payload looks
like, and the view trusts one origin, `controlFrom`, which the graph builder
assigns: `addSliceFetcher` from its own `controlFrom` option, `useStreamGraph`
from the view's own name. A transform on the receiver-Tee → view edge takes one
the same way, through `transform.controlFrom`, for a dashboard driving the
transform rather than the view. A node that declares none takes no controls, and
`controlMsg()` throws rather than stamp an empty origin, so a forgotten
assignment fails loud instead of leaving a dead button.

`SliceViewNode` handles the three verbs the sheet's `_control()` box lists, and
a subclass handles its own first, deferring the rest with
`super._control( value )`. `LogStreamViewNode` recognises a control the same way and answers eight
verbs of its own, so a stream view's Pause button rides this channel too.

## No throw from `fill()`

`fill()` runs synchronously in the drain, and the Router dispatches it with
`target.fill( message )` — **no per-message try/catch** — so a throw aborts the
whole message turn that delivered the reply. The base `SliceViewNode.fill()` is
total, branch by branch as the sheet under `setState` traces; preserve its order
if you override: origin, then TYPE, then shape. A `TM_ERROR` VALUE is a bare
string, which `errorMessage()` coerces to readable text, and the example's three
cards test `slice.error` first and render the notice alone. `_parse` receives
the reply VALUE's `payload` field and decodes it only when it is a string,
try/catching the `JSON.parse`; if you parse anything yourself, do the same.

Never `throw` to signal a bad reply — `return`, and either surface an error
slice or keep the prior one. Count what arrives, too: a terminal node has no
sink to count for it, so `fill()` bumps `this.counter` on every message, the
ones it drops included.

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
| `SliceViewNode` | — | [`src/shared/nodes/slice-view-node.js`](../src/shared/nodes/slice-view-node.js) | `Node`; the contract above, plus `sliceView()` and `registerSliceViews()` |
| `CatalogListViewNode` | `CatalogListView` | [`src/shared/nodes/catalog-list-view-node.js`](../src/shared/nodes/catalog-list-view-node.js) | A `sliceView()` declaration; a picker's rows, published under `items` for `useLogCatalog` |
| `LogStreamViewNode` | — | [`src/shared/nodes/log-stream-view-node.js`](../src/shared/nodes/log-stream-view-node.js) | `Node`; the log-stream base — a newest-first ring capped at `maxLines` (100,000 by default), pause and step, decaying lines/s, seek breadcrumbs, and the `pause` / `step` / `connection` / `browse` / `follow` / `clear` / `filter` / `select` controls. Subclasses implement `shapeRow()` and extend `_control()`, `viewModel()` and `matchesFilter()` |
| — | `ClassCatalogView`, `TopologyListView` | [`src/topology-console/nodes/register.js`](../src/topology-console/nodes/register.js) | `sliceView()` declarations; the palette's classes and formatters, and the OPEN dialog's topologies |
| — | `AggregatorSummaryView`, `AggregatorServersView` | [`src/event-aggregator/nodes/register.js`](../src/event-aggregator/nodes/register.js) | `sliceView()` declarations, both `json: true`; the header strip and the server cards |
| — | `SessionListView` | [`src/sessions/nodes/register.js`](../src/sessions/nodes/register.js) | A `sliceView()` declaration; the issued sessions, the TTL ceiling and the scope ladder in one slice |
| — | `VaultListView` | [`src/vault/nodes/register.js`](../src/vault/nodes/register.js) | A `sliceView()` declaration; the credential table |
| — | `TopologyManagerView` | [`src/event-dashboards/nodes/register.js`](../src/event-dashboards/nodes/register.js) | A `sliceView()` declaration, the only one overriding `description`; the Topology Manager list |
| `WorkerStatusViewNode` | `WorkerStatusView` | [`src/event-dashboards/nodes/worker-status-view-node.js`](../src/event-dashboards/nodes/worker-status-view-node.js) | `SliceViewNode`; its slice arrives already parsed, as a TM_STRUCT from `WorkerStatusTransform`, so it dispatches the struct actions itself and defers TM_ERROR to the base. `TreeEntity`'s `LogRows` draws what it publishes, one `SegmentBar` per segment |
| `PartitionViewerViewNode`, `LogViewerViewNode` | `PartitionViewerView`, `LogViewerView` | [`src/event-dashboards/nodes/`](../src/event-dashboards/nodes/) | `LogStreamViewNode`; `shapeRow()` shapes an SSE envelope into a row carrying all seven positional fields ([ADR-2](architecture-decisions.md#adr-2-one-message-format-the-7-field-positional-array)) plus `msgId`, `key`, `struct`, `raw` and a computed `partition` column, clipping `content` and `value` at 1,000 characters and `raw` at 262,144, and returning null on an empty VALUE so the base drops the record without moving the seek breadcrumb. Two controls ride on the base's eight: `select` records the chosen log, resets the seek tracker and empties the ring, and `logs` publishes the catalog, adopting its first entry only while nothing is selected — a later catalog never yanks a live pick. That `select` REPLACES the base's rather than deferring to it, taking a `log` instead of a `dir`, so the base's dir-driven breadcrumb arming never runs and seek tracking stays on for the life of the node. `LogViewerViewNode` inherits all of it and overrides the description alone |
| `ProbeStreamViewNode` | — | [`src/event-dashboards/nodes/probe-stream-view-node.js`](../src/event-dashboards/nodes/probe-stream-view-node.js) | `Node`; per-key entries, a ring, a publish throttle, TTL eviction and a 24h prune. Subclasses declare `identitySlot`, `modelKey`, `_fold()` and `_entryView()` |
| `TopicProbeViewNode`, `JobstatsViewNode` | `TopicProbeView`, `JobstatsView` | [`src/event-dashboards/nodes/`](../src/event-dashboards/nodes/) | `ProbeStreamViewNode`; the consumer series under `consumers`, the job-handler series under `handlers` |
| `SettingsAuditViewNode` | `SettingsAuditView` | [`src/event-dashboards/nodes/settings-audit-view-node.js`](../src/event-dashboards/nodes/settings-audit-view-node.js) | `Node`; a throttled newest-first ring of settings-change events |
| `SourceCountsViewNode`, `TopTableViewNode`, `AccumulatedViewNode` | `SourceCountsView`, `TopTableView`, `AccumulatedView` | [`examples/example-ai-newsletter/src/dashboard/nodes/`](../examples/example-ai-newsletter/src/dashboard/nodes/) | `SliceViewNode`; one `emptySlice()` each, for the walkthrough's three slices |

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
[`useCommandOnce`](../src/shared/hooks/useCommandOnce.js) builds. The two are
deliberate opposites, as the sheet under `setState` draws: a one-shot publishes
every reply on `result`, refusals included, and anything acting once per answer
registers a listener rather than reading `useNodeState`, because two replies
inside one React batch cost one re-render.
