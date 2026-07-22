const WORDS_PER_MINUTE = 200;

/** Whole minutes, rounded up, minimum 1 — matches the display label below. */
export function readingMinutes(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

export function readingTimeLabel(body: string): string {
  return `${readingMinutes(body)} min read`;
}

/** ISO 8601 duration for the `timeRequired` field of schema.org BlogPosting. */
export function readingTimeISO8601(body: string): string {
  return `PT${readingMinutes(body)}M`;
}
