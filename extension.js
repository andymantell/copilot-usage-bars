const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { calendarHtml } = require('./calendarHtml');

const BAR_WIDTH = 10;
const HOLIDAY_TTL_MS = 7 * 24 * 3600 * 1000;
const MIN_REFRESH_MS = 60_000;
const NON_BUDGET_KEYS = new Set(['chat', 'completions']);

function bar(frac) {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * BAR_WIDTH);
  return '▰'.repeat(n) + '▱'.repeat(BAR_WIDTH - n);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isWorkingDay(d, holidays) {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6 && !holidays.has(ymd(d));
}

// Counts today if it is a working day.
function workingDaysLeft(now, holidays) {
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  let n = 0;
  for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d <= end; d.setDate(d.getDate() + 1)) {
    if (isWorkingDay(d, holidays)) n++;
  }
  return n;
}

const fmt = (n) => Math.round(n).toLocaleString('en-GB');

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Hue sweeps green (120) to red (0) as frac goes 0 to 1.
const pastel = (frac) => hslToHex(120 * (1 - Math.max(0, Math.min(1, frac))), 55, 78);

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : undefined;
}

// Accepts "YYYY-MM-DD" or "YYYY-MM-DD/YYYY-MM-DD"; returns [] if invalid.
function expandEntry(entry) {
  const [a, b = a] = String(entry).split('/').map((s) => s.trim());
  const start = parseDate(a);
  const end = parseDate(b);
  if (!start || !end || end < start) return [];
  const days = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  return days;
}

function activate(context) {
  const cfg = () => vscode.workspace.getConfiguration('copilotUsageBars');
  const out = vscode.window.createOutputChannel('Copilot Usage Bars');
  const monthItem = vscode.window.createStatusBarItem('copilotUsageBars.month', vscode.StatusBarAlignment.Right, 100001);
  const dayItem = vscode.window.createStatusBarItem('copilotUsageBars.day', vscode.StatusBarAlignment.Right, 100000);
  monthItem.name = 'Copilot monthly usage';
  dayItem.name = 'Copilot daily limit';
  monthItem.command = dayItem.command = 'copilotUsageBars.refresh';
  context.subscriptions.push(out, monthItem, dayItem);

  monthItem.text = 'Monthly usage …';
  dayItem.text = 'Daily limit …';
  monthItem.show();
  dayItem.show();

  let busy = false;
  let lastRun = 0;
  let pending;
  context.subscriptions.push({ dispose: () => clearTimeout(pending) });

  async function bankHolidays() {
    const region = cfg().get('bankHolidayRegion');
    let data = context.globalState.get('bankHolidays');
    if (!data || Date.now() - data.at > HOLIDAY_TTL_MS) {
      try {
        const r = await fetch('https://www.gov.uk/bank-holidays.json');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const byRegion = {};
        for (const [k, v] of Object.entries(j)) byRegion[k] = v.events.map((e) => e.date);
        data = { at: Date.now(), byRegion };
        await context.globalState.update('bankHolidays', data);
      } catch (e) {
        out.appendLine(`bank holiday fetch failed: ${e.message}${data ? ' (using stale cache)' : ''}`);
      }
    }
    return data?.byRegion?.[region] ?? [];
  }

  function extraOffDays() {
    return (cfg().get('extraDaysOff') ?? []).flatMap(expandEntry);
  }

  async function holidaySet() {
    return new Set([...(await bankHolidays()), ...extraOffDays()]);
  }

  async function toggleDay(date) {
    if (!parseDate(date) || date < ymd(new Date())) return;
    const list = cfg().get('extraDaysOff') ?? [];
    const invalid = list.filter((e) => !expandEntry(e).length);
    const set = new Set(extraOffDays());
    if (!set.delete(date)) set.add(date);
    const ranges = [];
    for (const d of [...set].sort()) {
      const last = ranges[ranges.length - 1];
      const next = last && parseDate(last.end);
      if (next) next.setDate(next.getDate() + 1);
      if (next && ymd(next) === d) last.end = d;
      else ranges.push({ start: d, end: d });
    }
    const entries = ranges.map((r) => (r.start === r.end ? r.start : `${r.start}/${r.end}`));
    await cfg().update('extraDaysOff', [...invalid, ...entries], vscode.ConfigurationTarget.Global);
  }

  let calendarPanel;
  function openCalendar() {
    if (calendarPanel) {
      calendarPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('copilotUsageBarsCalendar', 'Copilot Days Off', vscode.ViewColumn.Active, { enableScripts: true });
    calendarPanel = panel;
    panel.webview.html = calendarHtml(randomBytes(16).toString('hex'));
    const post = async () =>
      panel.webview.postMessage({ type: 'state', today: ymd(new Date()), bank: await bankHolidays(), off: extraOffDays() });
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotUsageBars.extraDaysOff')) post();
    });
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') post();
      else if (m.type === 'toggle') toggleDay(m.date);
    });
    panel.onDidDispose(() => {
      cfgSub.dispose();
      calendarPanel = undefined;
    });
  }

  async function pruneDaysOff() {
    const list = cfg().get('extraDaysOff') ?? [];
    const today = ymd(new Date());
    // Unparseable entries are kept so they stay visible in settings.
    const kept = list.filter((e) => {
      const days = expandEntry(e);
      return !days.length || days[days.length - 1] >= today;
    });
    if (kept.length !== list.length) {
      await cfg().update('extraDaysOff', kept, vscode.ConfigurationTarget.Global);
    }
  }

  async function addDaysOff() {
    const v = await vscode.window.showInputBox({
      prompt: 'Day off (YYYY-MM-DD) or range (YYYY-MM-DD/YYYY-MM-DD)',
      placeHolder: ymd(new Date()),
      validateInput: (t) => (expandEntry(t).length ? undefined : 'Use YYYY-MM-DD or START/END, END on or after START'),
    });
    if (!v) return;
    const entry = v.split('/').map((s) => s.trim()).join('/');
    const list = cfg().get('extraDaysOff') ?? [];
    if (list.includes(entry)) return;
    await cfg().update('extraDaysOff', [...list, entry].sort(), vscode.ConfigurationTarget.Global);
  }

  async function removeDaysOff() {
    const list = cfg().get('extraDaysOff') ?? [];
    if (!list.length) {
      vscode.window.showInformationMessage('No extra days off registered.');
      return;
    }
    const picked = await vscode.window.showQuickPick(list, { canPickMany: true, placeHolder: 'Select entries to remove' });
    if (!picked?.length) return;
    await cfg().update('extraDaysOff', list.filter((x) => !picked.includes(x)), vscode.ConfigurationTarget.Global);
  }

  async function getToken(interactive) {
    const session = await vscode.authentication.getSession(
      'github',
      cfg().get('githubScopes'),
      interactive ? { createIfNone: true } : { silent: true }
    );
    return session?.accessToken;
  }

  function pickSnapshot(data) {
    const snaps = data.quota_snapshots ?? {};
    const key = cfg().get('quotaKey');
    if (snaps[key]) return [key, snaps[key]];
    for (const [k, v] of Object.entries(snaps)) {
      if (!NON_BUDGET_KEYS.has(k) && v && !v.unlimited) return [k, v];
    }
    return [undefined, undefined];
  }

  function showError(text, tip) {
    for (const it of [monthItem, dayItem]) {
      it.text = text;
      it.tooltip = tip;
      it.backgroundColor = undefined;
      it.color = undefined;
    }
    monthItem.show();
    dayItem.hide();
  }

  async function refresh(interactive = false) {
    if (busy) return;
    const wait = MIN_REFRESH_MS - (Date.now() - lastRun);
    if (!interactive && wait > 0) {
      // Coalesce everything inside the cooldown into one refresh when it ends.
      pending ??= setTimeout(() => {
        pending = undefined;
        refresh(false);
      }, wait);
      return;
    }
    busy = true;
    lastRun = Date.now();
    try {
      const token = await getToken(interactive);
      if (!token) {
        showError('$(sign-in) Copilot usage', 'Click to sign in to GitHub');
        monthItem.command = 'copilotUsageBars.signIn';
        return;
      }
      monthItem.command = 'copilotUsageBars.refresh';

      const r = await fetch('https://api.github.com/copilot_internal/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'copilot-usage-bars' },
      });
      if (!r.ok) throw new Error(`copilot_internal/user returned HTTP ${r.status}`);
      const data = await r.json();
      out.appendLine(
        `${new Date().toISOString()} ${JSON.stringify({
          copilot_plan: data.copilot_plan,
          token_based_billing: data.token_based_billing,
          quota_reset_date: data.quota_reset_date,
          quota_snapshots: data.quota_snapshots,
        })}`
      );

      const [key, snap] = pickSnapshot(data);
      if (!snap) throw new Error('No limited quota snapshot in response; see log for available keys');

      const hasEntitlement = typeof snap.entitlement === 'number' && snap.entitlement > 0;
      const total = hasEntitlement ? snap.entitlement : 100;
      // `remaining`/`percent_remaining` lag behind `credits_used`, so prefer the latter.
      const remaining = hasEntitlement && typeof snap.credits_used === 'number' ? total - snap.credits_used
        : typeof snap.remaining === 'number' ? snap.remaining
        : typeof snap.percent_remaining === 'number' ? (snap.percent_remaining / 100) * total
        : undefined;
      if (remaining === undefined) throw new Error(`Snapshot "${key}" has no remaining/percent_remaining`);
      const unit = hasEntitlement ? '' : '%';
      const used = total - remaining;

      monthItem.text = `Monthly usage ${bar(used / total)} ${Math.round((used / total) * 100)}%`;
      monthItem.tooltip = new vscode.MarkdownString(
        `**Monthly Copilot usage**\n\n${fmt(used)}${unit} of ${fmt(total)}${unit} used, ${fmt(remaining)}${unit} left` +
          (data.quota_reset_date ? `\n\nResets ${data.quota_reset_date}` : '')
      );
      monthItem.backgroundColor = remaining <= 0 ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      monthItem.show();

      const now = new Date();
      const today = ymd(now);
      let base = context.globalState.get('dayBaseline');
      const last = context.globalState.get('lastReading');
      if (!base || base.date !== today) {
        // Yesterday's final reading is the true start of today; fall back to now on first ever run.
        const start = last && last.remaining >= remaining ? last.remaining : remaining;
        base = { date: today, remaining: start };
        await context.globalState.update('dayBaseline', base);
      } else if (remaining > base.remaining) {
        base = { date: today, remaining };
        await context.globalState.update('dayBaseline', base);
      }
      await context.globalState.update('lastReading', { date: today, remaining });
      await pruneDaysOff();
      const holidays = await holidaySet();
      const daysLeft = workingDaysLeft(now, holidays);
      const workingToday = isWorkingDay(now, holidays);
      const budget = Math.max(base.remaining, 0) / Math.max(daysLeft, 1);
      const usedToday = Math.max(0, base.remaining - remaining);
      const frac = budget > 0 ? usedToday / budget : usedToday > 0 ? 1 : 0;

      dayItem.text = `Daily limit ${bar(frac)} ${Math.round(frac * 100)}% (${fmt(usedToday)}${unit} / ${fmt(budget)}${unit})`;
      dayItem.tooltip = new vscode.MarkdownString(
        `**Daily limit**\n\n${fmt(usedToday)}${unit} used today of a ${fmt(budget)}${unit} budget\n\n` +
          `Start-of-day remaining ${fmt(base.remaining)}${unit} / ${daysLeft} working day${daysLeft === 1 ? '' : 's'} left` +
          `${workingToday ? ' (incl. today)' : ' (today is a rest day)'}\n\n` +
          `Baseline is the first reading seen each day, so usage before VS Code started is not counted.`
      );
      dayItem.backgroundColor = frac > 1 ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      // Over budget: drop the pastel so the theme's error foreground stays legible.
      dayItem.color = frac > 1 ? undefined : pastel(frac);
      dayItem.show();
    } catch (e) {
      out.appendLine(`refresh failed: ${e.stack ?? e.message}`);
      showError('$(warning) Copilot usage', `${e.message}\n\nSee "Copilot Usage Bars: Show Log"`);
    } finally {
      busy = false;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotUsageBars.refresh', () => refresh(false)),
    vscode.commands.registerCommand('copilotUsageBars.signIn', () => refresh(true)),
    vscode.commands.registerCommand('copilotUsageBars.showLog', () => out.show()),
    vscode.commands.registerCommand('copilotUsageBars.addDaysOff', addDaysOff),
    vscode.commands.registerCommand('copilotUsageBars.removeDaysOff', removeDaysOff),
    vscode.commands.registerCommand('copilotUsageBars.openCalendar', openCalendar),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && Date.now() - lastRun > 60_000) refresh(false);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotUsageBars')) refresh(false);
    })
  );

  // VS Code rewrites a chat's transcript under chatSessions/ after each turn; refresh once writes settle.
  const storageRoot = path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'workspaceStorage');
  let settle;
  try {
    const watcher = fs.watch(storageRoot, { recursive: true }, (_evt, file) => {
      if (!file || !String(file).includes('chatSessions')) return;
      clearTimeout(settle);
      settle = setTimeout(() => refresh(false), 8_000);
    });
    context.subscriptions.push({ dispose: () => { watcher.close(); clearTimeout(settle); } });
  } catch (e) {
    out.appendLine(`chat activity watch failed: ${e.message}`);
  }

  const timer = setInterval(() => refresh(false), Math.max(1, cfg().get('refreshMinutes')) * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  refresh(false);
}

function deactivate() {}

module.exports = { activate, deactivate };
