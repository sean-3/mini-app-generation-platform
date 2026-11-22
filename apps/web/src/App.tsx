import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeRunStream, type AppRow, type AppSummary, type RunEvent, type RunMode, type RunRow, type Template } from './api';
import { AppPreview } from './preview';

type View = { kind: 'main' } | { kind: 'apps' } | { kind: 'replay'; runId: string };

const TEAM = [
  { key: 'mike', label: 'Mike · 协调', desc: '跑计划、协调各 Agent、请你审批' },
  { key: 'iris', label: 'Iris · 调研', desc: '查同类产品，找差异点' },
  { key: 'emma', label: 'Emma · 规格', desc: '写需求清单' },
  { key: 'bob', label: 'Bob · 架构', desc: '定数据结构、模块与设计' },
  { key: 'alex', label: 'Alex · 构建', desc: '按模板生成应用草稿' },
];

const MODES: Array<{ key: RunMode; label: string; desc: string }> = [
  { key: 'build', label: 'Build', desc: '直接开工' },
  { key: 'plan', label: 'Plan', desc: 'Mike 先出计划，你批准才开工' },
  { key: 'engineer', label: 'Engineer', desc: '只派 Alex 一人干活' },
];

/** 按当前 run 的模式与 Team Mode 开关，算出时间线的步骤。 */
function pipelineSteps(run: RunRow | null): Array<{ key: string; label: string; desc: string }> {
  const steps: Array<{ key: string; label: string; desc: string }> = [];
  if (run?.mode === 'plan') {
    steps.push(
      { key: 'plan', label: 'Mike · 出计划', desc: '目标、模板、步骤、参与的人' },
      { key: 'plan_gate', label: '审批 0 · 计划确认', desc: '你确认才开工' },
    );
  }
  if (run?.mode === 'engineer') {
    steps.push({ key: 'alex', label: 'Alex · 构建', desc: '匹配、生成草稿、自检一人做完' });
  } else if (run && run.team_mode === 1) {
    steps.push(
      { key: 'mike', label: 'Mike · 协调', desc: '派活、汇总、请你审批' },
      { key: 'iris', label: 'Iris · 调研', desc: '查同类产品，找差异点' },
      { key: 'emma', label: 'Emma · 规格', desc: '写需求清单' },
      { key: 'bob', label: 'Bob · 架构', desc: '定数据结构、模块与设计' },
    );
  } else {
    steps.push(
      { key: 'mike', label: 'Mike · 协调', desc: '匹配、需求、架构一人做完' },
      { key: 'alex', label: 'Alex · 构建', desc: '按模板生成应用草稿' },
    );
  }
  steps.push(
    { key: 'gate1', label: '审批 1 · 架构确认', desc: '你确认才继续生成' },
    { key: 'gate2', label: '审批 2 · 发布确认', desc: '你确认才发布' },
    { key: 'publish', label: '发布', desc: '上线 v1，之后改完点 Update' },
    { key: 'eval', label: '评估', desc: '回放打分：成功率 / 步数 / 耗时' },
  );
  return steps;
}

/** 当前状态对应时间线里的第几步（0 起）。 */
function statusStep(run: RunRow, steps: Array<{ key: string }>): number {
  const idx = (key: string) => {
    const i = steps.findIndex((s) => s.key === key);
    return i < 0 ? 0 : i;
  };
  switch (run.status) {
    case 'running': return run.mode === 'plan' && !run.plan_json ? idx('plan') : idx('mike') || idx('alex');
    case 'awaiting_plan': return idx('plan_gate');
    case 'awaiting_architecture': return idx('gate1');
    case 'generating': return idx('alex');
    case 'awaiting_publish': return idx('gate2');
    case 'testing': return idx('publish');
    case 'published': return steps.length;
    case 'rolled_back': return run.mode === 'plan' && !run.plan_json ? idx('plan_gate') : idx('gate1');
    case 'stopped': return steps.length;
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

function approvalName(kind: string): string {
  return kind === 'plan' ? '计划确认' : kind === 'architecture' ? '架构确认' : '发布确认';
}

function eventText(e: RunEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'stage_started': return `开始：${d.label ?? d.stage ?? ''}`;
    case 'approval_requested': return `请求审批：${approvalName(d.kind ?? '')}`;
    case 'approval_decided': return `审批${d.approved ? '通过' : '拒绝'}：${approvalName(d.kind ?? '')}`;
    case 'app_published': return `应用已发布：${d.appId ?? ''}`;
    case 'eval_ready': return `评估完成：成功率 ${Math.round((d.successRate ?? 0) * 100)}%，${d.steps ?? '?'} 步，${d.toolCalls ?? '?'} 次工具调用`;
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
  const [mode, setMode] = useState<RunMode>('build');
  const [teamMode, setTeamMode] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [app, setApp] = useState<AppRow | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [intercept, setIntercept] = useState<{ title: string; body: string; alt?: string } | null>(null);
  const [modelInfo, setModelInfo] = useState<{ provider: string; model: string; configured: boolean } | null>(null);
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
    void api.health().then((h) => setModelInfo(h.model ?? null)).catch(() => setNotice('后端未启动：请先在项目根目录跑 docker compose up，或 npm run dev:api'));
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
      const r = await api.createRun(t, { mode, teamMode: mode === 'engineer' ? false : teamMode });
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

  const approve = async (kind: 'plan' | 'architecture' | 'publish', approved: boolean) => {
    if (!run) return;
    setBusy(true);
    try {
      const r = approved
        ? kind === 'plan' ? await api.approvePlan(run.id, true)
          : kind === 'architecture' ? await api.approveArchitecture(run.id, true)
          : await api.approvePublish(run.id, true)
        : kind === 'plan' ? await api.approvePlan(run.id, false)
          : kind === 'architecture' ? await api.approveArchitecture(run.id, false)
          : await api.approvePublish(run.id, false);
      setRun(r);
      if (!approved) setNotice(kind === 'plan' ? '计划被拒绝，已回退，可换个说法重新生成。' : kind === 'architecture' ? '架构被拒绝，已回退到需求阶段，可改一句话重新生成。' : '发布被拒绝，草稿已保留，可修改后重新发布。');
    } catch (e: any) {
      setNotice(`审批失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const updateApp = async () => {
    if (!app) return;
    setBusy(true);
    try {
      const updated = await api.updateApp(app.id);
      setApp(updated);
      setNotice(updated.published_version === 1 ? '已发布 v1。' : `已更新到 v${updated.published_version}，线上版已是最新。`);
    } catch (e: any) {
      setNotice(`更新失败：${e?.message ?? e}`);
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
      setRun(null);
      setEvents([]);
      setView({ kind: 'main' });
    } catch (e: any) {
      setNotice(`打开失败：${e?.message ?? e}`);
    }
  };

  const steps = pipelineSteps(run);
  const step = run ? statusStep(run, steps) : 0;

  // 草稿 Preview：架构/发布审批之间，草稿已生成但还没上线，只读展示。
  const draftApp: AppRow | null = (() => {
    if (app || !run?.draft_json || run.status === 'published') return null;
    try {
      const d = JSON.parse(run.draft_json);
      return {
        id: `draft:${run.id}`,
        name: d.name ?? '未命名应用',
        template_id: d.templateId,
        data_json: JSON.stringify(d.data ?? {}),
        published_json: null,
        published_version: 0,
        created_at: run.created_at,
        updated_at: run.updated_at,
      };
    } catch {
      return null;
    }
  })();
  const shownApp = app ?? draftApp;
  const isDraft = !app && !!draftApp;
  const dirty = !!app && app.published_json !== null && app.published_json !== app.data_json;

  if (view.kind === 'apps') return <AppsView apps={apps} onRefresh={async () => setApps(await api.listApps())} onOpen={openApp} onBack={() => setView({ kind: 'main' })} notice={notice} />;
  if (view.kind === 'replay') return <ReplayView runId={view.runId} onBack={() => setView({ kind: 'main' })} />;

  return (
    <div>
      <header className="topbar">
        <div className="mark">A</div>
        <div className="intro"><b>迷你应用生成台</b>一句话生成一个能用的小应用，应用是主角，过程在侧栏。</div>
        {modelInfo && (
          <span className="small" title={modelInfo.configured ? '模型已配好，生成会烧真 token' : '没配 MOONSHOT_API_KEY，生成按钮点了也会报错'}>
            模型 {modelInfo.model} · {modelInfo.configured ? '已配 key' : '未配 key'}
          </span>
        )}
        <button className="tbtn" onClick={() => { void api.listApps().then(setApps); setView({ kind: 'apps' }); }}>我的应用</button>
        <button className="tbtn" onClick={() => run && setView({ kind: 'replay', runId: run.id })} disabled={!run}>回放与评分</button>
        <button className="tbtn primary" onClick={() => { setRun(null); setEvents([]); setApp(null); setInput(''); setNotice(null); setIntercept(null); }}>新建</button>
      </header>

      <div className="view-main">
        {/* 顶部输入：Build / Plan / Engineer + Team Mode + @ 点名 */}
        <div className="panel input-panel">
          <div className="panel-b">
            <textarea className="input" rows={2} placeholder="例如：小区团购接龙、记账看板、习惯打卡、报价计算器" value={input} onChange={(e) => setInput(e.target.value)} />
            <div className="row" style={{ marginTop: 10 }}>
              <div className="seg">
                {MODES.map((m) => (
                  <button key={m.key} className={mode === m.key ? 'on' : ''} title={m.desc} onClick={() => setMode(m.key)}>
                    {m.label}
                  </button>
                ))}
              </div>
              <label className="switch" title="开：完整 5 人团队可见；关：Mike + Alex 简化流程">
                <input type="checkbox" checked={teamMode} disabled={mode === 'engineer'} onChange={(e) => setTeamMode(e.target.checked)} />
                <span>Team Mode</span>
              </label>
              {teamMode && mode !== 'engineer' && (
                <span className="mention-wrap">
                  <button className="btn" onClick={() => setShowMention((v) => !v)}>@ 点名</button>
                  {showMention && (
                    <span className="mention-menu">
                      {TEAM.map((t) => (
                        <button key={t.key} onClick={() => { setInput((v) => `${v}@${t.label.split(' ')[0]} `); setShowMention(false); }}>
                          {t.label}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              )}
              <span className="small" style={{ marginLeft: 4 }}>
                {mode === 'plan' ? 'Plan：Mike 先出计划，你批准才开工' : mode === 'engineer' ? 'Engineer：只派 Alex 一人干活' : teamMode ? 'Team Mode 开：Mike + Iris + Emma + Bob + Alex' : 'Team Mode 关：Mike + Alex 简化流程'}
              </span>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              {templates.map((t) => (
                <button key={t.id} className="chip" onClick={() => setInput({ ledger: '我要一个记账看板', habit: '我要一个习惯打卡', quote: '我要一个报价计算器', signup: '小区团购接龙' }[t.id] ?? t.name)}>
                  {t.name}
                </button>
              ))}
              <button className="chip" onClick={() => void startRun('小区团购接龙')}>先看看示例</button>
              <button className="btn primary block" style={{ flex: 1 }} disabled={busy || !input.trim()} onClick={() => void startRun(input)}>
                {busy ? '生成中…' : '生成应用'}
              </button>
            </div>
            <p className="small" style={{ marginTop: 8 }}>只有 4 个模板：记账看板 / 习惯打卡 / 报价计算器 / 活动报名·接龙。匹配不上会直接告诉你，不会硬编。@ 点名只作记录，路由仍按上面选的模式走。</p>
          </div>
        </div>

        <div className="layout">
          {/* 主角：生成的应用 */}
          <div className="col-main">
            <div className="panel">
              <div className="panel-h">
                {shownApp ? shownApp.name : '应用'}
                <span className="sub">
                  {isDraft ? 'Preview · 未上线' : app ? (app.published_version > 0 ? `已发布 v${app.published_version}` : 'Preview · 未上线') : '生成后出现在这里'}
                </span>
              </div>
              <div className="panel-b appview">
                {shownApp ? (
                  <>
                    <p className="muted" style={{ margin: '0 0 10px' }}>
                      模板：{templates.find((t) => t.id === shownApp.template_id)?.name ?? shownApp.template_id}
                      {isDraft ? ' · 这是 Preview，确认发布后才上线' : ' · 数据已落库，刷新后还在'}
                    </p>
                    {isDraft ? <AppPreview app={shownApp} /> : <AppPreview app={shownApp} onSaved={setApp} />}
                    {app && (
                      <div className="versionbar">
                        {app.published_version > 0 ? (
                          <>
                            <span className="badge pub">已发布 v{app.published_version}</span>
                            {dirty ? (
                              <>
                                <span className="badge dirty">有未发布改动</span>
                                <button className="btn primary" disabled={busy} onClick={() => void updateApp()}>Update 发布新版</button>
                              </>
                            ) : (
                              <span className="muted">线上版与当前一致</span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="badge prev">Preview · 未上线</span>
                            <button className="btn primary" disabled={busy} onClick={() => void updateApp()}>发布</button>
                          </>
                        )}
                      </div>
                    )}
                    <div className="row" style={{ marginTop: 14 }}>
                      <button className="btn" disabled={!run || repeatStopped || busy} onClick={() => void repeatDemo()}>
                        {repeatStopped ? '重新生成（已停止）' : `重新生成${repeatClicks > 0 ? `（${repeatClicks}/3）` : ''}`}
                      </button>
                      <button className="btn" disabled={!app} onClick={() => void exportFile()}>导出为文件</button>
                      <button className="btn" disabled={!app} onClick={() => void exportJson()}>导出 JSON</button>
                      <button className="btn" disabled={!run} onClick={() => run && setView({ kind: 'replay', runId: run.id })}>回放与评分</button>
                    </div>
                    <p className="small" style={{ marginTop: 8 }}>
                      「导出为文件」会被 Tool Gateway 的权限拦截拦下（演示）；「重新生成」连点 3 次触发重复检测停止（演示）。发布后改数据不会直接动线上版，点 Update 才更新。
                    </p>
                  </>
                ) : (
                  <p className="muted">还没有可预览的应用。先在上面输入一句话生成，或去「我的应用」打开一个已保存的。</p>
                )}
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
          </div>

          {/* 侧栏：流水线 + 审批 + 需求/架构 + 实时轨迹 */}
          <div className="col-side">
            <div className="panel">
              <div className="panel-h">时间线 <span className="sub">{run ? `${run.mode === 'plan' ? 'Plan' : run.mode === 'engineer' ? 'Engineer' : 'Build'}${run.mode === 'engineer' ? '' : run.team_mode === 1 ? ' · Team Mode 开' : ' · Team Mode 关'}` : 'Mike 协调'}</span></div>
              <div className="panel-b">
                <ul className="steps">
                  {steps.map((s, i) => {
                    const cls = !run ? '' : run.status === 'rolled_back' && i === step ? 'blocked' : i < step ? 'done' : i === step ? 'active' : '';
                    return (
                      <li key={s.key} className={cls}>
                        <span className="dot">{i < step || run?.status === 'published' ? '✓' : i + 1}</span>
                        <span><div className="st">{s.label}</div><div className="sd">{s.desc}</div></span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            {run?.status === 'awaiting_plan' && (
              <div className="approve" style={{ marginTop: 14 }}>
                <h3>审批 0 · 计划确认</h3>
                <p>Mike 已出计划（见下方）。确认后才开工；拒绝则回退。</p>
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={() => void approve('plan', true)}>确认计划，开工</button>
                  <button className="btn danger" disabled={busy} onClick={() => void approve('plan', false)}>拒绝，回退</button>
                </div>
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
                <p>Alex 已生成草稿（见左侧 Preview）。确认后才上线；拒绝则保留草稿。</p>
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={() => void approve('publish', true)}>确认发布</button>
                  <button className="btn danger" disabled={busy} onClick={() => void approve('publish', false)}>拒绝，保留草稿</button>
                </div>
              </div>
            )}

            {run && (
              <>
                {run.plan_json && (
                  <div className="panel" style={{ marginTop: 14 }}>
                    <div className="panel-h">计划 <span className="sub">Mike</span></div>
                    <div className="panel-b">
                      <pre className="json">{pretty(run.plan_json)}</pre>
                    </div>
                  </div>
                )}
                <div className="panel" style={{ marginTop: 14 }}>
                  <div className="panel-h">需求清单 <span className="sub">{run.team_mode === 1 ? 'Iris + Emma' : 'Mike'} · {run.template_id ?? '未匹配'}</span></div>
                  <div className="panel-b">
                    {run.requirements_json ? <pre className="json">{pretty(run.requirements_json)}</pre> : <p className="muted">等待输出…</p>}
                  </div>
                </div>
                <div className="panel">
                  <div className="panel-h">设计说明 <span className="sub">Bob · 架构输出的一部分</span></div>
                  <div className="panel-b">
                    {run.design_json ? <pre className="json">{pretty(run.design_json)}</pre> : <p className="muted">等待 Bob 输出…</p>}
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

            <div className="panel" style={{ marginTop: 14 }}>
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
                      <><b>{a.name}</b> <span className="small">· {a.template_id} · {a.published_version > 0 ? `已发布 v${a.published_version}` : '未发布'} · {new Date(a.created_at).toLocaleString('zh-CN')}</span></>
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
                  {data.run.usage_json && (() => {
                    try {
                      const u = JSON.parse(data.run.usage_json);
                      return <div className="cell"><b>{u.totalTokens}</b><span>模型 tokens（输入 {u.promptTokens} / 输出 {u.completionTokens}，主 Agent 计；子 Agent 不在内）</span></div>;
                    } catch { return null; }
                  })()}
                </div>
              ) : (
                <p className="muted">本轮还没有评估结果（发布完成后由评估生成）。</p>
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
