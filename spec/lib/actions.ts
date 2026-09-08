// Zulip-specific action generators.
//
// Bombadil picks exactly one action per state, so anything that needs several
// UI steps (fill a form, type and send a message) has to be written as a
// *staged* generator: look at the page, offer only the single next step, and
// contribute nothing at all when the flow does not apply.
//
// The top-level specification (../zulip.ts) decides which of these is active.
// `login` and `returnToLogin` run *alone* while the browser is not logged in;
// the generic exploration generators only get a turn once the app is on
// screen. The first run of this stack showed why: with login merely weighted
// against the defaults, the random `inputs` generator typed a garbage email
// into the username field first, and the random `clicks` generator wandered
// off to the help center and the terms page.
import { CharSet, type Range } from "@antithesishq/bombadil/actions";
import { actions, type ActionTemplate } from "@antithesishq/bombadil/browser";
import type { ActionGenerator } from "@antithesishq/bombadil";

import { me, MY_MARKER_PATTERN } from "./credentials.ts";
import {
  blockingOverlay,
  canGoBack,
  composeBox,
  lastAction,
  loginForm,
  loginLink,
  narrow,
  sidebarLinks,
  type ClickTarget,
  type LoginFormState,
} from "./dom.ts";

/** Human-ish but fast typing. */
const TYPING_DELAY: Range = [1, 20];

// Key codes Bombadil knows how to press (lib/bombadil-browser-keys/src/lib.rs).
const BACKSPACE = 8;
const ENTER = 13;
const ESCAPE = 27;
const DELETE = 46;

/** Types a literal string. StringGenerator has no plain-string case, and a
 * single-entry CharSet of literals is the escaping-free way to say "this
 * exact text" (a Regexp would need every metacharacter escaped). */
function typeLiteral(literal: string): ActionTemplate {
  return {
    TypeText: {
      text: { CharSet: CharSet.fromLiterals(literal) },
      delayMillis: TYPING_DELAY,
    },
  };
}

type LoginField = {
  /** DOM id, compared against document.activeElement. */
  id: string;
  value: string;
  target: ClickTarget | null;
};

/**
 * The single next step that brings one login field to the wanted value, or
 * null when it already holds it.
 *
 * Bombadil has no "set value" action and no modifier keys, so a field holding
 * the wrong text is emptied one character per state before the right text is
 * typed in one go. Backspace and Delete are both offered because a click puts
 * the caret wherever the pointer landed -- possibly mid-text -- and Backspace
 * alone would stall at the start of the field with characters still to its
 * right. Either key makes progress, so the field empties in finitely many
 * states. In practice the field is empty or already right, since nothing else
 * types while the form is on screen; this is the defensive path.
 */
function fillField(
  form: LoginFormState,
  field: LoginField,
  wanted: string,
): ActionTemplate[] | null {
  if (field.value === wanted) return null;
  if (form.activeId !== field.id) {
    // A field without layout cannot be clicked; give the page a moment.
    return field.target ? [{ Click: field.target }] : ["Wait"];
  }
  if (field.value !== "") {
    return [{ PressKey: { code: BACKSPACE } }, { PressKey: { code: DELETE } }];
  }
  return [typeLiteral(wanted)];
}

/**
 * Logs in through the real /login/ form with this instance's credentials.
 *
 * One step per state: focus the username field, type the email, focus the
 * password field, type the password, click "Log in". Any field already holding
 * the right value is skipped; a field holding anything else is cleared first.
 * Zulip re-renders the same form (at /accounts/login/) when it rejects a
 * login, keeping the email and blanking the password, so a rejection simply
 * leads to another attempt -- and to a `credentialsAccepted` violation.
 *
 * Contributes nothing when the login form is not on screen. Never returns an
 * empty tree while it is: an empty action tree ends the run.
 */
export const login: ActionGenerator<ActionTemplate> = actions(() => {
  const form = loginForm.current;
  if (!form) return [];

  return (
    fillField(
      form,
      { id: "id_username", value: form.username, target: form.usernameTarget },
      me.email,
    ) ??
    fillField(
      form,
      { id: "id_password", value: form.password, target: form.passwordTarget },
      me.password,
    ) ??
    (form.submitTarget
      ? [{ Click: form.submitTarget }]
      : [{ PressKey: { code: ENTER } }])
  );
});

/**
 * Gets a browser that is neither logged in nor on the login page back to it.
 *
 * This covers the pages around the login flow: a first navigation that lands
 * on a portico page, the redirect chain after "log out", or a logged-in
 * session that has strayed onto a page without the app's chrome (/stats,
 * /policies, a 404) -- for those, going back returns to the app. The header's
 * "Log in" link is preferred when present; otherwise Back; otherwise wait a
 * state and reload, so the tree is never empty.
 */
export const returnToLogin: ActionGenerator<ActionTemplate> = actions(() => {
  const link = loginLink.current;
  if (link) return [{ Click: link }];
  if (canGoBack.current) return ["Back"];
  return lastAction.current === "Wait" ? ["Reload"] : ["Wait"];
});

function sameName(a: string | null, b: string): boolean {
  return a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Sends a marked message to the seeded channel and topic, and keeps the
 * browser looking at that conversation so the other instance's messages are
 * seen as they arrive. This is the workload the two instances exist for.
 *
 * One step per state, always the single next thing to do:
 *
 *   1. An overlay or modal is open: Escape. It would swallow every click below.
 *   2. Compose is open on some other conversation (a DM, another channel or
 *      topic -- random exploration gets it there): close it. Zulip keeps the
 *      text as a draft, which is fine.
 *   3. Compose is open on our conversation: focus the textarea, type a fresh
 *      marker if there is none, click Send. Whatever random typing has added
 *      to the box goes along; the marker is what the properties look for.
 *      The Send button is used rather than Enter because Zulip's default is
 *      Ctrl+Enter to send (UserProfile.enter_sends is False).
 *   4. Compose is closed and we are in our topic's narrow: click "Compose
 *      message", which opens the box addressed to that topic.
 *   5. Not in our topic's narrow: click the topic in the left sidebar if it
 *      is listed, else the channel, which narrows to it and lists its topics.
 *
 * Contributes nothing when none of that applies (e.g. the sidebar is not
 * rendered yet), so exploration goes on. Enter is only used as the fallback
 * for a Send button that has no layout.
 */
export const exchangeMessages: ActionGenerator<ActionTemplate> = actions(
  () => {
    if (blockingOverlay.current) return [{ PressKey: { code: ESCAPE } }];

    const box = composeBox.current;
    if (!box) return [];

    if (box.open) {
      const onOurConversation =
        box.kind === "channel" &&
        sameName(box.channel, me.channel) &&
        sameName(box.topic, me.topic);
      if (!onOurConversation) {
        return box.closeTarget
          ? [{ Click: box.closeTarget }]
          : [{ PressKey: { code: ESCAPE } }];
      }
      if (!box.focused) {
        return box.target ? [{ Click: box.target }] : [];
      }
      if (!box.value.includes(me.marker)) {
        return [
          {
            TypeText: {
              text: { Regexp: MY_MARKER_PATTERN },
              delayMillis: TYPING_DELAY,
            },
          },
        ];
      }
      return box.sendTarget
        ? [{ Click: box.sendTarget }]
        : [{ PressKey: { code: ENTER } }];
    }

    const here = narrow.current;
    const inOurTopic =
      sameName(here.channel, me.channel) && sameName(here.topic, me.topic);
    if (inOurTopic) {
      if (box.replyTarget) return [{ Click: box.replyTarget }];
      if (box.newConversationTarget) {
        return [{ Click: box.newConversationTarget }];
      }
      return [];
    }

    const links = sidebarLinks.current;
    if (links.topicTarget) return [{ Click: links.topicTarget }];
    if (links.channelTarget) return [{ Click: links.channelTarget }];
    return [];
  },
);
