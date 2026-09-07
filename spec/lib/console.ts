// Filtered replacement for the default noConsoleErrors property.
//
// Zulip is chatty, and this stack adds noise of its own: the certificate is
// self-signed and Chromium runs with --ignore-certificate-errors, there is no
// outgoing email or push bouncer, and random exploration provokes plenty of
// legitimate 4xx responses. The unfiltered default fires within seconds, which
// would drown out real findings.
//
// Triage workflow: run once with `strictConsoleErrors` exported instead of
// `noUnexpectedConsoleErrors`, read the violations out of
// `bombadil browser inspect out/user1`, and add the ones that turn out to be
// benign here -- each with a comment saying why.
import { always, type Formula } from "@antithesishq/bombadil";

import { consoleErrors } from "./dom.ts";

/** Console error messages that are expected in this test environment. */
export const BENIGN_CONSOLE_ERRORS: RegExp[] = [
  // Subresources that a stripped-down ephemeral instance simply does not have.
  /Failed to load resource/i,
  /favicon/i,
  // Certificate is self-signed on purpose; Chromium still logs about it.
  /ERR_CERT_/,
  // Random exploration hits endpoints that legitimately answer 4xx.
  /the server responded with a status of 4\d\d/i,
  // Well-known browser noise unrelated to the application.
  /ResizeObserver loop/i,
  /Unchecked runtime\.lastError/i,
];

function isUnexpected(message: string): boolean {
  return !BENIGN_CONSOLE_ERRORS.some((pattern) => pattern.test(message));
}

/**
 * No console errors other than the ones we have explicitly accepted above.
 */
export const noUnexpectedConsoleErrors: Formula = always(() =>
  consoleErrors.current.every((message) => !isUnexpected(message)),
);

/**
 * The unfiltered version, for the triage run described above. Not exported
 * from the top-level specification; swap it in there when you want to see
 * everything Zulip logs.
 */
export const strictConsoleErrors: Formula = always(
  () => consoleErrors.current.length === 0,
);
