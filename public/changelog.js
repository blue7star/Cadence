/* ==========================================================================
   Cadence · 版本号与更新记录
   数据源：/api/version（当前版本 + 本次更新）、/api/changelog（历次全部）
   两端都来自 version.js —— 这里是渲染，不保存任何更新文案。

   行为：
   - 顶栏版本号常驻，点开看历次更新；
   - 首次访问只记录版本不打扰；版本变了才自动弹一次，点「知道了」写回；
   - 接口拿不到就静默隐藏，不影响任何业务功能。
   ========================================================================== */
'use strict';
(function () {
  var SEEN_KEY = 'cadence_seen_version';
  var META = null;
  var HISTORY = null;
  var hovering = 'current';   // 弹窗当前显示：current | history
  var overlay = null;

  /* ---------- 小工具 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function readSeen() { try { return localStorage.getItem(SEEN_KEY); } catch (e) { return null; } }
  function writeSeen(v) { try { localStorage.setItem(SEEN_KEY, v); } catch (e) { /* 存不进也不影响使用 */ } }

  /* ---------- 样式（贴着现有设计变量，不额外引主题） ---------- */
  function ensureStyles() {
    if (document.getElementById('cv-style')) return;
    var css = [
      '.cv-chip{border:1px solid var(--line);background:#f8fafc;color:var(--ink3);border-radius:20px;',
      'padding:2px 9px;font-size:11.5px;cursor:pointer;line-height:1.6;font-family:inherit;transition:.12s}',
      '.cv-chip:hover{border-color:#c7d2e4;color:var(--accent);background:#f1f6ff}',
      '.cv-chip[hidden]{display:none}',

      '.cv-overlay{position:fixed;inset:0;z-index:9990;display:grid;place-items:center;padding:20px;',
      'background:rgba(16,24,40,.42);animation:cv-fade .16s ease-out}',
      '@keyframes cv-fade{from{opacity:0}to{opacity:1}}',
      '.cv-card{width:560px;max-width:100%;max-height:86vh;display:flex;flex-direction:column;background:var(--panel);',
      'border-radius:14px;box-shadow:0 20px 60px rgba(16,24,40,.28);overflow:hidden}',
      '.cv-head{padding:16px 20px 13px;border-bottom:1px solid var(--line);background:#fbfcfe}',
      '.cv-title{font-size:15px;font-weight:600;color:var(--ink);line-height:1.5;display:flex;align-items:center;gap:8px}',
      '.cv-badge{flex:0 0 auto;background:var(--accent);color:#fff;border-radius:20px;font-size:12px;font-weight:600;padding:1px 9px}',
      '.cv-date{margin-top:5px;font-size:11.5px;color:var(--ink3)}',
      '.cv-body{padding:14px 20px 6px;overflow-y:auto;flex:1}',
      '.cv-group{margin-bottom:13px}',
      '.cv-group-t{font-size:11.5px;font-weight:600;color:var(--ink2);letter-spacing:.4px;margin-bottom:5px}',
      '.cv-list{margin:0;padding:0 0 0 17px}',
      '.cv-list li{font-size:13px;line-height:1.68;color:var(--ink2);margin-bottom:3px}',
      '.cv-list li::marker{color:#9fb0cd}',
      '.cv-ver{padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--line2)}',
      '.cv-ver:last-child{border-bottom:0;margin-bottom:2px}',
      '.cv-ver-h{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--ink)}',
      '.cv-ver-d{font-size:11.5px;color:var(--ink3);margin:3px 0 8px}',
      '.cv-ver-sub{font-size:12.5px;color:var(--ink2);margin-bottom:8px}',
      '.cv-foot{padding:12px 20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;background:#fbfcfe}',
      '.cv-link{border:0;background:none;color:var(--accent);font-size:12px;cursor:pointer;padding:4px 0;font-family:inherit}',
      '.cv-link:hover{text-decoration:underline}',
      '.cv-empty{font-size:12.5px;color:var(--ink3);padding:10px 0}',
      '@media (max-width:560px){.cv-card{max-height:90vh}.cv-head,.cv-body,.cv-foot{padding-left:15px;padding-right:15px}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'cv-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 渲染 ---------- */
  function groupBlock(group) {
    var box = el('div', 'cv-group');
    box.appendChild(el('div', 'cv-group-t', group.group || ''));
    var ul = el('ul', 'cv-list');
    (Array.isArray(group.lines) ? group.lines : []).forEach(function (l) { ul.appendChild(el('li', null, l)); });
    box.appendChild(ul);
    return box;
  }

  /** 本次更新（单个版本）。 */
  function renderCurrent(entry) {
    var body = el('div', 'cv-body');
    if (!entry || !Array.isArray(entry.items) || !entry.items.length) {
      body.appendChild(el('div', 'cv-empty', '这个版本没有登记更新内容。'));
      return body;
    }
    entry.items.forEach(function (g) { body.appendChild(groupBlock(g)); });
    return body;
  }

  /** 历次更新（全部版本倒序，当前版本打徽章）。versions 为 null 表示还在取。 */
  function renderHistory(versions) {
    var body = el('div', 'cv-body');
    if (!versions) {
      body.appendChild(el('div', 'cv-empty', '正在读取更新记录…'));
      return body;
    }
    if (!versions.length) {
      body.appendChild(el('div', 'cv-empty', '暂时没有历史记录。'));
      return body;
    }
    versions.forEach(function (v) {
      var box = el('div', 'cv-ver');
      var h = el('div', 'cv-ver-h');
      h.appendChild(el('span', null, 'v' + v.version));
      if (META && v.version === META.semver) h.appendChild(el('span', 'cv-badge', '当前'));
      box.appendChild(h);
      box.appendChild(el('div', 'cv-ver-d', v.date || ''));
      if (v.title) box.appendChild(el('div', 'cv-ver-sub', v.title));
      (Array.isArray(v.items) ? v.items : []).forEach(function (g) { box.appendChild(groupBlock(g)); });
      body.appendChild(box);
    });
    return body;
  }

  /* ---------- 弹窗 ---------- */
  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function paint() {
    var card = overlay.querySelector('.cv-card');
    var entry = META && META.changelog;
    card.innerHTML = '';

    var head = el('div', 'cv-head');
    var title = el('div', 'cv-title');
    if (hovering === 'current' && META) {
      title.appendChild(el('span', 'cv-badge', 'v' + META.semver));
      title.appendChild(el('span', null, (entry && entry.title) || '版本更新'));
    } else {
      title.appendChild(el('span', null, '历次更新记录'));
    }
    head.appendChild(title);
    var sub = el('div', 'cv-date',
      hovering === 'current'
        ? ((entry && entry.date) ? '发布日期：' + entry.date : '')
        : ('当前版本 v' + (META ? META.semver : '—')));
    head.appendChild(sub);
    card.appendChild(head);

    card.appendChild(hovering === 'current' ? renderCurrent(entry) : renderHistory(HISTORY));

    var foot = el('div', 'cv-foot');
    var left = el('button', 'cv-link', hovering === 'current' ? '查看历次更新' : '← 回到本次更新');
    left.addEventListener('click', function () { hovering = hovering === 'current' ? 'history' : 'current'; paint(); });
    foot.appendChild(left);

    var ok = el('button', 'btn primary', '知道了');
    ok.addEventListener('click', function () {
      if (META) writeSeen(META.semver);   // 看过就不再自动弹
      close();
    });
    foot.appendChild(ok);
    card.appendChild(foot);
  }

  /** 打开弹窗。mode：current（本次更新）| history（历次） */
  function open(mode) {
    ensureStyles();
    if (overlay) { hovering = mode; paint(); return; }
    hovering = mode;
    overlay = el('div', 'cv-overlay');
    overlay.appendChild(el('div', 'cv-card'));
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    paint();

    if (mode === 'history' && !HISTORY) {
      fetch('/api/changelog').then(function (r) { return r.json(); }).then(function (d) {
        HISTORY = (d && Array.isArray(d.versions)) ? d.versions : [];
        if (overlay && hovering === 'history') paint();
      }).catch(function () {
        HISTORY = [];
        if (overlay && hovering === 'history') paint();
      });
    }
  }

  /* ---------- 顶栏版本号 ---------- */
  function mountChip(semver) {
    var chip = document.getElementById('appVer');
    if (!chip) return;
    chip.textContent = 'v' + semver;
    chip.title = '查看更新记录';
    chip.hidden = false;
    chip.addEventListener('click', function () { open('history'); });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    fetch('/api/version')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.semver) return;
        META = { semver: d.semver, version: d.version, changelog: d.changelog || null };
        mountChip(d.semver);

        var seen = readSeen();
        if (seen === null) { writeSeen(d.semver); return; }   // 第一次用：不打扰
        if (seen !== d.semver && META.changelog) open('current');
      })
      .catch(function () { /* 版本接口挂了不影响工作台使用 */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供页面其他地方主动打开历次更新（如设置页）
  window.cadenceChangelog = { open: function () { open('history'); } };
})();
