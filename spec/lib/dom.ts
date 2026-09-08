// Extractors over the Zulip web app.
//
// These run in the real browser (Bombadil evaluates the bundled specification
// in the page and calls runtime.runExtractors on every captured state --
// lib/bombadil-browser/src/driver.rs), so the full DOM is available. Keep each
// extractor cheap and returning plain JSON.
import {
  extract,
  getFingerprint,
  type Fingerprint,
  type Point,
} from "@antithesishq/bombadil/browser";

import { me } from "./credentials.ts";

export type ClickTarget = { fingerprint: Fingerprint; point: Point };

/**
 * A click target for an element, or null if it has no layout (hidden,
 * detached, zero-sized) and therefore cannot be clicked.
 *
 * Defined at module scope so extractors can share it; extractors may not read
 * other cells, but they may call plain helpers.
 */
function clickTarget(element: Element | null): ClickTarget | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    fingerprint: getFingerprint(element),
    point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
}

function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").trim();
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

export type LoginFormState = {
  username: string;
  password: string;
  /** id of document.activeElement, so the generator knows where to type. */
  activeId: string | null;
  usernameTarget: ClickTarget | null;
  passwordTarget: ClickTarget | null;
  submitTarget: ClickTarget | null;
  /**
   * Text of the server-rendered error alert inside the form, or null. Django
   * re-renders the form with this alert when a POST to /accounts/login/ is
   * rejected (templates/zerver/login.html, `form.errors`). Client-side
   * validation messages from jQuery Validate are deliberately not included:
   * they appear while a field is still being filled in.
   */
  serverError: string | null;
};

/** Non-null exactly when the real /login/ form is on screen. */
export const loginForm = extract<LoginFormState | null>((state) => {
  const doc = state.document;
  const form = doc.querySelector("form#login_form");
  if (!form) return null;

  const username = doc.querySelector("input#id_username");
  const password = doc.querySelector("input#id_password");
  if (
    !(username instanceof HTMLInputElement) ||
    !(password instanceof HTMLInputElement)
  ) {
    return null;
  }

  const alert = form.querySelector(".alert.alert-error");

  return {
    username: username.value,
    password: password.value,
    activeId: doc.activeElement ? doc.activeElement.id || null : null,
    usernameTarget: clickTarget(username),
    passwordTarget: clickTarget(password),
    submitTarget: clickTarget(form.querySelector("button[type=submit]")),
    serverError: alert ? text(alert) : null,
  };
});

// ---------------------------------------------------------------------------
// Where are we: the app, the login page, or some other portico page?
// ---------------------------------------------------------------------------

/**
 * True when the logged-in web app is on screen, including while it is still
 * loading. Both ids come from templates/zerver/app/index.html, which is only
 * ever served to an authenticated user; portico pages (login, help, policies,
 * signup) have neither. Class names are not usable for this: the login page
 * carries a `.app` class of its own.
 */
export const loggedIn = extract<boolean>(
  (state) =>
    state.document.querySelector("#app-loading, #navbar-fixed-container") !==
    null,
);

/**
 * The portico header's "Log in" link (templates/zerver/portico-header.html),
 * which Zulip shows to unauthenticated visitors on help, policy and signup
 * pages. Null when there is none: for an authenticated user, or on the login
 * page itself.
 */
export const loginLink = extract<ClickTarget | null>((state) => {
  const body = state.document.body;
  if (!body) return null;
  const origin = state.window.location.origin;
  for (const anchor of Array.from(body.querySelectorAll("a[href]"))) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (url.pathname !== "/login/" && url.pathname !== "/accounts/login/") {
      continue;
    }
    const target = clickTarget(anchor);
    if (target) return target;
  }
  return null;
});

/** Whether the browser has history to go back to. */
export const canGoBack = extract<boolean>(
  (state) => state.navigationHistory.back.length > 0,
);

// ---------------------------------------------------------------------------
// Compose box
// ---------------------------------------------------------------------------

export type ComposeBoxState = {
  /**
   * The textarea (textarea#compose-textarea) is always in the DOM; it only has
   * layout while the compose box is open, and only then can it be clicked.
   */
  open: boolean;
  value: string;
  focused: boolean;
  target: ClickTarget | null;
  /**
   * What the open compose box is addressed to. Zulip shows exactly one of
   * #compose-channel-recipient and #compose-direct-recipient
   * (web/src/compose_recipient.ts); null while the box is closed.
   */
  kind: "channel" | "dm" | null;
  /** Selected channel name from the recipient dropdown, when kind is "channel". */
  channel: string | null;
  /** Value of the topic input, when kind is "channel". */
  topic: string | null;
  sendTarget: ClickTarget | null;
  closeTarget: ClickTarget | null;
  /**
   * The two buttons Zulip shows in place of a closed compose box
   * (web/templates/compose.hbs): "Compose message" replies to the current
   * conversation, "Start new conversation" opens the box for the current
   * channel with an empty topic.
   */
  replyTarget: ClickTarget | null;
  newConversationTarget: ClickTarget | null;
};

function hasLayout(element: Element | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Non-null exactly when the compose textarea is present in the DOM. */
export const composeBox = extract<ComposeBoxState | null>((state) => {
  const doc = state.document;
  const textarea = doc.querySelector("textarea#compose-textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) return null;
  const target = clickTarget(textarea);
  const open = target !== null;

  let kind: ComposeBoxState["kind"] = null;
  let channel: string | null = null;
  let topic: string | null = null;
  if (open) {
    if (hasLayout(doc.querySelector("#compose-direct-recipient"))) {
      kind = "dm";
    } else if (hasLayout(doc.querySelector("#compose-channel-recipient"))) {
      kind = "channel";
      channel = text(
        doc.querySelector(
          "#compose_select_recipient_widget .dropdown_widget_value",
        ),
      );
      const topicInput = doc.querySelector("#stream_message_recipient_topic");
      topic = topicInput instanceof HTMLInputElement ? topicInput.value : null;
    }
  }

  return {
    open,
    value: textarea.value,
    focused: doc.activeElement === textarea,
    target,
    kind,
    channel,
    topic,
    sendTarget: clickTarget(doc.querySelector("#compose-send-button")),
    closeTarget: clickTarget(doc.querySelector("#compose_close")),
    replyTarget: clickTarget(
      doc.querySelector("#left_bar_compose_reply_button_big"),
    ),
    newConversationTarget: clickTarget(
      doc.querySelector("#new_conversation_button"),
    ),
  };
});

// ---------------------------------------------------------------------------
// Where in the app are we: the narrow, and the way to the seeded conversation
// ---------------------------------------------------------------------------

export type Narrow = {
  /** Channel name from the URL slug, or null outside a channel narrow. */
  channel: string | null;
  topic: string | null;
};

/**
 * Inverse of Zulip's hash encoding (web/src/internal_url.ts): percent-encoding
 * with "." in place of "%".
 */
function decodeHashComponent(component: string): string {
  try {
    return decodeURIComponent(component.replaceAll(".", "%"));
  } catch {
    return component;
  }
}

/**
 * The current narrow, parsed from the URL fragment. Zulip's channel operand is
 * "<id>-<name>" with spaces in the name turned into dashes
 * (web/src/stream_data.ts, id_to_slug), so the name comes back with dashes
 * where the channel has spaces -- fine for matching a plain name like
 * "bombadil".
 */
export const narrow = extract<Narrow>((state) => {
  const hash = state.window.location.hash;
  const result: Narrow = { channel: null, topic: null };
  if (!hash.startsWith("#narrow/")) return result;
  const parts = hash.slice("#narrow/".length).split("/");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const operator = parts[i];
    const operand = decodeHashComponent(parts[i + 1] ?? "");
    if (operator === "channel" || operator === "stream") {
      const dash = operand.indexOf("-");
      result.channel = dash >= 0 ? operand.slice(dash + 1) : operand;
    } else if (operator === "topic") {
      result.topic = operand;
    }
  }
  return result;
});

export type SidebarLinks = {
  /** The seeded channel's row in the left sidebar (stream_sidebar_row.hbs). */
  channelTarget: ClickTarget | null;
  /**
   * The seeded topic under it (topic_list_item.hbs). Zulip only lists a
   * channel's topics while that channel is the active narrow, so this is
   * usually null until channelTarget has been clicked.
   */
  topicTarget: ClickTarget | null;
};

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Left-sidebar links to the channel and topic in credentials.json. */
export const sidebarLinks = extract<SidebarLinks>((state) => {
  const body = state.document.body;
  const result: SidebarLinks = { channelTarget: null, topicTarget: null };
  if (!body) return result;

  for (const row of Array.from(
    body.querySelectorAll("li.narrow-filter[data-stream-id]"),
  )) {
    const name = text(row.querySelector(".stream-name"));
    if (!sameName(name, me.channel)) continue;
    result.channelTarget = clickTarget(row.querySelector("a.subscription_block"));
    break;
  }

  for (const item of Array.from(
    body.querySelectorAll("li.topic-list-item[data-topic-name]"),
  )) {
    const name = item.getAttribute("data-topic-name") ?? "";
    if (!sameName(name, me.topic)) continue;
    result.topicTarget = clickTarget(item.querySelector("a.topic-box"));
    if (result.topicTarget) break;
  }

  return result;
});

/**
 * An overlay (settings, channel settings, drafts, ...) or a modal is open.
 * They cover the sidebar and the compose box, so clicks aimed there land on
 * the overlay instead; Escape closes them (web/src/overlays.ts, modals.ts).
 */
export const blockingOverlay = extract<boolean>(
  (state) =>
    state.document.querySelector(
      ".overlay.show, .micromodal.modal--open, .micromodal.modal--opening",
    ) !== null,
);

// ---------------------------------------------------------------------------
// Message feed
// ---------------------------------------------------------------------------

export type RenderedMessage = {
  /** data-message-id; locally echoed messages get fractional ids. */
  id: number;
  locallyEchoed: boolean;
  content: string;
};

export type RenderedMessageList = {
  listId: string | null;
  messages: RenderedMessage[];
};

/**
 * Zulip keeps several rendered narrows in the DOM at once, so invariants are
 * checked per message list rather than across the whole document.
 */
export const messageLists = extract<RenderedMessageList[]>((state) => {
  const body = state.document.body;
  if (!body) return [];
  return Array.from(
    body.querySelectorAll(".message-list[data-message-list-id]"),
  ).map((list) => ({
    listId: list.getAttribute("data-message-list-id"),
    messages: Array.from(list.querySelectorAll(".message_row[data-message-id]"))
      .map((row) => ({
        id: Number(row.getAttribute("data-message-id")),
        locallyEchoed: row.classList.contains("locally-echoed"),
        content: text(row.querySelector(".message_content")),
      }))
      .filter((message) => Number.isFinite(message.id)),
  }));
});

/** Every rendered message body in the document, for substring matching. */
export const messageContents = extract<string[]>((state) => {
  const body = state.document.body;
  if (!body) return [];
  return Array.from(body.querySelectorAll(".message_row .message_content")).map(
    (element) => text(element),
  );
});

// ---------------------------------------------------------------------------
// Banners and counts
// ---------------------------------------------------------------------------

/**
 * The "Unable to connect to Zulip. Trying to reconnect..." banner
 * (web/src/popup_banners.ts). Transient by design, so this feeds a guarantee
 * property rather than an invariant.
 */
export const connectionErrorBanner = extract<boolean>(
  (state) =>
    state.document.querySelector(".connection-error-banner") !== null,
);

/**
 * The "Sent! Your message is outside your current view." banner
 * (web/templates/compose_banner/message_sent_banner.hbs). Zulip showing this
 * is a valid answer to "where did my message go?".
 */
export const messageSentBanner = extract<boolean>(
  (state) =>
    state.document.querySelector(".above_compose_banner.success") !== null,
);

/** Rendered unread badge texts, e.g. ["3", "", "12"]. */
export const unreadCountTexts = extract<string[]>((state) => {
  const body = state.document.body;
  if (!body) return [];
  return Array.from(body.querySelectorAll(".unread_count")).map((element) =>
    text(element),
  );
});

/**
 * Server-side error pages: Zulip's own 500 page (templates/500.html) and the
 * bodies nginx serves when Django or Tornado is not answering.
 */
export const serverErrorPage = extract<string | null>((state) => {
  const title = state.document.title || "";
  const heading = text(state.document.querySelector("h1"));
  for (const candidate of [title, heading]) {
    if (/internal server error|bad gateway|gateway time-?out|service unavailable/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
});

/** Console entries at error level, flattened to strings. */
export const consoleErrors = extract<string[]>((state) =>
  state.console
    .filter((entry) => entry.level === "error")
    .map((entry) =>
      entry.args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    ),
);

/** The current URL, used to tell the login page from the app. */
export const currentUrl = extract<string>((state) =>
  state.navigationHistory.current.url,
);

/** The last action Bombadil performed, for preconditions. */
export const lastAction = extract((state) => state.lastAction);
