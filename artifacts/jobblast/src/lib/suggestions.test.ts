// Pure-logic tests for the smart-search helpers (lot H6). No DOM, no
// network: fold/dedup/filter are plain string functions, exercised directly.

import { describe, expect, it } from 'vitest';
import {
  COMPANY_SUGGESTIONS,
  fold,
  isDuplicateTag,
  LOCATION_SUGGESTIONS,
  MAX_SUGGESTIONS,
  ROLE_SUGGESTIONS,
  SKILL_SUGGESTIONS,
  filterSuggestions,
} from './suggestions';

describe('fold', () => {
  it('lowercases and strips diacritics', () => {
    expect(fold('Thalès')).toBe('thales');
    expect(fold('ÉTÉ')).toBe('ete');
  });

  it('trims surrounding whitespace', () => {
    expect(fold('  Paris  ')).toBe('paris');
  });
});

describe('isDuplicateTag', () => {
  it('treats "C++", "c++" and "c ++" (with extra spaces) as the same tag', () => {
    const existing = ['C++'];
    expect(isDuplicateTag(existing, 'c++')).toBe(true);
    expect(isDuplicateTag(existing, 'c ++')).toBe(true);
    expect(isDuplicateTag(existing, 'C ++ ')).toBe(true);
  });

  it('is accent-insensitive', () => {
    expect(isDuplicateTag(['Thales'], 'Thalès')).toBe(true);
    expect(isDuplicateTag(['Thalès'], 'thales')).toBe(true);
  });

  it('is not fooled by an unrelated substring', () => {
    expect(isDuplicateTag(['React'], 'React Native')).toBe(false);
    expect(isDuplicateTag(['React Native'], 'React')).toBe(false);
  });

  it('treats a blank candidate as never a duplicate', () => {
    expect(isDuplicateTag(['React'], '   ')).toBe(false);
  });

  it('returns false against an empty list', () => {
    expect(isDuplicateTag([], 'React')).toBe(false);
  });
});

describe('filterSuggestions', () => {
  const pool = ['Paris', 'Tokyo', 'Taipei', 'Remote', 'Hybrid'];

  it('matches case- and accent-insensitively by substring', () => {
    expect(filterSuggestions(pool, 'tai', [])).toEqual(['Taipei']);
    expect(filterSuggestions(['Thalès'], 'thal', [])).toEqual(['Thalès']);
  });

  it('ranks a prefix match before a mid-string match', () => {
    // "to" is a prefix of Tokyo and a mid-string hit nowhere else here, but
    // add a mid-string case explicitly to exercise the ranking.
    const withMidString = ['Ontology Inc', 'Tokyo'];
    expect(filterSuggestions(withMidString, 'to', [])).toEqual(['Tokyo', 'Ontology Inc']);
  });

  it('excludes suggestions that duplicate an already-added value', () => {
    expect(filterSuggestions(pool, 'pa', ['Paris'])).toEqual([]);
  });

  it('returns nothing for a blank query', () => {
    expect(filterSuggestions(pool, '   ', [])).toEqual([]);
    expect(filterSuggestions(pool, '', [])).toEqual([]);
  });

  it('caps results at the given limit (default MAX_SUGGESTIONS)', () => {
    const bigPool = Array.from({ length: 20 }, (_, i) => `Location ${i}`);
    expect(filterSuggestions(bigPool, 'location', []).length).toBe(MAX_SUGGESTIONS);
    expect(filterSuggestions(bigPool, 'location', [], 3).length).toBe(3);
  });

  it('never returns more than the pool actually has', () => {
    expect(filterSuggestions(['Remote'], 'remo', []).length).toBe(1);
  });
});

describe('vocabularies', () => {
  it('are non-empty, deduplicated flat string lists', () => {
    for (const vocab of [SKILL_SUGGESTIONS, LOCATION_SUGGESTIONS, ROLE_SUGGESTIONS, COMPANY_SUGGESTIONS]) {
      expect(vocab.length).toBeGreaterThan(0);
      const folded = vocab.map(fold);
      expect(new Set(folded).size).toBe(folded.length);
    }
  });

  it('sizes roughly match the lot H6 brief', () => {
    expect(SKILL_SUGGESTIONS.length).toBeGreaterThanOrEqual(150);
    expect(SKILL_SUGGESTIONS.length).toBeLessThanOrEqual(250);
    expect(LOCATION_SUGGESTIONS.length).toBeGreaterThanOrEqual(60);
    expect(LOCATION_SUGGESTIONS.length).toBeLessThanOrEqual(80);
    expect(ROLE_SUGGESTIONS.length).toBeGreaterThanOrEqual(40);
    expect(ROLE_SUGGESTIONS.length).toBeLessThanOrEqual(63);
  });
});
