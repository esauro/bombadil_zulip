// Zulip-specific action generators.
//
// Bombadil picks exactly one action per state, so anything that needs several
// UI steps (fill a form, type and send a message) has to be written as a
// *staged* generator: look at the page, offer only the single next step, and
// contribute nothing at all when the flow does not apply.
import { CharSet, type Range } from "@antithesishq/bombadil/actions";
import { actions, type ActionTemplate } from "@antithesishq/bombadil/browser";
import type { ActionGenerator } from "@antithesishq/bombadil";

import { me, MY_MARKER_PATTERN } from "./credentials.ts";
import { composeBox, loginForm } from "./dom.ts";

/** Human-ish but fast typing. */
const TYPING_DELAY: Range = [1, 20];

const ENTER = 13;

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

/**
 * Logs in through the real /login/ form.
 *
 * Bombadil normally starts already authenticated, via the pre-minted session
 * cookie passed as --cookie. This generator exists for two reasons: it is the
 * fallback if that cookie is ever rejected, and -- unavoidably -- random
 * exploration will eventually click "log out", after which every other
 * generator has nothing interesting to offer until we are back in.
 *
 * Contributes nothing when the login form is not on screen, so its high weight
 * costs nothing during normal exploration.
 */
export const login: ActionGenerator<ActionTemplate> = actions(() => {
  const form = loginForm.current;
  if (!form) return [];

  if (form.username.trim() === "") {
    if (form.activeId !== "id_username") {
      return form.usernameTarget ? [{ Click: form.usernameTarget }] : [];
    }
    return [typeLiteral(me.email)];
  }

  if (form.password === "") {
    if (form.activeId !== "id_password") {
      return form.passwordTarget ? [{ Click: form.passwordTarget }] : [];
    }
    return [typeLiteral(me.password)];
  }

  return form.submitTarget ? [{ Click: form.submitTarget }] : [];
});

/**
 * Types a uniquely marked message into the compose box and sends it.
 *
 * The marker ("bombadil-user1-123456") is what makes two instances worth
 * running: instance 1's sends have to become visible to instance 2. It is also
 * the hook for the sentMessageAppears property, and it is deliberately plain
 * alphanumeric-and-dashes so that the text typed and the text rendered as
 * Markdown are identical.
 *
 * Note that the random `inputs` generator may also type into this same box.
 * That is fine: we only require that a marker is *somewhere* in the value
 * before pressing Enter.
 */
export const composeAndSend: ActionGenerator<ActionTemplate> = actions(() => {
  const box = composeBox.current;
  if (!box) return [];

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

  return [{ PressKey: { code: ENTER } }];
});
