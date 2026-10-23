/**
 * dsh-cache-cleaner browser half.
 *
 * Registers one action beside Settings at the sidebar foot. Clicking it POSTs
 * to the Host route registered by index.js, which runs the shared cleaner in
 * lib/cleaner.js and returns one report; the result is shown in a small
 * popover anchored above the button.
 *
 * The factory stays side-effect free: the stylesheet renders inside the
 * component (so React removes it on unmount) and every registration happens
 * inside `apply` with its own disposer.
 */

window.__ModuleLoader__.load({
  id: 'dsh-pc-cache-cleaner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace registered on the Client locale service. */
    const NS = 'cache-cleaner';

    /** Host route registered by the Host half. */
    const RUN_ROUTE = '/cache-clean/run';

    const zh = {
      'action': '清理缓存',
      'hint': '一键清理电脑缓存（所有盘符的临时文件、更新缓存、缩略图、浏览器缓存、DNS）',
      'running': '清理中…',
      'done': '已释放 {size}',
      'failed': '清理失败',
      'offline': '无法连接宿主进程',
      'summary': '删除 {deleted} 项，跳过 {skipped} 项，耗时 {seconds} 秒',
      'drives': '扫描盘符：{list}',
      'close': '关闭',
    };

    const en = {
      'action': 'Clean cache',
      'hint': 'One-click PC cache cleaning (temp files, update cache, thumbnails, browser caches, DNS on every drive)',
      'running': 'Cleaning…',
      'done': 'Freed {size}',
      'failed': 'Cleaning failed',
      'offline': 'Cannot reach the host process',
      'summary': '{deleted} removed, {skipped} skipped, {seconds}s',
      'drives': 'Drives scanned: {list}',
      'close': 'Close',
    };

    /**
     * Theme tokens only; the `dcc-` prefix keeps the selectors ours. The rule
     * block renders as a React child, so unmounting removes it again.
     */
    const CSS = `
.dcc-wrap{position:relative;display:block;max-width:100%;height:42px;margin-top:8px}
.dcc-wrap.rail{height:36px;margin-top:0}
.dcc-btn{display:flex;align-items:center;gap:8px;width:100%;height:42px;padding:0 10px 0 8px;margin:0;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:20px;cursor:pointer;text-align:left}
.dcc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dcc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dcc-btn:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.dcc-btn.rail{justify-content:center;width:36px;height:36px;padding:0;gap:0;border-radius:50%}
.dcc-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dcc-spin{transform-origin:50% 50%;animation:dcc-rotate 900ms linear infinite}
@keyframes dcc-rotate{to{transform:rotate(360deg)}}
.dcc-pop{position:absolute;bottom:calc(100% + 8px);left:0;width:264px;padding:10px 12px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:1.6;text-align:left;z-index:40}
.dcc-pop.rail{left:8px}
.dcc-title{margin:0 18px 2px 0;font-size:12px;font-weight:600}
.dcc-title.ok{color:var(--dsw-alias-state-success-primary)}
.dcc-title.err{color:var(--dsw-alias-state-error-primary)}
.dcc-sub{margin:0;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dcc-sub.dcc-detail{color:var(--dsw-alias-label-tertiary)}
.dcc-close{position:absolute;top:4px;right:6px;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;cursor:pointer}
.dcc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`;

    /** Replace `{name}` placeholders without pulling in an i18n runtime. */
    function fill(text, values) {
      let out = String(text);
      for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(String(value));
      return out;
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${String(value)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let size = value / 1024;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size >= 100 ? String(Math.round(size)) : size.toFixed(1)} ${units[index]}`;
    }

    /** Small inline trash-and-sparkle mark; `currentColor` follows the theme. */
    function CleanerIcon({ size = 16 }) {
      const stroke = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { flex: 'none', display: 'block' } },
        h('path', { d: 'M4.5 7h15M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7', ...stroke }),
        h('path', { d: 'M6.4 7l.9 11.7A2.3 2.3 0 0 0 9.6 21h4.8a2.3 2.3 0 0 0 2.3-2.3L17.6 7', ...stroke }),
        h('path', { d: 'M10.2 11v5.6M13.8 11v5.6', ...stroke, opacity: 0.55 }),
        h('path', { d: 'M20.4 3.2l.55 1.5 1.5.55-1.5.55-.55 1.5-.55-1.5-1.5-.55 1.5-.55z', fill: 'currentColor', stroke: 'none' }),
      );
    }

    function Spinner() {
      return h('svg', { className: 'dcc-spin', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false', style: { flex: 'none', display: 'block' } },
        h('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.25 }),
        h('path', { d: 'M8 2a6 6 0 0 1 6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    /**
     * The sidebar action: icon + label (wide rail) and its result popover.
     * `t` is injected by the owner through the factory closure.
     */
    function CleanButton({ wide, t }) {
      const [phase, setPhase] = React.useState('idle');
      const [report, setReport] = React.useState(null);
      const [error, setError] = React.useState(null);
      const timer = React.useRef(null);
      const wrapRef = React.useRef(null);

      const clearTimer = () => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      };

      React.useEffect(() => clearTimer, []);

      // Dismiss the popover on a click anywhere outside it, like a host popup.
      React.useEffect(() => {
        if (report === null && error === null) return undefined;
        const onPointerDown = (event) => {
          const wrap = wrapRef.current;
          if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
            setReport(null);
            setError(null);
          }
        };
        document.addEventListener('mousedown', onPointerDown, true);
        return () => document.removeEventListener('mousedown', onPointerDown, true);
      }, [report, error]);

      const busy = phase === 'running';

      const run = async () => {
        if (busy) return;
        clearTimer();
        setError(null);
        setReport(null);
        setPhase('running');
        try {
          const response = await fetch(RUN_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const payload = await response.json();
          if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'clean failed');
          setReport(payload);
          setPhase('done');
          timer.current = setTimeout(() => {
            setReport(null);
            timer.current = null;
          }, 12_000);
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
          setPhase('error');
          timer.current = setTimeout(() => {
            setError(null);
            timer.current = null;
          }, 12_000);
        }
      };

      const open = report !== null || error !== null;
      const rows = report && Array.isArray(report.targets)
        ? report.targets.filter((row) => row.deleted > 0 || row.bytes > 0 || row.id === 'dns')
        : [];

      return h('div', { className: `dcc-wrap${wide === false ? ' rail' : ''}`, ref: wrapRef },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: `dcc-btn${wide === false ? ' rail' : ''}`,
          onClick: run,
          disabled: busy,
          title: busy ? t('running') : t('hint'),
          'aria-label': t('action'),
          'aria-busy': busy ? 'true' : 'false',
        },
          busy ? h(Spinner, null) : h(CleanerIcon, { size: wide === false ? 18 : 16 }),
          wide === false ? null : h('span', { className: 'dcc-label' }, busy ? t('running') : t('action')),
        ),
        open
          ? h('div', { className: `dcc-pop${wide === false ? ' rail' : ''}`, role: 'status' },
              h('button', {
                type: 'button',
                className: 'dcc-close',
                'aria-label': t('close'),
                onClick: () => { setReport(null); setError(null); },
              }, '×'),
              error !== null
                ? h(React.Fragment, null,
                    h('p', { className: 'dcc-title err' }, t('failed')),
                    h('p', { className: 'dcc-sub' }, error.includes('HTTP 5') || error.includes('HTTP 4') ? t('offline') : error),
                  )
                : h(React.Fragment, null,
                    h('p', { className: 'dcc-title ok' }, fill(t('done'), { size: formatBytes(report.freedBytes) })),
                    h('p', { className: 'dcc-sub' }, fill(t('summary'), {
                      deleted: report.filesDeleted,
                      skipped: report.filesSkipped,
                      seconds: (Number(report.durationMs) / 1000).toFixed(1),
                    })),
                    Array.isArray(report.drives) && report.drives.length > 0
                      ? h('p', { className: 'dcc-sub dcc-detail' }, fill(t('drives'), { list: report.drives.join('、') }))
                      : null,
                    rows.map((row) => h('p', { key: row.id, className: 'dcc-sub dcc-detail' },
                      row.id === 'dns'
                        ? `${row.name}：已刷新`
                        : `${row.name}：${formatBytes(row.bytes)}${row.skipped > 0 ? `（跳过 ${String(row.skipped)}）` : ''}`,
                    )),
                  ),
            )
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cache-cleaner: locale dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'cache-cleaner',
          order: 100,
          label: () => t('action'),
        }, (props) => h(CleanButton, { ...props, t }))), 'cache-cleaner: sidebar footer action');
      },
    };
  },
});
