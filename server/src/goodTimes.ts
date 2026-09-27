/** The `good_times` shape stored per spot, and validation for it. */

export const PHASES = ['sunrise', 'golden_am', 'day', 'golden_pm', 'sunset', 'blue', 'night', 'astro'] as const;
export type Phase = (typeof PHASES)[number];

export const DAYS = ['any', 'weekday', 'weekend'] as const;
export type Days = (typeof DAYS)[number];

export interface GoodTimes {
  phases: Phase[];
  months: number[];
  days: Days;
  conditions: string[];
  eventKeywords: string[];
  avoid: string;
  notes: string;
}

export const DEFAULT_GOOD_TIMES: GoodTimes = {
  phases: [],
  months: [],
  days: 'any',
  conditions: [],
  eventKeywords: [],
  avoid: '',
  notes: '',
};

export class GoodTimesError extends Error {}

function stringArray(value: unknown, field: string, maxLen = 200): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new GoodTimesError(`${field} must be an array of strings`);
  }
  return value.map((s) => s.trim().slice(0, maxLen)).filter(Boolean);
}

/** Parse and validate an untrusted `good_times` payload, filling in defaults. */
export function parseGoodTimes(value: unknown): GoodTimes {
  if (value == null || typeof value !== 'object') return { ...DEFAULT_GOOD_TIMES };
  const v = value as Record<string, unknown>;

  const phases = stringArray(v.phases, 'phases');
  for (const p of phases) {
    if (!(PHASES as readonly string[]).includes(p)) throw new GoodTimesError(`Unknown phase: ${p}`);
  }

  const months = Array.isArray(v.months) ? v.months : v.months === undefined ? [] : null;
  if (months === null || !months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) {
    throw new GoodTimesError('months must be an array of integers 1-12');
  }

  const days = v.days === undefined ? 'any' : v.days;
  if (!(DAYS as readonly unknown[]).includes(days)) throw new GoodTimesError('days must be any, weekday or weekend');

  const avoid = v.avoid === undefined ? '' : v.avoid;
  if (typeof avoid !== 'string') throw new GoodTimesError('avoid must be a string');

  const notes = v.notes === undefined ? '' : v.notes;
  if (typeof notes !== 'string') throw new GoodTimesError('notes must be a string');

  return {
    phases: phases as Phase[],
    months: [...new Set(months)].sort((a, b) => a - b),
    days: days as Days,
    conditions: stringArray(v.conditions, 'conditions', 40),
    eventKeywords: stringArray(v.eventKeywords, 'eventKeywords', 60),
    avoid: avoid.slice(0, 500),
    notes: notes.slice(0, 2000),
  };
}
