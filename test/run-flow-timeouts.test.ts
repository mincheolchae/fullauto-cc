import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EVOLVE_STAGE_TIMEOUT_FLOOR_SEC,
  resolveEvolveStageTimeoutSec,
  resolvePlannerTimeoutSec,
} from '../src/run-flow.js';
import { ensureFullautoDir, saveConfigSnapshot } from '../src/persistence.js';
import { makeTmpDir, cleanup } from './helpers/tmp.js';

/**
 * `resolveEvolveStageTimeoutSec` exists because `fullauto evolve`'s shape
 * and assess stages (`/product-shape`, `/product-assess`) do materially
 * more work per call than the plain task-decomposition planner — WebSearch
 * benchmarking, reading state.json + tasks.md + the changed code, a
 * five-dimension score, rewriting product.md — and sharing the tighter
 * `plannerTimeoutSec` budget with them burns a whole `claude -p` invocation
 * on a guaranteed-timeout attempt when the shared value is too small. See
 * the field's doc comment in types.ts for the discovered-live case that
 * motivated this.
 */
describe('resolveEvolveStageTimeoutSec', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir('fullauto-evolve-timeout-');
  });
  afterEach(async () => {
    await cleanup(dir);
  });

  it('derives max(plannerTimeoutSec * 2, floor) when unset', async () => {
    // No config.json at all.
    expect(await resolveEvolveStageTimeoutSec(dir, 900)).toBe(1800); // 900*2 == floor
    expect(await resolveEvolveStageTimeoutSec(dir, 1200)).toBe(2400); // 1200*2 > floor
    expect(await resolveEvolveStageTimeoutSec(dir, 60)).toBe(EVOLVE_STAGE_TIMEOUT_FLOOR_SEC); // tiny planner timeout never drags the derived default below the floor
  });

  it('an explicit config.evolveStageTimeoutSec wins over the derived default', async () => {
    await ensureFullautoDir(dir);
    await saveConfigSnapshot(dir, { evolveStageTimeoutSec: 5000, gates: [] });
    expect(await resolveEvolveStageTimeoutSec(dir, 900)).toBe(5000);
    // Still wins even when the derived value would have been larger.
    expect(await resolveEvolveStageTimeoutSec(dir, 10_000)).toBe(5000);
  });

  it('a config.json that fails RunConfig validation (but parses as JSON) falls through to the derived default', async () => {
    await ensureFullautoDir(dir);
    // `verifyMode` must be one of VERIFY_MODES — this fails RunConfig.safeParse
    // while still being syntactically valid JSON, exercising the
    // `parsed.success` branch (as opposed to invalid-JSON, which
    // `loadUserConfig` deliberately throws on — same as `resolvePlannerTimeoutSec`).
    await saveConfigSnapshot(dir, { verifyMode: 'not-a-real-mode', gates: [] });
    await expect(resolveEvolveStageTimeoutSec(dir, 900)).resolves.toBe(1800);
  });
});

describe('resolvePlannerTimeoutSec (unchanged by the evolve-stage timeout split)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir('fullauto-planner-timeout-');
  });
  afterEach(async () => {
    await cleanup(dir);
  });

  it('CLI flag wins, then config.plannerTimeoutSec, then the schema default (900s)', async () => {
    expect(await resolvePlannerTimeoutSec(dir, 42)).toBe(42);
    expect(await resolvePlannerTimeoutSec(dir, undefined)).toBe(900);

    await ensureFullautoDir(dir);
    await saveConfigSnapshot(dir, { plannerTimeoutSec: 1234, gates: [] });
    expect(await resolvePlannerTimeoutSec(dir, undefined)).toBe(1234);
    expect(await resolvePlannerTimeoutSec(dir, 42)).toBe(42); // CLI flag still wins
  });
});
