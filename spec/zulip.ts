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
  credentialsAccepted,
  loginSucceeds,
  messageIdsAscend,
  noDuplicateRenderedMessages,
  noServerErrorPage,
  peerMessageReceived,
  sentMessageAppears,
  unreadCountsAreSane,
} from "./lib/properties.ts";

// ---------------------------------------------------------------------------
// Actions
//
// Bombadil weights every exported generator equally, so this module exports
// exactly one: a staged root that looks at the page and hands the whole turn
// to one of three stages.
//
//   login          the /login/ form is on screen. Nothing else runs: the
//                  random generators would otherwise type into the username
//                  field or click away to the help center before the form is
//                  submitted, which is exactly what the first run did.
//   returnToLogin  not logged in, and no form either (a portico page, the
//                  redirect after "log out"). Click the header's "Log in"
//                  link or go back.
//   explore        the app is on screen: fuzz it.
//
// Inside `explore`:
//   exchangeMessages  the workload the two instances exist for, and the
//                     heaviest weight: go to the seeded channel and topic,
//                     open compose there, type a marker, click Send. It also
//                     keeps both browsers looking at the same conversation,
//                     which is how each one receives the other's messages.
//                     A round is about five states, so with this weight a
//                     message goes out every ten to fifteen states.
//   clicks/inputs/    the Bombadil defaults, which is where the actual random
//   scroll            exploration of Zulip's UI comes from. `inputs` is kept
//                     lower than the default because it also types into the
//                     compose box; that text is sent along with the marker.
//   navigation        mostly Back; kept low because reloading Zulip is slow.
//   waitOnce          lets time-bounded guarantee properties make progress
//                     without an action forcing a new state.
//
// Random exploration will eventually find "Log out" in the gear menu. That is
// fine: Zulip redirects to /login/, the login stage takes over, and
// exploration resumes once the app is back.
// ---------------------------------------------------------------------------
import {
  clicks,
  inputs,
  navigation,
  scroll,
  waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";
import {
  actions,
  weighted,
  type ActionTemplate,
} from "@antithesishq/bombadil/browser";
import type { ActionGenerator } from "@antithesishq/bombadil";

import { exchangeMessages, login, returnToLogin } from "./lib/actions.ts";
import { loggedIn, loginForm } from "./lib/dom.ts";
import { sanitizeActions } from "./lib/fingerprint.ts";

const explore = weighted([
  [200, exchangeMessages],
  [100, clicks],
  [60, inputs],
  [30, scroll],
  [10, navigation],
  [5, waitOnce],
]);

const stages: ActionGenerator<ActionTemplate> = actions(() => {
  if (loginForm.current !== null) return login.generate();
  if (!loggedIn.current) return returnToLogin.generate();
  return explore.generate();
});

// Every emitted action passes through sanitizeActions: Bombadil 0.7.2 rejects
// the fingerprint its own `getFingerprint` builds for Zulip's `<a href="">`
// icon links, and that rejection ends the run. See ./lib/fingerprint.ts.
export const zulipActions: ActionGenerator<ActionTemplate> = actions(() =>
  sanitizeActions(stages.generate()),
);
