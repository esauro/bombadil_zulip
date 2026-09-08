// Zulip-specific properties.
//
// Everything here is deliberately conservative: random exploration produces a
// lot of *legitimately* bad-looking UI (missing topic, not subscribed to the
// channel, 4xx responses), and a property that fires on those is worse than no
// property at all. Compose-box validation banners, for instance, are
// intentionally not asserted on.
import {
  always,
  eventually,
  next,
  now,
  type Formula,
} from "@antithesishq/bombadil";

import { ANY_MARKER, isPeerMarker, me } from "./credentials.ts";
import {
  composeBox,
  connectionErrorBanner,
  lastAction,
  loggedIn,
  loginForm,
  messageContents,
  messageLists,
  messageSentBanner,
  serverErrorPage,
  unreadCountTexts,
} from "./dom.ts";

/** The marker currently sitting in the compose box, if any. */
function composeMarker(): string | null {
  const box = composeBox.current;
  if (!box) return null;
  const match = ANY_MARKER.exec(box.value);
  return match ? match[0] : null;
}

/** The login form is on screen and holds exactly this instance's credentials. */
function formHoldsMyCredentials(): boolean {
  const form = loginForm.current;
  return (
    form !== null &&
    form.username === me.email &&
    form.password === me.password
  );
}

/**
 * Logging in works: once the form holds this instance's credentials, the app
 * is on screen within a minute.
 *
 * While the form is on screen the login stage is the only generator running,
 * and it clicks "Log in" as soon as both fields are right, so "the form holds
 * our credentials" is precisely the state before the submit. The bound is
 * generous because a cold Zulip serves its first app page slowly, and under
 * fault injection slower still.
 */
export const loginSucceeds: Formula = always(
  now(formHoldsMyCredentials).implies(
    eventually(() => loggedIn.current).within(60, "seconds"),
  ),
);

/**
 * The server never rejects this instance's credentials.
 *
 * A rejected POST re-renders the form at /accounts/login/ with an error alert
 * and the submitted email. Seeing that alert next to our own email means the
 * seeded user or its password is wrong, or an authentication backend is
 * unavailable. Rate limiting is off in this stack
 * (SETTING_RATE_LIMITING_AUTHENTICATE in compose.yaml), so the repeated logins
 * that follow every "log out" cannot trip this legitimately.
 */
export const credentialsAccepted: Formula = always(() => {
  const form = loginForm.current;
  return (
    form === null || form.serverError === null || form.username !== me.email
  );
});

/**
 * The browser never lands on a server error page -- Zulip's own 500
 * (templates/500.html) or the body nginx serves when Django or Tornado is not
 * answering.
 *
 * This overlaps with the default noHttpErrorCodes, which only inspects the
 * navigation response status, and catches the cases that arrive as a 200 or
 * through a client-side transition.
 */
export const noServerErrorPage: Formula = always(
  () => serverErrorPage.current === null,
);

/**
 * A rendered message list never shows the same message twice.
 *
 * Checked per list, because Zulip keeps several rendered narrows in the DOM.
 */
export const noDuplicateRenderedMessages: Formula = always(() =>
  messageLists.current.every((list) => {
    const ids = list.messages.map((message) => message.id);
    return new Set(ids).size === ids.length;
  }),
);

/**
 * Message ids increase down a rendered list.
 *
 * Locally echoed messages get fractional ids (web/src/local_message.ts), which
 * sort between their neighbours, so this holds for optimistic sends too.
 */
export const messageIdsAscend: Formula = always(() =>
  messageLists.current.every((list) =>
    list.messages.every((message, index) => {
      if (index === 0) return true;
      const previous = list.messages[index - 1];
      return previous === undefined || message.id > previous.id;
    }),
  ),
);

/**
 * Unread badges never render a negative or non-numeric count.
 *
 * Zulip hides a zero count rather than rendering "0", so an empty badge is
 * normal and accepted here.
 */
export const unreadCountsAreSane: Formula = always(() =>
  unreadCountTexts.current.every(
    (badge) => badge === "" || /^\d+$/.test(badge),
  ),
);

/**
 * A guarantee property: if Zulip puts up the "Unable to connect ... trying to
 * reconnect" banner (web/src/popup_banners.ts), it gets itself back online and
 * takes the banner down again.
 *
 * This is the property that makes the run interesting under fault injection:
 * under Antithesis, killing Tornado is exactly the scenario that should raise
 * this banner and then recover from it.
 */
export const connectionRecovers: Formula = always(
  now(() => connectionErrorBanner.current).implies(
    eventually(() => !connectionErrorBanner.current).within(60, "seconds"),
  ),
);

/**
 * The last action was a click on the compose box's Send button.
 *
 * Checked on the serialised action rather than through the `Action` type:
 * fingerprints arrive from the Rust side in snake_case, which the TypeScript
 * type does not reflect, and the button's id is the same either way.
 */
function sendClicked(): boolean {
  const action = lastAction.current;
  return (
    action !== null &&
    typeof action === "object" &&
    "Click" in action &&
    JSON.stringify(action).includes("compose-send-button")
  );
}

/**
 * A contextful guarantee: a marked message that was sent has to turn up.
 *
 * Precondition: the compose box holds a marker now, and the next state was
 * produced by clicking Send. That is precisely what exchangeMessages does, and
 * it excludes the other ways a marker can leave the box -- Escape, "Cancel
 * compose", a random click elsewhere -- which the first version of this
 * property mistook for sends.
 *
 * Conclusion: the marker shows up in the rendered feed, or Zulip says the
 * message went somewhere outside the current view ("Sent! Your message is
 * outside your current view."). Either is a correct answer; silence is not.
 * Zulip refusing the send (an error banner, the text staying in the box) is
 * a violation too, and deliberately so: the box was addressed to a channel
 * both users are subscribed to.
 *
 * ANY_MARKER matches both instances' markers, so a quoted or forwarded peer
 * marker is covered as well.
 */
export const sentMessageAppears: Formula = always(() => {
  const marker = composeMarker();

  return now(() => marker !== null)
    .and(next(sendClicked))
    .implies(
      eventually(
        () =>
          messageSentBanner.current ||
          (marker !== null &&
            messageContents.current.some((content) =>
              content.includes(marker),
            )),
      ).within(60, "seconds"),
    );
});

/** Some rendered message carries a marker sent by the other instance. */
function peerMarkerVisible(): boolean {
  return messageContents.current.some((content) =>
    (content.match(new RegExp(ANY_MARKER.source, "g")) ?? []).some(isPeerMarker),
  );
}

/**
 * The reason for running two instances: within three minutes of starting,
 * this instance has seen a message the other instance sent.
 *
 * exchangeMessages keeps both browsers returning to the same channel and
 * topic and sending there every few states, so three minutes is generous for
 * a healthy stack -- it covers the other instance's login and app load, and
 * a stretch of it wandering through settings. Under fault injection this is
 * the property that says messages still get through; if a run legitimately
 * needs longer (a very slow machine, a paused peer), raise the bound rather
 * than dropping the property.
 */
export const peerMessageReceived: Formula = eventually(peerMarkerVisible).within(
  180,
  "seconds",
);
