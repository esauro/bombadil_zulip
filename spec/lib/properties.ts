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

import { ANY_MARKER } from "./credentials.ts";
import {
  composeBox,
  connectionErrorBanner,
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
 * A contextful guarantee, and the reason for running two instances: a marked
 * message that leaves the compose box has to turn up somewhere.
 *
 * Precondition: the compose box holds a marker now, and in the next state it
 * holds a different one (or none) -- i.e. the send went through rather than
 * being rejected. Zulip keeps the text in the box when it refuses to send, so
 * this precondition excludes rejected sends on its own.
 *
 * Conclusion: the marker shows up in the message feed, or Zulip says the
 * message went somewhere outside the current view ("Sent! Your message is
 * outside your current view."). Either is a correct answer; silence is not.
 *
 * ANY_MARKER matches both instances' markers, so this also covers instance 2
 * observing what instance 1 sent, whenever the two are in the same narrow.
 */
export const sentMessageAppears: Formula = always(() => {
  const marker = composeMarker();

  return now(() => marker !== null)
    .and(next(() => composeMarker() !== marker))
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
