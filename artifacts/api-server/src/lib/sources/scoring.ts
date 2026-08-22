// Relevance scoring for fetched job listings against the configured profile
// signals.
//
// Nothing here is hardcoded to a particular candidate: every keyword rule,
// weight, penalty and location signal comes from `scoring` in
// jobblast.config.json (see lib/config.ts for the schema and defaults, and
// docs/CONFIG.md for the documentation). Target locations default to the DB
// profile's `targetLocations` when the config doesn't list explicit
// keywords.
//
// This is a simple weighted-keyword scorer, not ML: each rule looks for a
// pattern in the title and/or description, awards points, and records a
// human-readable reason. Title hits count double since a keyword in the
// title is a much stronger signal than one buried in a long description.

import { loadConfig, toRegExp } from "../config";
import type { RawJob, ScoredJob } from "./types";

type CompiledRule = {
  regex: RegExp;
  skill: string;
  weight: number;
  reason: string;
  titleReason: string;
};

type CompiledPenalty = {
  regex: RegExp;
  weight: number;
  reason: string;
};

type CompiledScoring = {
  rules: CompiledRule[];
  locationBonus: number;
  locationBonusReason: string;
  scoreCap: number;
  configuredLocationKeywords: string[];
  targetishRegex: RegExp | null;
  remoteRegex: RegExp;
  workAuthorization: CompiledPenalty;
  seniorYears: CompiledPenalty;
  seniorTitle: CompiledPenalty;
  usLocation: CompiledPenalty;
  offsite: { weight: number; reason: string };
};

let compiled: CompiledScoring | null = null;

function compileScoring(): CompiledScoring {
  if (compiled) return compiled;

  const { scoring } = loadConfig();
  const penalty = (
    spec: { pattern: string; flags: string; weight: number; reason: string },
    label: string,
  ): CompiledPenalty => ({
    regex: toRegExp(spec, `scoring.penalties.${label}`),
    weight: spec.weight,
    reason: spec.reason,
  });

  compiled = {
    rules: scoring.rules.map((rule, index) => ({
      regex: toRegExp(rule, `scoring.rules[${index}] (${rule.skill})`),
      skill: rule.skill,
      weight: rule.weight,
      reason: rule.reason,
      titleReason: rule.titleReason ?? `${rule.reason} (title)`,
    })),
    locationBonus: scoring.locationBonus,
    locationBonusReason: scoring.locationBonusReason,
    scoreCap: scoring.scoreCap,
    configuredLocationKeywords: scoring.targetLocationKeywords
      .map((keyword) => keyword.trim().toLowerCase())
      .filter((keyword) => keyword.length > 0),
    targetishRegex: scoring.targetishLocationPattern
      ? toRegExp(scoring.targetishLocationPattern, "scoring.targetishLocationPattern")
      : null,
    remoteRegex: toRegExp(scoring.remoteSignalPattern, "scoring.remoteSignalPattern"),
    workAuthorization: penalty(scoring.penalties.workAuthorization, "workAuthorization"),
    seniorYears: penalty(scoring.penalties.seniorYears, "seniorYears"),
    seniorTitle: penalty(scoring.penalties.seniorTitle, "seniorTitle"),
    usLocation: penalty(scoring.penalties.usLocation, "usLocation"),
    offsite: scoring.penalties.offsiteNonTarget,
  };
  return compiled;
}

/**
 * Turns a profile's free-text target locations ("Paris / Île-de-France,
 * France") into loosely-matchable lowercase keywords (["paris",
 * "île-de-france", "france"]). Only used when the config doesn't declare
 * `scoring.targetLocationKeywords` explicitly.
 */
export function locationKeywordsFromProfile(targetLocations: string[]): string[] {
  const keywords = new Set<string>();
  for (const location of targetLocations) {
    for (const part of location.split(/[/,]/)) {
      const keyword = part.trim().toLowerCase();
      if (keyword.length > 1) keywords.add(keyword);
    }
  }
  return Array.from(keywords);
}

function withLocation(template: string, location: string): string {
  return template.replace(/\{location\}/g, location);
}

/**
 * Scores one job. `profileLocationKeywords` (derived from the DB profile by
 * the caller) is only consulted when the config leaves
 * `scoring.targetLocationKeywords` empty.
 */
export function scoreJob(job: RawJob, profileLocationKeywords: string[] = []): ScoredJob {
  const cfg = compileScoring();
  const title = job.title.toLowerCase();
  const description = job.description.toLowerCase();

  const locationKeywords =
    cfg.configuredLocationKeywords.length > 0
      ? cfg.configuredLocationKeywords
      : profileLocationKeywords.map((keyword) => keyword.toLowerCase());

  let score = 0;
  const matchReasons: string[] = [];
  const highlightedSkills = new Set<string>();

  for (const rule of cfg.rules) {
    const inTitle = rule.regex.test(title);
    const inDescription = rule.regex.test(description);
    if (!inTitle && !inDescription) continue;

    highlightedSkills.add(rule.skill);
    if (inTitle) {
      score += rule.weight * 2;
      matchReasons.push(rule.titleReason);
    } else {
      score += rule.weight;
      matchReasons.push(rule.reason);
    }
  }

  const locationText = job.location.toLowerCase();
  const matchedLocation = locationKeywords.find((keyword) => locationText.includes(keyword));
  if (matchedLocation) {
    score += cfg.locationBonus;
    matchReasons.push(withLocation(cfg.locationBonusReason, job.location));
  }

  for (const [rule, titleOnly] of [
    [cfg.workAuthorization, false],
    [cfg.seniorYears, false],
    [cfg.seniorTitle, true],
  ] as const) {
    const haystack = titleOnly ? title : `${title}\n${description}`;
    if (!rule.regex.test(haystack)) continue;
    score += rule.weight;
    matchReasons.push(withLocation(rule.reason, job.location));
  }

  if (!matchedLocation && cfg.usLocation.regex.test(job.location)) {
    score += cfg.usLocation.weight;
    matchReasons.push(withLocation(cfg.usLocation.reason, job.location));
  }

  // "Target-ish" is deliberately broader than the target keywords (e.g.
  // anywhere in the target countries, département codes...). Without an
  // explicit pattern we fall back to the target keywords themselves.
  const isTargetish = cfg.targetishRegex
    ? cfg.targetishRegex.test(job.location)
    : Boolean(matchedLocation);
  const hasRemoteSignal =
    cfg.remoteRegex.test(job.location) ||
    cfg.remoteRegex.test(title) ||
    cfg.remoteRegex.test(description);
  if (!isTargetish && !hasRemoteSignal) {
    score += cfg.offsite.weight;
    matchReasons.push(withLocation(cfg.offsite.reason, job.location));
  }

  return {
    ...job,
    relevanceScore: Math.max(0, Math.min(cfg.scoreCap, Math.round(score))),
    matchReasons,
    highlightedSkills: Array.from(highlightedSkills),
  };
}

export function scoreJobs(jobs: RawJob[], profileLocationKeywords: string[] = []): ScoredJob[] {
  return jobs.map((job) => scoreJob(job, profileLocationKeywords));
}
