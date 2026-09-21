import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { z } from 'zod';
import { paths } from './persistence.js';
import { VerifyMode } from './types.js';

/**
 * Product memory for `fullauto evolve`.
 *
 * Two files live under `.fullauto/`:
 *   - `product.md` — the LLM-owned brief written by /product-shape and
 *     rewritten by /product-assess after every round. The orchestrator never
 *     edits it; it only VALIDATES it (a brief with a missing section or an
 *     unparseable feature map would poison every later round's planner
 *     prompt) and EXTRACTS a capped context block for the planner.
 *   - `evolve-state.json` — orchestrator-owned loop state (`EvolveState`),
 *     the evolve counterpart of `state.json`.
 */

// ---------- product.md format ----------

/** Required h2 titles, in canonical spelling. Matched case-insensitively with collapsed whitespace. */
export const PRODUCT_REQUIRED_SECTIONS = [
  'Concept',
  'Target users & core value',
  'Category & benchmarks',
  'Principles & constraints',
  'Feature map',
  'Decisions',
  'Backlog',
  'Round log',
] as const;
export type ProductSection = (typeof PRODUCT_REQUIRED_SECTIONS)[number];

export const PRODUCT_MARKER = '<!-- fullauto:product v1 -->';

export const FEATURE_STATUSES = ['planned', 'in-progress', 'done', 'deferred', 'rejected'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** `| F001 | feature | status | round | note |` */
export interface FeatureRow {
  id: string;
  feature: string;
  status: FeatureStatus;
  round: string;
  note: string;
  /** 1-based line number in product.md (for error messages). */
  line: number;
}

/** `- [P1] F001 <feature> — impact:H effort:S — <why now>` */
export interface BacklogItem {
  priority?: string;
  id: string;
  feature: string;
  impact?: string;
  effort?: string;
  why?: string;
  raw: string;
  line: number;
}

export interface ProductBrief {
  name: string;
  hasMarker: boolean;
  /** Section body text keyed by canonical section title (only sections that were found). */
  sections: Partial<Record<ProductSection, string>>;
  /** h2 titles present in the file that are not required sections (kept for the context block). */
  extraSections: Record<string, string>;
  featureMap: FeatureRow[];
  backlog: BacklogItem[];
  /** Row / bullet level problems found while parsing (surfaced by `validateProductBrief`). */
  diagnostics: {
    featureMapErrors: string[];
    featureMapWarnings: string[];
    backlogWarnings: string[];
    /** Canonical section keys that appear more than once. */
    duplicateSections: string[];
  };
}

export interface ProductValidation {
  ok: boolean;
  /** Fatal — the brief must be rewritten before it can drive a round. */
  errors: string[];
  /** Non-fatal — logged, the brief is still usable. */
  warnings: string[];
  brief: ProductBrief;
}

const FEATURE_ID = /^F\d{3,}$/;
const H1_PRODUCT = /^#\s+Product\s*:\s*(.+?)\s*$/im;
const H2 = /^##\s+(.+?)\s*$/;

/** Canonical form for section-title comparison: lowercase, collapsed whitespace. */
function canon(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

const CANON_TO_SECTION = new Map<string, ProductSection>(
  PRODUCT_REQUIRED_SECTIONS.map((s) => [canon(s), s])
);

/**
 * Split product.md into h2 sections. Lenient by design — every shape
 * problem is reported by `validateProductBrief`, never thrown, so the
 * evolve loop can hand the errors back to the shaping subagent verbatim.
 */
export function parseProductBrief(source: string): ProductBrief {
  const lines = source.split(/\r?\n/);
  const nameMatch = source.match(H1_PRODUCT);
  const brief: ProductBrief = {
    name: nameMatch ? nameMatch[1].trim() : '',
    hasMarker: source.includes(PRODUCT_MARKER),
    sections: {},
    extraSections: {},
    featureMap: [],
    backlog: [],
    diagnostics: { featureMapErrors: [], featureMapWarnings: [], backlogWarnings: [], duplicateSections: [] },
  };

  // Collect sections with their line offsets so row/bullet diagnostics can
  // cite a line number the LLM can jump to.
  type Chunk = { title: string; canonical: ProductSection | undefined; startLine: number; lines: string[] };
  const chunks: Chunk[] = [];
  let current: Chunk | undefined;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A fenced code block may legitimately contain `## ...` (e.g. a quoted
    // template); do not let it open a section.
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence ? line.match(H2) : null;
    if (m) {
      current = { title: m[1].trim(), canonical: CANON_TO_SECTION.get(canon(m[1])), startLine: i + 1, lines: [] };
      chunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  const seenTitles = new Map<string, number>();
  for (const c of chunks) {
    const body = c.lines.join('\n').trim();
    const key = canon(c.title);
    seenTitles.set(key, (seenTitles.get(key) ?? 0) + 1);
    if (c.canonical) {
      // First occurrence wins; duplicates are reported by the validator.
      if (brief.sections[c.canonical] === undefined) brief.sections[c.canonical] = body;
    } else if (brief.extraSections[c.title] === undefined) {
      brief.extraSections[c.title] = body;
    }
  }
  for (const [key, n] of seenTitles) {
    if (n > 1) brief.diagnostics.duplicateSections.push(key);
  }

  const fm = chunks.find((c) => c.canonical === 'Feature map');
  if (fm) {
    const parsed = parseFeatureTable(fm.lines, fm.startLine);
    brief.featureMap = parsed.rows;
    brief.diagnostics.featureMapErrors = parsed.errors;
    brief.diagnostics.featureMapWarnings = parsed.warnings;
  }
  const bl = chunks.find((c) => c.canonical === 'Backlog');
  if (bl) {
    const parsed = parseBacklog(bl.lines, bl.startLine);
    brief.backlog = parsed.items;
    brief.diagnostics.backlogWarnings = parsed.warnings;
  }

  return brief;
}

interface FeatureTableParse {
  rows: FeatureRow[];
  errors: string[];
  warnings: string[];
  headerFound: boolean;
}

/**
 * Parse the markdown table under `## Feature map`. Columns are positional
 * (`id | feature | status | round | note`) — the header row is located by
 * its `id` and `status` cells so an extra column does not break parsing.
 */
function parseFeatureTable(lines: string[], startLine: number): FeatureTableParse {
  const rows: FeatureRow[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let headerFound = false;
  let cols = { id: 0, feature: 1, status: 2, round: 3, note: 4 };
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = startLine + 1 + i;
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitTableRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // separator row
    const lower = cells.map((c) => c.toLowerCase());
    if (!headerFound) {
      const idIdx = lower.indexOf('id');
      const statusIdx = lower.indexOf('status');
      if (idIdx !== -1 && statusIdx !== -1) {
        headerFound = true;
        cols = {
          id: idIdx,
          feature: lower.indexOf('feature') === -1 ? idIdx + 1 : lower.indexOf('feature'),
          status: statusIdx,
          round: lower.indexOf('round'),
          note: lower.indexOf('note'),
        };
        continue;
      }
      // Rows before a header: tolerate a header-less table with the
      // canonical column order rather than dropping the data.
      headerFound = true;
      warnings.push(`Feature map table has no header row (expected \`| id | feature | status | round | note |\`); assuming that column order.`);
    }
    const id = (cells[cols.id] ?? '').trim();
    const feature = (cells[cols.feature] ?? '').trim();
    const statusRaw = (cells[cols.status] ?? '').trim().toLowerCase();
    const round = cols.round >= 0 ? (cells[cols.round] ?? '').trim() : '';
    const note = cols.note >= 0 ? (cells[cols.note] ?? '').trim() : '';
    const problems: string[] = [];
    if (!FEATURE_ID.test(id)) problems.push(`id "${id || '(empty)'}" must look like F001`);
    if (!feature) problems.push('feature title is empty');
    if (!(FEATURE_STATUSES as readonly string[]).includes(statusRaw)) {
      problems.push(`status "${statusRaw || '(empty)'}" must be one of ${FEATURE_STATUSES.join('|')}`);
    }
    if (problems.length) {
      errors.push(`Feature map row at line ${lineNo} is malformed: ${problems.join('; ')} — row: ${line.trim()}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Feature map has duplicate id ${id} (line ${lineNo}).`);
      continue;
    }
    seen.add(id);
    rows.push({ id, feature, status: statusRaw as FeatureStatus, round, note, line: lineNo });
  }
  return { rows, errors, warnings, headerFound };
}

/** Split `| a | b | c |` into trimmed cells, ignoring the outer pipes. Escaped `\|` stays inside a cell. */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

interface BacklogParse {
  items: BacklogItem[];
  warnings: string[];
}

const BACKLOG_BULLET = /^\s*[-*+]\s+(.*)$/;
const BACKLOG_PRIORITY = /^\[(P\d+)\]\s*/i;
const BACKLOG_ID = /\b(F\d{3,})\b/;
const BACKLOG_IMPACT = /impact\s*:\s*([HML])\b/i;
const BACKLOG_EFFORT = /effort\s*:\s*([SML])\b/i;

/**
 * Backlog bullets. Only the feature id is mandatory — the priority tag,
 * impact/effort and "why now" are parsed when present so the planner
 * context and the report can show them, and their absence is a warning.
 */
function parseBacklog(lines: string[], startLine: number): BacklogParse {
  const items: BacklogItem[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BACKLOG_BULLET);
    if (!m) continue;
    const lineNo = startLine + 1 + i;
    let rest = m[1].trim();
    if (/^\[[ xX]\]/.test(rest)) rest = rest.replace(/^\[[ xX]\]\s*/, '');
    const pm = rest.match(BACKLOG_PRIORITY);
    const priority = pm ? pm[1].toUpperCase() : undefined;
    if (pm) rest = rest.slice(pm[0].length);
    const idm = rest.match(BACKLOG_ID);
    if (!idm) {
      warnings.push(`Backlog bullet at line ${lineNo} names no feature id (expected \`- [P1] F001 <feature> — impact:H effort:S — <why now>\`): ${lines[i].trim()}`);
      continue;
    }
    const id = idm[1];
    // Segments are separated by em/en dashes: title — impact/effort — why.
    const segments = rest.split(/\s+[—–]\s+/);
    const feature = segments[0].replace(BACKLOG_ID, '').trim().replace(/^[:\-]\s*/, '');
    const impact = rest.match(BACKLOG_IMPACT)?.[1].toUpperCase();
    const effort = rest.match(BACKLOG_EFFORT)?.[1].toUpperCase();
    const why = segments.length >= 3 ? segments.slice(2).join(' — ').trim() : undefined;
    if (!priority) warnings.push(`Backlog item ${id} (line ${lineNo}) has no [P#] priority tag.`);
    if (!impact || !effort) warnings.push(`Backlog item ${id} (line ${lineNo}) is missing impact:H|M|L / effort:S|M|L.`);
    items.push({ priority, id, feature: feature || id, impact, effort, why, raw: lines[i].trim(), line: lineNo });
  }
  return { items, warnings };
}

/**
 * Validate a product brief. `ok` means every required section exists, the
 * feature map is a well-formed table with ≥1 row, and the backlog has ≥1
 * item naming a feature id. Anything softer (missing marker, unknown
 * backlog ids, duplicate sections) is a warning.
 */
export function validateProductBrief(source: string): ProductValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const brief = parseProductBrief(source);

  if (!source.trim()) {
    return { ok: false, errors: ['product.md is empty.'], warnings, brief };
  }
  if (!brief.name) warnings.push('Missing `# Product: <name>` title line.');
  if (!brief.hasMarker) warnings.push(`Missing marker line \`${PRODUCT_MARKER}\` under the title.`);

  for (const s of PRODUCT_REQUIRED_SECTIONS) {
    if (brief.sections[s] === undefined) {
      errors.push(`Missing required section \`## ${s}\` (h2, exact title).`);
    } else if (!brief.sections[s]!.trim() && s !== 'Round log' && s !== 'Feature map' && s !== 'Backlog') {
      // Round log may be empty before round 1; the table / backlog sections
      // get their own, more specific, emptiness errors below.
      errors.push(`Section \`## ${s}\` is empty.`);
    }
  }

  for (const key of brief.diagnostics.duplicateSections) {
    warnings.push(`Section "${key}" appears more than once — only the first is used.`);
  }

  // Feature map: row-level problems from the parse, then the emptiness check.
  if (brief.sections['Feature map'] !== undefined) {
    errors.push(...brief.diagnostics.featureMapErrors);
    warnings.push(...brief.diagnostics.featureMapWarnings);
    if (brief.featureMap.length === 0 && brief.diagnostics.featureMapErrors.length === 0) {
      errors.push('Feature map has no rows — expected a markdown table `| id | feature | status | round | note |` with at least one F### row.');
    }
  }

  // Backlog: ≥1 item; ids should exist in the feature map.
  if (brief.sections['Backlog'] !== undefined) {
    warnings.push(...brief.diagnostics.backlogWarnings);
    if (brief.backlog.length === 0) {
      errors.push('Backlog has no items — expected ordered bullets `- [P1] F001 <feature> — impact:H|M|L effort:S|M|L — <why now>` (at least one).');
    }
    const known = new Set(brief.featureMap.map((f) => f.id));
    for (const item of brief.backlog) {
      if (known.size > 0 && !known.has(item.id)) {
        warnings.push(`Backlog item ${item.id} has no row in the Feature map.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, brief };
}

// ---------- planner context ----------

export interface ProductContextOptions {
  /** Hard cap on the returned text (default ~6k chars). */
  maxChars?: number;
  /** How many backlog items to inline (default 15). */
  backlogTop?: number;
}

const DEFAULT_CONTEXT_CHARS = 6000;

/** Truncate `text` to `max` chars, marking the cut. */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 14)).replace(/\s+\S*$/, '')}\n…(truncated)`;
}

/**
 * The planner does not need the whole brief — it needs who the product is
 * for, the rules, what exists, and what is next. Each part is clipped on its
 * own so a long Principles section cannot crowd out the backlog, then the
 * whole block is capped at `maxChars`.
 */
export function extractProductContext(source: string, opts: ProductContextOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_CONTEXT_CHARS;
  const backlogTop = opts.backlogTop ?? 15;
  const brief = parseProductBrief(source);
  const parts: string[] = [];

  if (brief.name) parts.push(`# Product: ${brief.name}`);
  const section = (title: ProductSection, cap: number): void => {
    const body = brief.sections[title];
    if (body === undefined || !body.trim()) return;
    parts.push(`## ${title}\n${clip(body, cap)}`);
  };
  section('Concept', 900);
  section('Target users & core value', 900);
  section('Category & benchmarks', 700);
  section('Principles & constraints', 1400);
  section('Decisions', 900);

  if (brief.featureMap.length) {
    const rows = brief.featureMap.map((f) => {
      const tail = [f.round ? `round ${f.round}` : '', f.note].filter(Boolean).join('; ');
      return `- ${f.id} [${f.status}] ${f.feature}${tail ? ` (${tail})` : ''}`;
    });
    parts.push(`## Feature map\n${clip(rows.join('\n'), 1600)}`);
  }

  if (brief.backlog.length) {
    const items = brief.backlog.slice(0, backlogTop).map((b) => `- ${b.raw.replace(/^[-*+]\s+/, '')}`);
    const more = brief.backlog.length > backlogTop ? `\n…(${brief.backlog.length - backlogTop} more backlog items in product.md)` : '';
    parts.push(`## Backlog (top ${Math.min(backlogTop, brief.backlog.length)}, in priority order)\n${clip(items.join('\n'), 2200)}${more}`);
  }

  return clip(parts.join('\n\n'), maxChars);
}

// ---------- machine lines ----------

export interface RoundHeader {
  round: number;
  items: string[];
}

const ROUND_HEADER = /<!--\s*fullauto:round\s*=\s*(\d+)\s+items\s*=\s*([^>]*?)\s*-->/i;

/**
 * `<!-- fullauto:round=<r> items=F001,F004 -->` — the planner writes it as
 * the first line of a round's tasks.md. The whole file is searched (not just
 * line 1) because a planner that prefixes a blank line or a heading should
 * not lose the round bookkeeping.
 */
export function parseRoundHeader(source: string): RoundHeader | null {
  const m = source.match(ROUND_HEADER);
  if (!m) return null;
  const round = parseInt(m[1], 10);
  if (!Number.isFinite(round)) return null;
  const items = m[2]
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => FEATURE_ID.test(s));
  return { round, items };
}

export const ASSESS_VERDICTS = ['continue', 'ship', 'stop'] as const;
export type AssessVerdictKind = (typeof ASSESS_VERDICTS)[number];

export interface AssessVerdict {
  verdict: AssessVerdictKind;
  /** 0–100 when the line carried a parseable score. */
  score?: number;
  /** Feature ids the assessor picked as next focus (empty for `none`). */
  next: string[];
  reason?: string;
  /** False when no `FULLAUTO_ASSESS:` line was found — verdict defaulted to `continue`. */
  found: boolean;
  warnings: string[];
}

/**
 * Parse the assessor's machine line. LAST line wins (an assessor that
 * quotes the format while thinking, then commits at the end, must not be
 * tripped by the earlier mention). Missing line → `continue` with unknown
 * score and a warning; an unknown verdict word is treated the same way
 * rather than stopping an unattended loop on a typo.
 */
export function parseAssessVerdict(stdout: string): AssessVerdict {
  const re = /^[ \t]*FULLAUTO_ASSESS:\s*(.+?)\s*$/gm;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) last = m[1];
  if (last === undefined) {
    return {
      verdict: 'continue',
      next: [],
      found: false,
      warnings: ['no FULLAUTO_ASSESS line found in assessor output — treating as verdict=continue with unknown score'],
    };
  }
  const warnings: string[] = [];
  const field = (name: string, stopAt: string[]): string | undefined => {
    // Values run until the next known `key=`; `reason` takes the rest of the line.
    const stops = stopAt.length ? `(?=\\s+(?:${stopAt.join('|')})=|$)` : '(?=$)';
    const fm = last!.match(new RegExp(`\\b${name}=(.*?)${stops}`, 'i'));
    return fm ? fm[1].trim() : undefined;
  };
  const keys = ['verdict', 'score', 'next', 'reason'];
  const others = (k: string) => keys.filter((x) => x !== k);
  const verdictRaw = (field('verdict', others('verdict')) ?? '').toLowerCase();
  let verdict: AssessVerdictKind = 'continue';
  if ((ASSESS_VERDICTS as readonly string[]).includes(verdictRaw)) {
    verdict = verdictRaw as AssessVerdictKind;
  } else {
    warnings.push(`FULLAUTO_ASSESS verdict "${verdictRaw || '(missing)'}" is not one of ${ASSESS_VERDICTS.join('|')} — treating as continue`);
  }
  let score: number | undefined;
  const scoreRaw = field('score', others('score'));
  if (scoreRaw !== undefined) {
    const n = parseInt(scoreRaw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) score = n;
    else warnings.push(`FULLAUTO_ASSESS score "${scoreRaw}" is not a number in 0–100 — ignored`);
  } else {
    warnings.push('FULLAUTO_ASSESS line has no score= field');
  }
  const nextRaw = field('next', others('next')) ?? '';
  const next = /^none$/i.test(nextRaw)
    ? []
    : nextRaw
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => FEATURE_ID.test(s));
  const reason = field('reason', others('reason'));
  return { verdict, score, next, reason: reason || undefined, found: true, warnings };
}

// ---------- evolve state ----------

export const EvolveStage = z.enum(['shape', 'plan', 'run', 'assess', 'done']);
export type EvolveStage = z.infer<typeof EvolveStage>;

export const EvolveOutcome = z.enum([
  /** Assessor judged the MVP loop complete. */
  'ship',
  /** Assessor judged progress blocked by something outside autonomy (needs a human). */
  'stop',
  'max_rounds',
  'time_budget',
  /** A round finished with zero done tasks. */
  'no_progress',
  /** Two consecutive rounds picked the same next set and no new feature reached done. */
  'stalled',
  /** A stage failed hard (invalid product.md after retry, planner failure, no gates). */
  'aborted',
]);
export type EvolveOutcome = z.infer<typeof EvolveOutcome>;

export const EvolveRound = z.object({
  round: z.number().int().positive(),
  stage: EvolveStage,
  tasksPath: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Set when the run stage kicked off a fresh `state.json` — on resume, its presence means "resume that run" rather than "start one". */
  runStartedAt: z.string().optional(),
  /** Counts of USER tasks (synthetic enhance/verify tasks are excluded). */
  tasksDone: z.number().int().nonnegative().default(0),
  tasksFailed: z.number().int().nonnegative().default(0),
  verdict: z.enum(ASSESS_VERDICTS).optional(),
  score: z.number().optional(),
  /** Backlog ids the round's plan covered (from the tasks.md round header). */
  backlogItems: z.array(z.string()).default([]),
  /** Ids the assessor picked as next focus (`next=`); used by the stall guard. */
  nextItems: z.array(z.string()).default([]),
  /** Feature ids at status `done` in product.md after assess; used by the stall guard. */
  featuresDone: z.array(z.string()).default([]),
  reason: z.string().optional(),
});
export type EvolveRound = z.infer<typeof EvolveRound>;

export const EvolveOptions = z.object({
  vibeEnhance: z.boolean().default(false),
  ux: z.boolean().default(false),
  verifyMode: VerifyMode.optional(),
});

export const EvolveState = z.object({
  concept: z.string(),
  startedAt: z.string(),
  /** Number of the current (or last) round; 0 before round 1 starts. */
  round: z.number().int().nonnegative().default(0),
  maxRounds: z.number().int().positive(),
  maxTasksPerRound: z.number().int().positive(),
  /** Wall-clock budget PER INVOCATION (a resume gets a fresh budget). */
  timeBudgetSec: z.number().int().positive().optional(),
  rounds: z.array(EvolveRound).default([]),
  /** Union of placeholder env names seeded across rounds (reported at the end). */
  placeholderEnvs: z.array(z.string()).default([]),
  options: EvolveOptions.default({}),
  outcome: EvolveOutcome.optional(),
  finishedAt: z.string().optional(),
  /** One line explaining the outcome (assessor reason, guard that fired, error). */
  outcomeDetail: z.string().optional(),
});
export type EvolveState = z.infer<typeof EvolveState>;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function saveEvolveState(projectDir: string, state: EvolveState): Promise<void> {
  const p = paths(projectDir);
  await mkdir(p.fullautoDir, { recursive: true });
  // temp + rename, same as state.json — a crash mid-write must not leave a
  // half file that blocks every later resume.
  const tmp = `${p.evolveStatePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, p.evolveStatePath);
}

export async function loadEvolveState(projectDir: string): Promise<EvolveState | null> {
  const p = paths(projectDir);
  if (!(await fileExists(p.evolveStatePath))) return null;
  const raw = await readFile(p.evolveStatePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `evolve-state.json is corrupted (invalid JSON). Run \`fullauto evolve --force "<concept>"\` to start over (product.md is kept), or restore from a backup.`
    );
  }
  try {
    return EvolveState.parse(parsed);
  } catch (err) {
    throw new Error(
      `evolve-state.json schema mismatch — the file may be from an older version. Run \`fullauto evolve --force "<concept>"\` to start over.\nDetails: ${(err as Error).message}`
    );
  }
}

/** Read product.md if present; null when missing. */
export async function loadProductBrief(projectDir: string): Promise<string | null> {
  const p = paths(projectDir);
  if (!(await fileExists(p.productPath))) return null;
  return readFile(p.productPath, 'utf-8');
}
