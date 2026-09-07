// Top-level Bombadil specification for the Zulip web app.
//
// Run by docker/bombadil/run.sh as:
//
//   bombadil browser test-external ... https://zulip.test/ <copy of>/spec/zulip.ts
//
// Only properties and action generators may be exported from this module.

// ---------------------------------------------------------------------------
// Defaults we keep
//
// noHttpErrorCodes only inspects the navigation response status
// (browser/defaults/properties.ts), so it is cheap and quiet. The two
// exception properties are the highest-value checks Bombadil ships.
//
// noConsoleErrors is deliberately NOT re-exported -- see ./lib/console.ts.
// ---------------------------------------------------------------------------
export {
  noHttpErrorCodes,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

export { noUnexpectedConsoleErrors } from "./lib/console.ts";

// ---------------------------------------------------------------------------
// Zulip properties
// ---------------------------------------------------------------------------
export {
  connectionRecovers,
  messageIdsAscend,
  noDuplicateRenderedMessages,
  noServerErrorPage,
  sentMessageAppears,
  unreadCountsAreSane,
} from "./lib/properties.ts";

// ---------------------------------------------------------------------------
// Actions
//
// One weighted root generator instead of re-exporting defaultActions, so the
// two staged Zulip flows can be weighted against the generic ones.
//
//   login          heavily weighted, but contributes nothing unless the login
//                  form is on screen -- so it is free during normal
//                  exploration and recovers fast after a stray "log out".
//   composeAndSend the interesting workload: three states (focus, type, send)
//                  and the messages become observable to the other instance.
//   clicks/inputs/ the Bombadil defaults, which is where the actual random
//   scroll         exploration of Zulip's UI comes from.
//   navigation     mostly Back; kept low because reloading Zulip is slow.
//   waitOnce       lets time-bounded guarantee properties make progress
//                  without an action forcing a new state.
// ---------------------------------------------------------------------------
import {
  clicks,
  inputs,
  navigation,
  scroll,
  waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";
import { weighted } from "@antithesishq/bombadil/browser";

import { composeAndSend, login } from "./lib/actions.ts";

export const zulipActions = weighted([
  [300, login],
  [100, clicks],
  [100, inputs],
  [50, scroll],
  [40, composeAndSend],
  [10, navigation],
  [5, waitOnce],
]);
