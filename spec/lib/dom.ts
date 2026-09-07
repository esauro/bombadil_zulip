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

  return {
    username: username.value,
    password: password.value,
    activeId: doc.activeElement ? doc.activeElement.id || null : null,
    usernameTarget: clickTarget(username),
    passwordTarget: clickTarget(password),
    submitTarget: clickTarget(form.querySelector("button[type=submit]")),
  };
});

// ---------------------------------------------------------------------------
// Compose box
// ---------------------------------------------------------------------------

export type ComposeBoxState = {
  value: string;
  focused: boolean;
  target: ClickTarget | null;
};

/** Non-null exactly when the compose box is present in the DOM. */
export const composeBox = extract<ComposeBoxState | null>((state) => {
  const textarea = state.document.querySelector("textarea#compose-textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) return null;
  return {
    value: textarea.value,
    focused: state.document.activeElement === textarea,
    target: clickTarget(textarea),
  };
});

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
