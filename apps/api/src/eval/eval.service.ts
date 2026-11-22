import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../persistence/database.service';

export interface EvalResult {
  runId: string;
  successRate: number;
  steps: number;
  durationMs: number;
  toolCalls: number;
  errorCalls: number;
  score: number;
  detail: { steps: number; toolCalls: number; errors: number };
}

/**
 * 评估：用真实运行 trace 算分（成功率 / 步数 / 耗时），不手写分数。
 * score = 成功率*70 + 步数分（<=15 步满 15 分，越多越少）+ 耗时分（<=30s 满 15 分）。
 */
@Injectable()
export class EvalService {
  constructor(private readonly db: DatabaseService) {}

  /** 与 compute() 同一套算分公式：成功率*70 + 步数分 + 耗时分。 */
  static scoreFor(successRate: number, steps: number, durationMs: number): number {
    const stepsScore = Math.max(0, 15 - Math.max(0, steps - 15));
    const durationScore =
      durationMs <= 30_000 ? 15 : Math.max(0, 15 - Math.floor((durationMs - 30_000) / 10_000));
    return Math.round(successRate * 70 + stepsScore + durationScore);
  }

  compute(runId: string): EvalResult {
    const rows = this.db.query<{ is_error: number; duration_ms: number | null }>(
      'SELECT is_error, duration_ms FROM traces WHERE run_id = ? AND kind = ?',
      runId,
      'tool',
    );
    const toolCalls = rows.length;
    const errorCalls = rows.filter((r) => r.is_error === 1).length;
    const successRate = toolCalls === 0 ? 0 : (toolCalls - errorCalls) / toolCalls;
    const durationMs = rows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);
    const steps = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM traces WHERE run_id = ?',
      runId,
    )?.c ?? 0;
    const score = EvalService.scoreFor(successRate, steps, durationMs);
    const result: EvalResult = {
      runId,
      successRate: Math.round(successRate * 1000) / 1000,
      steps,
      durationMs,
      toolCalls,
      errorCalls,
      score,
      detail: { steps, toolCalls, errors: errorCalls },
    };
    this.db.run(
      'INSERT INTO evals (run_id, success_rate, steps, duration_ms, tool_calls, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      runId,
      result.successRate,
      steps,
      durationMs,
      toolCalls,
      JSON.stringify(result.detail),
      new Date().toISOString(),
    );
    return result;
  }

  latest(runId: string): EvalResult | null {
    const row = this.db.get<{
      success_rate: number;
      steps: number;
      duration_ms: number;
      tool_calls: number;
      detail_json: string;
    }>('SELECT success_rate, steps, duration_ms, tool_calls, detail_json FROM evals WHERE run_id = ? ORDER BY id DESC LIMIT 1', runId);
    if (!row) return null;
    const detail = JSON.parse(row.detail_json);
    return {
      runId,
      successRate: row.success_rate,
      steps: row.steps,
      durationMs: row.duration_ms,
      toolCalls: row.tool_calls,
      errorCalls: detail.errors ?? 0,
      score: EvalService.scoreFor(row.success_rate, row.steps, row.duration_ms),
      detail,
    };
  }
}
