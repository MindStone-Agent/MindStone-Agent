/**
 * Minimal SemVer 2.0.0 parsing and range satisfaction for the pack subsystem
 * (design D5/§5). Dependency-free by intent — mindstone-core carries no
 * runtime dependencies. Supported range grammar (comma/space-separated
 * comparator sets, `||` alternatives):
 *
 *   1.2.3        exact        ^1.2.3   compatible-with (SemVer caret)
 *   ~1.2.3       tilde        >=1.2.3 <2.0.0   comparator conjunction
 *   *            any
 *
 * That covers every range the design document uses. Unknown syntax fails
 * CLOSED (returns unsatisfied) — a range we cannot parse must never admit a
 * version.
 */

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemVer(input: string): SemVer | undefined {
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1; // numeric identifiers sort before alphanumeric
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A prerelease sorts BELOW the release it precedes.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const cmp = compareIdentifiers(ai, bi);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

type Comparator = { op: ">=" | ">" | "<=" | "<" | "="; version: SemVer };

function parseComparator(token: string): Comparator | undefined {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token.trim());
  if (!match) return undefined;
  const version = parseSemVer(match[2]);
  if (!version) return undefined;
  return { op: (match[1] as Comparator["op"]) ?? "=", version };
}

function satisfiesComparator(version: SemVer, comparator: Comparator): boolean {
  const cmp = compareSemVer(version, comparator.version);
  switch (comparator.op) {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
  }
}

/** Expand ^/~ sugar into comparator conjunctions. Returns undefined on unparseable input. */
function expandRangePart(part: string): Comparator[] | undefined {
  const trimmed = part.trim();
  if (trimmed === "*" || trimmed === "") return [];
  if (trimmed.startsWith("^")) {
    const base = parseSemVer(trimmed.slice(1));
    if (!base) return undefined;
    const upper: SemVer = base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
    return [{ op: ">=", version: base }, { op: "<", version: upper }];
  }
  if (trimmed.startsWith("~")) {
    const base = parseSemVer(trimmed.slice(1));
    if (!base) return undefined;
    return [
      { op: ">=", version: base },
      { op: "<", version: { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] } },
    ];
  }
  const comparators: Comparator[] = [];
  for (const token of trimmed.split(/\s+/)) {
    const comparator = parseComparator(token);
    if (!comparator) return undefined;
    comparators.push(comparator);
  }
  return comparators;
}

/**
 * Range satisfaction. Unknown/unparseable ranges fail CLOSED. Prerelease
 * versions only satisfy ranges that explicitly mention a prerelease of the
 * same [major, minor, patch] tuple (standard SemVer range semantics).
 */
export function satisfiesRange(versionInput: string, rangeInput: string): boolean {
  const version = parseSemVer(versionInput);
  if (!version) return false;
  for (const alternative of rangeInput.split("||")) {
    const comparators = expandRangePart(alternative);
    if (comparators === undefined) return false; // fail closed on syntax we don't know
    if (version.prerelease.length > 0) {
      const anchored = comparators.some((c) =>
        c.version.prerelease.length > 0 &&
        c.version.major === version.major && c.version.minor === version.minor && c.version.patch === version.patch);
      if (!anchored) continue;
    }
    if (comparators.every((c) => satisfiesComparator(version, c))) return true;
  }
  return false;
}
