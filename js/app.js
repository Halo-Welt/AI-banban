import {
  DEFAULT_PICK_ID,
  DEFAULT_PROMPT,
  applyConstraint,
  buyAmount,
  buySpec,
  classifyConstraint,
  clone,
  composePostText,
  filterListings,
  formatMD,
  formatYuan,
  highlightTerms,
  itemSpec,
  listingSpec,
  sanitizeGeneratedPlan,
  selectListing,
  setBuyStatus,
  setCommuteCap,
  setDisposition,
  statusLabel,
  syncPlan,
  templateExplanation,
} from "./engine.js";
import {
  canCallModel,
  classifyWithModel,
  generateExplanation,
  generatePlan,
  generatePost,
  loadModelConfig,
} from "./ai.js";

const state = {
  view: "start",
  catalog: null,
  baseCatalog: null,
  defaultPlan: null,
  plan: null,
  mode: "",
  thinkStep: 0,
  prompt: "",
  appendDraft: "",
  model: loadModelConfig(),
  busy: null,
  fallbackBanner: false,
  drawer: null,
  toast: "",
  housingFlash: false,
  copied: false,
  listening: false,
  animate: false,
  enterKind: "",
  pickingHome: false,
  showBuy: false,
  editingQuery: false,
  queryDraft: "",
  roomPhoto: "",
  scanning: false,
  calYear: null,
  calMonth: null,
  tour: null,
};

let toastTimer = null;
let flashTimer = null;
let stepTimer = null;
let scanTimer = null;
let thinkTimer = null;

const THINK_STEPS = ["正在读你的原句", "划出日期、预算和待办", "给旧物定价，配新家置办"];
const THINK_INTERVAL = 1100;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`load ${path}`);
  return response.json();
}

async function boot() {
  const [listings, items, buy, defaultPlan, posts] = await Promise.all([
    loadJson("./data/listings.json"),
    loadJson("./data/items.json"),
    loadJson("./data/buy.json"),
    loadJson("./data/default-plan.json"),
    loadJson("./data/post-fallbacks.json"),
  ]);
  state.baseCatalog = { listings, items, buy, posts };
  state.catalog = clone(state.baseCatalog);
  state.defaultPlan = defaultPlan;
  try {
    if (localStorage.getItem(TOUR_KEY) !== "1") state.tour = 0;
  } catch {
    state.tour = 0;
  }
  render();
}

function showToast(text) {
  state.toast = text;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = "";
    render();
  }, 2200);
}

function topbarHtml(showReset) {
  const aboutOpen = state.drawer?.type === "about";
  return `
    <header class="topbar">
      <div class="brand"><span class="brand-dot"></span>搬伴</div>
      <div class="topbar-actions">
        ${
          showReset
            ? `<button class="btn btn-secondary" type="button" data-action="reset">重置 Demo</button>`
            : `<button class="btn btn-secondary ${aboutOpen ? "is-on" : ""}" type="button" data-action="open-about" aria-expanded="${aboutOpen ? "true" : "false"}">产品说明</button>`
        }
      </div>
    </header>
  `;
}

function micIcon() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 12v2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

function startHtml() {
  const generating = state.busy === "plan";
  const listening = state.listening;
  return `
    <main class="page-start">
      <div class="wrap">
        <section class="start-card">
          <div class="start-brand">
            <div class="brand-dot"></div>
            <h1>搬伴</h1>
          </div>
          <p class="lede">AI作伴，定制完整搬家计划</p>
          <div class="prompt-wrap" data-tour="prompt">
            <textarea class="prompt" data-field="prompt" placeholder="输入你的需求" ${generating ? "disabled" : ""}>${esc(state.prompt)}</textarea>
            <button class="btn-mic ${listening ? "is-on" : ""}" type="button" data-action="voice" ${generating ? "disabled" : ""} aria-label="${listening ? "停止语音输入" : "语音输入"}">${micIcon()}</button>
          </div>
          <div class="btn-row">
            <button class="btn btn-secondary" type="button" data-action="demo-run" data-tour="demo" ${generating ? "disabled" : ""}>Demo试运行</button>
            <button class="btn btn-primary" type="button" data-action="generate" data-tour="generate" ${generating ? "disabled" : ""}>
              ${generating ? `<span class="pulse"></span>生成中` : "生成计划"}
            </button>
          </div>
          ${
            generating
              ? `<ol class="think-list" data-tour="think" aria-live="polite">${THINK_STEPS.map((text, index) => {
                  const on = state.thinkStep >= index ? "is-on" : "";
                  const now = state.thinkStep === index ? "is-now" : "";
                  return `<li class="${on} ${now}">${esc(text)}</li>`;
                }).join("")}</ol>`
              : ""
          }
        </section>
      </div>
    </main>
  `;
}

function changeHtml() {
  const change = state.plan.lastChange;
  if (!change) return "";
  return `
    <section class="change-card">
      <h2>计划已改写</h2>
      <p class="change-trigger">触发：${esc(change.trigger)}</p>
      <ul class="change-list">
        ${change.diffs.map((line) => `<li>${esc(line)}</li>`).join("")}
        <li>一次性花费差额：${change.delta === 0 ? "无" : `${change.delta > 0 ? "+" : ""}${formatYuan(change.delta)}`}</li>
      </ul>
      <p class="change-body">${esc(change.explanation)}</p>
      ${change.needReselectHousing ? `<div class="btn-row"><button class="btn btn-primary" type="button" data-action="open-listings">重新筛房</button></div>` : ""}
    </section>
  `;
}

function itemHtml(item, index = 0) {
  const spec = itemSpec(state.catalog, item.id);
  if (!spec) return "";
  const delay = state.animate && state.enterKind === "items" ? ` style="animation-delay:${0.18 + index * 0.16}s"` : "";
  const fee =
    item.disposition === "discard" && spec.discardFee
      ? `清运费 ${formatYuan(spec.discardFee)}`
      : item.disposition === "take"
        ? `搬运加价 ${formatYuan(spec.haulFee)}`
        : item.disposition === "sell"
          ? `预计回款 ${formatYuan(spec.resale)}（未到账）`
          : "";
  return `
    <article class="item-card"${delay}>
      <img src="${esc(spec.image)}" alt="${esc(spec.name)}" width="72" height="72" />
      <div class="item-body">
        <div class="item-name">${esc(spec.name)}</div>
        ${item.note ? `<div class="fee-note">${esc(item.note)}</div>` : ""}
        <div class="seg">
          ${["sell:转卖", "discard:丢弃", "take:带走"]
            .map((pair) => {
              const [value, label] = pair.split(":");
              const on = item.disposition === value ? "is-on" : "";
              const tour = item.id === "item-sofa" && value === "sell" ? ` data-tour="sell"` : "";
              return `<button type="button" class="${on}" data-action="dispose" data-id="${item.id}" data-value="${value}"${tour}>${label}</button>`;
            })
            .join("")}
        </div>
        ${fee ? `<div class="fee-note">${fee}</div>` : ""}
        ${item.disposition === "sell" ? `<div class="fee-note"><button class="btn btn-text danger" type="button" data-action="open-post" data-id="${item.id}"${item.id === "item-sofa" ? ` data-tour="post"` : ""}>生成转卖帖</button></div>` : ""}
      </div>
    </article>
  `;
}

function houseHtml() {
  const { plan, catalog, housingFlash } = state;
  const listing = listingSpec(catalog, plan.listings.selectedId);
  if (!listing) {
    return `
      <div class="house-empty ${housingFlash ? "is-flash" : ""}">
        <div>还没选房</div>
        <p class="empty-hint">${esc(plan.houseNote || `陆家嘴附近，通勤 ${plan.listings.commuteCap} 分钟内。`)}</p>
        <div class="btn-row"><button class="btn btn-text danger" type="button" data-action="open-listings">按通勤筛房</button></div>
      </div>
    `;
  }
  return `
    <article class="house-card" data-action="open-listing" data-id="${listing.id}">
      <img src="${esc(listing.cover)}" alt="${esc(listing.title)}" width="88" height="88" />
      <div>
        <div class="card-title">${esc(listing.title)} <span class="star">★</span></div>
        <div class="fee-note">${esc(listing.area)} · 月租 ${formatYuan(listing.monthlyRent)}</div>
        <div class="fee-note">通勤 ${listing.commuteMinutes} 分钟 · 起租 ${formatMD(listing.availableFrom)} · ${listing.petsAllowed ? "可养宠物" : "不允许宠物"}</div>
        <div class="btn-row"><button class="btn btn-secondary" type="button" data-action="repick-home">换一套</button></div>
      </div>
    </article>
  `;
}

function buyHtml(row, index = 0) {
  const spec = buySpec(state.catalog, row.id);
  if (!spec) return "";
  const delay = state.animate && state.enterKind === "buy" ? ` style="animation-delay:${0.12 + index * 0.12}s"` : "";
  const amount = buyAmount(state.catalog, row);
  const canDowngrade = spec.downgraded != null && row.status === "planned";
  const canCut = row.status !== "cut";
  return `
    <article class="buy-row ${row.status === "cut" ? "is-cut" : ""}"${delay}>
      <img src="${esc(spec.image)}" alt="${esc(spec.name)}" width="72" height="72" />
      <div class="buy-body">
        <div class="buy-name">${esc(spec.name)}</div>
        <div class="buy-meta">
          <span class="price">${row.status === "downgraded" ? `<s>${formatYuan(spec.planned)}</s>${formatYuan(amount)}` : formatYuan(row.status === "cut" ? spec.planned : amount)}</span>
          <span class="status-chip">${statusLabel(row.status)}</span>
          ${canDowngrade ? `<button class="btn btn-text" type="button" data-action="buy-status" data-id="${row.id}" data-value="downgraded">降级</button>` : ""}
          ${canCut ? `<button class="btn btn-text" type="button" data-action="buy-status" data-id="${row.id}" data-value="cut">砍掉</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function parseISO(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysISO(iso, days) {
  const date = parseISO(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

function addMark(marks, iso, kind, tag) {
  if (!iso) return;
  if (!marks[iso]) marks[iso] = { kinds: [], tags: [] };
  if (!marks[iso].kinds.includes(kind)) marks[iso].kinds.push(kind);
  if (tag && !marks[iso].tags.includes(tag)) marks[iso].tags.push(tag);
}

function calendarMarks(plan) {
  const marks = {};
  const moveOut = plan.dates.moveOut;
  const leaseStart = plan.dates.leaseStart;
  const reportBy = plan.dates.reportBy;
  const nights = plan.dates.transitionNights || 0;
  addMark(marks, moveOut, "moveOut", "退租");
  if (nights > 0 && leaseStart) {
    for (let i = 0; i < nights; i += 1) {
      const iso = addDaysISO(moveOut, i);
      addMark(marks, iso, "transition", iso === moveOut ? "" : "过渡");
    }
  }
  if (leaseStart) addMark(marks, leaseStart, "lease", "起租");
  addMark(marks, reportBy, "report", "报到");
  const leaseAfterReport = leaseStart && leaseStart > reportBy;
  if (!leaseStart) addMark(marks, moveOut, "conflict", "");
  if (leaseAfterReport) {
    addMark(marks, leaseStart, "conflict", "");
    addMark(marks, reportBy, "conflict", "");
  }
  return marks;
}

function dayCellHtml(date, marks, muted) {
  const iso = toISO(date);
  const info = marks[iso] || { kinds: [], tags: [] };
  const classes = ["cal-cell"];
  if (muted) classes.push("is-muted");
  if (info.kinds.includes("transition")) classes.push("is-gap");
  if (info.kinds.includes("conflict")) classes.push("is-conflict");
  const tags = muted ? [] : info.tags.filter(Boolean);
  return `
    <div class="${classes.join(" ")}">
      <div class="cal-num">${date.getDate()}</div>
      ${tags
        .map((tag) => {
          const hot = tag === "退租" || info.kinds.includes("conflict");
          return `<div class="cal-tag ${hot ? "is-out" : ""} ${info.kinds.includes("conflict") && tag !== "过渡" ? "is-conflict" : ""}">${esc(tag)}</div>`;
        })
        .join("")}
    </div>
  `;
}

function monthGridHtml(year, month, marks) {
  const first = new Date(year, month, 1);
  const weekday = first.getDay();
  const count = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < weekday; i += 1) {
    cells.push(dayCellHtml(new Date(year, month, i - weekday + 1), marks, true));
  }
  for (let day = 1; day <= count; day += 1) {
    cells.push(dayCellHtml(new Date(year, month, day), marks, false));
  }
  const extra = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= extra; i += 1) {
    cells.push(dayCellHtml(new Date(year, month, count + i), marks, true));
  }
  return `
    <div class="cal-month">
      <div class="cal-grid">
        ${["日", "一", "二", "三", "四", "五", "六"].map((name) => `<div class="cal-dow">${name}</div>`).join("")}
        ${cells.join("")}
      </div>
    </div>
  `;
}

function chevronIcon(dir) {
  const d = dir === "prev" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5";
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function showCalMonth(iso) {
  const date = parseISO(iso || "2026-06-01");
  state.calYear = date.getFullYear();
  state.calMonth = date.getMonth();
}

function currentCalDate() {
  if (Number.isInteger(state.calYear) && Number.isInteger(state.calMonth)) {
    return new Date(state.calYear, state.calMonth, 1);
  }
  const date = parseISO(state.plan?.dates.moveOut || "2026-06-01");
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function shiftCalMonth(delta) {
  const date = currentCalDate();
  date.setMonth(date.getMonth() + delta);
  state.calYear = date.getFullYear();
  state.calMonth = date.getMonth();
  render();
}

function timelineHtml() {
  const { plan } = state;
  const marks = calendarMarks(plan);
  const cursor = currentCalDate();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const leaseAfterReport = plan.dates.leaseStart && plan.dates.leaseStart > plan.dates.reportBy;
  return `
    <section class="timeline-wrap" data-tour="timeline">
      <div class="timeline-head">
        <h2>日程表</h2>
        <div class="cal-nav">
          <button class="cal-shift" type="button" data-action="cal-prev" aria-label="上个月">${chevronIcon("prev")}</button>
          <div class="cal-title">${year}年${month + 1}月</div>
          <button class="cal-shift" type="button" data-action="cal-next" aria-label="下个月">${chevronIcon("next")}</button>
        </div>
      </div>
      <div class="cal-months">
        ${monthGridHtml(year, month, marks)}
      </div>
      <div class="cal-legend">
        <span><i class="cal-swatch is-out"></i>重要事项</span>
        <span><i class="cal-swatch"></i>常规事项</span>
        ${leaseAfterReport ? `<span>报到日早于可入住日</span>` : ""}
      </div>
      ${plan.notes.length ? `<p class="fee-note">备注待办：${plan.notes.map((note) => esc(note.text)).join("；")}</p>` : ""}
    </section>
  `;
}

function highlightQuery(text) {
  const src = String(text);
  const terms = state.plan && state.catalog ? highlightTerms(src, state.plan, state.catalog) : [];
  if (!terms.length) return esc(src);
  const used = new Array(src.length).fill(false);
  const spans = [];
  for (const term of terms) {
    let from = 0;
    while (from <= src.length - term.length) {
      const index = src.indexOf(term, from);
      if (index < 0) break;
      let overlap = false;
      for (let i = index; i < index + term.length; i += 1) {
        if (used[i]) overlap = true;
      }
      if (!overlap) {
        spans.push({ start: index, end: index + term.length });
        for (let i = index; i < index + term.length; i += 1) used[i] = true;
      }
      from = index + 1;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let html = "";
  let last = 0;
  spans.forEach((span, index) => {
    html += esc(src.slice(last, span.start));
    html += `<span class="query-mark" style="--mark-i:${index}">${esc(src.slice(span.start, span.end))}</span>`;
    last = span.end;
  });
  html += esc(src.slice(last));
  return html;
}

function queryHtml() {
  const initial = state.plan.constraints.find((item) => item.kind === "initial") || state.plan.constraints[0];
  if (!initial) return "";
  const editing = state.editingQuery;
  const live = state.mode === "live";
  const saving = live && state.busy === "plan";
  return `
    <section class="query" data-tour="query">
      <div class="query-head">
        <p class="query-label">你的要求</p>
        <div class="query-actions">
          ${
            editing
              ? `<button class="btn btn-secondary" type="button" data-action="cancel-query" ${saving ? "disabled" : ""}>取消</button>
                 <button class="btn btn-primary" type="button" data-action="save-query" ${saving ? "disabled" : ""}>${saving ? "生成中" : "保存"}</button>`
              : `<button class="btn btn-secondary" type="button" data-action="edit-query">编辑</button>
                 <details class="query-hint">
                   <summary class="query-bang" aria-label="划线说明">!</summary>
                   <p>划线部分是 AI 识别出的日期、地点、预算和待办等关键信息。</p>
                 </details>`
          }
        </div>
      </div>
      ${
        editing
          ? `<textarea class="query-edit" data-field="query" rows="3" ${saving ? "disabled" : ""}>${esc(state.queryDraft)}</textarea>`
          : `<p class="query-text">${highlightQuery(initial.text)}</p>`
      }
    </section>
  `;
}

function roomShotHtml() {
  if (!state.roomPhoto) return `<p class="empty-hint">还没有房屋照片。</p>`;
  return `
    <div class="room-shot ${state.scanning ? "is-scanning" : ""}">
      <img src="${esc(state.roomPhoto)}" alt="旧房照片" />
      ${state.scanning ? `<i class="scan-line"></i><p class="scan-label">正在按这张照片认旧物</p>` : ""}
    </div>
  `;
}

function oldEmptyHtml() {
  return `
    <div class="track-empty">
      <p class="empty-hint">暂未上传照片</p>
      <div class="btn-row" data-tour="sample">
        <button class="btn btn-secondary" type="button" data-action="pick-photo">上传房屋照片</button>
        <button class="btn btn-primary" type="button" data-action="use-sample">用示例房间</button>
      </div>
    </div>
  `;
}

function newEmptyHtml() {
  return `
    <div class="track-empty" data-action="pick-home">
      <p class="empty-hint">暂未选择新房</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="pick-home" data-tour="pick-home">选一套</button>
      </div>
    </div>
  `;
}

function buyEmptyHtml() {
  return `
    <div class="track-empty" data-action="pick-buy">
      <p class="empty-hint">还没置办家具。</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="pick-buy" data-tour="pick-buy">置办家具</button>
      </div>
    </div>
  `;
}

function oldTrackHtml() {
  const { plan } = state;
  const showItems = Boolean(state.roomPhoto) && !state.scanning;
  return `
    <section class="track" data-tour="old">
      <h2>旧房清理</h2>
      ${state.roomPhoto ? roomShotHtml() : oldEmptyHtml()}
      ${showItems ? plan.items.map((item, index) => itemHtml(item, index)).join("") : ""}
      <input class="room-file" type="file" accept="image/*" />
    </section>
  `;
}

function listingChoicesHtml() {
  const { plan, catalog } = state;
  const list = filterListings(plan, catalog);
  return `
    <div class="track-picks">
      ${
        list.length
          ? list
              .map((listing, index) => {
                const selected = plan.listings.selectedId === listing.id;
                const delay = state.animate && state.enterKind === "listings" ? ` style="animation-delay:${0.12 + index * 0.1}s"` : "";
                const tour = listing.id === DEFAULT_PICK_ID ? ` data-tour="listing"` : "";
                return `
                  <button type="button" class="listing-row ${selected ? "is-selected" : ""}" data-action="pick-listing" data-id="${listing.id}"${tour}${delay}>
                    <img src="${esc(listing.cover)}" alt="${esc(listing.title)}" width="72" height="72" />
                    <div>
                      <div class="card-title">${esc(listing.title)}</div>
                      <div class="fee-note">${esc(listing.area)} · 月租 ${formatYuan(listing.monthlyRent)} · 通勤 ${listing.commuteMinutes} 分钟</div>
                      <div class="fee-note">${listing.petsAllowed ? "可养宠物" : "不允许宠物"} · 起租 ${formatMD(listing.availableFrom)}</div>
                    </div>
                  </button>
                `;
              })
              .join("")
          : `<p class="empty-hint">这个通勤里没有合适的房子。可以放宽到 60 分钟。</p>`
      }
    </div>
  `;
}

function newTrackHtml() {
  const selected = state.plan.listings.selectedId;
  const picking = state.pickingHome;
  let body = newEmptyHtml();
  if (selected && !picking) {
    const buy = state.showBuy ? `<div data-tour="buy">${state.plan.buy.map((row, index) => buyHtml(row, index)).join("")}</div>` : buyEmptyHtml();
    body = `${houseHtml()}${buy}`;
  } else if (picking) {
    body = listingChoicesHtml();
  }
  return `
    <section class="track">
      <h2>新房安置</h2>
      ${body}
    </section>
  `;
}

function boardHtml() {
  const enter = state.animate && state.enterKind ? `is-enter-${state.enterKind}` : "";
  return `
    <main class="page-board">
      <div class="wrap stack ${enter}">
        ${queryHtml()}
        <div class="tracks">
          ${oldTrackHtml()}
          ${newTrackHtml()}
        </div>
        ${timelineHtml()}
      </div>
    </main>
  `;
}

function lineIcon(inner) {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function aboutIco(inner) {
  return `<span class="about-ico" aria-hidden="true">${lineIcon(inner)}</span>`;
}

function aboutDrawerHtml() {
  const board = `<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.6"/><path d="M2.25 6.25h11.5M6.5 6.25V13.75"/>`;
  const person = `<circle cx="8" cy="5.1" r="2.15"/><path d="M3.4 13.25c.7-2.3 2.4-3.5 4.6-3.5s3.9 1.2 4.6 3.5"/>`;
  const list = `<path d="M3 4.5h10M3 8h10M3 11.5h6"/>`;
  const mic = `<rect x="6" y="1.6" width="4" height="7" rx="2"/><path d="M4 7.2a4 4 0 0 0 8 0M8 11.2v2.4"/>`;
  const camera = `<path d="M6.1 3.3h3.8l.9 1.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1h2.2z"/><circle cx="8" cy="8.7" r="1.9"/>`;
  const pencil = `<path d="M9.3 2.7 13.2 6.6 6.1 13.6H2.4v-3.6z"/><path d="M8 4 11.8 7.8"/>`;
  const bubble = `<path d="M2.5 3.3h11a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H7.1L4.7 13v-2.3H2.5a1 1 0 0 1-1-1V4.3a1 1 0 0 1 1-1z"/>`;
  const note = `<path d="M4.2 2.3h5.1L12.6 5.6v7.7a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1V3.3a1 1 0 0 1 1-1z"/><path d="M9.2 2.5V5.8h3.3M5.5 9h5M5.5 11.3h3.2"/>`;
  const house = `<path d="M2.4 7.2 8 2.6l5.6 4.6"/><path d="M4 6.9V13h8V6.9"/><path d="M7 13v-3h2v3"/>`;
  const bag = `<path d="M2.8 6.2 8 3.7l5.2 2.5L8 8.7z"/><path d="M2.8 6.2V11l5.2 2.5V8.7"/><path d="M13.2 6.2V11L8 13.5"/>`;
  const cal = `<rect x="2.5" y="3.2" width="11" height="10.4" rx="1.4"/><path d="M2.5 6.6h11M5.3 1.8v2.6M10.7 1.8v2.6M5.4 9.1h1.5M9.1 9.1h1.5"/>`;
  const refresh = `<path d="M12.7 8.1a4.7 4.7 0 1 1-1.4-3.7"/><path d="M11.2 2.1v2.8h2.8"/>`;
  const row = (icon, title, text) => `
    <li>
      ${aboutIco(icon)}
      <div>
        <strong>${title}</strong>
        <p>${text}</p>
      </div>
    </li>`;
  return `
    <aside class="sidebar about-sidebar" data-stop="1">
      <div class="drawer-head">
        <h2>产品说明</h2>
        <button class="btn btn-secondary" type="button" data-action="close-drawer">关闭</button>
      </div>
      <div class="drawer-body about-body">
        <section class="about-block">
          <h3>搬伴是什么</h3>
          <ul class="about-rows">
            ${row(board, "是什么", "跨城搬家的计划看板。旧房、新房、日程摊在同一屏。")}
            ${row(person, "给谁", "要一起处理退租、旧物、找房和置办的人。")}
            ${row(list, "能做什么", "说出约束，计划先摊开。补上旧房、新房和要买的东西，时间和花费跟着改。")}
          </ul>
        </section>
        <section class="about-block">
          <h3>为什么要用 AI</h3>
          <p>旧房没点清，新房没定，预算和报到日却在变。每动一个条件，日期和钱都要一起改。</p>
          <ul class="about-chips">
            <li>${aboutIco(mic)}一句口语</li>
            <li>${aboutIco(camera)}一张照片</li>
            <li>${aboutIco(pencil)}一次改口</li>
          </ul>
          <p>AI 听懂这些，写回同一盘计划。</p>
        </section>
        <section class="about-block">
          <h3>AI 能做什么</h3>
          <ul class="about-rows">
            ${row(bubble, "读约束", "抽出退租日、报到日、预算和通勤，划线填进计划。")}
            ${row(camera, "认旧物", "看房间照片，逐件给出转卖、丢弃或带走，并标上费用。")}
            ${row(note, "写转卖帖", "生成小红书标题、正文和标签，复制就能发。")}
            ${row(house, "按通勤筛房", "过滤小红书房源。选定一套，新房才落定。")}
            ${row(bag, "补上置办", "不带走的旧物转成新家清单，守住一次性预算。")}
            ${row(cal, "写入日程", "退租、过渡、起租、报到落到月历，冲突标在当天。")}
            ${row(refresh, "改了就重算", "预算、报到日或宠物一变，日期和花费一起更新。")}
          </ul>
        </section>
      </div>
    </aside>
  `;
}

function drawerHtml() {
  if (!state.drawer) return "";
  if (state.drawer.type === "post") return postDrawerHtml();
  if (state.drawer.type === "listing") return listingDrawerHtml();
  if (state.drawer.type === "listings") return listingsDrawerHtml();
  return "";
}

function postDrawerHtml() {
  const item = itemSpec(state.catalog, state.drawer.itemId);
  const post = state.drawer.post;
  const loading = state.busy === "post";
  return `
    <aside class="sidebar" data-stop="1">
      <div class="drawer-head">
        <h2>转卖帖预览</h2>
        <button class="btn btn-secondary" type="button" data-action="close-drawer" data-tour="close-post">关闭</button>
      </div>
      <div class="drawer-body">
        ${
          loading
            ? `<p class="lede">正在写帖…</p>`
            : `<article class="note-card">
                <img src="${esc(item.image)}" alt="${esc(item.name)}" />
                <div class="note-text">
                  <h3>${esc(post.title)}</h3>
                  <p>${esc(post.body)}</p>
                  <div class="tags">${post.tags.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join("")}</div>
                </div>
              </article>`
        }
        ${!loading ? `<div class="btn-row"><button class="btn btn-primary" type="button" data-action="copy-post">复制文案</button></div>` : ""}
      </div>
    </aside>
  `;
}

function listingDrawerHtml() {
  const listing = listingSpec(state.catalog, state.drawer.listingId);
  if (!listing) return "";
  const pet = listing.petsAllowed ? "可养宠物" : "不允许宠物";
  const tags = [listing.area, `通勤${listing.commuteMinutes}分钟`, `起租${formatMD(listing.availableFrom)}`, pet];
  return `
    <aside class="sidebar" data-stop="1">
      <div class="drawer-head">
        <div class="drawer-title">
          <h2>房源详情</h2>
          <span class="source-chip">来源 小红书</span>
        </div>
        <button class="btn btn-secondary" type="button" data-action="close-drawer">关闭</button>
      </div>
      <div class="drawer-body">
        <article class="note-card is-listing">
          <img src="${esc(listing.cover)}" alt="${esc(listing.title)}" />
          <div class="note-text">
            <h3>${esc(listing.title)}</h3>
            <ul class="note-list">
              <li><span>月租</span><strong>${formatYuan(listing.monthlyRent)}</strong></li>
              <li><span>位置</span><strong>${esc(listing.area)}</strong></li>
              <li><span>通勤</span><strong>${listing.commuteMinutes} 分钟</strong></li>
              <li><span>起租</span><strong>${formatMD(listing.availableFrom)}</strong></li>
              <li><span>宠物</span><strong>${listing.petsAllowed ? "可养" : "不允许"}</strong></li>
            </ul>
            <p>${esc(listing.pitch)}</p>
            <div class="tags">${tags.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join("")}</div>
          </div>
        </article>
        <div class="btn-row"><button class="btn btn-primary" type="button" data-action="close-drawer" data-tour="confirm-listing">就这套</button></div>
      </div>
    </aside>
  `;
}

function listingsDrawerHtml() {
  const { plan, catalog } = state;
  const cap = plan.listings.commuteCap;
  const list = filterListings(plan, catalog);
  const pet = plan.constraints.some((item) => item.kind === "pet");
  return `
    <aside class="sidebar wide" data-stop="1">
      <div class="drawer-head">
        <h2>按通勤筛房</h2>
        <button class="btn btn-secondary" type="button" data-action="close-drawer">关闭</button>
      </div>
      <div class="drawer-body">
        <div class="tabs">
          ${[30, 45, 60]
            .map(
              (value) =>
                `<button type="button" class="${cap === value ? "is-on" : ""}" data-action="commute" data-value="${value}">${value} 分钟</button>`,
            )
            .join("")}
        </div>
        <p class="demo-hint">公司：陆家嘴。通勤分钟写在房源上。${pet ? "已开启宠物过滤。" : ""}</p>
        ${
          list.length
            ? list
                .map((listing) => {
                  const selected = plan.listings.selectedId === listing.id;
                  return `
                    <button type="button" class="listing-row ${selected ? "is-selected" : ""}" data-action="pick-listing" data-id="${listing.id}">
                      <img src="${esc(listing.cover)}" alt="${esc(listing.title)}" width="88" height="88" />
                      <div>
                        <div class="card-title">${esc(listing.title)}</div>
                        <div class="fee-note">${esc(listing.area)} · 月租 ${formatYuan(listing.monthlyRent)} · 通勤 ${listing.commuteMinutes} 分钟</div>
                        <div class="fee-note">${listing.petsAllowed ? "可养宠物" : "不允许宠物"} · 起租 ${formatMD(listing.availableFrom)}</div>
                        ${listing.id === DEFAULT_PICK_ID ? `<div class="demo-hint">路演默认点这套</div>` : ""}
                        <div class="fee-note">${esc(listing.pitch)}</div>
                      </div>
                    </button>
                  `;
                })
                .join("")
            : `<p class="empty-hint">没有符合条件的房子。试试放宽通勤到 60 分钟。${pet ? "本 Demo 不能删掉宠物约束，只能重置。" : ""}</p>`
        }
      </div>
    </aside>
  `;
}

const TOUR_KEY = "banban-onboard-v1";
let tourLaidId = "";
let tourFollowTimer = null;

const TOUR_STEPS = [
  {
    id: "prompt",
    title: "在这里说清搬家约束",
    body: "写从哪搬到哪、退租和报到日期、一次性预算，以及旧物怎么处理。右下角麦克风可以语音输入。",
    next: "下一步",
    anchor: () => "[data-tour='prompt']",
  },
  {
    id: "generate",
    title: "生成计划会摊开整盘",
    body: "点「生成计划」后，旧房、新房和日程会一起出现。还没拍照、没选房的地方先留白，等你补上再长出来。",
    next: "下一步",
    anchor: () => "[data-tour='generate']",
  },
  {
    id: "demo",
    title: "先点 Demo 走一遍",
    body: (s) =>
      s.busy === "plan"
        ? "正在按示例要求摊开旧房、新房和日程。好了就带你继续。"
        : "第一次不用自己写。点「Demo试运行」，会填好一句示例要求，并带你看完认旧物、选房和置办。",
    hint: (s) => (s.busy === "plan" ? "请稍等" : "请点击「Demo试运行」"),
    wait: "board",
    pass: (s) => s.busy !== "plan",
    anchor: (s) => (s.busy === "plan" ? "[data-tour='think']" : "[data-tour='demo']"),
  },
  {
    id: "query",
    title: "要求被划出来了",
    body: "划线是日期、地点、预算和待办。之后点「编辑」改一句，时间和花费会一起重算。",
    next: "下一步",
    anchor: () => "[data-tour='query']",
  },
  {
    id: "sample",
    title: "旧房先留白",
    body: (s) =>
      s.scanning
        ? "正在按这张照片认旧物，认出后会列出沙发、桌椅和床垫。"
        : "点「用示例房间」，或上传一张房屋照片。每件旧物可以转卖、丢弃或带走。",
    hint: (s) => (s.scanning ? "请稍等" : "请点击「用示例房间」"),
    wait: "items-ready",
    pass: (s) => !s.scanning,
    anchor: (s) => (s.scanning || s.roomPhoto ? "[data-tour='old']" : "[data-tour='sample']"),
  },
  {
    id: "sell",
    title: "给旧沙发选转卖",
    body: "点「转卖」。预计回款标在卡片上，并出现「生成转卖帖」。丢弃和带走会改一次性花费。回款先不算进已经花掉的钱。",
    hint: "请点击「转卖」",
    wait: "sold",
    pass: true,
    anchor: () => "[data-tour='sell']",
  },
  {
    id: "post",
    title: "生成小红书转卖帖",
    body: "点「生成转卖帖」，会写出可复制的帖子。这里只预览，不会真的发出去。",
    hint: "请点击「生成转卖帖」",
    wait: "post-open",
    pass: true,
    anchor: () => "[data-tour='post']",
  },
  {
    id: "post-close",
    title: "这是要复制的帖子",
    body: (s) =>
      s.busy === "post"
        ? "正在写转卖帖。写好后可以复制，再点「关闭」回到计划。"
        : "上图下文加标签，就是即将复制去发的帖子。看完点「关闭」。",
    hint: "请点击「关闭」",
    wait: "closed",
    pass: true,
    anchor: () => "[data-tour='close-post']",
  },
  {
    id: "pick-home",
    title: "新房也先留白",
    body: "点「选一套」。会按通勤上限列出小红书房源，公司地点是陆家嘴。",
    hint: "请点击「选一套」",
    wait: "picking",
    pass: true,
    anchor: () => "[data-tour='pick-home']",
  },
  {
    id: "listing",
    title: "点一套能通勤的",
    body: "这套是示例默认房：通勤合格，方便接着置办家具。点它打开详情。",
    hint: "请点击这套房源",
    wait: "picked",
    pass: true,
    anchor: () => "[data-tour='listing']",
  },
  {
    id: "confirm-listing",
    title: "房源详情在侧栏",
    body: "月租、位置、通勤、起租和宠物按列表展示。点「就这套」写回计划。",
    hint: "请点击「就这套」",
    wait: "closed",
    pass: true,
    anchor: () => "[data-tour='confirm-listing']",
  },
  {
    id: "pick-buy",
    title: "选完房再置办",
    body: "点「置办家具」。新家要买的东西会列出来，预算不够就降级或砍掉。",
    hint: "请点击「置办家具」",
    wait: "furnished",
    pass: true,
    anchor: () => "[data-tour='pick-buy']",
  },
  {
    id: "buy",
    title: "置办清单可以改",
    body: "每行能降级或砍掉。一次性花费跟着变，月租不占那 8000 的预算。",
    next: "下一步",
    anchor: () => "[data-tour='buy']",
  },
  {
    id: "timeline",
    title: "日程按月翻",
    body: "退租、起租、报到标在日历上。左右箭头可以翻月。改要求后，这些日期会重算。",
    next: "下一步",
    anchor: () => "[data-tour='timeline']",
  },
  {
    id: "done",
    title: "这遍走完了",
    body: "之后可以自己写一句再生成，或点「编辑」改要求。点「重置 Demo」会回到开头。",
    next: "开始使用",
    finish: true,
    center: true,
  },
];

function tourText(value) {
  return typeof value === "function" ? value(state) : value || "";
}

function tourPass(step) {
  if (!step || step.center) return false;
  if (typeof step.pass === "function") return step.pass(state);
  return Boolean(step.pass);
}

function endTour() {
  state.tour = null;
  tourLaidId = "";
  try {
    localStorage.setItem(TOUR_KEY, "1");
  } catch {
    /* ignore */
  }
  render();
}

function noteTour(name) {
  if (state.tour == null) return;
  const step = TOUR_STEPS[state.tour];
  if (!step || step.wait !== name) return;
  state.tour += 1;
  if (state.tour >= TOUR_STEPS.length) {
    state.tour = null;
    tourLaidId = "";
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* ignore */
    }
  }
}

function advanceTour() {
  if (state.tour == null) return;
  const step = TOUR_STEPS[state.tour];
  if (step?.finish) {
    endTour();
    return;
  }
  state.tour += 1;
  if (state.tour >= TOUR_STEPS.length) {
    endTour();
    return;
  }
  render();
}

function placeTourBox(el, x, y, width, height) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, width)}px`;
  el.style.height = `${Math.max(0, height)}px`;
}

function placeTourCard(card, hole, anchor) {
  const margin = 16;
  const gap = 12;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sidebar = anchor?.closest(".sidebar");
  if (sidebar) {
    const side = sidebar.getBoundingClientRect();
    const left = side.left - gap - cw;
    const top = Math.max(margin, Math.min(hole.top, vh - margin - ch));
    if (left >= margin) {
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      return;
    }
  }
  const centerLeft = Math.max(margin, Math.min(hole.left + hole.width / 2 - cw / 2, vw - margin - cw));
  const candidates = [
    { left: centerLeft, top: hole.bottom + gap },
    { left: centerLeft, top: hole.top - gap - ch },
    { left: hole.right + gap, top: Math.max(margin, Math.min(hole.top, vh - margin - ch)) },
    { left: hole.left - gap - cw, top: Math.max(margin, Math.min(hole.top, vh - margin - ch)) },
  ];
  const fits = (pos) => pos.top >= margin && pos.left >= margin && pos.top + ch <= vh - margin && pos.left + cw <= vw - margin;
  const hits = (pos) => pos.left < hole.right && pos.left + cw > hole.left && pos.top < hole.bottom && pos.top + ch > hole.top;
  const pick = candidates.find((pos) => fits(pos) && !hits(pos)) || candidates.find((pos) => fits(pos)) || candidates[0];
  card.style.left = `${Math.max(margin, Math.min(pick.left, vw - margin - cw))}px`;
  card.style.top = `${Math.max(margin, Math.min(pick.top, vh - margin - ch))}px`;
}

function layoutTour(scroll) {
  const step = state.tour == null ? null : TOUR_STEPS[state.tour];
  const root = document.querySelector(".tour-root");
  if (!step || !root) return;
  const card = root.querySelector(".tour-card");
  const ring = root.querySelector(".tour-ring");
  const shield = root.querySelector(".tour-shield");
  const full = root.querySelector(".tour-dim-full");
  const dims = ["top", "left", "right", "bottom"].map((name) => root.querySelector(`.tour-dim-${name}`));
  const anchor = step.anchor ? document.querySelector(step.anchor(state)) : null;
  if (step.center || !anchor) {
    full.hidden = false;
    ring.hidden = true;
    shield.hidden = true;
    dims.forEach((el) => {
      el.hidden = true;
    });
    card.classList.add("is-center");
    card.style.top = "";
    card.style.left = "";
    return;
  }
  if (scroll) anchor.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = anchor.getBoundingClientRect();
  const pad = 6;
  const hole = {
    left: Math.max(8, rect.left - pad),
    top: Math.max(8, rect.top - pad),
    right: Math.min(window.innerWidth - 8, rect.right + pad),
    bottom: Math.min(window.innerHeight - 8, rect.bottom + pad),
  };
  hole.width = hole.right - hole.left;
  hole.height = hole.bottom - hole.top;
  full.hidden = true;
  dims.forEach((el) => {
    el.hidden = false;
  });
  placeTourBox(dims[0], 0, 0, window.innerWidth, hole.top);
  placeTourBox(dims[1], 0, hole.top, hole.left, hole.height);
  placeTourBox(dims[2], hole.right, hole.top, window.innerWidth - hole.right, hole.height);
  placeTourBox(dims[3], 0, hole.bottom, window.innerWidth, window.innerHeight - hole.bottom);
  ring.hidden = false;
  placeTourBox(ring, hole.left, hole.top, hole.width, hole.height);
  ring.style.borderRadius = getComputedStyle(anchor).borderRadius || "12px";
  const pass = tourPass(step);
  shield.hidden = pass;
  if (!pass) placeTourBox(shield, hole.left, hole.top, hole.width, hole.height);
  card.classList.remove("is-center");
  placeTourCard(card, hole, anchor);
}

function mountTour() {
  document.querySelector(".tour-root")?.remove();
  if (state.tour == null) return;
  const step = TOUR_STEPS[state.tour];
  if (!step) {
    endTour();
    return;
  }
  const hint = tourText(step.hint);
  const primary = step.next
    ? `<button class="btn btn-primary" type="button" data-action="${step.finish ? "tour-finish" : "tour-next"}">${esc(step.next)}</button>`
    : "";
  const skip = step.finish ? "" : `<button class="btn btn-text" type="button" data-action="tour-skip">跳过</button>`;
  const root = document.createElement("div");
  root.className = "tour-root";
  root.innerHTML = `
    <div class="tour-dim tour-dim-full"></div>
    <div class="tour-dim tour-dim-top" hidden></div>
    <div class="tour-dim tour-dim-left" hidden></div>
    <div class="tour-dim tour-dim-right" hidden></div>
    <div class="tour-dim tour-dim-bottom" hidden></div>
    <div class="tour-shield" hidden></div>
    <div class="tour-ring" hidden></div>
    <div class="tour-card" role="dialog" aria-labelledby="tour-title">
      <p class="tour-kicker">${state.tour + 1} / ${TOUR_STEPS.length}</p>
      <h2 id="tour-title">${esc(step.title)}</h2>
      <p class="tour-body">${esc(tourText(step.body))}</p>
      <div class="tour-actions">${hint ? `<p class="tour-hint">${esc(hint)}</p>` : ""}${primary}${skip}</div>
    </div>
  `;
  document.getElementById("app").appendChild(root);
  const scroll = tourLaidId !== step.id;
  tourLaidId = step.id;
  layoutTour(scroll);
  clearTimeout(tourFollowTimer);
  tourFollowTimer = setTimeout(() => layoutTour(false), 700);
}

function render() {
  const root = document.getElementById("app");
  const scroller = document.querySelector("#app.is-board .app-main");
  const scrollY = scroller ? scroller.scrollTop : window.scrollY;
  const showSidebar = state.view === "board" ? Boolean(state.drawer) : state.drawer?.type === "about";
  root.classList.toggle("is-board", state.view === "board");
  root.classList.toggle("is-start", state.view === "start");
  root.classList.toggle("has-sidebar", showSidebar);
  if (state.view === "start") {
    root.innerHTML = `${topbarHtml(false)}<div class="app-shell"><div class="app-main">${startHtml()}</div>${showSidebar ? aboutDrawerHtml() : ""}</div>`;
  } else {
    root.innerHTML = `${topbarHtml(true)}<div class="app-shell"><div class="app-main">${boardHtml()}</div>${drawerHtml()}</div>`;
  }
  if (state.toast) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = state.toast;
    root.appendChild(toast);
  }
  const next = document.querySelector("#app.is-board .app-main");
  if (next) next.scrollTop = scrollY;
  else window.scrollTo(0, scrollY);
  mountTour();
}

let recognition = null;

function setMicUi(on) {
  const btn = document.querySelector(".btn-mic");
  if (!btn) return;
  btn.classList.toggle("is-on", on);
  btn.setAttribute("aria-label", on ? "停止语音输入" : "语音输入");
}

function writePrompt(text) {
  state.prompt = text;
  const area = document.querySelector("textarea.prompt");
  if (area) area.value = text;
}

function stopVoice() {
  state.listening = false;
  try {
    recognition?.stop();
  } catch {
    /* ignore */
  }
  setMicUi(false);
}

async function toggleVoice() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) {
    showToast("请用 Chrome 打开后再用语音");
    return;
  }
  if (state.listening) {
    stopVoice();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    showToast("需要允许麦克风权限");
    return;
  }
  recognition = new Speech();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  let committed = state.prompt.trim();
  recognition.onresult = (event) => {
    let finalPiece = "";
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalPiece += piece;
      else interim += piece;
    }
    if (finalPiece.trim()) {
      const next = finalPiece.trim();
      committed = committed ? `${committed}${/[。，,、！？]$/.test(committed) ? "" : "，"}${next}` : next;
      writePrompt(committed);
    } else if (interim) {
      writePrompt(committed ? `${committed}${interim}` : interim);
    }
  };
  recognition.onend = () => {
    if (state.listening) {
      try {
        recognition.start();
      } catch {
        stopVoice();
      }
    } else {
      setMicUi(false);
    }
  };
  recognition.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    stopVoice();
    if (event.error === "not-allowed") showToast("需要允许麦克风权限");
    else showToast("语音输入未完成");
  };
  state.listening = true;
  setMicUi(true);
  try {
    recognition.start();
  } catch {
    stopVoice();
    showToast("语音输入启动失败");
  }
}

function restoreCatalog() {
  if (state.baseCatalog) state.catalog = clone(state.baseCatalog);
}

function startThinkCycle() {
  clearInterval(thinkTimer);
  state.thinkStep = 0;
  thinkTimer = setInterval(() => {
    if (state.thinkStep >= THINK_STEPS.length - 1) return;
    state.thinkStep += 1;
    render();
  }, THINK_INTERVAL);
}

function stopThinkCycle() {
  clearInterval(thinkTimer);
  thinkTimer = null;
  state.thinkStep = THINK_STEPS.length - 1;
}

function capturePlanChoices(plan) {
  return {
    photo: state.roomPhoto,
    picking: state.pickingHome,
    showBuy: state.showBuy,
    selected: plan.listings.selectedId,
    items: plan.items.map((item) => ({
      name: itemSpec(state.catalog, item.id)?.name,
      disposition: item.disposition,
    })),
    buy: plan.buy.map((row) => ({
      name: buySpec(state.catalog, row.id)?.name,
      status: row.status,
    })),
    drawer: state.drawer,
  };
}

function restorePlanChoices(plan, kept) {
  plan.items.forEach((item) => {
    const name = itemSpec(state.catalog, item.id)?.name;
    const old = kept.items.find((row) => row.name && row.name === name);
    if (old) item.disposition = old.disposition;
  });
  plan.buy.forEach((row) => {
    const name = buySpec(state.catalog, row.id)?.name;
    const old = kept.buy.find((item) => item.name && item.name === name);
    if (old) row.status = old.status;
  });
  const stillOk = Boolean(kept.selected && filterListings(plan, state.catalog).some((row) => row.id === kept.selected));
  plan.listings.selectedId = stillOk ? kept.selected : null;
  syncPlan(plan, state.catalog);
  state.roomPhoto = kept.photo;
  state.pickingHome = stillOk ? false : kept.selected ? true : kept.picking;
  state.showBuy = stillOk ? kept.showBuy : false;
  if (!stillOk && kept.drawer?.type === "listing") state.drawer = null;
}

async function buildLivePlan(sentence) {
  if (canCallModel(state.model)) {
    const plan = await generatePlan({
      config: state.model,
      sentence,
      defaultPlan: state.defaultPlan,
      catalog: state.catalog,
    });
    return { plan, usedModel: true };
  }
  const plan = sanitizeGeneratedPlan(null, sentence, state.defaultPlan, state.catalog, { live: true });
  return { plan, usedModel: false };
}

function applyDemoNotes(plan) {
  const itemLines = {
    "item-sofa": "旧沙发可转卖或清运",
    "item-table": "桌椅可低价转卖",
    "item-mattress": "旧床垫建议直接清运",
  };
  plan.items.forEach((item) => {
    if (!item.note && itemLines[item.id]) item.note = itemLines[item.id];
  });
  const pet = plan.constraints.some((row) => row.kind === "pet");
  plan.houseNote = `陆家嘴附近，通勤 ${plan.listings.commuteCap} 分钟内${pet ? "，要能养宠物" : ""}。`;
}

function currentQueryText() {
  const initial = state.plan?.constraints.find((item) => item.kind === "initial") || state.plan?.constraints[0];
  return initial?.text || state.prompt;
}

function beginEditQuery() {
  state.editingQuery = true;
  state.queryDraft = currentQueryText();
  render();
  const area = document.querySelector("textarea.query-edit");
  if (!area) return;
  area.focus();
  const end = area.value.length;
  area.setSelectionRange(end, end);
}

async function onSaveQuery() {
  if (!state.plan || state.busy) return;
  const sentence = state.queryDraft.trim();
  if (!sentence) {
    showToast("先写一句搬家要求");
    return;
  }
  const kept = capturePlanChoices(state.plan);
  const live = state.mode === "live";
  let plan;
  if (live) {
    state.busy = "plan";
    render();
    try {
      const result = await buildLivePlan(sentence);
      plan = result.plan;
      state.fallbackBanner = !result.usedModel;
    } catch {
      restoreCatalog();
      plan = sanitizeGeneratedPlan(null, sentence, state.defaultPlan, state.catalog, { live: true });
      state.fallbackBanner = true;
    }
    state.busy = null;
  } else {
    plan = sanitizeGeneratedPlan(null, sentence, state.defaultPlan, state.catalog);
    applyDemoNotes(plan);
  }
  restorePlanChoices(plan, kept);
  state.plan = plan;
  state.prompt = sentence;
  state.editingQuery = false;
  state.queryDraft = "";
  showCalMonth(plan.dates.moveOut);
  state.animate = true;
  state.enterKind = "board";
  render();
  const markCount = document.querySelectorAll(".query-mark").length;
  clearTimeout(stepTimer);
  stepTimer = setTimeout(() => {
    state.animate = false;
  }, 720 + markCount * 220);
  showToast(kept.selected && !plan.listings.selectedId ? "约束变了，请重新选房" : "已更新要求");
}

function enterBoard() {
  clearTimeout(stepTimer);
  clearTimeout(scanTimer);
  state.view = "board";
  state.animate = true;
  state.enterKind = "board";
  state.scanning = false;
  state.pickingHome = false;
  state.showBuy = false;
  showCalMonth(state.plan.dates.moveOut);
  noteTour("board");
  render();
  const markCount = document.querySelectorAll(".query-mark").length;
  stepTimer = setTimeout(() => {
    state.animate = false;
  }, 720 + markCount * 220);
}

function beginScan(src) {
  clearTimeout(stepTimer);
  clearTimeout(scanTimer);
  state.roomPhoto = src;
  state.scanning = true;
  state.animate = true;
  state.enterKind = "photo";
  render();
  scanTimer = setTimeout(() => {
    if (state.view !== "board" || !state.scanning) return;
    state.scanning = false;
    state.animate = true;
    state.enterKind = "items";
    noteTour("items-ready");
    render();
    const itemCount = document.querySelectorAll(".item-card").length;
    stepTimer = setTimeout(() => {
      state.animate = false;
    }, 780 + itemCount * 160);
  }, 1300);
}

function settleGeneratedPlan(plan, usedModel) {
  state.plan = plan;
  state.fallbackBanner = state.mode === "live" && !usedModel;
  state.drawer = null;
  state.roomPhoto = "";
  state.busy = null;
  stopThinkCycle();
  enterBoard();
  if (state.fallbackBanner) showToast("这次按原句本地拆了一版");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDemoPlan() {
  restoreCatalog();
  const plan = sanitizeGeneratedPlan(null, DEFAULT_PROMPT, state.defaultPlan, state.catalog);
  applyDemoNotes(plan);
  syncPlan(plan, state.catalog);
  return plan;
}

function onDemoGenerate() {
  if (state.busy) return;
  state.prompt = DEFAULT_PROMPT;
  runGenerate({ mock: true });
}

function onGenerate() {
  runGenerate({ mock: false });
}

async function runGenerate({ mock }) {
  if (state.busy) return;
  stopVoice();
  const sentence = state.prompt.trim();
  if (!sentence) {
    showToast("请输入搬家计划");
    return;
  }
  state.mode = mock ? "demo" : "live";
  state.busy = "plan";
  state.thinkStep = 0;
  startThinkCycle();
  render();
  if (mock) {
    await wait(THINK_INTERVAL * (THINK_STEPS.length - 1) + 700);
    if (state.busy !== "plan") return;
    settleGeneratedPlan(buildDemoPlan(), true);
    return;
  }
  try {
    const result = await buildLivePlan(sentence);
    if (state.busy !== "plan") return;
    settleGeneratedPlan(result.plan, result.usedModel);
  } catch {
    if (state.busy !== "plan") return;
    restoreCatalog();
    const plan = sanitizeGeneratedPlan(null, sentence, state.defaultPlan, state.catalog, { live: true });
    settleGeneratedPlan(plan, false);
  }
}

async function onAppend(event) {
  event.preventDefault();
  if (!state.plan || state.busy) return;
  const text = state.appendDraft.trim();
  if (!text) return;
  state.busy = "rewrite";
  render();

  let classified = classifyConstraint(text);
  if (canCallModel(state.model) && classified.kind === "note") {
    try {
      const kind = await classifyWithModel({ config: state.model, text });
      if (kind === "pet") classified = { kind: "pet" };
      if (kind === "budget" || kind === "deadline") {
        const again = classifyConstraint(text);
        classified = again.kind === kind ? again : { kind: "note" };
      }
    } catch {
      /* keep rule result */
    }
  }

  const result = applyConstraint(state.plan, state.catalog, text, classified);
  if (result.kind !== "note" && state.plan.lastChange && canCallModel(state.model)) {
    try {
      state.plan.lastChange.explanation = await generateExplanation({
        config: state.model,
        change: state.plan.lastChange,
      });
    } catch {
      state.plan.lastChange.explanation = templateExplanation(state.plan.lastChange);
    }
  }

  state.appendDraft = "";
  state.busy = null;
  if (result.housingFlash) {
    state.housingFlash = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state.housingFlash = false;
      render();
    }, 600);
  }
  if (result.kind !== "note") showToast("已按新约束重算");
  else showToast("已加入备注待办");
  render();
}

async function onOpenPost(itemId) {
  const item = itemSpec(state.catalog, itemId);
  const fallback = state.catalog.posts[itemId] || {
    title: `${item?.name || "旧物"} 北京自提`,
    body: item?.sellHint || "北京自提，不邮寄。",
    tags: ["搬家出清", "北京自提"],
  };
  state.drawer = { type: "post", itemId, post: fallback };
  state.busy = "post";
  noteTour("post-open");
  render();
  if (canCallModel(state.model)) {
    try {
      const post = await generatePost({ config: state.model, item });
      state.drawer.post = post;
    } catch {
      state.drawer.post = fallback;
    }
  }
  state.busy = null;
  render();
}

async function copyPost() {
  const post = state.drawer?.post;
  if (!post) return;
  const text = composePostText(post);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast("复制成功");
}

function onPickListing(id) {
  selectListing(state.plan, state.catalog, id);
  state.drawer = { type: "listing", listingId: id };
  state.pickingHome = false;
  state.showBuy = false;
  state.animate = true;
  state.enterKind = "house";
  noteTour("picked");
  render();
}

function onOpenListing(id) {
  if (!listingSpec(state.catalog, id)) return;
  state.drawer = { type: "listing", listingId: id };
  render();
}

function resetDemo() {
  stopVoice();
  clearTimeout(stepTimer);
  clearTimeout(scanTimer);
  stopThinkCycle();
  restoreCatalog();
  state.view = "start";
  state.plan = null;
  state.mode = "";
  state.thinkStep = 0;
  state.fallbackBanner = false;
  state.drawer = null;
  state.appendDraft = "";
  state.housingFlash = false;
  state.busy = null;
  state.prompt = "";
  state.roomPhoto = "";
  state.scanning = false;
  state.animate = false;
  state.enterKind = "";
  state.pickingHome = false;
  state.showBuy = false;
  state.editingQuery = false;
  state.queryDraft = "";
  state.calYear = null;
  state.calMonth = null;
  render();
}

function onClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  state.animate = false;
  const action = target.dataset.action;

  if (action === "tour-next") {
    advanceTour();
    return;
  }
  if (action === "tour-skip" || action === "tour-finish") {
    endTour();
    return;
  }
  if (action === "generate") onGenerate();
  if (action === "edit-query") beginEditQuery();
  if (action === "cancel-query") {
    state.editingQuery = false;
    state.queryDraft = "";
    render();
  }
  if (action === "save-query") onSaveQuery();
  if (action === "cal-prev") shiftCalMonth(-1);
  if (action === "cal-next") shiftCalMonth(1);
  if (action === "pick-photo") document.querySelector(".room-file")?.click();
  if (action === "use-sample") beginScan("./assets/room.svg");
  if (action === "pick-home") {
    state.pickingHome = true;
    state.showBuy = false;
    state.animate = true;
    state.enterKind = "listings";
    noteTour("picking");
    render();
  }
  if (action === "repick-home") {
    state.pickingHome = true;
    state.showBuy = false;
    state.animate = true;
    state.enterKind = "listings";
    render();
  }
  if (action === "pick-buy") {
    if (!state.plan?.listings.selectedId) return;
    state.showBuy = true;
    state.animate = true;
    state.enterKind = "buy";
    noteTour("furnished");
    render();
  }
  if (action === "demo-run") onDemoGenerate();
  if (action === "voice") toggleVoice();
  if (action === "reset") resetDemo();
  if (action === "dispose") {
    setDisposition(state.plan, state.catalog, target.dataset.id, target.dataset.value);
    const item = state.plan.items.find((row) => row.id === target.dataset.id);
    if (state.drawer?.type === "post" && state.drawer.itemId === target.dataset.id && item?.disposition !== "sell") {
      state.drawer = null;
    }
    if (item?.disposition === "sell") noteTour("sold");
    render();
  }
  if (action === "open-post") onOpenPost(target.dataset.id);
  if (action === "open-about") {
    state.drawer = state.drawer?.type === "about" ? null : { type: "about" };
    render();
  }
  if (action === "close-drawer") {
    state.drawer = null;
    noteTour("closed");
    render();
  }
  if (action === "copy-post") copyPost();
  if (action === "open-listings") {
    state.drawer = { type: "listings" };
    render();
  }
  if (action === "commute") {
    const result = setCommuteCap(state.plan, state.catalog, Number(target.dataset.value));
    if (!state.plan.listings.selectedId) {
      state.pickingHome = true;
      state.showBuy = false;
    }
    if (result.cleared) {
      state.housingFlash = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        state.housingFlash = false;
        render();
      }, 600);
      showToast("已按新约束重算");
    }
    render();
  }
  if (action === "pick-listing") onPickListing(target.dataset.id);
  if (action === "open-listing") onOpenListing(target.dataset.id);
  if (action === "buy-status") {
    setBuyStatus(state.plan, state.catalog, target.dataset.id, target.dataset.value);
    render();
  }
}

function onInput(event) {
  const field = event.target.dataset.field;
  if (field === "prompt") state.prompt = event.target.value;
  if (field === "append") state.appendDraft = event.target.value;
  if (field === "query") state.queryDraft = event.target.value;
}

function onFile(event) {
  const file = event.target.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => beginScan(String(reader.result || ""));
  reader.readAsDataURL(file);
}

function onSubmit(event) {
  if (event.target.dataset.action === "append-form") onAppend(event);
}

window.addEventListener("resize", () => {
  if (state.tour == null) return;
  layoutTour(false);
});
document.addEventListener(
  "scroll",
  () => {
    if (state.tour == null) return;
    layoutTour(false);
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.tour != null) endTour();
});

document.getElementById("app").addEventListener("click", onClick);
document.getElementById("app").addEventListener("input", onInput);
document.getElementById("app").addEventListener("change", onFile);
document.getElementById("app").addEventListener("submit", onSubmit);

boot().catch((error) => {
  document.getElementById("app").innerHTML = `<p class="wrap">加载失败：${esc(error.message)}</p>`;
});
