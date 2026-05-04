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

export function parseTasksMarkdown(source: string): Task[] {
  const lines = source.split(/\r?\n/);
  const tasks: Task[] = [];
  let current: { task: Task; bodyLines: string[] } | null = null;

  // First pass: collect every explicit ID present in the file so the auto-ID
  // counter can skip them and never collide. (Without this, "T001 → unlabeled
  // → T002" would auto-assign the unlabeled task as T002, duplicating the
  // explicit T002 that follows.)
  const explicitIds = new Set<string>();
  for (const line of lines) {
    const parsed = classifyLine(line);
    if (parsed.isTaskLine && parsed.id) explicitIds.add(parsed.id);
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
    const parsed = classifyLine(line);
    if (parsed.isTaskLine) {
      finalize();
      const { cleanTitle, dependencies } = extractDependencies(parsed.rawTitle);
      const id = parsed.id ?? nextAutoId();
      current = {
        task: {
          id,
          title: cleanTitle,
          body: '',
          dependencies,
          status: 'pending',
          attempts: [],
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
