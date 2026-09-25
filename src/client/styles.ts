/**
 * Client styles for the Comate plugin card.
 * 卡片外壳与按钮原语沿用 dsh-connect-workbuddy/trae 的 dsm-* 表现语言（MIT），
 * 表单部分为本插件新增。
 *
 * 折叠箭头是**纯 CSS** 的，不是图标组件：两条线的 primitives 图标名不重叠
 * （0.1.5 是 `IconChevronDownOutline14`，0.1.7 是
 * `IconChevronDownOutlineRegular`），没有任何一个静态图标 import 能同时服务
 * 两边——在另一条线上会渲染成 `undefined` 并直接抛错。
 *
 * @module dsh-connect-comate/client/styles
 */

export const COMATE_CARD_CSS = `
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.dsm-plugin-card-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-comate{display:flex;flex-direction:column;gap:14px;margin:0;padding:16px 0 4px}
.dsm-comate-status{display:flex;align-items:center;gap:8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-comate-status-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-comate-status-ok{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-comate-status-empty{background:var(--dsw-alias-state-warning-primary,#d9a320)}
.dsm-comate-field{display:flex;flex-direction:column;gap:6px}
.dsm-comate-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-comate-input{width:100%;box-sizing:border-box;font:inherit;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);transition:border-color .15s,box-shadow .15s}
.dsm-comate-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-comate-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-sid-row{display:flex;gap:8px;align-items:center}
.dsm-comate-sid-row .dsm-comate-input{flex:1;min-width:0}
.dsm-comate-sid-row .dsm-btn{flex:none;white-space:nowrap}
.dsm-comate-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary,#c6c9d0);cursor:pointer}
.dsm-comate-check input{margin-top:3px}
.dsm-comate-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.dsm-comate-saved{margin:0;font-size:12.5px;color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-comate-error{margin:0;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-comate-info{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-models{display:flex;flex-direction:column;gap:8px}
.dsm-comate-models-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsm-comate-models-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-comate-models-tools{display:flex;gap:6px}
.dsm-comate-models-tools .dsm-btn{padding:2px 9px;font-size:12px}
.dsm-comate-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;overflow:hidden;max-height:280px;overflow-y:auto}
.dsm-comate-model{display:flex;flex-direction:column;gap:3px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-comate-model+.dsm-comate-model{border-top:1px solid var(--dsw-alias-border-l2,#3a3d45)}
.dsm-comate-model-row{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer}
.dsm-comate-model-row input{margin:0}
.dsm-comate-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.dsm-comate-model-tag{flex:none;font-size:10.5px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-model-meta{padding-left:23px;margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
`
