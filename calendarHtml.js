function calendarHtml(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  .nav { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  #title { min-width: 11em; text-align: center; font-size: 1.2em; }
  #grid { display: grid; grid-template-columns: repeat(7, 3em); gap: 4px; }
  .h { text-align: center; opacity: 0.6; font-size: 0.85em; }
  button { font: inherit; color: inherit; background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; border-radius: 4px; padding: 6px 0; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { cursor: default; opacity: 0.4; }
  #grid button.off { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
  #grid button.today { border-color: var(--vscode-focusBorder); }
  #grid button.weekend, #grid button.bank { background: transparent; }
  .legend { margin-top: 14px; opacity: 0.7; font-size: 0.85em; }
</style>
</head>
<body>
  <div class="nav">
    <button id="prev">&lt;</button>
    <div id="title"></div>
    <button id="next">&gt;</button>
    <button id="now">Today</button>
  </div>
  <div id="grid"></div>
  <div class="legend">Click a working day to toggle it as a day off. Weekends, bank holidays and past days are not selectable.</div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  let st = { today: '', bank: new Set(), off: new Set() };
  let view = new Date();
  view.setDate(1);
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const title = document.getElementById('title');
  const grid = document.getElementById('grid');

  function render() {
    title.textContent = view.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    grid.replaceChildren();
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((n) => {
      const h = document.createElement('div');
      h.className = 'h';
      h.textContent = n;
      grid.appendChild(h);
    });
    const lead = (view.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('div'));
    const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    for (let n = 1; n <= count; n++) {
      const d = new Date(view.getFullYear(), view.getMonth(), n);
      const k = key(d);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const bank = st.bank.has(k);
      const b = document.createElement('button');
      b.textContent = n;
      if (weekend) b.classList.add('weekend');
      if (bank) { b.classList.add('bank'); b.title = 'Bank holiday'; }
      if (st.off.has(k)) b.classList.add('off');
      if (k === st.today) b.classList.add('today');
      if (weekend || bank || k < st.today) b.disabled = true;
      else b.onclick = () => api.postMessage({ type: 'toggle', date: k });
      grid.appendChild(b);
    }
  }

  document.getElementById('prev').onclick = () => { view.setMonth(view.getMonth() - 1); render(); };
  document.getElementById('next').onclick = () => { view.setMonth(view.getMonth() + 1); render(); };
  document.getElementById('now').onclick = () => { view = new Date(); view.setDate(1); render(); };

  window.addEventListener('message', (e) => {
    if (e.data.type !== 'state') return;
    st = { today: e.data.today, bank: new Set(e.data.bank), off: new Set(e.data.off) };
    render();
  });
  api.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { calendarHtml };
