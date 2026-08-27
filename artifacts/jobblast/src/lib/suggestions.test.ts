// Pure-logic tests for the smart-search helpers (lot H6). No DOM, no
// network: fold/dedup/filter are plain string functions, exercised directly.

import { describe, expect, it } from 'vitest';
import { ROME_ROLE_SUGGESTIONS } from './rome-roles';
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

  it('sizes roughly match the lot J1 brief (opening to all trades, was lot H6)', () => {
    expect(SKILL_SUGGESTIONS.length).toBeGreaterThanOrEqual(380);
    expect(SKILL_SUGGESTIONS.length).toBeLessThanOrEqual(450);
    expect(LOCATION_SUGGESTIONS.length).toBeGreaterThanOrEqual(95);
    expect(LOCATION_SUGGESTIONS.length).toBeLessThanOrEqual(115);
  });

  it('ROLE_SUGGESTIONS scales to the lot K1 brief\'s target after merging in ROME_ROLE_SUGGESTIONS (~2000-4000)', () => {
    expect(ROLE_SUGGESTIONS.length).toBeGreaterThanOrEqual(2000);
    expect(ROLE_SUGGESTIONS.length).toBeLessThanOrEqual(4000);
  });
});

describe('ROLE_SUGGESTIONS merge with ROME_ROLE_SUGGESTIONS (lot K1)', () => {
  it('keeps the hand-picked roles in their original relative order, all before the ROME-only entries', () => {
    // 'Software Engineer' is the first hand-picked role, 'Ouvrier Agricole'
    // the last (see suggestions.ts's HAND_PICKED_ROLE_SUGGESTIONS); 'Maçon
    // -fumiste' is a niche ROME-only term no hand-picked list names.
    const first = ROLE_SUGGESTIONS.indexOf('Software Engineer');
    const last = ROLE_SUGGESTIONS.indexOf('Ouvrier Agricole');
    const romeOnly = ROLE_SUGGESTIONS.indexOf('Maçon-fumiste');
    expect(first).toBe(0);
    expect(first).toBeLessThan(last);
    expect(last).toBeLessThan(romeOnly);
  });

  it('is deduplicated by fold across the hand-picked and ROME pools combined', () => {
    const folded = ROLE_SUGGESTIONS.map(fold);
    expect(new Set(folded).size).toBe(folded.length);
  });

  it('adds real new ROME entries not present in the pre-K1 hand-picked list (e.g. a niche trade)', () => {
    expect(ROLE_SUGGESTIONS).toContain('Maçon-fumiste');
  });

  it('every ROME_ROLE_SUGGESTIONS entry is represented in ROLE_SUGGESTIONS (itself, or a fold-equal hand-picked entry)', () => {
    const foldedRoleSuggestions = new Set(ROLE_SUGGESTIONS.map(fold));
    for (const romeEntry of ROME_ROLE_SUGGESTIONS) {
      expect(foldedRoleSuggestions.has(fold(romeEntry))).toBe(true);
    }
  });

  it('never shows a ROME entry that folds the same as an existing hand-picked entry twice', () => {
    // "Maçon" is both hand-picked (SKILL_SUGGESTIONS/ROLE_SUGGESTIONS predate
    // lot K1) and present verbatim in ROME_ROLE_SUGGESTIONS - only one survives the merge.
    const maconOccurrences = ROLE_SUGGESTIONS.filter((role) => fold(role) === fold('Maçon'));
    expect(maconOccurrences).toHaveLength(1);
  });
});

describe('filterSuggestions against the merged ~3200-entry ROLE_SUGGESTIONS pool (lot K1)', () => {
  it('finds relevant results typing "infirm" (santé)', () => {
    const results = filterSuggestions(ROLE_SUGGESTIONS, 'infirm');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((role) => fold(role).includes('infirm'))).toBe(true);
  });

  it('finds relevant results typing "maç" (BTP)', () => {
    const results = filterSuggestions(ROLE_SUGGESTIONS, 'maç');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((role) => fold(role).startsWith('macon'))).toBe(true);
  });

  it('finds relevant results typing "comptab" (tertiaire)', () => {
    const results = filterSuggestions(ROLE_SUGGESTIONS, 'comptab');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((role) => fold(role).includes('comptab'))).toBe(true);
  });

  it('still caps at MAX_SUGGESTIONS against the much larger pool', () => {
    expect(filterSuggestions(ROLE_SUGGESTIONS, 'e').length).toBe(MAX_SUGGESTIONS);
  });

  it('runs comfortably fast against the merged pool (perf check, lot K1 brief)', () => {
    const queries = ['infirm', 'maç', 'comptab', 'dev', 'chauffeur', 'a', 'e'];
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      for (const query of queries) filterSuggestions(ROLE_SUGGESTIONS, query);
    }
    const elapsedMs = performance.now() - start;
    // 350 calls against a ~3200-entry pool; generous budget - this is a
    // regression guard, not a tight benchmark (see build-rome-suggestions's
    // report for the actual measured numbers with/without fold() memoized).
    expect(elapsedMs).toBeLessThan(2000);
  });
});
