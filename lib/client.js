// dsh-reboot-lights — client 半身。
//
// 经典脚本信封：本文件会被原样注入页面，禁止出现 import/export 语句。
//
// 职责（M1/M2）：
//   1. 在 shell.overlay 挂一个右下角悬浮红绿灯
//   2. 轮询 host 的 /api/reboot-lights/state 拿聚合结果
//   3. 三态：红=不能重启；黄=需等待/退出后需手动操作；绿=可直接重启
//   4. 点击灯展开面板，列出每个会话的裁决与理由，含「重新检测」按钮
//
// 关键：shell.overlay 容器 CSS 是 pointer-events:none + 直接子元素 auto，
// 所以组件根元素必须紧贴灯体本身，不能包全屏 inset:0 的 div。

window.__ModuleLoader__.load({
  id: 'dsh-reboot-lights',
  factory: function (require) {
    var React = require('react');

    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var h = React.createElement;

    var STATE_URL = '/api/reboot-lights/state';
    var DETECT_URL = '/api/reboot-lights/detect';
    var POLL_MS = 4000;

    // 三色。红绿用语义色，黄用琥珀色——都是「状态」而非「品牌」，
    // 所以可以用字面色，但仍从主题取背景/文字/边框保证明暗适配。
    var COLORS = {
      red: '#f85149',
      yellow: '#d29922',
      green: '#3fb950',
      unknown: '#8b949e',
    };

    var CSS = [
      '.rbl-root{position:absolute;right:16px;bottom:16px;z-index:1;',
      '  display:flex;flex-direction:column;align-items:flex-end;gap:8px;',
      '  font-family:inherit;}',
      '.rbl-light{width:14px;height:14px;border-radius:50%;cursor:pointer;',
      '  border:1px solid rgba(128,128,128,.35);padding:0;',
      '  transition:box-shadow .15s ease, transform .15s ease;}',
      '.rbl-light:hover{transform:scale(1.15);}',
      '.rbl-light:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4f8ef7);outline-offset:2px;}',
      '.rbl-panel{width:308px;max-height:min(60vh,440px);overflow:auto;',
      '  border:1px solid var(--dsw-alias-border-l1,#ffffff1f);',
      '  border-radius:10px;',
      '  background:var(--dsw-alias-bg-layer-2,#171b22);',
      '  box-shadow:0 8px 24px rgba(0,0,0,.4);',
      '  color:var(--dsw-alias-label-primary,#e6e8eb);',
      '  font-size:12px;line-height:1.55;',
      '  display:flex;flex-direction:column;gap:10px;padding:12px 14px;}',
      '.rbl-head{display:flex;align-items:center;gap:8px;}',
      '.rbl-dot{width:9px;height:9px;border-radius:50%;flex:none;}',
      '.rbl-title{font-weight:650;font-size:12.5px;flex:1;min-width:0;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rbl-close{flex:none;border:none;background:none;cursor:pointer;',
      '  color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:13px;padding:0 2px;line-height:1;}',
      '.rbl-close:hover{color:var(--dsw-alias-label-primary,#e6e8eb);}',
      '.rbl-summary{color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11.5px;}',
      '.rbl-actions{display:flex;gap:8px;}',
      '.rbl-btn{flex:1;border-radius:999px;cursor:pointer;font:inherit;font-size:11.5px;',
      '  font-weight:600;padding:5px 12px;',
      '  border:1px solid var(--dsw-alias-state-accent-primary,#4f8ef7);',
      '  color:var(--dsw-alias-state-accent-primary,#4f8ef7);background:transparent;}',
      '.rbl-btn:hover{background:rgba(79,142,247,.14);}',
      '.rbl-btn:disabled{opacity:.5;cursor:default;background:transparent;}',
      '.rbl-list{display:flex;flex-direction:column;gap:7px;}',
      '.rbl-item{border:1px solid var(--dsw-alias-border-l1,#ffffff1f);',
      '  border-radius:8px;padding:7px 9px;',
      '  display:flex;flex-direction:column;gap:3px;}',
      '.rbl-itemHead{display:flex;align-items:center;gap:6px;}',
      '.rbl-itemTitle{flex:1;min-width:0;font-weight:600;font-size:11.5px;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rbl-tag{flex:none;font-size:10px;font-weight:700;letter-spacing:.03em;',
      '  padding:0 6px;border-radius:999px;border:1px solid currentColor;}',
      '.rbl-reason{color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11px;}',
      '.rbl-steps{margin:2px 0 0;padding-left:16px;',
      '  color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11px;}',
      '.rbl-steps li{margin:1px 0;}',
      '.rbl-empty{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11.5px;}',
      '.rbl-hint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;}',
    ].join('\n');

    var LABELS = {
      red: '不可重启',
      yellow: '需等待',
      green: '可重启',
    };

    function shortTitle(report) {
      if (report && typeof report.title === 'string' && report.title) return report.title;
      var sid = (report && report.sessionId) || 'unknown';
      return sid.length > 18 ? sid.slice(0, 16) + '…' : sid;
    }

    /**
     * 把 sessions byId 快照行渲染成「工作区名 · 会话名」。
     * cwd 末段 = 工作区名；displayTitle = 会话名；拿不到返回 ''（调用方回退 shortTitle）。
     */
    function displayLabel(row) {
      if (!row) return '';
      var workspace = '';
      if (typeof row.cwd === 'string' && row.cwd) {
        var parts = row.cwd.split('/').filter(Boolean);
        workspace = parts[parts.length - 1] || '';
      }
      var name = (typeof row.displayTitle === 'string' && row.displayTitle) ? row.displayTitle : '';
      if (workspace && name) return workspace + ' · ' + name;
      return workspace || name;
    }

    /** 把 host 返回的 JSON 规整成组件好用的形状。 */
    function normalize(payload) {
      if (!payload || typeof payload !== 'object') return null;
      var light = payload.light;
      if (light !== 'red' && light !== 'yellow' && light !== 'green') light = 'unknown';
      var items = Array.isArray(payload.items) ? payload.items : [];
      var counts = payload.counts || {};
      return {
        light: light,
        items: items,
        counts: {
          red: counts.red | 0,
          yellow: counts.yellow | 0,
          green: counts.green | 0,
          awaiting: counts.awaiting | 0,
        },
      };
    }

    function TrafficLight(props) {
      // sessions.list 是 createSnapshotStore（响应式快照存储）：直接读
      // .phase/.byId 拿到的是内部初始值（恒 pending/空），必须走
      // getSnapshot()。每次轮询 setState 重渲染时重新取，标题即会显示。
      var sessionsStore = props && props.sessions;
      var sessionsList = (sessionsStore && sessionsStore.list && typeof sessionsStore.list.getSnapshot === 'function')
        ? sessionsStore.list.getSnapshot()
        : null;
      var byId = (sessionsList && sessionsList.phase === 'ready' && sessionsList.byId) || {};

      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      var stateState = useState(null);
      var state = stateState[0];
      var setState = stateState[1];

      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var load = useCallback(function () {
        return fetch(STATE_URL, { credentials: 'include', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(function (json) { setState(normalize(json)); setError(null); })
          .catch(function (e) { setError(e && e.message ? e.message : String(e)); });
      }, []);

      // 轮询。面板展开时加速，收起时慢速。
      useEffect(function () {
        load();
        var timer = setInterval(load, open ? 1500 : POLL_MS);
        return function () { clearInterval(timer); };
      }, [load, open]);

      var detect = useCallback(function () {
        setBusy(true);
        fetch(DETECT_URL, { method: 'POST', credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(function () { return load(); })
          .catch(function (e) { setError(e && e.message ? e.message : String(e)); })
          .then(function () { setBusy(false); });
      }, [load]);

      // Esc 关闭面板
      useEffect(function () {
        if (!open) return undefined;
        var onKey = function (e) { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, [open]);

      var light = state ? state.light : 'unknown';
      var color = COLORS[light] || COLORS.unknown;
      var counts = state ? state.counts : { red: 0, yellow: 0, green: 0, awaiting: 0 };

      var summary = light === 'red'
        ? '有 ' + counts.red + ' 个会话不能中断'
        : light === 'green'
          ? '全部 ' + counts.green + ' 个会话都可以中断'
          : light === 'yellow'
            ? '有会话需等待（黄 ' + counts.yellow + ' / 未回 ' + counts.awaiting + '）'
            : '尚未检测';

      // 根元素紧贴灯体；面板作为兄弟节点挂在同一 flex 列里。
      return h('div', { className: 'rbl-root' },
        open && h('div', { className: 'rbl-panel', role: 'dialog', 'aria-label': '重启安全检测' },
          h('div', { className: 'rbl-head' },
            h('span', { className: 'rbl-dot', style: { background: color } }),
            h('span', { className: 'rbl-title' }, '重启安全检测'),
            h('button', {
              type: 'button', className: 'rbl-close', 'aria-label': '关闭',
              onClick: function () { setOpen(false); },
            }, '✕'),
          ),
          h('div', { className: 'rbl-summary' }, summary),
          h('div', { className: 'rbl-actions' },
            h('button', {
              type: 'button', className: 'rbl-btn', disabled: busy,
              onClick: detect,
            }, busy ? '检测中…' : '重新检测'),
          ),
          error && h('div', { className: 'rbl-hint' }, '读取失败：' + error),
          h('div', { className: 'rbl-list' },
            state && state.items.length > 0
              ? state.items.map(function (report) {
                  var c = COLORS[report.light] || COLORS.unknown;
                  return h('div', { className: 'rbl-item', key: report.sessionId },
                    h('div', { className: 'rbl-itemHead' },
                      h('span', { className: 'rbl-dot', style: { background: c } }),
                      h('span', { className: 'rbl-itemTitle', title: report.sessionId },
                        displayLabel(byId[report.sessionId]) || shortTitle(report)),
                      h('span', { className: 'rbl-tag', style: { color: c } },
                        LABELS[report.light] || report.light),
                    ),
                    report.reason && h('div', { className: 'rbl-reason' }, report.reason),
                    report.light === 'yellow' && Array.isArray(report.manualSteps) && report.manualSteps.length > 0
                      ? h('ol', { className: 'rbl-steps' },
                          report.manualSteps.map(function (step, i) {
                            return h('li', { key: i }, step);
                          }))
                      : null,
                  );
                })
              : h('div', { className: 'rbl-empty' }, '还没有会话上报。点「重新检测」让各会话判断一次。'),
          ),
        ),
        h('button', {
          type: 'button',
          className: 'rbl-light',
          'aria-label': '重启安全检测：' + (LABELS[light] || '未知'),
          title: '重启安全检测：' + summary,
          style: {
            background: color,
            boxShadow: '0 0 0 3px ' + color + '2e, 0 2px 8px rgba(0,0,0,.35)',
          },
          onClick: function () { setOpen(function (v) { return !v; }); },
        }),
      );
    }

    return {
      inject: ['slots', 'sessions'],
      apply: function (ctx) {
        ctx.effect(function () {
          var style = document.createElement('style');
          style.setAttribute('data-dsh-plugin', 'dsh-reboot-lights');
          style.textContent = CSS;
          document.head.appendChild(style);
          return function () { style.remove(); };
        }, 'reboot-lights: styles');

        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-reboot-lights', order: 100 },
            function () {
              // 渲染时才取 sessions 快照（apply 早期可能尚未就绪）；
              // 面板轮询触发重渲染时会拿到更新的 byId。
              return TrafficLight({ sessions: ctx.get('sessions') });
            }
          );
        });

        console.log('[reboot-lights] client active (M1/M2: poll + traffic light + panel)');
      },
    };
  },
});
