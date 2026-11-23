import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SQLite 访问层（Node 24 内置 node:sqlite，零原生依赖）。
 * 只暴露最小的 query/get/all/run；换 Postgres 时只改这个文件。
 */
@Injectable()
export class DatabaseService implements OnModuleInit {
  private db!: DatabaseSync;

  onModuleInit() {
    const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'app.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        template_id TEXT,
        requirements_json TEXT,
        design_json TEXT,
        architecture_json TEXT,
        draft_json TEXT,
        app_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        name TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool TEXT,
        args_json TEXT,
        result_json TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        success_rate REAL NOT NULL,
        steps INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_versions (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(app_id, version)
      );
    `);

    // v3 迁移：已部署的数据库没有这些列，ALTER 失败（列已存在）时忽略。
    // runs.mode/team_mode/plan_json：Build / Plan / Engineer 三种启动方式 + Team Mode 开关 + 计划；
    // apps.published_json/published_version：Preview 与上线分离（上线快照 + 版本号）。
    const addColumn = (sql: string) => {
      try {
        this.db.exec(sql);
      } catch {
        /* column already exists */
      }
    };
    addColumn('ALTER TABLE runs ADD COLUMN mode TEXT');
    addColumn('ALTER TABLE runs ADD COLUMN team_mode INTEGER DEFAULT 0');
    addColumn('ALTER TABLE runs ADD COLUMN plan_json TEXT');
    // v4：runs.usage_json：主 Agent 各轮调用的 token 用量
    // {promptTokens, completionTokens, totalTokens, modelCalls}；子 Agent 的用量不在内。
    addColumn('ALTER TABLE runs ADD COLUMN usage_json TEXT');
    // @ 指定 Agent：run 记录里被 @ 的人名（仅提示，不改路由）。
    addColumn('ALTER TABLE runs ADD COLUMN mentioned_agent TEXT');
    addColumn('ALTER TABLE apps ADD COLUMN published_json TEXT');
    addColumn('ALTER TABLE apps ADD COLUMN published_version INTEGER DEFAULT 0');
  }

  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as any[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as any[]));
  }
}
