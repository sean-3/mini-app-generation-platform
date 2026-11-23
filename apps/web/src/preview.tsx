import { useState } from 'react';
import { api, type AppRow } from './api';

/** 四个模板的真实交互预览：改动都调 PATCH /api/apps/:id/data 落库，刷新后还在。 */

function today() {
  return new Date().toISOString().slice(0, 10);
}

function Ledger({ app, onSaved }: { app: AppRow; onSaved?: (a: AppRow) => void }) {
  const editable = !!onSaved;
  const data = JSON.parse(app.data_json) as { records: Array<{ id: string; amount: number; category: string; date: string; note?: string }> };
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('餐饮');
  const [note, setNote] = useState('');
  const total = data.records.reduce((s, r) => s + r.amount, 0);
  const byCat = new Map<string, number>();
  for (const r of data.records) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amount);

  const add = async () => {
    const v = Number(amount);
    if (!onSaved || !v || v <= 0) return;
    const next = { ...data, records: [...data.records, { id: `r${Date.now()}`, amount: v, category, date: today(), note }] };
    onSaved(await api.updateAppData(app.id, next));
    setAmount('');
    setNote('');
  };

  return (
    <div>
      <div className="kv"><span>当月合计</span><b>¥{total.toFixed(1)}</b></div>
      {[...byCat.entries()].map(([c, v]) => (
        <div className="kv" key={c}><span>{c}</span><span>¥{v.toFixed(1)}</span></div>
      ))}
      <table className="data">
        <thead><tr><th>日期</th><th>分类</th><th>备注</th><th>金额</th></tr></thead>
        <tbody>
          {data.records.slice(-8).map((r) => (
            <tr key={r.id}><td>{r.date}</td><td>{r.category}</td><td>{r.note ?? ''}</td><td>¥{r.amount}</td></tr>
          ))}
        </tbody>
      </table>
      {editable && <div className="form-grid" style={{ marginTop: 10 }}>
        <input className="input" type="number" placeholder="金额" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          {['餐饮', '交通', '购物', '娱乐', '其他'].map((c) => <option key={c}>{c}</option>)}
        </select>
        <input className="input full" placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary full" onClick={add}>记一笔</button>
      </div>}
    </div>
  );
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

function Habit({ app, onSaved }: { app: AppRow; onSaved?: (a: AppRow) => void }) {
  const editable = !!onSaved;
  const data = JSON.parse(app.data_json) as { habits: Array<{ id: string; name: string; streak: number; week: boolean[] }> };
  const toggle = async (id: string, i: number) => {
    if (!onSaved) return;
    const next = {
      ...data,
      habits: data.habits.map((h) => {
        if (h.id !== id) return h;
        const week = [...h.week];
        week[i] = !week[i];
        const streak = week[i] ? h.streak + 1 : Math.max(0, h.streak - 1);
        return { ...h, week, streak };
      }),
    };
    onSaved(await api.updateAppData(app.id, next));
  };
  return (
    <div>
      {data.habits.map((h) => (
        <div key={h.id} style={{ marginBottom: 14 }}>
          <div className="kv"><span><b>{h.name}</b></span><span>连续 {h.streak} 天</span></div>
          <div className="week">
            {h.week.map((done, i) => (
              <button key={i} className={done ? 'on' : ''} disabled={!editable} onClick={() => toggle(h.id, i)} title={`周${WEEK[i]}`}>
                {WEEK[i]}
              </button>
            ))}
          </div>
        </div>
      ))}
      {editable && <p className="small">点一下格子就打卡 / 取消，连续天数跟着变。</p>}
    </div>
  );
}

function Quote({ app, onSaved }: { app: AppRow; onSaved?: (a: AppRow) => void }) {
  const editable = !!onSaved;
  const data = JSON.parse(app.data_json) as { rows: Array<{ id: string; item: string; qty: number; price: number }> };
  const [item, setItem] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const total = data.rows.reduce((s, r) => s + r.qty * r.price, 0);

  const add = async () => {
    if (!onSaved || !item.trim() || !(Number(price) >= 0) || !(Number(qty) > 0)) return;
    const next = { ...data, rows: [...data.rows, { id: `q${Date.now()}`, item: item.trim(), qty: Number(qty), price: Number(price) }] };
    onSaved(await api.updateAppData(app.id, next));
    setItem('');
    setQty('1');
    setPrice('');
  };
  const remove = async (id: string) => {
    if (!onSaved) return;
    onSaved(await api.updateAppData(app.id, { ...data, rows: data.rows.filter((r) => r.id !== id) }));
  };
  const editQty = async (id: string, delta: number) => {
    if (!onSaved) return;
    const next = { ...data, rows: data.rows.map((r) => (r.id === id ? { ...r, qty: Math.max(1, r.qty + delta) } : r)) };
    onSaved(await api.updateAppData(app.id, next));
  };

  return (
    <div>
      <table className="data">
        <thead><tr><th>项目</th><th>数量</th><th>单价</th><th>小计</th><th></th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.item}</td>
              <td>
                {editable ? (
                  <>
                    <button className="btn" style={{ padding: '0 8px', minHeight: 28 }} onClick={() => editQty(r.id, -1)}>−</button>
                    {' '}{r.qty}{' '}
                    <button className="btn" style={{ padding: '0 8px', minHeight: 28 }} onClick={() => editQty(r.id, 1)}>＋</button>
                  </>
                ) : r.qty}
              </td>
              <td>¥{r.price}</td>
              <td>¥{(r.qty * r.price).toFixed(0)}</td>
              <td>{editable && <button className="btn danger" style={{ padding: '0 8px', minHeight: 28 }} onClick={() => remove(r.id)}>删</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="kv"><span>总价</span><b>¥{total.toFixed(0)}</b></div>
      {editable && <div className="form-grid" style={{ marginTop: 10 }}>
        <input className="input" placeholder="项目" value={item} onChange={(e) => setItem(e.target.value)} />
        <input className="input" type="number" placeholder="单价" value={price} onChange={(e) => setPrice(e.target.value)} />
        <input className="input" type="number" placeholder="数量" value={qty} onChange={(e) => setQty(e.target.value)} />
        <button className="btn primary" onClick={add}>加一行</button>
      </div>}
    </div>
  );
}

/** 自取时间段选项。必须和 apps/api/src/templates/templates.service.ts 里的 SIGNUP_SLOTS 一致。 */
const SLOTS = ['上午 09:00-11:00', '下午 16:00-18:00', '晚上 18:00-20:00'];

type SignupRow = { id: string; name: string; count: number; note?: string; building?: string; slot?: string; phone?: string; items?: string };

/** 手机号脱敏：前三后四，中间 ****；太短的直接原样显示（空即空）。 */
const maskPhone = (p?: string) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : (p ?? ''));

function Signup({ app, onSaved, cap }: { app: AppRow; onSaved?: (a: AppRow) => void; cap: number }) {
  const editable = !!onSaved;
  const data = JSON.parse(app.data_json) as { signups: SignupRow[] };
  const [name, setName] = useState('');
  const [building, setBuilding] = useState('');
  const [phone, setPhone] = useState('');
  const [count, setCount] = useState('1');
  const [slot, setSlot] = useState(SLOTS[0]);
  const [note, setNote] = useState('');
  const [blocked, setBlocked] = useState(false);
  // 向后兼容：老数据没有 building/slot/phone/items，缺失时给默认值（楼栋空、时间段第一项、手机空、购买内容空）。
  const signups = data.signups.map((p) => ({
    ...p,
    building: p.building ?? '',
    slot: p.slot && SLOTS.includes(p.slot) ? p.slot : SLOTS[0],
    phone: p.phone ?? '',
    items: p.items ?? '',
  }));
  const total = signups.reduce((s, p) => s + p.count, 0);
  const remaining = Math.max(0, cap - total);
  // 组织者统计：由报名数据现算，不存冗余字段。
  const bySlot = SLOTS.map((s) => {
    const rows = signups.filter((p) => p.slot === s);
    return { slot: s, people: rows.length, count: rows.reduce((n, p) => n + p.count, 0) };
  });
  // 购买内容列只在有数据时显示：默认 seed 没有 items，空列摆在那是摆设；
  // 模型生成的数据带 items 时（团购）列才出现。不造假数据。
  const hasItems = signups.some((p) => p.items);

  const join = async () => {
    const n = Number(count);
    if (!onSaved || !name.trim() || !(n > 0)) return;
    if (total + n > cap) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    const next = { ...data, signups: [...data.signups, { id: `s${Date.now()}`, name: name.trim(), count: n, note, building: building.trim(), slot, phone: phone.trim() }] };
    onSaved(await api.updateAppData(app.id, next));
    setName('');
    setBuilding('');
    setPhone('');
    setCount('1');
    setSlot(SLOTS[0]);
    setNote('');
  };

  return (
    <div>
      <div className="kv"><span>已报名</span><b>{total} / {cap} 人</b></div>
      <div className="kv"><span>组织者统计</span><b>共 {total} 份 · {signups.length} 人报名 · 还剩 {remaining} 个名额</b></div>
      {bySlot.map((b) => (
        <div className="kv" key={b.slot}><span>{b.slot}</span><span>{b.people} 人 · {b.count} 份</span></div>
      ))}
      <table className="data">
        <thead><tr><th>#</th><th>姓名</th><th>楼栋房号</th><th>手机号</th><th>自取时间段</th><th>人数</th>{hasItems && <th>购买内容</th>}<th>备注</th></tr></thead>
        <tbody>
          {signups.map((p, i) => (
            <tr key={p.id}><td>{i + 1}</td><td>{p.name}</td><td>{p.building}</td><td>{maskPhone(p.phone)}</td><td>{p.slot}</td><td>{p.count}</td>{hasItems && <td>{p.items}</td>}<td>{p.note ?? ''}</td></tr>
          ))}
        </tbody>
      </table>
      {blocked && <div className="intercept" style={{ marginTop: 10 }}><h3>人数已满</h3><p>再加 {count} 人会超过上限 {cap} 人，本次报名没有写入。</p></div>}
      {editable && <div className="form-grid" style={{ marginTop: 10 }}>
        <input className="input" placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="楼栋房号（可选）" value={building} onChange={(e) => setBuilding(e.target.value)} />
        <input className="input" placeholder="手机号（可选）" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className="input" type="number" placeholder="人数" value={count} onChange={(e) => setCount(e.target.value)} />
        <select className="input" value={slot} onChange={(e) => setSlot(e.target.value)}>
          {SLOTS.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input className="input full" placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary full" onClick={join}>报名</button>
      </div>}
    </div>
  );
}

export function AppPreview({ app, onSaved }: { app: AppRow; onSaved?: (a: AppRow) => void }) {
  switch (app.template_id) {
    case 'ledger':
      return <Ledger app={app} onSaved={onSaved} />;
    case 'habit':
      return <Habit app={app} onSaved={onSaved} />;
    case 'quote':
      return <Quote app={app} onSaved={onSaved} />;
    case 'signup':
      return <Signup app={app} onSaved={onSaved} cap={20} />;
    default:
      return <pre className="json">{app.data_json}</pre>;
  }
}
