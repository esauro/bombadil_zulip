// Per-instance identity for this Bombadil container.
//
// The specification runtime has no access to the environment, so
// docker/bombadil/run.sh writes credentials.json into a writable copy of this
// tree before starting Bombadil. The file checked in here holds the .env.example
// defaults for instance 1, so `bombadil browser test ... spec/zulip.ts` also
// works when run by hand from the repo root.
import credentials from "../credentials.json";

export type Credentials = {
  /** e.g. "user1" -- matches the compose service and the ./out subdirectory. */
  instance: string;
  email: string;
  password: string;
  /**
   * Prefix of the message text this instance sends, e.g. "bombadil-user1".
   * Must be safe both as a regular expression (it is used to build the
   * generator pattern) and as Markdown (the property compares the text typed
   * into the compose box against the rendered message), so keep it to letters,
   * digits and dashes.
   */
  marker: string;
  /** The seeded channel and topic both instances exchange messages in. */
  channel: string;
  topic: string;
};

export const me: Credentials = credentials as Credentials;

if (!/^[A-Za-z0-9-]+$/.test(me.marker)) {
  throw new Error(
    `credentials.json: marker ${JSON.stringify(me.marker)} must match /^[A-Za-z0-9-]+$/`,
  );
}

/** Matches the marker of either instance, so each can observe the other's messages. */
export const ANY_MARKER = /bombadil-[A-Za-z0-9-]+?-\d{6}/;

/** Matches only this instance's markers. */
export const MY_MARKER = new RegExp(`${me.marker}-\\d{6}`);

/** True for a marker sent by the other instance. */
export function isPeerMarker(marker: string): boolean {
  return ANY_MARKER.test(marker) && !MY_MARKER.test(marker);
}

// Resolving a topic renames it in place, prepending "✔ "
// (web/src/resolved_topic.ts, RESOLVED_TOPIC_PREFIX; the regex also copes with
// the "✔ ✔✔ " that repeated resolve/unresolve can leave behind). A resolved
// topic is the same conversation as its unresolved form, so every topic
// comparison in the spec ignores the prefix. Without this, the message
// exchange loses its rendezvous the instant random exploration clicks "Mark as
// resolved" -- which is exactly what stranded one instance in the first run.
const RESOLVED_TOPIC_PREFIX_RE = /^✔ [ ✔]*/;

/** A topic name with any resolved-topic prefix removed, trimmed and lowercased. */
export function normalizeTopic(topic: string): string {
  return topic.replace(RESOLVED_TOPIC_PREFIX_RE, "").trim().toLowerCase();
}

/** Whether two topic names denote the same conversation, resolution aside. */
export function sameTopic(a: string | null, b: string): boolean {
  return a !== null && normalizeTopic(a) === normalizeTopic(b);
}

/** The rand_regex pattern Bombadil uses to generate a fresh marker to send. */
export const MY_MARKER_PATTERN = `${me.marker}-[0-9]{6}`;
