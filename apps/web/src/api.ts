/** 后端 API 客户端：全部走同源 /api（开发时 Vite 代理到 :3000，生产由 NestJS 同源 serve）。 */

export type RunMode = 'build' | 'plan' | 'engineer';

export type RunStatus =
  | 'running'
  | 'awaiting_plan'
  | 'awaiting_architecture'
  | 'generating'
  | 'awaiting_publish'
  | 'testing'
  | 'published'
  | 'rolled_back'
  | 'stopped';

export interface RunRow {
  id: string;
  input: string;
  status: RunStatus;
  mode: RunMode;
  team_mode: number;
  plan_json: string | null;
  template_id: string | null;
  requirements_json: string | null;
  design_json: string | null;
  architecture_json: string | null;
  draft_json: string | null;
  app_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunEvent {
  seq: number;
  type: string;
  actor?: string;
  data?: any;
  at: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  fields: Array<{ key: string; label: string; type: string }>;
  cap?: number;
}

export interface AppSummary {
  id: string;
  name: string;
  template_id: string;
  published_version: number;
  created_at: string;
}

export interface AppRow extends AppSummary {
  data_json: string;
  published_json: string | null;
  updated_at: string;
}

export interface TraceRow {
  seq: number;
  actor: string;
  kind: string;
  tool: string;
  result_json: string;
  is_error: number;
}

export interface EvalResult {
  runId: string;
  successRate: number;
  steps: number;
  durationMs: number;
  toolCalls: number;
  errorCalls: number;
  score: number;
  detail?: any;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ status: string }>('/health'),
  templates: () => req<Template[]>('/api/templates'),
  createRun: (input: string, opts?: { mode?: RunMode; teamMode?: boolean }) =>
    req<RunRow>('/api/runs', { method: 'POST', body: JSON.stringify({ input, mode: opts?.mode ?? 'build', teamMode: opts?.teamMode ?? false }) }),
  repeatDemo: (input: string) => req<RunRow>('/api/runs/repeat-demo', { method: 'POST', body: JSON.stringify({ input }) }),
  listRuns: () => req<RunRow[]>('/api/runs'),
  getRun: (id: string) => req<RunRow>(`/api/runs/${id}`),
  getReplay: (id: string) => req<{ run: RunRow; traces: TraceRow[]; eval: EvalResult | null }>(`/api/runs/${id}/replay`),
  approvePlan: (id: string, approved: boolean) =>
    req<RunRow>(`/api/runs/${id}/approve-plan`, { method: 'POST', body: JSON.stringify({ approved }) }),
  approveArchitecture: (id: string, approved: boolean) =>
    req<RunRow>(`/api/runs/${id}/approve-architecture`, { method: 'POST', body: JSON.stringify({ approved }) }),
  approvePublish: (id: string, approved: boolean) =>
    req<RunRow>(`/api/runs/${id}/approve-publish`, { method: 'POST', body: JSON.stringify({ approved }) }),
  listApps: () => req<AppSummary[]>('/api/apps'),
  getApp: (id: string) => req<AppRow>(`/api/apps/${id}`),
  createApp: (templateId: string, name?: string) =>
    req<AppRow>('/api/apps', { method: 'POST', body: JSON.stringify({ templateId, name }) }),
  updateAppData: (id: string, data: unknown) =>
    req<AppRow>(`/api/apps/${id}/data`, { method: 'PATCH', body: JSON.stringify({ data }) }),
  updateApp: (id: string) => req<AppRow>(`/api/apps/${id}/update`, { method: 'POST' }),
  renameApp: (id: string, name: string) =>
    req<AppRow>(`/api/apps/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteApp: (id: string) => req<{ ok: boolean }>(`/api/apps/${id}`, { method: 'DELETE' }),
  exportJson: (id: string) => req<{ data: unknown }>(`/api/apps/${id}/export`, { method: 'POST' }),
  exportFile: (id: string, format = 'csv') =>
    req<unknown>(`/api/apps/${id}/export-file`, { method: 'POST', body: JSON.stringify({ format }) }),
};

/** 订阅一轮 run 的 SSE 事件；返回取消函数。 */
export function subscribeRunStream(runId: string, onEvent: (e: RunEvent) => void): () => void {
  const es = new EventSource(`/api/runs/${runId}/stream`);
  es.onmessage = (msg) => {
    try {
      const e = JSON.parse(msg.data) as RunEvent;
      if (e.type === 'ping') return;
      onEvent(e);
    } catch {
      /* ignore malformed frames */
    }
  };
  es.onerror = () => {
    /* EventSource 会自动重连；run 结束由后端关闭 */
  };
  return () => es.close();
}
