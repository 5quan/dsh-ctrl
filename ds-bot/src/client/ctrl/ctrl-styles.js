// Styles for dsh-ctrl P3-1 panels (dshMemory panel, "Needs Attention" inbox,
// and Ticket usage attribution card). Strictly uses --bt-* variables and allowed RADII.
export const CTRL_CSS = `
.bt-ctrl-inbox-wrap{padding:2px 8px 6px}
.bt-side.bt-rail .bt-ctrl-inbox-wrap{display:flex;justify-content:center;padding:4px 0 2px}
.bt-ctrl-inbox-pill{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;padding:0 10px;border:.5px solid color-mix(in srgb,var(--bt-accent) 32%,var(--bt-line-2));border-radius:10px;background:color-mix(in srgb,var(--bt-accent) 10%,var(--bt-card));color:var(--bt-ink);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;box-sizing:border-box;transition:background-color .12s ease}
.bt-ctrl-inbox-pill:hover{background:color-mix(in srgb,var(--bt-accent) 16%,var(--bt-card))}
.bt-ctrl-inbox-pill[data-rail]{width:36px;height:28px;padding:0;justify-content:center;border-radius:999px}
.bt-ctrl-inbox-label{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ctrl-inbox-dot{width:7px;height:7px;border-radius:50%;background:var(--bt-accent);flex:none}
.bt-ctrl-inbox-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--bt-accent);color:var(--bt-user-ink);font-size:11px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums;flex:none}
.bt-ctrl-mem-wide{width:min(820px,calc(100vw - 48px));height:min(780px,calc(100vh - 2*max(32px,var(--dsh-frame-overlay-top,32px))))}
.bt-ctrl-tabs{display:flex;gap:4px;padding:10px 24px 0;border-bottom:.5px solid var(--bt-line);overflow-x:auto;scrollbar-width:none;flex:none}
.bt-ctrl-tabs::-webkit-scrollbar{display:none}
.bt-ctrl-tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px 6px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;font-weight:500;white-space:nowrap;cursor:pointer}
.bt-ctrl-tab:hover{color:var(--bt-ink);background:var(--bt-hover)}
.bt-ctrl-tab[aria-selected=true]{color:var(--bt-accent)}
.bt-ctrl-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;font-variant-numeric:tabular-nums}
.bt-ctrl-tab[aria-selected=true] .bt-ctrl-tab-badge{background:var(--bt-accent-soft);color:var(--bt-accent)}
.bt-ctrl-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 20px;display:flex;flex-direction:column;gap:14px}
.bt-ctrl-split{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;flex:1;min-height:360px}
@media (max-width:640px){.bt-ctrl-split{grid-template-columns:1fr;min-height:0}}
.bt-ctrl-side-list{display:flex;flex-direction:column;gap:4px;overflow:auto;padding-right:4px;border-right:.5px solid var(--bt-line)}
.bt-ctrl-side-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:.5px solid transparent;border-radius:10px;background:none;color:var(--bt-ink);text-align:left;font:inherit;cursor:pointer;box-sizing:border-box}
.bt-ctrl-side-item:hover{background:var(--bt-hover)}
.bt-ctrl-side-item[aria-current=true]{background:var(--bt-accent-soft);border-color:color-mix(in srgb,var(--bt-accent) 30%,transparent)}
.bt-ctrl-side-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ctrl-side-sub{font-size:11.5px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ctrl-pane{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;flex:1}
.bt-ctrl-editor{width:100%;flex:1;min-height:320px;padding:12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:12.5px;line-height:1.55;resize:vertical;box-sizing:border-box}
.bt-ctrl-editor:focus{outline:2px solid var(--bt-accent);outline-offset:-1px}
.bt-ctrl-pre{margin:0;flex:1;min-height:300px;max-height:460px;overflow:auto;padding:12px 14px;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.bt-ctrl-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.bt-ctrl-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-ctrl-btn-primary{height:32px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-user-ink);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer}
.bt-ctrl-btn-primary:disabled{opacity:.45;cursor:default}
.bt-ctrl-btn-danger{height:32px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-danger-soft);color:var(--bt-danger);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer}
.bt-ctrl-btn-danger:disabled{opacity:.45;cursor:default}
.bt-ctrl-list{display:flex;flex-direction:column;gap:8px}
.bt-ctrl-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card)}
.bt-ctrl-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.bt-ctrl-card-title{font-size:13.5px;font-weight:500;color:var(--bt-ink)}
.bt-ctrl-meta{font-size:12px;color:var(--bt-ink-2);line-height:1.45}
.bt-ctrl-check-row{display:flex;align-items:flex-start;gap:10px;cursor:pointer}
.bt-ctrl-check-row input{margin-top:3px;flex:none}
.bt-ctrl-tags{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.bt-ctrl-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;font-weight:500}
.bt-ctrl-tag[data-tone=accent]{background:var(--bt-accent-soft);color:var(--bt-accent)}
.bt-ctrl-tag[data-tone=danger]{background:var(--bt-danger-soft);color:var(--bt-danger)}
.bt-ctrl-tag[data-tone=warn]{background:color-mix(in srgb,var(--bt-star) 16%,transparent);color:var(--bt-ink)}
.bt-ctrl-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}
.bt-ctrl-section-head h3{margin:0;font-size:12.5px;font-weight:600;color:var(--bt-ink-2);text-transform:none}
.bt-ctrl-empty{padding:28px 16px;text-align:center;color:var(--bt-ink-3);font-size:13px}
.bt-ctrl-note{font-size:12px;color:var(--bt-ink-3)}
.bt-ctrl-ok{font-size:12px;color:var(--bt-green)}
.bt-ctrl-row-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:var(--bt-accent-soft);color:var(--bt-accent);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-ctrl-ticket-glyph{display:inline-flex;align-items:center;justify-content:center;border-radius:10px;background:var(--bt-accent-soft);color:var(--bt-accent);font-size:12px;font-weight:600}
`
