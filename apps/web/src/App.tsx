import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeRunStream, type AppRow, type AppSummary, type EvalResult, type RunMode, type RunRow, type Template, type TraceRow } from './api';
import { AppPreview } from './preview';

type Tab = 'preview' | 'overview' | 'code' | 'replay';
type ReplayData = { run: RunRow; traces: TraceRow[]; eval: EvalResult | null };

const AGENTS = [
  { key: 'mike', label: 'Mike', role: '协调', cls: 'av-mike' },
  { key: 'iris', label: 'Iris', role: '调研', cls: 'av-iris' },
  { key: 'emma', label: 'Emma', role: '规格', cls: 'av-emma' },
  { key: 'bob', label: 'Bob', role: '架构', cls: 'av-bob' },
  { key: 'alex', label: 'Alex', role: '工程师', cls: 'av-alex' },
];

const TEMPLATE_PROMPTS: Record<string, string> = {
  ledger: '我要一个记账看板',
  habit: '我要一个习惯打卡',
  quote: '我要一个报价计算器',
  signup: '小区团购接龙',
};

/** 按当前 run 的模式与 Team Mode 开关，算出流水线步骤（只用于"持续构建"进度条）。 */
function pipelineSteps(run: RunRow | null): Array<{ key: string; label: string }> {
  const steps: Array<{ key: string; label: string }> = [];
  if (run?.mode === 'plan') {
    steps.push({ key: 'plan', label: '出计划' }, { key: 'plan_gate', label: '计划确认' });
  }
  if (run?.mode === 'engineer') {
    steps.push({ key: 'alex', label: 'Alex 构建' });
  } else if (run && run.team_mode === 1) {
    steps.push(
      { key: 'mike', label: 'Mike 协调' }, { key: 'iris', label: 'Iris 调研' },
      { key: 'emma', label: 'Emma 规格' }, { key: 'bob', label: 'Bob 架构' },
    );
  } else if (run) {
    steps.push({ key: 'mike', label: 'Mike 协调' }, { key: 'alex', label: 'Alex 构建' });
  }
  steps.push(
    { key: 'gate1', label: '架构确认' },
    { key: 'gate2', label: '发布确认' },
    { key: 'publish', label: '发布' },
    { key: 'eval', label: '评估' },
  );
  return steps;
}

function statusStep(run: RunRow, steps: Array<{ key: string }>): number {
  const idx = (key: string) => {
    const i = steps.findIndex((s) => s.key === key);
    return i < 0 ? 0 : i;
  };
  switch (run.status) {
    case 'running': return run.mode === 'plan' && !run.plan_json ? idx('plan') : idx('mike');
    case 'awaiting_plan': return idx('plan_gate');
    case 'awaiting_architecture': return idx('gate1');
    case 'generating': return idx('alex');
    case 'awaiting_publish': return idx('gate2');
    case 'testing': return idx('publish');
    case 'published': case 'rolled_back': case 'stopped': return steps.length;
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

/** trace 一条工具调用 → 步骤列表里的一行（灰色说明文字 + 药丸按钮）。 */
function stepLine(t: TraceRow): { line: string; pill: string; err: boolean } {
  let step = '';
  let outcome = '';
  let detail = '';
  try {
    const r = JSON.parse(t.result_json ?? '{}');
    step = r.step ?? '';
    outcome = r.outcome ?? '';
    detail = r.detail ?? '';
  } catch {
    step = t.result_json.slice(0, 80);
  }
  const line = `${t.tool}${step ? ` · ${step}` : ''}${outcome ? ` · ${outcome === 'blocked' ? '已拦截' : outcome}` : ''}${detail ? `（${detail}）` : ''}`;
  return { line, pill: t.tool, err: t.is_error === 1 };
}

function agentFor(run: RunRow | null): { key: string; label: string; role: string; cls: string } {
  if (!run) return AGENTS[0];
  switch (run.status) {
    case 'awaiting_plan': return AGENTS[0];
    case 'awaiting_architecture': return AGENTS[3];
    case 'generating': case 'awaiting_publish': case 'testing': case 'published': return AGENTS[4];
    default: return AGENTS[0];
  }
}

function parseUsage(json: string | null): { totalTokens: number; promptTokens: number; completionTokens: number; modelCalls: number } | null {
  if (!json) return null;
  try {
    const u = JSON.parse(json);
    return { totalTokens: u.totalTokens ?? 0, promptTokens: u.promptTokens ?? 0, completionTokens: u.completionTokens ?? 0, modelCalls: u.modelCalls ?? 0 };
  } catch {
    return null;
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

export default function App() {
  const [view, setView] = useState<'home' | 'project'>('home');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [runsList, setRunsList] = useState<RunRow[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<RunMode>('build');
  const [teamMode, setTeamMode] = useState(false);
  const [run, setRun] = useState<RunRow | null>(null);
  const [app, setApp] = useState<AppRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [intercept, setIntercept] = useState<{ title: string; body: string; alt?: string } | null>(null);
  const [modelInfo, setModelInfo] = useState<{ provider: string; model: string; configured: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [repeatClicks, setRepeatClicks] = useState(0);
  const [repeatStopped, setRepeatStopped] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastRef = useRef<number | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<number | null>(null);

  // 项目页状态
  const [tab, setTab] = useState<Tab>('preview');
  const [mobilePreview, setMobilePreview] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreTab, setMoreTab] = useState<'main' | 'templates'>('main');
  const [buildMenuOpen, setBuildMenuOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);
  const [buildCardOpen, setBuildCardOpen] = useState(true);
  const [isPublic, setIsPublic] = useState(true);
  const [search, setSearch] = useState('');
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [replaySel, setReplaySel] = useState<ReplayData | null>(null);
  const [rename, setRename] = useState('');
  const [chatInput, setChatInput] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastRef.current) window.clearTimeout(toastRef.current);
    toastRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshReplay = useCallback(async (id: string) => {
    try {
      setReplay(await api.getReplay(id));
    } catch { /* run 还没轨迹时忽略 */ }
  }, []);

  const refreshRun = useCallback(async (id: string) => {
    try {
      const r = await api.getRun(id);
      setRun(r);
      if (r.app_id) {
        try { setApp(await api.getApp(r.app_id)); } catch { /* app 可能已删 */ }
      }
      void refreshReplay(id);
      return r;
    } catch {
      return null;
    }
  }, [refreshReplay]);

  const attachStream = useCallback((runId: string) => {
    unsubRef.current?.();
    unsubRef.current = subscribeRunStream(runId, (e) => {
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
      if (toastRef.current) window.clearTimeout(toastRef.current);
    };
  }, []);

  const startRun = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setNotice(null);
    setIntercept(null);
    setApp(null);
    setReplay(null);
    setReplaySel(null);
    setTab('preview');
    setChatCollapsed(false);
    try {
      const r = await api.createRun(t, { mode, teamMode: mode === 'engineer' ? false : teamMode });
      setRun(r);
      setView('project');
      attachStream(r.id);
      void refreshReplay(r.id);
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
      void refreshReplay(r.id);
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
      setPublishOpen(false);
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

  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch {
      setNotice('复制失败：浏览器不允许访问剪贴板。');
    }
  };

  const openProject = async (appId: string) => {
    try {
      const a = await api.getApp(appId);
      setApp(a);
      setReplay(null);
      setReplaySel(null);
      setTab('preview');
      setChatCollapsed(false);
      setView('project');
      const runs = await api.listRuns().catch(() => [] as RunRow[]);
      const r = runs.find((x) => x.app_id === appId) ?? null;
      setRun(r);
      if (r) {
        void refreshReplay(r.id);
        if (!['published', 'rolled_back', 'stopped'].includes(r.status)) attachStream(r.id);
      }
    } catch (e: any) {
      setNotice(`打开失败：${e?.message ?? e}`);
    }
  };

  const loadHistoryRun = async (runId: string) => {
    setHistoryOpen(false);
    const r = await refreshRun(runId);
    if (!r) return;
    setTab('replay');
    try {
      setReplaySel(await api.getReplay(runId));
    } catch { /* ignore */ }
    if (!['published', 'rolled_back', 'stopped'].includes(r.status)) attachStream(runId);
  };

  const doRename = async () => {
    if (!app || !rename.trim()) return;
    try {
      const a = await api.renameApp(app.id, rename.trim());
      setApp(a);
      setApps(await api.listApps());
      setTitleMenuOpen(false);
      showToast('已改名');
    } catch (e: any) {
      setNotice(`改名失败：${e?.message ?? e}`);
    }
  };

  const doDeleteApp = async () => {
    if (!app) return;
    if (!window.confirm(`删除「${app.name}」？`)) return;
    try {
      await api.deleteApp(app.id);
      setApps(await api.listApps());
      setApp(null);
      setRun(null);
      setTitleMenuOpen(false);
      setView('home');
    } catch (e: any) {
      setNotice(`删除失败：${e?.message ?? e}`);
    }
  };

  const steps = pipelineSteps(run);
  const step = run ? statusStep(run, steps) : 0;
  const agent = agentFor(run);
  const usage = parseUsage(run?.usage_json ?? null);
  const toolTraces = (replay?.traces ?? []).filter((t) => t.kind === 'tool');

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
  const templateName = (id: string | null | undefined) => templates.find((t) => t.id === id)?.name ?? id ?? '未匹配';
  const filteredApps = apps.filter((a) => !search.trim() || a.name.includes(search.trim()) || a.template_id.includes(search.trim()));

  /** Agent 总结正文：只写 run/app 里真实有的数据。 */
  const agentSummary = (): string => {
    if (!run) return '输入一句话，我来把它变成一个能用的小应用。只做 4 个模板，匹配不上会直接告诉你。';
    switch (run.status) {
      case 'running': return '收到，正在按流程走：先匹配模板，再出需求和架构。';
      case 'awaiting_plan': return '计划已出好，等你确认才开工。';
      case 'awaiting_architecture': return '需求和架构已出好，等你确认架构，确认后 Alex 才开始生成。';
      case 'generating': return '架构已确认，Alex 正在生成草稿并自检。';
      case 'awaiting_publish': return '草稿已生成并自检通过，等你确认发布，确认后才上线。';
      case 'testing': return '正在做发布前检查…';
      case 'published': return shownApp ? `已完成「${shownApp.name}」，${templateName(shownApp.template_id)}应用已发布 v${shownApp.published_version}。数据已落库，刷新后还在。` : '已发布。';
      case 'rolled_back': return '已回退，草稿保留，可以换个说法重新生成。';
      case 'stopped': return '已停止。';
      default: return '';
    }
  };

  const requirements: string[] = (() => {
    if (!run?.requirements_json) return [];
    try {
      const r = JSON.parse(run.requirements_json);
      return Array.isArray(r.requirements) ? r.requirements : [];
    } catch {
      return [];
    }
  })();

  const publishAction = (): { label: string; disabled: boolean; onClick?: () => void } => {
    if (run?.status === 'awaiting_publish') return { label: '确认发布', disabled: busy, onClick: () => void approve('publish', true) };
    if (app && dirty) return { label: 'Update 发布新版', disabled: busy, onClick: () => void updateApp() };
    if (app && app.published_version > 0) return { label: `已发布 v${app.published_version}`, disabled: true };
    if (app && app.published_version === 0) return { label: '发布', disabled: busy, onClick: () => void updateApp() };
    return { label: '发布', disabled: true };
  };
  const pub = publishAction();

  if (view === 'home') {
    return (
      <div className="home">
        <aside className="sidebar">
          <div className="sb-logo"><span className="mark">A</span>迷你应用生成台</div>
          <div className="sb-ws"><span>Sean's Workspace</span><span>↕</span></div>
          <input className="input sb-search" placeholder="搜索项目" value={search} onChange={(e) => setSearch(e.target.value)} />
          <nav className="sb-nav">
            <button className="on" onClick={() => window.scrollTo({ top: 0 })}>⌂ 首页</button>
            <button onClick={() => document.getElementById('proj-list')?.scrollIntoView({ behavior: 'smooth' })}>▦ 项目</button>
            <button onClick={() => { setMoreTab('templates'); setMoreOpen(true); }}>▤ 模板</button>
          </nav>
          <div className="sb-sec">最近</div>
          <div className="sb-user">
            <span className="avatar sm av-alex">S</span>
            <span className="who"><b>sean</b><span className="small">未接账号</span></span>
            <button className="icon-btn" title="通知（未接）" onClick={() => showToast('通知未接')}>🔔</button>
            <button className="icon-btn" title="设置（未接）" onClick={() => showToast('设置未接')}>⚙</button>
          </div>
        </aside>

        <main className="home-main">
          <div className="home-center">
            <div className="avatars" title="Mike · 协调 / Iris · 调研 / Emma · 规格 / Bob · 架构 / Alex · 工程师">
              {AGENTS.map((a) => (
                <span key={a.key} className={`avatar ${a.cls}`} title={`${a.label} · ${a.role}`}>{a.label[0]}</span>
              ))}
            </div>
            <h1 className="greeting">你想创造什么？</h1>

            <div className="composer">
              <textarea
                placeholder="描述你想要的应用，一句话就行"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void startRun(input); }}
              />
              <div className="composer-foot">
                <div style={{ position: 'relative' }}>
                  <button className="icon-btn" title="附件" onClick={() => setAttachOpen((v) => !v)}>＋</button>
                  {attachOpen && (
                    <div className="menu" style={{ bottom: 44, left: 0 }}>
                      <button className="menu-row" onClick={() => { setAttachOpen(false); showToast('上传文件未接'); }}>上传文件</button>
                      <button className="menu-row" onClick={() => { setAttachOpen(false); showToast('上传文件夹未接'); }}>上传文件夹</button>
                    </div>
                  )}
                </div>
                <span className="spacer" />
                <div style={{ position: 'relative' }}>
                  <button className="menu-btn" onClick={() => { setMoreOpen((v) => !v); setBuildMenuOpen(false); }}>更多 ∨</button>
                  {moreOpen && (
                    <div className="menu" style={{ bottom: 44, left: 0 }}>
                      {moreTab === 'main' ? (
                        <>
                          <div className="menu-row">
                            <span className="grow"><b>团队模式</b><span className="sub">开：完整 5 人团队；关：Mike + Alex</span></span>
                            <button className={`switch${teamMode ? ' on' : ''}`} disabled={mode === 'engineer'} onClick={() => setTeamMode((v) => !v)} aria-label="团队模式开关" />
                          </div>
                          <button className="menu-row" onClick={() => setMoreTab('templates')}>
                            <span className="grow"><b>使用模板创建</b><span className="sub">4 个模板，点一个填进输入框</span></span><span>›</span>
                          </button>
                          <button className="menu-row" disabled>
                            <span className="grow"><b>深度研究</b><span className="sub">未接搜索，暂不可用</span></span><span className="tag-off">未接</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="menu-row" onClick={() => setMoreTab('main')}>‹ 返回</button>
                          {templates.map((t) => (
                            <button key={t.id} className="menu-row" onClick={() => { setInput(TEMPLATE_PROMPTS[t.id] ?? t.name); setMoreOpen(false); setMoreTab('main'); }}>
                              <span className="grow"><b>{t.name}</b><span className="sub">{t.description}</span></span>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ position: 'relative' }}>
                  <button className="menu-btn" onClick={() => { setBuildMenuOpen((v) => !v); setMoreOpen(false); }}><b>构建 ∨</b></button>
                  {buildMenuOpen && (
                    <div className="menu" style={{ bottom: 44, right: 0, minWidth: 320 }}>
                      <button className="menu-row" onClick={() => { setMode('build'); setBuildMenuOpen(false); }}>
                        <span className="grow"><b>构建</b><span className="sub">通用构建模式</span></span>
                        {mode === 'build' && <span className="check">✓</span>}
                      </button>
                      <button className="menu-row" onClick={() => { setMode('plan'); setBuildMenuOpen(false); }}>
                        <span className="grow"><b>计划</b><span className="sub">Mike 规划并分配构建任务</span></span>
                        <span className="tag-new">NEW</span>
                        {mode === 'plan' && <span className="check">✓</span>}
                      </button>
                      <button className="menu-row" onClick={() => { setMode('engineer'); setBuildMenuOpen(false); }}>
                        <span className="grow"><b>Engineer</b><span className="sub">只派 Alex 一人干活</span></span>
                        {mode === 'engineer' && <span className="check">✓</span>}
                      </button>
                    </div>
                  )}
                </div>
                <button className="icon-btn" title="语音输入（未接）" onClick={() => showToast('语音输入未接')}>♪</button>
                <button className="send-btn" disabled={busy || !input.trim()} title="生成应用" onClick={() => void startRun(input)}>↑</button>
              </div>
            </div>
            <p className="small" style={{ textAlign: 'center', marginTop: 8 }}>
              {mode === 'plan' ? 'Plan：Mike 先出计划，你批准才开工' : mode === 'engineer' ? 'Engineer：只派 Alex 一人干活' : teamMode ? 'Team Mode 开：Mike + Iris + Emma + Bob + Alex' : 'Team Mode 关：Mike + Alex 简化流程'}
              {modelInfo ? ` · 模型 ${modelInfo.model}${modelInfo.configured ? '（已配 key）' : '（未配 key，生成会报错）'}` : ''}
            </p>

            <div className="pill-row">
              <button className="chip" onClick={() => setInput('小区团购接龙')}>小区团购接龙</button>
              <button className="chip" onClick={() => setInput('我要一个记账看板')}>记账看板</button>
              <button className="chip" onClick={() => setInput('我要一个报价计算器')}>报价计算器</button>
              <button className="chip" onClick={() => { setMoreTab('templates'); setMoreOpen(true); }}>查看全部模板</button>
            </div>

            <div id="proj-list">
              <div className="proj-head"><h2>项目</h2><span className="small">{filteredApps.length} 个</span></div>
              {notice && <div className="guidance" style={{ marginBottom: 12 }}>{notice}</div>}
              {filteredApps.length === 0 ? (
                <p className="muted">还没有保存的应用。上面输入一句话，生成一个并发布后会出现在这里。</p>
              ) : (
                <div className="proj-grid">
                  {filteredApps.map((a) => (
                    <button key={a.id} className="proj-card" onClick={() => void openProject(a.id)}>
                      <span className={`proj-thumb th-${a.template_id}`}>{templateName(a.template_id)[0]}</span>
                      <span className="proj-meta">
                        <b>{a.name}</b>
                        <span className="small">{templateName(a.template_id)} · {a.published_version > 0 ? `已发布 v${a.published_version}` : '未发布'} · {fmtTime(a.created_at)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ---------------- 项目页 ---------------- */
  return (
    <div className="project">
      <div className="rail">
        <button className="mark" title="回到首页" onClick={() => setView('home')}>A</button>
        <button className="rail-btn" title="Sean's Workspace" onClick={() => setView('home')}>S</button>
        <button className="rail-btn" title="sean（未接账号）" onClick={() => showToast('账号未接')}>◉</button>
        <button className="rail-btn" title="设置（未接）" onClick={() => showToast('设置未接')}>⚙</button>
        <button className="rail-btn" title="通知（未接）" onClick={() => showToast('通知未接')}>🔔<span className="dot" /></button>
        <span className="spacer" />
        <button className="rail-btn" title="展开侧边栏（未接）" onClick={() => showToast('展开侧边栏未接')}>»</button>
      </div>

      {!chatCollapsed && (
        <section className="chat">
          <div className="chat-scroll">
            {run && buildCardOpen && (
              <div className="build-card">
                <b>持续构建</b>
                <span className="segbar">
                  {steps.map((s, i) => <i key={s.key} className={i < step ? 'on' : ''} />)}
                </span>
                <span>{Math.min(step, steps.length)}/{steps.length}</span>
                <button className="x" onClick={() => setBuildCardOpen(false)} title="关闭">×</button>
              </div>
            )}
            {run && <div className="date-sep">{fmtDate(run.created_at)}</div>}
            {run && (
              <div className="msg-user">{run.input}</div>
            )}
            {run && <div className="msg-time">{fmtTime(run.created_at)}</div>}

            {run && (
              <div className="msg-agent">
                <span className={`avatar sm ${agent.cls}`}>{agent.label[0]}</span>
                <div className="msg-body">
                  <div className="who">{agent.label} <span>· {agent.role}</span></div>
                  <button className="steps-toggle" onClick={() => setStepsOpen((v) => !v)}>
                    ✓ 已处理 {toolTraces.length} 步 {stepsOpen ? '∨' : '›'}
                  </button>
                  {stepsOpen && toolTraces.length > 0 && (
                    <ul className="step-list">
                      {toolTraces.map((t) => {
                        const s = stepLine(t);
                        return (
                          <li key={t.seq} className="step-item">
                            <div className="step-line">{s.line}</div>
                            <span className={`step-pill${s.err ? ' err' : ''}`}>{s.pill}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {stepsOpen && toolTraces.length === 0 && (
                    <p className="muted">还没产生工具调用，生成开始后这里会列出每一步。</p>
                  )}
                  <p>{agentSummary()}</p>
                  {requirements.length > 0 && (
                    <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13.5 }}>
                      {requirements.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  )}
                  {app && app.published_version > 0 && (
                    <div className="ver-card">
                      <b>版本 {app.published_version} · 完成{app.name}</b>
                      <div className="row">
                        <button className="btn" onClick={() => showToast('克隆未接')}>克隆</button>
                        <button className="btn" onClick={() => void copyText(window.location.origin, '链接已复制')}>复制链接</button>
                      </div>
                    </div>
                  )}
                  {run.status === 'awaiting_plan' && (
                    <div className="approve">
                      <h3>审批 0 · 计划确认</h3>
                      <p>Mike 已出计划。确认后才开工；拒绝则回退。</p>
                      <div className="row">
                        <button className="btn primary" disabled={busy} onClick={() => void approve('plan', true)}>确认计划，开工</button>
                        <button className="btn danger" disabled={busy} onClick={() => void approve('plan', false)}>拒绝，回退</button>
                      </div>
                    </div>
                  )}
                  {run.status === 'awaiting_architecture' && (
                    <div className="approve">
                      <h3>审批 1 · 架构确认</h3>
                      <p>Bob 已出架构决策。确认后 Alex 才开始生成；拒绝则回退到需求阶段。</p>
                      <div className="row">
                        <button className="btn primary" disabled={busy} onClick={() => void approve('architecture', true)}>确认架构，继续生成</button>
                        <button className="btn danger" disabled={busy} onClick={() => void approve('architecture', false)}>拒绝，回退</button>
                      </div>
                    </div>
                  )}
                  {run.status === 'awaiting_publish' && (
                    <div className="approve">
                      <h3>审批 2 · 发布确认</h3>
                      <p>Alex 已生成草稿（见右侧预览）。确认后才上线；拒绝则保留草稿。</p>
                      <div className="row">
                        <button className="btn primary" disabled={busy} onClick={() => void approve('publish', true)}>确认发布</button>
                        <button className="btn danger" disabled={busy} onClick={() => void approve('publish', false)}>拒绝，保留草稿</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {!run && (
              <div className="msg-agent">
                <span className="avatar sm av-mike">M</span>
                <div className="msg-body">
                  <div className="who">Mike <span>· 协调</span></div>
                  <p>输入一句话，我来把它变成一个能用的小应用。只做 4 个模板，匹配不上会直接告诉你。</p>
                </div>
              </div>
            )}
          </div>

          <div className="chat-foot">
            <div className="tokenbar">
              <span>◆</span>
              {usage
                ? <span>本次 run：{usage.totalTokens} tokens（输入 {usage.promptTokens} / 输出 {usage.completionTokens}，{usage.modelCalls} 次调用）</span>
                : <span>本次 run：暂无 token 用量</span>}
              {modelInfo && <span className="pill-blue">{modelInfo.model}{modelInfo.configured ? '' : ' · 未配 key'}</span>}
            </div>
            <div className="chat-input">
              <textarea
                placeholder="让智能体团队实现你的想法"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void startRun(chatInput); }}
              />
              <div className="composer-foot">
                <div style={{ position: 'relative' }}>
                  <button className="icon-btn" title="附件" onClick={() => setAttachOpen((v) => !v)}>＋</button>
                  {attachOpen && (
                    <div className="menu" style={{ bottom: 44, left: 0 }}>
                      <button className="menu-row" onClick={() => { setAttachOpen(false); showToast('上传文件未接'); }}>上传文件</button>
                      <button className="menu-row" onClick={() => { setAttachOpen(false); showToast('上传文件夹未接'); }}>上传文件夹</button>
                    </div>
                  )}
                </div>
                <span className="spacer" />
                <button className="icon-btn" title="语音输入（未接）" onClick={() => showToast('语音输入未接')}>♪</button>
                <button className="send-btn" disabled={busy || !chatInput.trim()} title="开始新一轮生成" onClick={() => void startRun(chatInput)}>↑</button>
              </div>
            </div>
            <p className="chat-note">新输入会开始新一轮生成，不会修改当前应用（对话改应用的功能没有）。</p>
          </div>
        </section>
      )}

      <section className="pv">
        <div className="pv-top">
          <div style={{ position: 'relative' }}>
            <button className="pv-title" onClick={() => { setTitleMenuOpen((v) => !v); setRename(app?.name ?? ''); }}>{shownApp ? shownApp.name : '未命名应用'} ∨</button>
            {titleMenuOpen && app && (
              <div className="menu" style={{ top: 44, left: 0 }}>
                <div className="menu-row">
                  <input className="input" value={rename} onChange={(e) => setRename(e.target.value)} placeholder="应用名" />
                  <button className="btn primary" onClick={() => void doRename()}>保存</button>
                </div>
                <button className="menu-row" onClick={() => void doDeleteApp()}><span className="grow" style={{ color: '#DC2626' }}>删除应用</span></button>
              </div>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" title="历史版本" onClick={async () => { setHistoryOpen((v) => !v); if (!historyOpen) setRunsList(await api.listRuns().catch(() => [])); }}>◷</button>
            {historyOpen && (
              <div className="menu" style={{ top: 48, left: 0, minWidth: 340 }}>
                <div className="menu-row"><b>版本</b></div>
                {runsList.length === 0 ? (
                  <div className="menu-row"><span className="grow muted">暂无历史版本</span></div>
                ) : runsList.slice(0, 10).map((r) => (
                  <button key={r.id} className="menu-row" onClick={() => void loadHistoryRun(r.id)}>
                    <span className="grow"><b>{r.input.slice(0, 28)}</b><span className="sub">{r.status} · {fmtTime(r.created_at)}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" title={chatCollapsed ? '展开聊天栏' : '收起聊天栏'} onClick={() => setChatCollapsed((v) => !v)}>{chatCollapsed ? '»' : '«'}</button>
          <div className="seg-ctl">
            {([['preview', '预览'], ['overview', '概览'], ['code', '代码'], ['replay', '回放']] as Array<[Tab, string]>).map(([k, label]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); if (k === 'replay') void api.listRuns().then(setRunsList).catch(() => undefined); }}>{label}</button>
            ))}
          </div>
          <button className="icon-btn" title={mobilePreview ? '显示桌面预览' : '显示移动预览'} onClick={() => setMobilePreview((v) => !v)}>{mobilePreview ? '▣' : '▯'}</button>
          <button className="icon-btn" title="分享" onClick={() => setShareOpen(true)}>↗</button>
          <button className="publish-fab" title="发布你的项目" onClick={() => setPublishOpen(true)}>↑</button>
        </div>

        <div className="pv-body">
          {notice && <div className="guidance" style={{ marginBottom: 12 }}>{notice}</div>}
          {tab === 'preview' && (
            <div className={mobilePreview ? 'phone-frame' : ''}>
              <div className="pv-card">
                <h3>{shownApp ? shownApp.name : '应用'}</h3>
                <p className="muted" style={{ margin: '0 0 10px' }}>
                  模板：{templateName(shownApp?.template_id)}
                  {isDraft ? ' · 这是 Preview，确认发布后才上线' : app ? ' · 数据已落库，刷新后还在' : ' · 生成后出现在这里'}
                  {app && app.published_version > 0 && ` · 已发布 v${app.published_version}`}
                  {app && dirty && ' · 有未发布改动'}
                </p>
                {shownApp ? (
                  isDraft ? <AppPreview app={shownApp} /> : <AppPreview app={shownApp} onSaved={setApp} />
                ) : (
                  <p className="muted">还没有可预览的应用。先回首页输入一句话生成，或从项目列表打开一个已保存的。</p>
                )}
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
                <div className="pv-actions">
                  <button className="btn" disabled={!run || repeatStopped || busy} onClick={() => void repeatDemo()}>
                    {repeatStopped ? '重新生成（已停止）' : `重新生成${repeatClicks > 0 ? `（${repeatClicks}/3）` : ''}`}
                  </button>
                  <button className="btn" disabled={!app} onClick={() => void exportFile()}>导出为文件</button>
                  <button className="btn" disabled={!app} onClick={() => void exportJson()}>导出 JSON</button>
                  <button className="btn" disabled={!run} onClick={() => setTab('replay')}>回放与评分</button>
                </div>
                <p className="small" style={{ marginTop: 8 }}>
                  「导出为文件」会被 Tool Gateway 的权限拦截拦下（演示）；「重新生成」连点 3 次触发重复检测停止（演示）。发布后改数据不会直接动线上版，点 Update 才更新。
                </p>
              </div>
              <div className="design-tools">
                <button onClick={() => showToast('选择元素未接')}>选择元素</button>
                <button onClick={() => showToast('修改文本未接')}>修改文本</button>
                <button onClick={() => showToast('主题未接')}>主题</button>
              </div>
            </div>
          )}

          {tab === 'overview' && (
            <div>
              <div className="ov-card">
                <h3>{shownApp ? shownApp.name : '未命名应用'}</h3>
                <p className="muted" style={{ margin: '0 0 12px' }}>{shownApp ? templateName(shownApp.template_id) : '还没有应用'} · {shownApp ? `创建于 ${fmtTime(shownApp.created_at)}` : ''}</p>
                <div className="ov-row">
                  <div className="grow"><b>发布你的 app</b><span className="small">确认发布后上线 v1，之后改完点 Update 才更新线上版。</span></div>
                  <button className="btn primary" disabled={pub.disabled} onClick={pub.onClick}>{pub.label}</button>
                </div>
              </div>
              <div className="ov-card">
                <div className="ov-row">
                  <div className="grow"><b>线上应用版本</b><span className="small">{app ? (app.published_version > 0 ? `已发布 v${app.published_version}${dirty ? '，有未发布改动' : ''}` : '未发布（Preview）') : '暂无应用'}</span></div>
                </div>
                <div className="ov-row">
                  <div className="grow"><b>评估分数</b><span className="small">{replay?.eval ? `成功率 ${Math.round(replay.eval.successRate * 100)}% · ${replay.eval.steps} 步 · ${(replay.eval.durationMs / 1000).toFixed(1)}s · ${replay.eval.toolCalls} 次工具调用` : '本轮还没有评估结果（发布完成后生成）'}</span></div>
                </div>
                <div className="ov-row">
                  <div className="grow"><b>Token 用量</b><span className="small">{usage ? `${usage.totalTokens} tokens（输入 ${usage.promptTokens} / 输出 ${usage.completionTokens}，${usage.modelCalls} 次调用）` : '暂无'} · 模型 {modelInfo?.model ?? 'kimi-k3'}</span></div>
                </div>
                <div className="ov-row">
                  <div className="grow"><b>导出</b><span className="small">应用数据 JSON，浏览器直接下载。</span></div>
                  <button className="btn" disabled={!app} onClick={() => void exportJson()}>导出 JSON</button>
                </div>
              </div>
            </div>
          )}

          {tab === 'code' && (
            <div className="ov-card">
              <h3>应用数据 JSON</h3>
              <p className="muted" style={{ margin: '0 0 8px' }}>没有代码文件：我们的应用是模板数据 JSON，不是整站代码。下方是当前应用的完整数据（只读），以及本次 run 的工具调用 trace。</p>
              {shownApp ? (
                <>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <button className="btn" onClick={() => void copyText(pretty(shownApp.data_json), 'JSON 已复制')}>复制 JSON</button>
                    <span className="small">模板：{templateName(shownApp.template_id)}</span>
                  </div>
                  <pre className="json">{pretty(shownApp.data_json)}</pre>
                </>
              ) : (
                <p className="muted">还没有应用数据。</p>
              )}
              <h3 style={{ marginTop: 18 }}>工具调用 trace</h3>
              {toolTraces.length === 0 ? (
                <p className="muted">本轮暂无工具调用。</p>
              ) : (
                <ul className="trace">
                  {toolTraces.map((t) => {
                    const s = stepLine(t);
                    return (
                      <li key={t.seq} className={s.err ? 'err' : 'ok'}>
                        <span className="tag">{t.actor}</span>
                        <span className="detail">{s.line}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {tab === 'replay' && (
            <div>
              <div className="ov-card">
                <h3>版本历史</h3>
                <ul className="hist-list">
                  {runsList.length === 0 ? (
                    <li><span className="muted">暂无历史版本。</span></li>
                  ) : runsList.slice(0, 10).map((r) => (
                    <li key={r.id}>
                      <button onClick={async () => { try { setReplaySel(await api.getReplay(r.id)); } catch { /* ignore */ } }}>
                        <b>{r.input.slice(0, 32)}</b>
                        <span className="meta"> · {r.status} · {fmtTime(r.created_at)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {(replaySel ?? replay) && (() => {
                const d = replaySel ?? replay;
                if (!d) return null;
                const u = parseUsage(d.run.usage_json);
                return (
                  <div className="ov-card">
                    <h3>回放 · {d.run.input.slice(0, 32)}</h3>
                    {d.eval ? (
                      <div className="score" style={{ marginBottom: 12 }}>
                        <div className="cell"><b>{Math.round(d.eval.successRate * 100)}%</b><span>成功率</span></div>
                        <div className="cell"><b>{d.eval.steps}</b><span>步数</span></div>
                        <div className="cell"><b>{(d.eval.durationMs / 1000).toFixed(1)}s</b><span>耗时</span></div>
                        <div className="cell"><b>{d.eval.toolCalls}</b><span>工具调用</span></div>
                        <div className="cell"><b>{u ? u.totalTokens : '—'}</b><span>tokens</span></div>
                      </div>
                    ) : (
                      <p className="muted">本轮还没有评估结果（发布完成后生成）。</p>
                    )}
                    <ul className="trace">
                      {d.traces.map((t) => {
                        const s = t.kind === 'tool' ? stepLine(t) : { line: `${t.tool} · ${t.kind} · ${t.result_json.slice(0, 120)}`, pill: t.tool, err: t.is_error === 1 };
                        return (
                          <li key={t.seq} className={s.err ? 'err' : 'ok'}>
                            <span className="tag">{t.actor}</span>
                            <span className="detail">{s.line}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {publishOpen && (
          <div className="panel-side">
            <button className="x" onClick={() => setPublishOpen(false)}>×</button>
            <h2>发布</h2>
            <div className="kv-row"><b>你的网站 URL</b><span className="small">{window.location.origin}</span></div>
            <div className="row" style={{ margin: '8px 0 4px' }}>
              <button className="btn" onClick={() => void copyText(window.location.origin, '链接已复制')}>复制链接</button>
            </div>
            <p className="small">发布后，别人打开这个链接就能用你的应用；应用数据存在后端，刷新后还在。改完数据要再点 Update，线上版才会变。</p>
            <div className="kv-row">
              <b>将你的项目设为公开</b>
              <button className={`switch${isPublic ? ' on' : ''}`} onClick={() => setIsPublic((v) => !v)} aria-label="设为公开开关" />
            </div>
            <p className="small">本 Demo 不设私密应用，链接一直是公开的，开关只做显示。</p>
            <div className="kv-row"><b>当前状态</b><span>{app ? (app.published_version > 0 ? `已发布 v${app.published_version}${dirty ? '，有未发布改动' : ''}` : 'Preview · 未上线') : run ? run.status : '还没有应用'}</span></div>
            <button className="btn primary block" style={{ marginTop: 18, width: '100%', padding: '12px 0', fontSize: 15 }} disabled={pub.disabled} onClick={pub.onClick}>{pub.label}</button>
          </div>
        )}

        {shareOpen && (
          <div className="overlay" onClick={() => setShareOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <button className="x" onClick={() => setShareOpen(false)}>×</button>
              <h2>分享</h2>
              <div className="pub-card">
                <b>公开</b>
                <p style={{ margin: '6px 0 0' }}>项目可以通过链接访问。{app ? `当前应用：${app.name}。` : '还没有可分享的应用。'}</p>
              </div>
              <button className="btn primary block" style={{ width: '100%', padding: '10px 0' }} onClick={() => void copyText(window.location.origin, '链接已复制')}>复制链接</button>
              <button className="btn block" style={{ width: '100%', marginTop: 8, padding: '10px 0' }} disabled={!app} onClick={() => { setShareOpen(false); void exportJson(); }}>导出 JSON</button>
              <p className="small" style={{ marginTop: 10 }}>私人分享需要 Pro，本 Demo 没有账号体系，未接。</p>
            </div>
          </div>
        )}

        {intercept && (
          <div className="overlay" onClick={() => setIntercept(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <button className="x" onClick={() => setIntercept(null)}>×</button>
              <div className="intercept" style={{ border: 'none', background: 'none', padding: 0 }}>
                <h3>{intercept.title}</h3>
                <p>{intercept.body}</p>
                {intercept.alt && <button className="btn" onClick={() => { setIntercept(null); void exportJson(); }}>{intercept.alt}</button>}
              </div>
            </div>
          </div>
        )}
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
