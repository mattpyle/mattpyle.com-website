/**
 * The /audit form's running state: the only script that page has.
 *
 * Kept out of the component's `<script>` so `node --test` can exercise it without a browser (see
 * tests/audit-page.test.mjs) — the same split src/lib/webmcp-tools.mjs and src/lib/guestbook.mjs
 * take, and for the same reason: the interesting half of a progressive enhancement is the half
 * that is hardest to reach from a test.
 *
 * WHAT A SUBMIT DOES, AND ALL IT DOES. The button reads "Running…", carries `disabled`, and the
 * live region already in the markup names the site being audited. Nothing moves, nothing fades,
 * there is no spinner (design_handoff_audit/README.md, "Interactions and Behaviour"). A submit
 * here is a real form post — the browser leaves for `/audit/`, the server runs the audit and
 * answers with a 303 — so this is not managing a request. It is labelling the seconds between the
 * press and the new document, which the browser otherwise spends showing nothing but its own tab
 * spinner. Remove it and the form posts exactly as it did before it existed.
 *
 * THE BUTTON'S COLOUR IS NOT SET HERE. `disabled` is the whole signal and the stylesheet does the
 * paint (`.audit-form button[disabled]` in AuditBody.astro). `style-src` in vercel.json carries no
 * `unsafe-inline`, so writing `style.background` would be refused in production and nowhere else,
 * which is the worst place to find that out.
 *
 * BOTH FORMS, ONE HANDLER. The address form and the report's Run again button post the same
 * request to the same URL, so they get the same treatment; `data-audit-form` is what says so,
 * rather than two selectors that have to be kept in step.
 */

import { FORM } from '../data/audit-copy.mjs';

/**
 * The three effects of a submit, and the undo, for one form — or `null` if the form is not one of
 * this page's (no submit button, or no live region to write into).
 *
 * Returned as an object rather than applied directly so the whole state change is one testable
 * value: `start()` is what a submit does and `reset()` is what a back/forward restore undoes, and
 * neither needs an event to be reachable.
 *
 * @param {any} form an element with `querySelector`
 */
export function runningState(form) {
  const button = form.querySelector('[data-audit-submit]');
  const status = form.querySelector('[data-audit-status]');
  if (!button || !status) return null;

  // The label to put back, read off the button rather than re-derived from the copy module: the
  // two forms carry different words ("Run the audit", "Run again") and only the button knows which.
  const idle = button.textContent ?? '';

  return {
    start() {
      const field = form.querySelector('input[name="url"]');
      button.disabled = true;
      button.textContent = FORM.running;
      status.textContent = FORM.runningStatus((field?.value ?? '').trim());
    },
    reset() {
      button.disabled = false;
      button.textContent = idle;
      status.textContent = '';
    },
  };
}

/**
 * Wire one form: submit sets the running state, a back/forward restore clears it.
 *
 * **The restore handler is not optional.** A form post leaves this page, and coming back restores
 * it from the back/forward cache exactly as it was left: the button still disabled, still reading
 * "Running…", over a form that is not running anything and cannot be pressed. `pageshow` fires on
 * an ordinary load too, and only the `persisted` one needs undoing.
 *
 * No `preventDefault` anywhere: the post is the feature. A `required` field that failed the
 * browser's own validation never fires `submit` at all, so the button cannot come to read
 * "Running…" over a form that did not go.
 *
 * @param {any} form
 * @param {any} scope the window the restore listener is attached to
 */
export function wireRunningState(form, scope = globalThis) {
  const state = runningState(form);
  if (!state) return null;

  form.addEventListener('submit', () => state.start());
  scope.addEventListener?.('pageshow', (event) => {
    if (event?.persisted) state.reset();
  });
  return state;
}
