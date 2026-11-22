import { DatabaseService } from '../src/persistence/database.service';
import { EvalService } from '../src/eval/eval.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('EvalService', () => {
  it('computes success rate / steps / duration from real traces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-test-'));
    process.env.DATA_DIR = dir;
    const db = new DatabaseService();
    db.onModuleInit();
    const svc = new EvalService(db);
    const runId = 'run-1';
    const insert = (isError: number, ms: number) =>
      db.run(
        'INSERT INTO traces (run_id, seq, actor, kind, tool, result_json, is_error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        runId,
        1,
        'ToolGateway',
        'tool',
        'add',
        '{}',
        isError,
        ms,
        new Date().toISOString(),
      );
    insert(0, 100);
    insert(0, 200);
    insert(0, 150);
    insert(1, 50);
    const e = svc.compute(runId);
    expect(e.toolCalls).toBe(4);
    expect(e.errorCalls).toBe(1);
    expect(e.successRate).toBe(0.75);
    expect(e.durationMs).toBe(500);
    expect(e.steps).toBe(4);
    expect(e.score).toBeGreaterThan(0);
    expect(e.score).toBeLessThanOrEqual(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
