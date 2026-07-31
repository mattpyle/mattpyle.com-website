import type { Page } from '@playwright/test';

/**
 * Keyboard-traversal primitives shared by keyboard.spec.ts and focus-visible.spec.ts.
 *
 * The expected tab order is derived from the live DOM rather than committed to a
 * fixture, so the check does not churn when a post ships. What it asserts is the
 * relationship between the two: sequential focus order must match DOM order, every
 * tabbable must be reachable, and no press may fail to move focus.
 */

export interface Tabbable {
  /** Index in DOM order; also written to the element as data-a11y-idx. */
  idx: number;
  /** Human-readable identifier for failure messages. */
  label: string;
}

export interface Stop {
  /** null when focus left the document (body / browser UI). */
  idx: number | null;
  label: string;
  /** Whether a focus indicator is painted on the element or its `:has()` frame. */
  ring: boolean;
  ringSource: string;
}

/**
 * Tag every tabbable element in DOM order and return the expected sequence.
 *
 * "Tabbable" here is deliberately narrower than "focusable": an element with
 * tabindex="-1" is focusable by script but not by Tab, and this site uses that
 * on purpose for the roving-tabindex radiogroups (FilterPills, the /webmcp mode
 * pills), where only the checked radio is in the tab order.
 */
export async function markTabbables(page: Page): Promise<Tabbable[]> {
  return page.evaluate(() => {
    const CANDIDATES =
      'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable="true"]';

    function visible(el: Element): boolean {
      if ((el as HTMLElement).hidden) return false;
      if (el.closest('[hidden]')) return false;
      if (el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.contentVisibility === 'hidden') {
        return false;
      }
      return true;
    }

    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const name =
        el.getAttribute('aria-label') ??
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const id = el.id ? `#${el.id}` : '';
      return `${tag}${id}${name ? ` "${name}"` : ''}`;
    }

    const out: { idx: number; label: string }[] = [];
    let idx = 0;
    for (const el of Array.from(document.querySelectorAll(CANDIDATES))) {
      const html = el as HTMLElement;
      if ((html as HTMLButtonElement).disabled) continue;
      if (html.inert) continue;
      if (html.tabIndex < 0) continue;
      if (!visible(html)) continue;
      html.dataset.a11yIdx = String(idx);
      out.push({ idx, label: describe(html) });
      idx++;
    }
    return out;
  });
}

/** Elements that are in the tab order but hidden from assistive tech: a 4.1.2 defect. */
export async function tabbablesInsideAriaHidden(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-a11y-idx]'))
      .filter(el => el.closest('[aria-hidden="true"]'))
      .map(el => `${el.tagName.toLowerCase()}[data-a11y-idx="${el.dataset.a11yIdx}"]`),
  );
}

const READ_ACTIVE = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) {
    return { idx: null, label: el ? el.tagName.toLowerCase() : 'none', ring: false, ringSource: '' };
  }

  // The focus ring is not always on the focused element. /webmcp's scrollable
  // output and snippet panels null their own outline and paint it on the frame
  // via `:has(.output-body:focus-visible)`, because the ring has to land on
  // parchment rather than on the near-black LCD ground. So walk a few ancestors.
  let ring = false;
  let ringSource = '';
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const cs = getComputedStyle(node);
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) {
      ring = true;
      ringSource = depth === 0 ? 'outline' : `outline on ancestor +${depth}`;
      break;
    }
    if (depth === 0 && cs.boxShadow && cs.boxShadow !== 'none') {
      ring = true;
      ringSource = 'box-shadow';
      break;
    }
  }

  const idxAttr = el.dataset.a11yIdx;
  const name =
    el.getAttribute('aria-label') ??
    (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return {
    idx: idxAttr === undefined ? -1 : Number(idxAttr),
    label: `${el.tagName.toLowerCase()}${name ? ` "${name}"` : ''}`,
    ring,
    ringSource,
  };
};

async function readActive(page: Page): Promise<Stop> {
  return page.evaluate(READ_ACTIVE);
}

/**
 * Press Tab (or Shift+Tab) `count` times, recording where focus lands each time.
 * Focus must start on the body, which is where a fresh load leaves it.
 */
export async function walk(page: Page, count: number, back = false): Promise<Stop[]> {
  const key = back ? 'Shift+Tab' : 'Tab';
  const stops: Stop[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key);
    stops.push(await readActive(page));
  }
  return stops;
}

export function formatStops(stops: Stop[]): string {
  return stops.map((s, i) => `  ${i}: idx=${s.idx} ${s.label}`).join('\n');
}
