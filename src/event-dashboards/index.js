/**
 * Dashboards Entry Point
 *
 * Registers the hub DevTools tabs the event-dashboards bundle owns (Overview —
 * which folds in the per-topology detail tree — plus the Partition Viewer and Log
 * Viewer) via the side-effecting `./tabs` import. There is no standalone React
 * mount — they are hub tabs.
 */

import './nodes/register';
import './tabs';
