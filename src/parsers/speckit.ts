import { readFile } from 'node:fs/promises';
import type { Task } from '../types.js';

/**
 * Parse a tasks.md file into a Task[] list.
 *
 * Supports the Speckit `/speckit.tasks` output format and the looser markdown
 * conventions people tend to write by hand. Recognized line shapes:
 *
 *   - [ ] T001 Description
 *   - [ ] T001: Description
 *   - [ ] 1. Description
 *   * [ ] Description                       (auto-assigned ID)
 *   1. Description                          (auto-assigned ID)
 *
 * Indented sub-bullets and free text after a task line are folded into the
 * task body until the next top-level checkbox/numbered item.
 *
 * Dependencies are extracted from inline annotations:
 *   - [ ] T003 Foo (depends on T001, T002)
 *   - [ ] T003 Foo [depends: T001, T002]
 */

const TASK_LINE = new RegExp(
  String.raw`^\s*(?:[-*+]\s+)?` + // optional list bullet
    String.raw`(?:\[[ xX]\]\s+)?` + // optional checkbox
    String.raw`(?:` + // ID group
    String.raw`(T\d+)|` + //   T001
    String.raw`(\d+)\.|` + //   1.
    String.raw`\((\d+)\)` + //   (1)
    String.raw`)?` +
    String.raw`\s*[:.\-)]?\s*` + // optional separator after ID
    String.raw`(.+?)\s*$` // title text
);

const DEPENDS_INLINE =
  /\(\s*depends\s+on\s+([^)]+)\)|\[\s*depends:\s*([^\]]+)\]/i;
const TASK_REF = /T?\d+/g;

interface ParsedLine {
  id?: string;
  rawTitle: string;
  isTaskLine: boolean;
  indent: number;
}

function classifyLine(line: string): ParsedLine {
  const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
  // A "task line" must start at column 0 with a checkbox or numbered prefix —
  // indented bullets are body text. Speckit uses no indentation for tasks.
  if (indent > 0) {
    return { rawTitle: line.trim(), isTaskLine: false, indent };
  }
  const m = line.match(TASK_LINE);
  if (!m) return { rawTitle: line.trim(), isTaskLine: false, indent };

  const rawId = m[1] ?? m[2] ?? m[3];
  const title = m[4]?.trim();
  if (!title) return { rawTitle: line.trim(), isTaskLine: false, indent };

  // Heuristic: require either a checkbox OR a numeric/T-prefixed ID for it
  // to count as a task line. Otherwise plain prose lines would be promoted.
  const hasCheckbox = /\[[ xX]\]/.test(line);
  if (!hasCheckbox && !rawId) {
    return { rawTitle: title, isTaskLine: false, indent };
  }

  return {
    id: rawId ? canonicalizeId(rawId) : undefined,
    rawTitle: title,
    isTaskLine: true,
    indent,
  };
}

/**
 * Normalize every form of task ID into a single canonical `T###` shape so
 * that `T1`, `T01`, `T001`, `1`, `01`, and `001` all collapse to `T001`.
 *
 * Without this, dependency references and explicit IDs can diverge in
 * surface form even when they refer to the same task — e.g. a line `1. Foo`
 * stores `id="1"` while `(depends on 1)` is normalized to `T001` elsewhere,
 * leaving the dep unresolvable.
 */
function canonicalizeId(rawId: string): string {
  const digits = rawId.replace(/^T/i, '');
  if (!/^\d+$/.test(digits)) return rawId; // safety: leave odd shapes alone
  return `T${digits.padStart(3, '0')}`;
}

function extractDependencies(rawTitle: string): {
  cleanTitle: string;
  dependencies: string[];
} {
  const m = rawTitle.match(DEPENDS_INLINE);
  if (!m) return { cleanTitle: rawTitle, dependencies: [] };

  const depBlob = m[1] ?? m[2] ?? '';
  const deps = depBlob.match(TASK_REF) ?? [];
  // Use the same canonical form as task IDs so deps always resolve.
  const normalized = deps.map(canonicalizeId);
  const cleanTitle = rawTitle.replace(DEPENDS_INLINE, '').trim();
  return { cleanTitle, dependencies: normalized };
}

/**
 * The Manual Prerequisites section lives in the same tasks.md file (planner
 * appends it after the task list). Cut the source at that boundary so the
 * task parser never tries to interpret prereq bullets as tasks.
 */
const PREREQ_CUTOFF =
  /^[ \t]*<!--\s*fullauto:prerequisites\s*-->[ \t]*$|^[ \t]*##+\s*Manual\s+Prerequisites\s*$/im;

function stripPrerequisitesSection(source: string): string {
  const m = source.match(PREREQ_CUTOFF);
  if (!m || m.index === undefined) return source;
  return source.slice(0, m.index);
}

// h2 heading that introduces a feature group in HAND-WRITTEN tasks.md.
// Tasks following it (until the next h2) belong to that feature. Allow
// optional "Feature: " prefix so users can write either `## Auth flow` or
// `## Feature: Auth flow`. NOT used when the file is Speckit-format (see
// fileUsesStoryLabels below) — Speckit's h2 is "Phase N: ..." which spans
// multiple categories beyond what we want as feature boundaries.
const FEATURE_HEADING = /^##\s+(?:Feature\s*:\s*)?(.+?)\s*$/i;

// Speckit task lines carry a `[USx]` story label and optionally `[P]`
// (parallel-safe) flag right after the ID. The story label IS the feature
// boundary in Speckit — each user story is "delivered as an MVP increment"
// per the template. We pre-scan for any [USx] occurrence to detect Speckit
// mode automatically; in that mode, h2 is ignored.
const STORY_LABEL = /\[\s*(US\d+)\s*\]/i;
const PARALLEL_FLAG = /\[\s*P\s*\]/gi;

function stripSpeckitFlags(rawTitle: string): {
  storyId: string | undefined;
  cleanTitle: string;
} {
  const storyMatch = rawTitle.match(STORY_LABEL);
  const storyId = storyMatch ? storyMatch[1].toUpperCase() : undefined;
  const cleaned = rawTitle
    .replace(STORY_LABEL, '')
    .replace(PARALLEL_FLAG, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { storyId, cleanTitle: cleaned };
}

export function parseTasksMarkdown(source: string): Task[] {
  const lines = stripPrerequisitesSection(source).split(/\r?\n/);
  const tasks: Task[] = [];
  let current: { task: Task; bodyLines: string[] } | null = null;
  let currentFeature: string | undefined = undefined;

  // First pass: (a) collect every explicit ID so the auto-ID counter can
  // skip them and never collide; (b) decide whether the file is Speckit
  // format (any `[USx]` label present anywhere). The two passes through
  // `classifyLine` are cheap — bodies aren't needed yet.
  const explicitIds = new Set<string>();
  let fileUsesStoryLabels = false;
  for (const line of lines) {
    const parsed = classifyLine(line);
    if (parsed.isTaskLine) {
      if (parsed.id) explicitIds.add(parsed.id);
      if (STORY_LABEL.test(parsed.rawTitle)) fileUsesStoryLabels = true;
    }
  }
  let autoCounter = 1;
  const nextAutoId = (): string => {
    while (true) {
      const candidate = `T${String(autoCounter).padStart(3, '0')}`;
      autoCounter += 1;
      if (!explicitIds.has(candidate)) return candidate;
    }
  };

  const finalize = () => {
    if (!current) return;
    const body = current.bodyLines.join('\n').trim();
    current.task.body = body || current.task.title;
    tasks.push(current.task);
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      // Blank lines belong to the body of the current task (preserves spacing).
      if (current) current.bodyLines.push('');
      continue;
    }

    // h2 heading switches the active feature group — but ONLY in hand-written
    // (non-Speckit) mode. Speckit's h2 is "Phase N: ..." which spans Setup /
    // Foundational / each User Story / Polish, and only the User Story phases
    // are real feature boundaries. The story label on each task gives that
    // information directly, so h2 is redundant noise in Speckit mode.
    const headingMatch = line.match(FEATURE_HEADING);
    if (headingMatch) {
      finalize();
      if (!fileUsesStoryLabels) {
        currentFeature = headingMatch[1].trim();
      }
      continue;
    }

    const parsed = classifyLine(line);
    if (parsed.isTaskLine) {
      finalize();
      // In Speckit mode: feature comes from the [USx] label on this line —
      // tasks without a label (Setup/Foundational/Polish) get feature=undefined
      // and form one implicit group, so enhance fires only after every cross-
      // cutting task is also done (i.e. effectively "end of run").
      // In hand-written mode: feature comes from the most recent h2 heading.
      let titleForExtract = parsed.rawTitle;
      let feature: string | undefined = currentFeature;
      if (fileUsesStoryLabels) {
        const stripped = stripSpeckitFlags(parsed.rawTitle);
        titleForExtract = stripped.cleanTitle;
        feature = stripped.storyId; // may be undefined for non-story tasks
      }
      const { cleanTitle, dependencies } = extractDependencies(titleForExtract);
      const id = parsed.id ?? nextAutoId();
      current = {
        task: {
          id,
          title: cleanTitle,
          body: '',
          dependencies,
          status: 'pending',
          attempts: [],
          feature,
          kind: 'user',
        },
        bodyLines: [],
      };
    } else if (current) {
      current.bodyLines.push(line);
    }
    // Lines before the first task are ignored (heading, intro paragraphs, etc.)
  }

  finalize();

  // Trim trailing blank lines from each body
  for (const t of tasks) {
    t.body = t.body.replace(/\s+$/g, '');
    if (!t.body) t.body = t.title;
  }

  return tasks;
}

export async function loadTasksFromFile(path: string): Promise<Task[]> {
  const source = await readFile(path, 'utf-8');
  const tasks = parseTasksMarkdown(source);
  if (tasks.length === 0) {
    throw new Error(
      `No tasks parsed from ${path}. Expected markdown checkbox list (e.g. "- [ ] T001 Description").`
    );
  }
  return tasks;
}

export type PrerequisiteKind = 'ENV' | 'AUTH' | 'ACCOUNT' | 'OTHER';

export interface Prerequisite {
  kind: PrerequisiteKind;
  /** For ENV: the variable name. For others: a short label/identifier or empty. */
  identifier: string;
  description: string;
}

/**
 * Pull the "Manual Prerequisites" section out of a tasks.md and parse each
 * bullet. Supports both the marker comment and the markdown header.
 *
 * Recognized line shape:  - [KIND] IDENTIFIER — description
 *                         - [KIND] description without identifier
 *
 * Lines that don't match are silently skipped (they're free-form notes).
 * Returns [] if no prerequisites section exists.
 */
const PREREQ_LINE =
  /^\s*[-*+]\s*\[(ENV|AUTH|ACCOUNT|OTHER)\]\s*(.+?)\s*$/i;

export function extractPrerequisites(source: string): Prerequisite[] {
  const m = source.match(PREREQ_CUTOFF);
  if (!m || m.index === undefined) return [];
  const tail = source.slice(m.index + m[0].length);
  // Stop at the next markdown header (any depth) — symmetric with the
  // opener `##+`, so a `### Notes` follow-on doesn't get swept in.
  const nextHeader = tail.search(/^#+\s+\S/m);
  const sectionBody = nextHeader === -1 ? tail : tail.slice(0, nextHeader);

  const prereqs: Prerequisite[] = [];
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const lineMatch = rawLine.match(PREREQ_LINE);
    if (!lineMatch) continue;
    const kind = lineMatch[1].toUpperCase() as PrerequisiteKind;
    const rest = lineMatch[2].trim();
    // Split on em-dash, en-dash, or " - " (hyphen surrounded by spaces).
    // Identifier is the part before; description is the part after.
    const sep = rest.match(/^(\S[^—–]*?)\s+[—–-]\s+(.+)$/);
    let identifier = '';
    let description = rest;
    if (sep) {
      identifier = sep[1].trim();
      description = sep[2].trim();
    } else if (kind === 'ENV') {
      // ENV without explicit description: treat the whole rest as the var name.
      identifier = rest;
      description = '';
    }
    // Filter the planner's "None" sentinel regardless of which kind tag it
    // chose — but ONLY when "None" is the entire payload (optionally with
    // trailing punctuation). A real description that happens to start with
    // "None of the existing services support …" must survive.
    if (/^none[\s.!,]*$/i.test(identifier || description)) {
      continue;
    }
    prereqs.push({ kind, identifier, description });
  }
  return prereqs;
}

export async function loadPrerequisitesFromFile(
  path: string
): Promise<Prerequisite[]> {
  const source = await readFile(path, 'utf-8');
  return extractPrerequisites(source);
}
