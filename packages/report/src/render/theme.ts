import { IMPORT_OUTCOMES, PROVIDERS } from "@swain/core";
import { AGENT_CLASS_MAX, actionsStyle } from "./actions.js";
import { CATEGORIES, CHIPS, MINIMAP_STEPS } from "./stream.js";
import { traceStyle } from "./trace.js";

/** Tabs: id suffix and the panel it shows. Labels are rendered in this order. */
export const TABS = [
  ["wf", "Waterfall"],
  ["cm", "Commands"],
  ["ex", "Explanation"],
  ["tl", "Timeline"],
  ["wn", "Warnings"],
] as const;

/** Panels that only the server span run page has (its other tabs reuse `TABS` keys). */
export const SPAN_EXTRA_TABS = [
  ["ag", "Agents"],
  ["sp", "Spans"],
] as const;

const CAT_COLORS: Readonly<Record<(typeof CATEGORIES)[number], readonly [string, string]>> = {
  user: ["#f2f2f2", "#f2f2f2"],
  assistant: ["#8b8b94", "#8b8b94"],
  reasoning: ["#6b6b75", "#8b8b94"],
  tool: ["#d9a441", "#d9a441"],
  command: ["#4fb3a9", "#4fb3a9"],
  subagent: ["#ff6b78", "#ff6b78"],
  system: ["#5c5c66", "#8b8b94"],
};

/**
 * The one stylesheet of every page. It depends on no data: filter rules come from closed constant
 * lists, positions from fixed class ranges. Contrast of text colours is at least 4.5:1 on the panels.
 */
export function buildStyle(): string {
  const rules: string[] = [];
  const r = (s: string): void => {
    rules.push(s);
  };

  r(
    ":root{color-scheme:dark;--bg:#0a0a0b;--pn:#111113;--rs:#16161a;--bd:#232328;--fg:#e6e6e9;--mut:#8b8b94;--dim:#5c5c66;--red:#ff2d3d;--red2:#ff6b78;--amb:#d9a441;--teal:#4fb3a9;--c:#5c5c66;--ct:#8b8b94;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
  );
  r("*{box-sizing:border-box}html{scroll-padding-top:56px}");
  r(
    "body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}",
  );
  r("h1,h2,h3{margin:0;font-weight:600}h2{font-size:13px}h3{font-size:13px;margin:16px 0 8px}");
  r("a{color:var(--fg);text-decoration-color:var(--dim)}a:hover{text-decoration-color:var(--fg)}");
  r(
    "code{font-family:var(--mono);font-size:12px}ul,ol{padding-left:20px;margin:4px 0}li{margin:4px 0}",
  );
  r(":focus-visible{outline:2px solid var(--red2);outline-offset:1px}");
  r(
    "input[type=radio]{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}",
  );
  r(".dim{color:var(--mut)}p{margin:4px 0}");

  // Top bar and logo (pure CSS: two dots joined by two curves).
  r(
    ".top{position:sticky;top:0;z-index:6;height:44px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;background:var(--pn);border-bottom:1px solid var(--bd)}",
  );
  r(
    ".brand{display:flex;align-items:center;gap:12px;min-width:0}.wm{font-weight:600;white-space:nowrap}",
  );
  r(
    ".crumb{color:var(--mut);font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.crumb a{color:var(--mut)}.crumb code{color:var(--fg)}",
  );
  r(
    ".ts{display:flex;align-items:center;gap:16px;color:var(--mut);font:12px var(--mono);white-space:nowrap}.ts .em{color:var(--fg);font-weight:600}.ln{display:block}",
  );
  r(
    ".flag{border:1px solid var(--amb);color:var(--amb);border-radius:2px;padding:0 6px;font:600 11px/18px var(--mono);text-transform:uppercase}",
  );
  r(
    ".logo{position:relative;display:inline-block;flex:none;width:30px;height:24px}.logo span{position:absolute;display:block}",
  );
  r(
    ".lc{width:17px;height:17px;border:3px solid transparent;border-radius:50%;transform:rotate(-25deg)}.lc1{left:10px;top:0;border-color:var(--red2) var(--red2) transparent transparent}.lc2{left:3px;top:6px;border-color:transparent transparent var(--red) var(--red)}",
  );
  r(
    ".ld{width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 6px 2px rgba(255,255,255,.55),0 0 12px 4px rgba(255,45,61,.45)}.ld1{left:0;top:3px}.ld2{left:23px;top:15px}",
  );

  // Notices and stat cards.
  r(
    ".notice{position:relative;z-index:5;background:var(--bg);display:flex;flex-wrap:wrap;gap:0 24px;margin:8px 16px 0;padding:4px 12px;border:1px solid var(--amb);border-radius:4px;list-style:none;color:var(--amb);font-size:12px}.notice li{margin:2px 0}",
  );
  r(
    ".stats{position:relative;z-index:5;background:var(--bg);display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 16px 0}.card{background:var(--pn);border:1px solid var(--bd);border-radius:4px;padding:8px 12px}",
  );
  r(
    ".cl{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.cv{font:600 22px/1.3 var(--mono)}.card.bad .cv{color:var(--red)}",
  );

  // Minimap.
  r(
    ".mmw{position:relative;z-index:5;background:var(--bg);margin:8px 16px 0}.mm{position:relative;height:28px;overflow:hidden;background:var(--pn);border:1px solid var(--bd);border-radius:4px}",
  );
  r(
    ".mm .t{position:absolute;bottom:2px;width:2px;height:60%;background:var(--c);font-size:0;overflow:hidden}.mm .t:hover{width:4px}.mm .t.bad{height:calc(100% - 4px);background:var(--red)}",
  );
  r(".mmn{display:block;margin-top:2px;color:var(--mut);font-size:11px}");
  const xs: string[] = [];
  for (let k = 0; k < MINIMAP_STEPS; k++) xs.push(`.x${k}{left:${k / 2}%}`);
  r(xs.join(""));

  // Category colours: --c for markers and bars, --ct for label text (contrast safe).
  for (const cat of CATEGORIES) {
    const [c, ct] = CAT_COLORS[cat];
    r(`.k-${cat}{--c:${c};--ct:${ct}}`);
  }
  r(".bad{--c:var(--red)}.k-reasoning .sm{font-style:italic;color:var(--mut)}");

  // Grid.
  r(
    ".grid{display:grid;grid-template-columns:220px minmax(0,1fr) 380px;margin:12px 0 0;background:var(--pn);border-top:1px solid var(--bd);border-bottom:1px solid var(--bd)}",
  );
  r(
    ".side,.details{position:sticky;top:44px;align-self:start;max-height:calc(100vh - 44px);overflow:auto;padding:12px}.side{border-right:1px solid var(--bd)}.details{border-left:1px solid var(--bd)}",
  );
  r(
    ".side h2,.details h2{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px}.side h2+.rl+h2{margin-top:16px}",
  );
  r(
    ".rl label,.turns a{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;border-left:2px solid transparent;color:var(--mut);cursor:pointer;text-decoration:none}.rl label span:first-child,.turns a span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  );
  r(
    ".rl input:checked+label{color:var(--fg);background:var(--rs);border-left-color:var(--red)}.rl label:hover,.turns a:hover{background:var(--rs);color:var(--fg)}.n{font:12px var(--mono);color:var(--mut)}",
  );
  r(".turns{list-style:none;padding:0;margin:0}.turns li{margin:0}");
  r(
    ".rl input:focus-visible+label,.chips input:focus-visible+label,.tabbar input:focus-visible+label{outline:2px solid var(--red2);outline-offset:-2px}",
  );

  // Stream.
  r(
    ".stream{min-width:0}.sh{position:sticky;top:44px;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:8px 12px;background:var(--pn);border-bottom:1px solid var(--bd)}",
  );
  r(
    ".cnt{color:var(--mut);font:12px var(--mono)}.sn{padding:4px 12px}.jump a{color:var(--mut)}.cardnote{margin:4px 16px 0;padding:0;position:relative;z-index:5}",
  );
  r(
    ".chips{display:flex;margin-left:auto}.chips label{padding:3px 10px;border:1px solid var(--bd);border-bottom:2px solid var(--bd);margin-left:-1px;color:var(--mut);font-size:12px;cursor:pointer}",
  );
  r(
    ".chips input:checked+label{color:var(--fg);background:var(--rs);border-bottom-color:var(--red)}.chips label:hover{color:var(--fg)}",
  );
  r(
    "details.turn>summary,.wturn>summary{display:flex;align-items:baseline;gap:8px;padding:6px 12px;background:var(--rs);border-bottom:1px solid var(--bd);cursor:pointer;list-style:none}details>summary::-webkit-details-marker{display:none}",
  );
  r(
    "details.turn>summary::before,.wturn>summary::before{content:'\\25B8';color:var(--mut)}details[open].turn>summary::before,.wturn[open]>summary::before{content:'\\25BE'}",
  );
  r(
    ".tg{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.05em;color:var(--ct);white-space:nowrap}.pr{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cn{color:var(--mut);font:12px var(--mono);white-space:nowrap}",
  );
  r(
    ".item{position:relative;border-left:2px solid var(--c);border-bottom:1px solid var(--bd);scroll-margin-top:100px}.item:target,.item:has(:target){background:var(--rs);border-left-color:var(--red)}.an{position:absolute;top:0}",
  );
  r(
    ".row{display:grid;grid-template-columns:64px 52px 104px minmax(0,1fr) 64px 64px;align-items:center;gap:8px;height:28px;padding:0 12px 0 8px;color:var(--fg);text-decoration:none}.row:hover{background:var(--rs)}",
  );
  r(
    ".tm{font:12px var(--mono);color:var(--mut)}.lb{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.05em;color:var(--ct)}.nr .lb{outline:1px solid var(--amb);outline-offset:1px;text-align:center}",
  );
  r(
    ".ag,.sm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ag{color:var(--mut);font-size:12px}.tn{font-family:var(--mono);margin-right:8px}",
  );
  r(
    ".st{font:600 11px var(--mono);text-transform:uppercase;margin-left:8px}.st.bad,.b-bad{color:var(--red)}.st.warn,.b-warn{color:var(--amb)}",
  );
  r(
    ".du{text-align:right;font:12px var(--mono);color:var(--mut)}.dtk{position:relative;display:block;height:2px;background:var(--bd)}.dtk .bar{background:var(--c)}",
  );
  r(".b-ok{color:var(--mut)}.b-bad,.b-warn{font-weight:600}");

  // Detail blocks: hidden until their item is the target; wide screens pin them to the right column.
  r(
    ".d{display:none;padding:12px;background:var(--pn);overflow:auto;border-left:1px solid var(--bd)}.item:target>.d,.item:has(:target)>.d{display:block}",
  );
  r(
    "@media (min-width:1100px){.item:target>.d,.item:has(:target)>.d{position:fixed;z-index:4;top:44px;right:0;width:380px;height:calc(100vh - 44px)}}",
  );
  r("body:has(.item:target) .d-default,body:has(.item :target) .d-default{display:none}");
  r(
    ".dh{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}.dn{font:600 13px var(--mono);overflow-wrap:anywhere}",
  );
  r(
    ".kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:4px 12px;margin:0}.kv dt{color:var(--mut);font-size:12px}.kv dd{margin:0;overflow-wrap:anywhere;font:12px var(--mono)}.kv .v{display:block;white-space:pre-wrap;max-height:160px;overflow:auto}",
  );
  r(
    ".rawh{margin:16px 0 4px;color:var(--mut);font:600 11px var(--mono);letter-spacing:.06em}.raw{background:var(--bg);border:1px solid var(--bd);border-radius:4px;padding:8px;max-height:360px;overflow:auto}.raw code{display:block;font-size:11px}.rl{display:block;white-space:pre}.raw .trunc{display:block;margin-top:4px}.trunc{color:var(--amb);font:600 11px var(--mono);text-transform:uppercase}",
  );

  // Tabs.
  r(".tabs{margin:16px 16px 24px}.tabbar{display:flex;border-bottom:1px solid var(--bd)}");
  r(
    ".tabbar label{padding:8px 16px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--mut);cursor:pointer}.tabbar input:checked+label{color:var(--fg);border-bottom-color:var(--red)}.tabbar label:hover{color:var(--fg)}",
  );
  r(
    ".panel{display:none;padding:12px 0}.panel>h2{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}",
  );
  for (const [k] of TABS) r(`body:has(#t-${k}:checked) #p-${k}{display:block}`);
  // Span run pages (server): Agents and Spans panels, and the shared agent filter shown only on the
  // Commands and Timeline tabs.
  for (const [k] of SPAN_EXTRA_TABS) r(`body:has(#t-${k}:checked) #p-${k}{display:block}`);
  r(
    "body:has(#t-wf:checked) .agf,body:has(#t-ag:checked) .agf,body:has(#t-sp:checked) .agf{display:none}",
  );

  // Waterfall.
  r(
    ".wturn{border:1px solid var(--bd);border-radius:4px;background:var(--pn);margin:0 0 8px}.wturn>summary{flex-wrap:wrap}",
  );
  r(
    ".meta{color:var(--mut);font:12px var(--mono)}.trace{list-style:none;margin:0;padding:0}.trace li{margin:0}.sub{margin:0}.wb{min-width:0}",
  );
  r(
    ".wr{display:grid;grid-template-columns:minmax(0,1fr) 40% 72px;gap:8px;align-items:center;min-height:26px;padding:2px 12px;border-bottom:1px solid var(--bd)}.wn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut)}.wn code{color:var(--fg)}",
  );
  const ind: string[] = [];
  for (let k = 0; k <= 16; k++) ind.push(`.i${k}{padding-left:${k * 16}px}`);
  r(ind.join(""));
  r(
    ".wd{text-align:right;font:12px var(--mono);color:var(--mut)}.wf{display:block;position:relative;height:8px;background:var(--rs)}.bar{position:absolute;top:0;bottom:0;background:var(--c)}.bar.nr{background:transparent;border:1px solid var(--amb)}",
  );
  r(
    ".axis{border-bottom:1px solid var(--bd)}.ticks{display:flex;justify-content:space-between;color:var(--mut);font:11px var(--mono)}",
  );
  r(
    ".trace details{padding:2px 12px 6px 28px}.trace details>summary{cursor:pointer;color:var(--mut);font-size:12px}.prompts li{margin:4px 0}",
  );
  rules.push(...traceStyle());

  // Tables, filters, explanation.
  r(".scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}");
  r(
    "th{color:var(--mut);font:600 11px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd);background:var(--pn);white-space:nowrap}td{padding:4px 8px;border-bottom:1px solid var(--bd);vertical-align:top;overflow-wrap:anywhere;font-family:var(--mono)}tbody tr:hover{background:var(--rs)}",
  );
  r(
    ".usage td+td,.usage th+th{text-align:right}.bad td:nth-child(4){color:var(--red);font-weight:600}",
  );
  r(
    ".interp{border-left:2px solid var(--amb);padding-left:8px}.tag{color:var(--amb);font-weight:600}.ev{color:var(--mut)}",
  );
  r(
    "fieldset{display:inline-block;margin:0 16px 8px 0;padding:0;border:0}legend{float:left;margin:0 8px 0 0;padding:3px 0;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}",
  );
  r(
    "fieldset label{display:inline-block;padding:3px 10px;border:1px solid var(--bd);border-bottom:2px solid var(--bd);margin-left:-1px;color:var(--mut);font-size:12px;cursor:pointer}fieldset input:checked+label{color:var(--fg);background:var(--rs);border-bottom-color:var(--red)}fieldset input:focus-visible+label{outline:2px solid var(--red2);outline-offset:-2px}",
  );
  r(".acts td:nth-child(6){min-width:14rem}.pc{white-space:pre-wrap;overflow-wrap:anywhere}");
  r(".wrap{margin:12px 16px 24px}");

  // Index.
  r(
    ".idx td:first-child{border-left:2px solid var(--mut)}.idx th:nth-child(n+5):nth-child(-n+9),.idx td:nth-child(n+5):nth-child(-n+9){text-align:right}.idx td.f{color:var(--red);font-weight:600}.idx a{text-decoration:none}.idx a:hover{text-decoration:underline}",
  );
  r(".filters{margin:12px 16px 0}");

  // Responsive and print.
  r(
    "@media (max-width:1099px){.grid{display:block}.side,.details{position:static;max-height:none;border:0}.sh{position:static}.row{grid-template-columns:64px 52px minmax(0,1fr) 64px}.ag,.dtk{display:none}.wr{grid-template-columns:minmax(0,1fr) 30% 64px}}",
  );
  r(
    "@media print{:root{color-scheme:light;--bg:#fff;--pn:#fff;--rs:#f2f2f2;--bd:#c8c8c8;--fg:#000;--mut:#444;--dim:#777;--amb:#7a5500;--red:#b00020;--red2:#b00020}.top,.sh{position:static}.mmw,.chips,.side,.tabbar,.details,.d{display:none}.grid{display:block}.panel{display:block}body{font-size:11px}}",
  );

  // Static filter rules.
  for (const [k] of CHIPS) {
    rules.push(`body:has(#c-${k}:checked) .item:not(.f-${k}){display:none}`);
  }
  for (let k = 0; k <= AGENT_CLASS_MAX; k++) {
    rules.push(`body:has(#th-${k}:checked) .item:not(.ag${k}){display:none}`);
  }
  rules.push(...actionsStyle());
  for (const p of PROVIDERS) {
    rules.push(
      `body:has(#f-p-${p}:checked) tr[data-provider]:not([data-provider="${p}"]){display:none}`,
    );
  }
  for (const oc of IMPORT_OUTCOMES) {
    rules.push(
      `body:has(#f-o-${oc}:checked) tr[data-outcome]:not([data-outcome="${oc}"]){display:none}`,
    );
  }
  return rules.join("\n");
}
