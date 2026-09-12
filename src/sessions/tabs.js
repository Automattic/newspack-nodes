/**
 * Register the Sessions station tab (order 35) and this bundle's slice-view
 * node class. The bundle entry imports this module for both side effects.
 *
 * The descriptor is the shared `./tabMeta`, which the station's lazy placeholder
 * carries as well, so the tab-bar identity holds before the bundle loads. The
 * station renders the page chrome and the DebugOverlay around whichever tab is
 * active, so the component registered here is SessionsAdmin itself rather than a
 * page wrapper.
 *
 * Importing `./nodes/register` enters SessionListView in this bundle's
 * `CommandInterpreterNode` name table, which TSL and the console palette read.
 * `useSessionsGraph` does not depend on that table: name resolution is a
 * per-bundle static, so the hook hands `makeNode` the exported class itself
 * (ADR-16).
 */

import { registerTab } from '@newspack-nodes/shared/tabs/tabRegistry';
import tabMeta from './tabMeta';
import SessionsAdmin from './SessionsAdmin';
import './nodes/register';

registerTab( { ...tabMeta, component: SessionsAdmin } );
