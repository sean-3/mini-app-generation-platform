import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeRunStream, type AppRow, type AppSummary, type RunEvent, type RunRow, type Template } from './api';
import { AppPreview } from './preview';

type View = { kind: 'main' } | { kind: 'apps' } | { kind: 'replay'; runId: string };

const PIPELINE = [
  { key: 'iris', label: 'Iris · 调研', desc: '查同类产品，找差异点' },
  { key: 'emma', label: 'Emma · 产品', desc: '写需求清单' },
  { key: 'nora', label: 'Nora · 设计', desc: '出界面说明' },
  { key: 'bob', label: 'Bob · 架构', desc: '定数据结构与模块' },
  { key: 'gate1', label: '审批 1 · 架构确认', desc: '你确认才继续生成' },
  { key: 'alex', label: 'Alex · 开发', desc: '按模板生成应用草稿' },
  { key: 'gate2', label: '审批 2 · 发布确认', desc: '你确认才发布' },
  { key: 'tina', label: 'Tina · 测试 / Oscar · 运维', desc: '冒烟测试 + 健康检查 + 发布' },
  { key: 'david', label: 'David · 复盘', desc: '回放打分：成功率 / 步数 / 耗时' },
];

function statusStep(status: string): number {
  switch (status) {
    case 'running': return 1;
    case 'awaiting_architecture': return 4;
    case 'generating': return 5;
    case 'awaiting_publish': return 6;
    case 'testing': return 7;
    case 'published': return 9;
    case 'rolled_back': return 4;
    case 'stopped': return 9;
    default: return 0;
  }
}

function pretty(json: string | null): string {
  if (!json) return '';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function eventText(e: RunEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'stage_started': return `开始：${d.label ?? d.stage ?? ''}`;
    case 'approval_requested': return d.kind === 'architecture' ? '请求审批：架构确认' : '请求审批：发布确认';
    case 'approval_decided': return `审批${d.approved ? '通过' : '拒绝'}：${d.kind === 'architecture' ? '架构确认' : '发布确认'}`;
    case 'app_published': return `应用已发布：${d.appId ?? ''}`;
    case 'eval_ready': return `复盘完成：成功率 ${Math.round((d.successRate ?? 0) * 100)}%，${d.steps ?? '?'} 步，${d.toolCalls ?? '?'} 次工具调用`;
    case 'run_stopped': return d.reason === 'no_template_match' ? '没有匹配的模板，已停下' : d.reason === 'repeat_call' ? '重复调用 3 次，网关已拦截并停止' : `已停止：${d.reason ?? d.error ?? ''}`;
    case 'tool': {
      const t = d.tool ?? '';
      const step = d.step ?? '';
      const outcome = d.outcome ?? '';
      return `${t} · ${step} · ${outcome === 'blocked' ? '已拦截' : outcome}${d.detail ? `（${d.detail}）` : ''}`;
    }
    default: return e.type;
  }
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'main' });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [input, setInput] = useState('');
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [app, setApp] = useState<AppRow | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [intercept, setIntercept] = useState<{ title: string; body: string; alt?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [repeatClicks, setRepeatClicks] = useState(0);
  const [repeatStopped, setRepeatStopped] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<number | null>(null);

  const refreshRun = useCallback(async (id: string) => {
    try {
      const r = await api.getRun(id);
      setRun(r);
      if (r.app_id) {
        try { setApp(await api.getApp(r.app_id)); } catch { /* app may be deleted */ }
      }
      return r;
    } catch {
      return null;
    }
  }, []);

  const attachStream = useCallback((runId: string) => {
    unsubRef.current?.();
    setEvents([]);
    unsubRef.current = subscribeRunStream(runId, (e) => {
      setEvents((prev) => [...prev, e]);
      if (e.type === 'run_stopped' && e.data?.reason === 'repeat_call') {
        setRepeatStopped(true);
        setIntercept({
          title: '重复调用被网关拦截',
          body: '同一工具、同一参数连续调用 3 次，Tool Gateway 在第 3 次直接拦截并打开熔断，run 已停止，未产生脏数据。',
        });
      }
      if (['stage_started', 'approval_requested', 'approval_decided', 'app_published', 'eval_ready', 'run_stopped'].includes(e.type)) {
        void refreshRun(runId);
      }
    });
    // 兜底轮询：SSE 断开也不丢状态
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void refreshRun(runId).then((r) => {
        if (r && ['published', 'rolled_back', 'stopped'].includes(r.status)) {
          if (pollRef.current) window.clearInterval(pollRef.current);
        }
      });
    }, 3000);
  }, [refreshRun]);

  useEffect(() => {
    void api.templates().then(setTemplates).catch(() => setTemplates([]));
    void api.listApps().then(setApps).catch(() => setApps([]));
    void api.health().catch(() => setNotice('后端未启动：请先在项目根目录跑 docker compose up，或 npm run dev:api'));
    return () => {
      unsubRef.current?.();
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const startRun = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setNotice(null);
    setIntercept(null);
    setApp(null);
    try {
      const r = await api.createRun(t);
      setRun(r);
      attachStream(r.id);
      if (r.status === 'stopped') {
        setNotice('没有匹配的模板：目前只有 4 个模板（记账 / 打卡 / 报价 / 接龙），换一句更贴近的说法再试。');
      }
    } catch (e: any) {
      setNotice(`生成失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (kind: 'architecture' | 'publish', approved: boolean) => {
    if (!run) return;
    setBusy(true);
    try {
      const r = approved
        ? kind === 'architecture' ? await api.approveArchitecture(run.id, true) : await api.approvePublish(run.id, true)
        : kind === 'architecture' ? await api.approveArchitecture(run.id, false) : await api.approvePublish(run.id, false);
      setRun(r);
      if (!approved) setNotice(kind === 'architecture' ? '架构被拒绝，已回退到需求阶段，可改一句话重新生成。' : '发布被拒绝，草稿已保留，可修改后重新发布。');
    } catch (e: any) {
      setNotice(`审批失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const repeatDemo = async () => {
    if (repeatStopped || !run) return;
    setBusy(true);
    setIntercept(null);
    try {
      const r = await api.repeatDemo(run.input || '团购接龙');
      setRun(r);
      attachStream(r.id);
      const clicks = repeatClicks + 1;
      setRepeatClicks(clicks);
      if (clicks >= 3) setRepeatStopped(true);
    } catch (e: any) {
      setNotice(`重新生成失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async () => {
    if (!app) return;
    setIntercept(null);
    try {
      const res: any = await api.exportFile(app.id, 'csv');
      // 网关拒绝时返回 isError:true 的结果（HTTP 200），不是异常。
      if (res && res.isError) {
        setIntercept({
          title: '导出为文件被权限拦截',
          body: `Tool Gateway 在「权限拦截」一步拦下了 export_file：当前策略不允许直接写文件。原因：${res.message ?? res.reason ?? 'permission denied'}。`,
          alt: '改用导出 JSON',
        });
      } else {
        setNotice('已导出（网关放行）。');
      }
    } catch (e: any) {
      setNotice(`导出失败：${e?.message ?? e}`);
    }
  };

  const exportJson = async () => {
    if (!app) return;
    try {
      const { data } = await api.exportJson(app.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${app.name || app.id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setNotice(`导出 JSON 失败：${e?.message ?? e}`);
    }
  };

  const openApp = async (id: string) => {
    try {
      const a = await api.getApp(id);
      setApp(a);
      setView({ kind: 'main' });
    } catch (e: any) {
      setNotice(`打开失败：${e?.message ?? e}`);
    }
  };

  const step = run ? statusStep(run.status) : 0;
  const isTerminal = run ? ['published', 'rolled_back', 'stopped'].includes(run.status) : true;

  if (view.kind === 'apps') return <AppsView apps={apps} onRefresh={async () => setApps(await api.listApps())} onOpen={openApp} onBack={() => setView({ kind: 'main' })} notice={notice} />;
  if (view.kind === 'replay') return <ReplayView runId={view.runId} onBack={() => setView({ kind: 'main' })} />;

  return (
    <div>
      <header className="topbar">
        <div className="mark">A</div>
        <div className="intro"><b>迷你应用生成台</b>一句话说清想要的应用，看 Agent 怎么跑、怎么拦、怎么打分。</div>
        <button className="tbtn" onClick={() => { void api.listApps().then(setApps); setView({ kind: 'apps' }); }}>我的应用</button>
        <button className="tbtn" onClick={() => run && setView({ kind: 'replay', runId: run.id })} disabled={!run}>回放与评分</button>
        <button className="tbtn primary" onClick={() => { setRun(null); setEvents([]); setApp(null); setInput(''); setNotice(null); setIntercept(null); }}>新建</button>
      </header>

      <div className="layout">
        {/* 左：流水线 + 实时轨迹 */}
        <div className="col-left">
          <div className="panel">
            <div className="panel-h">流水线 <span className="sub">9 个职能 Bot · Mike 协调</span></div>
            <div className="panel-b">
              <ul className="steps">
                {PIPELINE.map((s, i) => {
                  const idx = i + 1;
                  const cls = !run ? '' : run.status === 'rolled_back' && idx === 5 ? 'blocked' : run.status === 'stopped' && idx > step ? 'blocked' : idx < step ? 'done' : idx === step ? 'active' : '';
                  return (
                    <li key={s.key} className={cls}>
                      <span className="dot">{idx < step || run?.status === 'published' ? '✓' : idx}</span>
                      <span><div className="st">{s.label}</div><div className="sd">{s.desc}</div></span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
          <div className="panel">
            <div className="panel-h">实时轨迹 <span className="sub">SSE 推送 · 全部走 Tool Gateway</span></div>
            <div className="panel-b">
              {events.length === 0 ? (
                <p className="muted">还没开始。输入一句话，点「生成应用」，这里会实时打出每一步：谁在做、调了什么工具、哪一步被拦。</p>
              ) : (
                <ul className="trace">
                  {events.map((e) => {
                    const err = e.type === 'run_stopped' || (e.type === 'tool' && e.data?.outcome === 'blocked') || (e.type === 'approval_decided' && e.data?.approved === false);
                    return (
                      <li key={e.seq} className={err ? 'err' : 'ok'}>
                        <span className="tag">{e.actor ?? e.type}</span>
                        <span className="detail">{eventText(e)}</span>
                        <span className="tt">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* 中：输入 + 需求 / 设计 / 架构 */}
        <div className="col-middle">
          <div className="panel">
            <div className="panel-h">说出你想要的应用</div>
            <div className="panel-b">
              <textarea className="input" rows={3} placeholder="例如：小区团购接龙、记账看板、习惯打卡、报价计算器" value={input} onChange={(e) => setInput(e.target.value)} />
              <div className="row" style={{ marginTop: 8 }}>
                {templates.map((t) => (
                  <button key={t.id} className="chip" onClick={() => setInput({ ledger: '我要一个记账看板', habit: '我要一个习惯打卡', quote: '我要一个报价计算器', signup: '小区团购接龙' }[t.id] ?? t.name)}>
                    {t.name}
                  </button>
                ))}
                <button className="chip" onClick={() => void startRun('小区团购接龙')}>先看看示例</button>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary block" style={{ flex: 1 }} disabled={busy || !input.trim()} onClick={() => void startRun(input)}>
                  {busy ? '生成中…' : '生成应用'}
                </button>
              </div>
              <p className="small" style={{ marginTop: 8 }}>只有 4 个模板：记账看板 / 习惯打卡 / 报价计算器 / 活动报名·接龙。匹配不上会直接告诉你，不会硬编。</p>
            </div>
          </div>

          {notice && <div className="guidance" style={{ marginTop: 14 }}>{notice}</div>}
          {intercept && (
            <div className="intercept" style={{ marginTop: 14 }}>
              <h3>{intercept.title}</h3>
              <p>{intercept.body}</p>
              {intercept.alt && <button className="btn" onClick={() => { setIntercept(null); void exportJson(); }}>{intercept.alt}</button>}
            </div>
          )}

          {run?.status === 'awaiting_architecture' && (
            <div className="approve" style={{ marginTop: 14 }}>
              <h3>审批 1 · 架构确认</h3>
              <p>Bob 已出架构决策（见下方）。确认后 Alex 才开始生成；拒绝则回退到需求阶段。</p>
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={() => void approve('architecture', true)}>确认架构，继续生成</button>
                <button className="btn danger" disabled={busy} onClick={() => void approve('architecture', false)}>拒绝，回退</button>
              </div>
            </div>
          )}
          {run?.status === 'awaiting_publish' && (
            <div className="approve" style={{ marginTop: 14 }}>
              <h3>审批 2 · 发布确认</h3>
              <p>Alex 已生成草稿（见右侧预览）。确认后 Oscar 部署、Tina 冒烟测试、David 复盘打分。</p>
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={() => void approve('publish', true)}>确认发布</button>
                <button className="btn danger" disabled={busy} onClick={() => void approve('publish', false)}>拒绝，保留草稿</button>
              </div>
            </div>
          )}

          {run && (
            <>
              <div className="panel" style={{ marginTop: 14 }}>
                <div className="panel-h">需求清单 <span className="sub">Iris + Emma · {run.template_id ?? '未匹配'}</span></div>
                <div className="panel-b">
                  {run.requirements_json ? <pre className="json">{pretty(run.requirements_json)}</pre> : <p className="muted">等待 Iris / Emma 输出…</p>}
                </div>
              </div>
              <div className="panel">
                <div className="panel-h">设计说明 <span className="sub">Nora</span></div>
                <div className="panel-b">
                  {run.design_json ? <pre className="json">{pretty(run.design_json)}</pre> : <p className="muted">等待 Nora 输出…</p>}
                </div>
              </div>
              <div className="panel">
                <div className="panel-h">架构决策 <span className="sub">Bob</span></div>
                <div className="panel-b">
                  {run.architecture_json ? <pre className="json">{pretty(run.architecture_json)}</pre> : <p className="muted">等待 Bob 输出…</p>}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 右：实时预览 */}
        <div className="col-right">
          <div className="panel">
            <div className="panel-h">实时预览 <span className="sub">{app ? `${app.name} · 可直接操作` : '生成后出现在这里'}</span></div>
            <div className="panel-b appview">
              {app ? (
                <>
                  <h3>{app.name}</h3>
                  <p className="muted" style={{ margin: '0 0 10px' }}>模板：{templates.find((t) => t.id === app.template_id)?.name ?? app.template_id} · 数据已落库，刷新后还在</p>
                  <AppPreview app={app} onSaved={setApp} />
                  <div className="row" style={{ marginTop: 14 }}>
                    <button className="btn" disabled={!run || repeatStopped || busy} onClick={() => void repeatDemo()}>
                      {repeatStopped ? '重新生成（已停止）' : `重新生成${repeatClicks > 0 ? `（${repeatClicks}/3）` : ''}`}
                    </button>
                    <button className="btn" disabled={!app} onClick={() => void exportFile()}>导出为文件</button>
                    <button className="btn" disabled={!app} onClick={() => void exportJson()}>导出 JSON</button>
                    <button className="btn" disabled={!run} onClick={() => run && setView({ kind: 'replay', runId: run.id })}>回放与评分</button>
                  </div>
                  <p className="small" style={{ marginTop: 8 }}>
                    「导出为文件」会被 Tool Gateway 的权限拦截拦下（演示）；「重新生成」连点 3 次触发重复检测停止（演示）。{isTerminal ? '' : '当前 run 还在跑，等它跑完再点。'}
                  </p>
                </>
              ) : (
                <p className="muted">还没有可预览的应用。先在中间输入一句话生成，或去「我的应用」打开一个已保存的。</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppsView({ apps, onRefresh, onOpen, onBack, notice }: { apps: AppSummary[]; onRefresh: () => Promise<void>; onOpen: (id: string) => void; onBack: () => void; notice: string | null }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  return (
    <div className="view">
      <button className="btn back" onClick={onBack}>← 回到生成台</button>
      <div className="panel">
        <div className="panel-h">我的应用 <span className="sub">{apps.length} 个</span></div>
        <div className="panel-b">
          {notice && <div className="guidance" style={{ marginBottom: 10 }}>{notice}</div>}
          {apps.length === 0 ? (
            <p className="muted">还没有保存的应用。生成一个并发布后会出现在这里。</p>
          ) : (
            <ul className="list">
              {apps.map((a) => (
                <li key={a.id}>
                  <span style={{ flex: 1, minWidth: 160 }}>
                    {renaming === a.id ? (
                      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                    ) : (
                      <><b>{a.name}</b> <span className="small">· {a.template_id} · {new Date(a.created_at).toLocaleString('zh-CN')}</span></>
                    )}
                  </span>
                  {renaming === a.id ? (
                    <button className="btn primary" onClick={async () => { await api.renameApp(a.id, name.trim() || a.name); setRenaming(null); await onRefresh(); }}>保存</button>
                  ) : (
                    <>
                      <button className="btn" onClick={() => onOpen(a.id)}>打开</button>
                      <button className="btn" onClick={() => { setRenaming(a.id); setName(a.name); }}>改名</button>
                      <button className="btn danger" onClick={async () => { if (window.confirm(`删除「${a.name}」？`)) { await api.deleteApp(a.id); await onRefresh(); } }}>删除</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplayView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [data, setData] = useState<{ run: RunRow; traces: Array<{ seq: number; actor: string; kind: string; tool: string; result_json: string; is_error: number }>; eval: { successRate: number; steps: number; durationMs: number; toolCalls: number; errorCalls: number } | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.getReplay(runId).then(setData).catch((e: any) => setErr(String(e?.message ?? e)));
  }, [runId]);
  return (
    <div className="view">
      <button className="btn back" onClick={onBack}>← 回到生成台</button>
      {err && <div className="guidance">{err}</div>}
      {!data ? (
        <p className="muted">加载回放…</p>
      ) : (
        <>
          <div className="panel">
            <div className="panel-h">回放 · {data.run.input} <span className="sub">{data.run.status}</span></div>
            <div className="panel-b">
              {data.eval ? (
                <div className="score">
                  <div className="cell"><b>{Math.round(data.eval.successRate * 100)}%</b><span>成功率</span></div>
                  <div className="cell"><b>{data.eval.steps}</b><span>步数</span></div>
                  <div className="cell"><b>{(data.eval.durationMs / 1000).toFixed(1)}s</b><span>耗时</span></div>
                  <div className="cell"><b>{data.eval.toolCalls}</b><span>工具调用</span></div>
                  <div className="cell"><b>{data.eval.errorCalls}</b><span>拦截 / 错误</span></div>
                </div>
              ) : (
                <p className="muted">本轮还没有评估结果（发布完成后由 David 复盘生成）。</p>
              )}
            </div>
          </div>
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-h">轨迹 <span className="sub">{data.traces.length} 条 · 全部来自 SQLite</span></div>
            <div className="panel-b">
              {data.traces.length === 0 ? <p className="muted">暂无轨迹。</p> : (
                <ul className="trace" style={{ maxHeight: 'none' }}>
                  {data.traces.map((t) => (
                    <li key={t.seq} className={t.is_error ? 'err' : 'ok'}>
                      <span className="tag">{t.actor}</span>
                      <span className="detail">{t.tool} · {t.kind} · {t.result_json.slice(0, 160)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
