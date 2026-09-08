// Works around an inconsistency in Bombadil 0.7.2's element fingerprints.
//
// `getFingerprint` (lib/bombadil/src/specification/browser/index.ts) decides
// whether to compute a structural path by JavaScript truthiness of the other
// identifiers, so an element with an *empty* attribute -- `href=""`, `id=""`,
// `aria-label=""` -- and no text gets a structural path *and* keeps the empty
// string. The Rust side (lib/bombadil-browser/src/js_action.rs) deserialises
// "" as Some("") and then refuses the action outright:
//
//   failed to convert generated action from `zulipActions`:
//   structural_path must not be included when other fingerprint values are present
//
// which ends the whole run. Zulip's app hits this on the first screen after
// login: web/templates/topic_list_new_topic.hbs renders
// `<a class="zoomed-new-topic" href="">` around an icon, and the default
// `clicks` generator offers it as a target. The fix upstream is a one-liner in
// getFingerprint; until we are on a release that has it, every action the
// specification emits goes through `sanitizeActions` below.
import type { Tree } from "@antithesishq/bombadil";
import type { ActionTemplate, Fingerprint } from "@antithesishq/bombadil/browser";

function nonEmpty(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

/**
 * Empty-string identifiers become null, and the structural path is dropped
 * whenever any other identifier remains -- the invariant the Rust side checks.
 * A fingerprint that only had a structural path keeps it.
 */
export function normalizeFingerprint(fingerprint: Fingerprint): Fingerprint {
  const normalized: Fingerprint = {
    tag: fingerprint.tag,
    testId: nonEmpty(fingerprint.testId),
    id: nonEmpty(fingerprint.id),
    role: nonEmpty(fingerprint.role),
    accessibleName: nonEmpty(fingerprint.accessibleName),
    href: nonEmpty(fingerprint.href),
    nameAttr: nonEmpty(fingerprint.nameAttr),
    placeholder: nonEmpty(fingerprint.placeholder),
    inputType: nonEmpty(fingerprint.inputType),
    textContent: nonEmpty(fingerprint.textContent),
    structuralPath: nonEmpty(fingerprint.structuralPath),
  };
  const hasOtherIdentifier = [
    normalized.testId,
    normalized.id,
    normalized.role,
    normalized.accessibleName,
    normalized.href,
    normalized.nameAttr,
    normalized.placeholder,
    normalized.inputType,
    normalized.textContent,
  ].some((value) => value !== null);
  if (hasOtherIdentifier) normalized.structuralPath = null;
  return normalized;
}

function sanitizeAction(action: ActionTemplate): ActionTemplate {
  if (typeof action !== "object") return action;
  if ("Click" in action) {
    return {
      Click: {
        ...action.Click,
        fingerprint: normalizeFingerprint(action.Click.fingerprint),
      },
    };
  }
  if ("DoubleClick" in action) {
    return {
      DoubleClick: {
        ...action.DoubleClick,
        fingerprint: normalizeFingerprint(action.DoubleClick.fingerprint),
      },
    };
  }
  return action;
}

/** Applies `normalizeFingerprint` to every Click and DoubleClick in a tree. */
export function sanitizeActions(
  tree: Tree<ActionTemplate>,
): Tree<ActionTemplate> {
  if ("value" in tree) return { value: sanitizeAction(tree.value) };
  return {
    branches: tree.branches.map(([weight, subtree]) => [
      weight,
      sanitizeActions(subtree),
    ]),
  };
}
