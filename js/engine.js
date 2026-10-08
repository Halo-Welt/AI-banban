export const MOVE_COST = 2000;
export const TRANSITION_PER_NIGHT = 400;
export const MOVE_OUT = "2026-06-30";
export const DEFAULT_REPORT = "2026-07-15";
export const DEFAULT_PICK_ID = "lz-minsheng";

export const DEFAULT_PROMPT =
  "6月30日北京退租，7月15日上海陆家嘴报到，一次性预算8000，旧沙发桌椅床垫要处理，新家通勤不超过45分钟。";

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function formatMD(iso) {
  if (!iso) return "—";
  const parts = iso.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export function formatYuan(n) {
  return `¥${Number(n).toLocaleString("zh-CN")}`;
}

export function itemSpec(catalog, id) {
  return catalog.items.find((item) => item.id === id);
}

export function listingSpec(catalog, id) {
  return catalog.listings.find((item) => item.id === id) || null;
}

export function buySpec(catalog, id) {
  return catalog.buy.find((item) => item.id === id);
}

export function buyAmount(catalog, row) {
  const spec = buySpec(catalog, row.id);
  if (!spec) return 0;
  if (row.status === "cut") return 0;
  if (row.status === "downgraded") return spec.downgraded ?? 0;
  return spec.planned;
}

export function statusLabel(status) {
  if (status === "downgraded") return "已降级";
  if (status === "cut") return "已砍掉";
  return "计划中";
}

export function hasPetConstraint(plan) {
  return plan.constraints.some((item) => item.kind === "pet");
}

export function transitionNights(plan, catalog) {
  const listing = listingSpec(catalog, plan.listings.selectedId);
  if (!listing) return 0;
  if (listing.availableFrom <= plan.dates.moveOut) return 0;
  return daysBetween(plan.dates.moveOut, listing.availableFrom);
}

export function occupiedOneOff(plan, catalog) {
  let total = plan.ledger.moveCost ?? MOVE_COST;
  for (const item of plan.items) {
    const spec = itemSpec(catalog, item.id);
    if (!spec) continue;
    if (item.disposition === "discard") total += spec.discardFee || 0;
    if (item.disposition === "take") total += spec.haulFee || 0;
  }
  total += transitionNights(plan, catalog) * TRANSITION_PER_NIGHT;
  for (const row of plan.buy) total += buyAmount(catalog, row);
  return total;
}

export function expectedResale(plan, catalog) {
  let total = 0;
  for (const item of plan.items) {
    if (item.disposition !== "sell") continue;
    total += itemSpec(catalog, item.id)?.resale || 0;
  }
  return total;
}

export function syncPlan(plan, catalog) {
  const listing = listingSpec(catalog, plan.listings.selectedId);
  plan.dates.transitionNights = transitionNights(plan, catalog);
  plan.dates.leaseStart = listing ? listing.availableFrom : null;
  plan.ledger.moveCost = MOVE_COST;
  plan.ledger.monthlyRent = listing ? listing.monthlyRent : null;
  plan.ledger.expectedResale = expectedResale(plan, catalog);
  plan.ledger.occupiedOneOff = occupiedOneOff(plan, catalog);
  return plan;
}

export function autoCutFurnishings(plan, catalog) {
  const diffs = [];
  const order = [...catalog.buy].sort((a, b) => a.cutOrder - b.cutOrder);
  const over = () => occupiedOneOff(plan, catalog) > plan.ledger.oneOffBudget;

  for (const spec of order) {
    if (!over()) break;
    const row = plan.buy.find((item) => item.id === spec.id);
    if (!row || row.status === "cut") continue;

    if (spec.downgraded != null && row.status === "planned") {
      row.status = "downgraded";
      diffs.push(`${spec.name}从计划中 ${formatYuan(spec.planned)} 降为 ${formatYuan(spec.downgraded)}`);
      if (!over()) break;
    }

    if (row.status !== "cut" && over()) {
      const fromLabel = statusLabel(row.status);
      const fromAmount = buyAmount(catalog, row);
      row.status = "cut";
      diffs.push(`${spec.name}从${fromLabel} ${formatYuan(fromAmount)} 砍掉`);
    }
  }

  syncPlan(plan, catalog);
  return diffs;
}

export function filterListings(plan, catalog) {
  const cap = plan.listings.commuteCap;
  const petsOnly = hasPetConstraint(plan);
  return catalog.listings.filter((listing) => {
    if (listing.commuteMinutes > cap) return false;
    if (petsOnly && !listing.petsAllowed) return false;
    return true;
  });
}

export function classifyConstraint(text) {
  const raw = text.trim();
  if (/养猫|宠物|能养|宠物友好/.test(raw)) return { kind: "pet" };

  if (/预算|砍到|一次性/.test(raw)) {
    const match = raw.match(/(\d{3,6})/);
    if (match) return { kind: "budget", oneOffBudget: Number(match[1]) };
  }

  if (/报到|提前/.test(raw)) {
    const match =
      raw.match(/(\d{1,2})\s*[月/.]\s*(\d{1,2})/) ||
      raw.match(/(\d{1,2})月(\d{1,2})日/);
    if (match) {
      const month = String(Number(match[1])).padStart(2, "0");
      const day = String(Number(match[2])).padStart(2, "0");
      return { kind: "deadline", reportBy: `2026-${month}-${day}` };
    }
  }

  return { kind: "note" };
}

export function nextId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseChineseMoney(chunk) {
  const text = String(chunk || "").replace(/\s+/g, "");
  if (!text) return null;
  const wanDigit = text.match(/^(\d+(?:\.\d+)?)万([一二三四五六七八九两])?$/);
  if (wanDigit) {
    return Math.round(Number(wanDigit[1]) * 10000 + (wanDigit[2] ? CN_DIGIT[wanDigit[2]] * 1000 : 0));
  }
  const wan = text.match(/^([一二三四五六七八九两])?万([一二三四五六七八九两])?$/);
  if (wan) return (wan[1] ? CN_DIGIT[wan[1]] : 1) * 10000 + (wan[2] ? CN_DIGIT[wan[2]] * 1000 : 0);
  const qian = text.match(/^([一二三四五六七八九两])千([一二三四五六七八九])?$/);
  if (qian) return CN_DIGIT[qian[1]] * 1000 + (qian[2] ? CN_DIGIT[qian[2]] * 100 : 0);
  return null;
}

function budgetFromSentence(sentence) {
  const digit = sentence.match(/预算\s*(\d{3,6})/) || sentence.match(/(\d{4,6})\s*元/);
  if (digit) {
    const value = Number(digit[1]);
    if (value >= 1000 && value <= 200000) return value;
  }
  const wan = sentence.match(/预算\s*(\d+(?:\.\d+)?)\s*万/) || sentence.match(/一次性[^\n]{0,6}(\d+(?:\.\d+)?)\s*万/);
  if (wan) {
    const value = Math.round(Number(wan[1]) * 10000);
    if (value >= 1000 && value <= 200000) return value;
  }
  const cn = sentence.match(/预算\s*([一二三四五六七八九十两零\d.万千]+)/) || sentence.match(/一次性[^\n]{0,8}([一二三四五六七八九十两零\d.万千]+)/);
  if (cn) {
    const value = parseChineseMoney(cn[1]);
    if (value >= 1000 && value <= 200000) return value;
  }
  const loose = sentence.match(/(\d{4,6})/);
  if (loose && /预算|一次性/.test(sentence)) {
    const value = Number(loose[1]);
    if (value >= 1000 && value <= 200000) return value;
  }
  return null;
}

function commuteFromSentence(sentence) {
  if (/半小时|半个小时/.test(sentence)) return 30;
  if (/一个小时|1\s*小时|六十分钟/.test(sentence)) return 60;
  if (/四十五分钟/.test(sentence)) return 45;
  const cap = sentence.match(/通勤[^\d]{0,8}(\d{2,3})/) || sentence.match(/不超过\s*(\d{2,3})\s*分钟/) || sentence.match(/(\d{2,3})\s*分钟/);
  if (cap) {
    const value = Number(cap[1]);
    if (value >= 20 && value <= 120) return value;
  }
  return null;
}

const BOUNDARY_WHEN = "\\d{1,2}月\\d{1,2}[日号]?|下个?月月底|月底|月初|月中|下个?月|这个?月|本月|\\d{4}-\\d{2}-\\d{2}";

function eventDated(sentence, keyword) {
  const when = new RegExp(BOUNDARY_WHEN);
  return String(sentence || "")
    .split(/[，,。；;！!？?\n]/)
    .some((clause) => keyword.test(clause) && when.test(clause.replace(/\s+/g, "")));
}

function mentionedDates(sentence) {
  const found = [];
  const re = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g;
  let match = re.exec(sentence);
  while (match) {
    found.push(`${Number(match[1])}月${Number(match[2])}日`);
    match = re.exec(sentence);
  }
  return [...new Set(found)];
}

function cutPlace(name) {
  return String(name || "")
    .replace(/(坐|乘|搭|实习|报到|入职|上班|开学|搬家|出发|退租|入住|搬出).*$/, "")
    .replace(/(市|城区)$/, "")
    .slice(0, 8);
}

function mentionedPlaces(sentence) {
  const text = sentence.replace(/\s+/g, "");
  let from = "";
  let to = "";
  const fromMatch = text.match(/从([\u4e00-\u9fa5]{2,8}?)(?:搬家|搬去|搬到|出发|去|到)/);
  if (fromMatch) from = cutPlace(fromMatch[1]);
  const toMatch = text.match(/搬家去([\u4e00-\u9fa5]{2,8})/) || text.match(/(?:搬去|搬到|去到|到达|抵达)([\u4e00-\u9fa5]{2,8})/);
  if (toMatch) to = cutPlace(toMatch[1]);
  if (!from) {
    const leaveCity = text.match(/([\u4e00-\u9fa5]{2,8})(?:退租|出发|搬出|离开)/);
    if (leaveCity) from = cutPlace(leaveCity[1]);
  }
  if (!to) {
    const arriveCity =
      text.match(/(?:去|到)([\u4e00-\u9fa5]{2,8}?)(?:报到|入职|上班|开学|实习|入住)/) ||
      text.match(/([\u4e00-\u9fa5]{2,8})(?:报到|入职|实习)/) ||
      text.match(/去([\u4e00-\u9fa5]{2,6})(?=[，,。]|$)/);
    if (arriveCity) to = cutPlace(arriveCity[1]);
  }
  if (from && to && from === to) to = "";
  return { from, to };
}

function hintedMonth(sentence) {
  const match = String(sentence || "").match(/(\d{1,2})\s*月/);
  if (match) {
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) return { year: 2026, month };
  }
  if (/下个?月/.test(sentence)) return { year: 2026, month: 11 };
  return { year: 2026, month: 10 };
}

function sliderWidget(id, prompt, min, max, step, value, unit, text) {
  return { type: "slider", id, prompt, min, max, step, value, unit, text };
}

function fillTemplate(template, pairs) {
  return Object.entries(pairs).reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), template);
}

export function normalizeWidgets(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const widgets = [];
  const seen = new Set();
  for (const item of list) {
    if (widgets.length >= 4) break;
    const type = String(item?.type || "");
    if (!["calendar", "slider", "choice", "field"].includes(type)) continue;
    const id = String(item.id || type).replace(/[^\w-]/g, "").slice(0, 24) || `${type}-${widgets.length}`;
    if (seen.has(id)) continue;
    const prompt = String(item.prompt || "").trim().slice(0, 24);
    if (!prompt) continue;
    if (type === "calendar") {
      const year = Number.isFinite(Number(item.year)) ? Number(item.year) : 2026;
      const month = Number(item.month);
      seen.add(id);
      widgets.push({
        type,
        id,
        prompt,
        year: year >= 2024 && year <= 2028 ? year : 2026,
        month: month >= 1 && month <= 12 ? month : 10,
        text: String(item.text || "{m}月{d}日").slice(0, 48),
      });
    } else if (type === "slider") {
      let min = Number(item.min);
      let max = Number(item.max);
      let step = Number(item.step);
      let value = Number(item.value);
      if (!Number.isFinite(min)) min = 0;
      if (!Number.isFinite(max) || max <= min) max = min + 1000;
      if (!Number.isFinite(step) || step <= 0) step = 1;
      if (!Number.isFinite(value)) value = min;
      value = Math.min(max, Math.max(min, value));
      seen.add(id);
      widgets.push({
        type,
        id,
        prompt,
        min,
        max,
        step,
        value,
        unit: String(item.unit || "").slice(0, 4),
        text: String(item.text || "{value}").slice(0, 48),
      });
    } else if (type === "choice") {
      const options = (Array.isArray(item.options) ? item.options : [])
        .map((option) => ({
          label: String(option?.label || "").trim().slice(0, 12),
          text: String(option?.text || "").trim().slice(0, 48),
        }))
        .filter((option) => option.label && option.text)
        .slice(0, 4);
      if (options.length < 2) continue;
      seen.add(id);
      widgets.push({ type, id, prompt, options });
    } else if (type === "field") {
      const text = String(item.text || "{value}").slice(0, 48);
      seen.add(id);
      widgets.push({
        type,
        id,
        prompt,
        placeholder: String(item.placeholder || "写在这里").slice(0, 12),
        text,
      });
    }
  }
  return widgets;
}

export function fallbackWidgets(sentence) {
  const text = String(sentence || "").trim();
  if (!text) return [];
  const compact = text.replace(/\s+/g, "");
  const dates = mentionedDates(compact);
  const { from, to } = mentionedPlaces(compact);
  const datedLeave = eventDated(compact, /退租|搬出|退房|到期|出发|离开/);
  const datedArrive = eventDated(compact, /到达|抵达|入住/);
  const datedWork = eventDated(compact, /报到|入职|上班|开学|实习/);
  const work = /报到|入职|上班|开学|实习|公司/.test(compact);
  const specificRelative = /月[初中底]/.test(compact);
  const vagueMonth = /下个?月|这个?月|本月/.test(compact) && !dates.length && !specificRelative;
  const widgets = [];
  const { year, month } = hintedMonth(compact);

  if (dates.length && !datedLeave && !datedArrive && !datedWork) {
    const day = dates[0];
    const options = [];
    if (from) options.push({ label: `离开${from}`, text: `${day}离开${from}` });
    if (to) options.push({ label: `到达${to}`, text: `${day}到达${to}` });
    if (!from && !to) {
      options.push({ label: "当天出发", text: `${day}出发` }, { label: "当天到达", text: `${day}到达` });
    }
    if (from) options.push({ label: `${from}退租`, text: `${day}在${from}退租` });
    else options.push({ label: "当天退租", text: `${day}退租` });
    if (work && to) options.push({ label: `${to}报到`, text: `${day}在${to}报到` });
    widgets.push({ id: "date-role", type: "choice", prompt: `${day}是哪一天`, options: options.slice(0, 4) });
  } else if (vagueMonth || (!dates.length && !specificRelative && !datedLeave && !datedArrive && !datedWork)) {
    const where = to ? `到达${to}` : from ? `离开${from}` : "搬家";
    widgets.push({
      type: "calendar",
      id: "when",
      prompt: to ? `哪天到${to}` : from ? `哪天离开${from}` : "哪天搬家",
      year,
      month,
      text: `{m}月{d}日${where}`,
    });
  }

  if (!from || !to) {
    let prompt = "从哪搬到哪";
    let template = "{value}";
    if (from && !to) {
      prompt = `从${from}搬去哪`;
      template = `搬去{value}`;
    } else if (!from && to) {
      prompt = `从哪搬去${to}`;
      template = `从{value}搬去${to}`;
    }
    widgets.push({ type: "field", id: "place", prompt, placeholder: "城市", text: template });
  }

  const crossCity = !/同城|不跨城|区内/.test(compact) && ((from && to && from !== to) || /跨城|搬去|搬家去|搬到/.test(compact));
  if (crossCity && !/高铁|火车|动车|飞机|航班|自驾|开车/.test(compact)) {
    widgets.push({
      id: "travel",
      type: "choice",
      prompt: to ? `人怎么去${to}` : "人怎么走",
      options: [
        { label: "高铁", text: to ? `人坐高铁去${to}` : "人坐高铁" },
        { label: "飞机", text: to ? `人坐飞机去${to}` : "人坐飞机" },
        { label: "自驾", text: "人自己开车" },
      ],
    });
  }
  if (crossCity && !/行李|快递|寄送|托运|随身/.test(compact)) {
    widgets.push({
      id: "luggage",
      type: "choice",
      prompt: "行李怎么走",
      options: [
        { label: "随身带走", text: "行李随身" },
        { label: "快递寄送", text: "行李走快递" },
        { label: "搬家公司", text: "行李跟搬家公司" },
      ],
    });
  }

  if (budgetFromSentence(text) == null) {
    const cross = Boolean(from && to && from !== to);
    widgets.push(sliderWidget("budget", "一次性预算", cross ? 2000 : 1000, cross ? 40000 : 20000, 500, cross ? 15000 : 6000, "元", "一次性预算{value}"));
  }

  if (work && commuteFromSentence(text) == null && /通勤|公司/.test(compact)) {
    widgets.push(sliderWidget("commute", to ? `到${to}最多多久` : "通勤最多多久", 15, 90, 5, 45, "分钟", "通勤不超过{value}分钟"));
  }

  return widgets.slice(0, 4);
}

export function mergeWidgetGaps(sentence, widgets) {
  const have = new Set();
  for (const widget of widgets || []) {
    const blob = `${widget.id} ${widget.prompt} ${widget.text || ""} ${(widget.options || []).map((option) => option.text).join(" ")}`;
    if (widget.type === "slider" && /预算|元/.test(blob)) have.add("budget");
    if (widget.type === "slider" && /通勤|分钟/.test(blob)) have.add("commute");
    if (widget.type === "calendar" || widget.id === "when" || widget.id === "date-role") have.add("when");
    if (widget.type === "choice" && /日|离开|到达|退租|出发|报到/.test(blob)) have.add("when");
    if (widget.type === "field" || widget.id === "place") have.add("place");
    if (widget.id === "travel" || (widget.type === "choice" && /高铁|飞机|自驾|火车|开车/.test(blob))) have.add("travel");
    if (widget.id === "luggage" || (widget.type === "choice" && /行李|快递|托运|随身/.test(blob))) have.add("luggage");
  }
  const extras = fallbackWidgets(sentence).filter((widget) => {
    const kind = widget.id === "date-role" || widget.id === "when" ? "when" : widget.id;
    return !have.has(kind);
  });
  return [...(widgets || []), ...extras].slice(0, 4);
}

export function applyWidgets(sentence, widgets, picks) {
  const base = String(sentence || "")
    .trim()
    .replace(/[。！？，,\s]+$/g, "");
  const parts = [base];
  for (const widget of widgets || []) {
    const raw = picks?.[widget.id];
    if (widget.type === "slider") {
      const value = raw == null || raw === "" ? widget.value : Number(raw);
      if (!Number.isFinite(value)) return { ok: false, missing: widget.id };
      parts.push(fillTemplate(widget.text, { value: Math.round(value) }));
      continue;
    }
    if (widget.type === "calendar") {
      const match = String(raw || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return { ok: false, missing: widget.id };
      parts.push(fillTemplate(widget.text, { m: Number(match[2]), d: Number(match[3]) }));
      continue;
    }
    if (widget.type === "choice") {
      const option = widget.options.find((item) => item.text === raw);
      if (!option) return { ok: false, missing: widget.id };
      parts.push(option.text);
      continue;
    }
    const value = String(raw || "").trim();
    if (!value) return { ok: false, missing: widget.id };
    parts.push(fillTemplate(widget.text, { value: value.replace(/[，,]/g, " ") }));
  }
  return { ok: true, sentence: parts.filter(Boolean).join("，") };
}

function dateFromMatch(month, day) {
  return `2026-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

export function buildPlanFromSentence(sentence, defaultPlan) {
  const plan = clone(defaultPlan);
  plan.constraints = [
    {
      id: "c-initial",
      text: sentence.trim() || DEFAULT_PROMPT,
      kind: "initial",
      source: "start",
    },
  ];
  plan.listings.selectedId = null;
  plan.items.forEach((item) => {
    item.disposition = "pending";
  });
  plan.buy.forEach((item) => {
    item.status = "planned";
  });
  plan.notes = [];
  plan.lastChange = null;
  plan.brief = "";
  plan.marks = [];

  const budget = budgetFromSentence(sentence);
  if (budget) plan.ledger.oneOffBudget = budget;

  const cap = commuteFromSentence(sentence);
  if (cap) plan.listings.commuteCap = cap;

  const moveOut =
    sentence.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?[^\n]{0,8}退租/) ||
    sentence.match(/退租[^\n]{0,6}(\d{1,2})\s*月\s*(\d{1,2})/);
  if (moveOut) plan.dates.moveOut = dateFromMatch(moveOut[1], moveOut[2]);

  const report =
    sentence.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?[^\n]{0,10}报到/) ||
    sentence.match(/报到[^\n]{0,6}(\d{1,2})\s*月\s*(\d{1,2})/);
  if (report) plan.dates.reportBy = dateFromMatch(report[1], report[2]);

  if (/猫|狗|宠物|养猫/.test(sentence) && !plan.constraints.some((item) => item.kind === "pet")) {
    plan.constraints.push({
      id: "c-pet",
      text: sentence.trim(),
      kind: "pet",
      source: "start",
    });
  }

  return plan;
}

const ITEM_IMAGES = [
  "assets/items/sofa.svg",
  "assets/items/table.svg",
  "assets/items/mattress.svg",
  "assets/items/lamp.svg",
  "assets/items/bed.svg",
];

function cleanName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .slice(0, 8);
}

function money(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function imageForItem(name, index) {
  if (/沙发/.test(name)) return ITEM_IMAGES[0];
  if (/桌|椅|柜|架/.test(name)) return ITEM_IMAGES[1];
  if (/灯|饰/.test(name)) return ITEM_IMAGES[3];
  if (/床垫|洗衣|冰箱/.test(name)) return ITEM_IMAGES[2];
  if (/床|行李/.test(name)) return ITEM_IMAGES[4];
  return ITEM_IMAGES[index % ITEM_IMAGES.length];
}

function normalizeGeneratedItems(list) {
  if (!Array.isArray(list)) return null;
  const specs = [];
  const rows = [];
  for (const row of list) {
    if (specs.length >= 4) break;
    const name = cleanName(row?.name);
    const resale = money(row?.resale, 0, 20000);
    const discardFee = money(row?.discardFee, 0, 1500);
    const haulFee = money(row?.haulFee, 0, 1500);
    if (!name || resale == null || discardFee == null || haulFee == null) continue;
    const id = `item-gen-${specs.length + 1}`;
    specs.push({
      id,
      name,
      resale,
      discardFee,
      haulFee,
      image: imageForItem(name, specs.length),
      sellHint: String(row?.sellHint || "北京自提，不邮寄").trim().slice(0, 36),
    });
    rows.push({
      id,
      disposition: "pending",
      note: String(row?.note || "").trim().slice(0, 24),
    });
  }
  if (rows.length < 2) return null;
  return { specs, rows };
}

export function applySeenItems(plan, catalog, list) {
  if (!Array.isArray(list)) return false;
  const specs = [];
  const rows = [];
  const seen = new Set();
  for (const row of list) {
    if (specs.length >= 6) break;
    const name = cleanName(row?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const id = `item-seen-${specs.length + 1}`;
    const shot = String(row?.image || "");
    specs.push({
      id,
      name,
      resale: money(row?.resale, 0, 20000) ?? 0,
      discardFee: money(row?.discardFee, 0, 1500) ?? 0,
      haulFee: money(row?.haulFee, 0, 1500) ?? 0,
      image: shot.startsWith("data:image/") ? shot : "",
      sellHint: String(row?.sellHint || "自提，不邮寄").trim().slice(0, 36),
    });
    rows.push({
      id,
      disposition: "pending",
      note: String(row?.note || "").trim().slice(0, 24),
    });
  }
  if (!rows.length) return false;
  catalog.items = catalog.items.filter((item) => !String(item.id).startsWith("item-seen-")).concat(specs);
  plan.items = rows;
  syncPlan(plan, catalog);
  return true;
}

function normalizeGeneratedBuy(list) {
  if (!Array.isArray(list)) return null;
  const specs = [];
  const rows = [];
  for (const row of list) {
    if (specs.length >= 4) break;
    const name = cleanName(row?.name);
    const planned = money(row?.planned, 100, 20000);
    if (!name || planned == null) continue;
    const cheaper = money(row?.downgraded, 50, planned - 1);
    const id = `buy-gen-${specs.length + 1}`;
    specs.push({
      id,
      name,
      planned,
      downgraded: cheaper,
      cutOrder: specs.length + 1,
      image: imageForItem(name, specs.length),
    });
    rows.push({ id, status: "planned" });
  }
  if (rows.length < 2) return null;
  [...specs].sort((a, b) => a.planned - b.planned).forEach((spec, index) => {
    spec.cutOrder = index + 1;
  });
  return { specs, rows };
}

const ITEM_LEXICON = [
  { re: /洗衣机/, name: "洗衣机", resale: 500, discardFee: 0, haulFee: 280, note: "太重，建议本地转卖", sellHint: "北京自提，不邮寄" },
  { re: /冰箱/, name: "冰箱", resale: 600, discardFee: 0, haulFee: 350, note: "跨城不搬，可自提", sellHint: "北京自提，不邮寄" },
  { re: /书桌|电脑桌/, name: "书桌", resale: 180, discardFee: 0, haulFee: 120, note: "可拆装后转卖", sellHint: "桌板可拆，自提" },
  { re: /书柜|书架/, name: "书柜", resale: 150, discardFee: 0, haulFee: 150, note: "书先清，柜子可卖", sellHint: "北京自提" },
  { re: /衣柜/, name: "衣柜", resale: 200, discardFee: 80, haulFee: 220, note: "大件优先本地出清", sellHint: "自提不邮寄" },
  { re: /电视/, name: "电视", resale: 400, discardFee: 0, haulFee: 120, note: "可装箱或转卖", sellHint: "北京自提" },
  { re: /显示器/, name: "显示器", resale: 300, discardFee: 0, haulFee: 80, note: "建议装箱带走", sellHint: "可自提" },
  { re: /行李箱|箱子/, name: "行李箱", resale: 0, discardFee: 0, haulFee: 50, note: "衣服被褥随身带走", sellHint: "不转卖" },
  { re: /猫爬架|猫砂/, name: "猫爬架", resale: 80, discardFee: 0, haulFee: 60, note: "可随猫带走", sellHint: "自提" },
  { re: /沙发/, name: "沙发", resale: 800, discardFee: 0, haulFee: 300, note: "跨城不带走，可自提出清", sellHint: "北京自提，不邮寄" },
  { re: /桌椅|餐桌/, name: "桌椅", resale: 200, discardFee: 0, haulFee: 100, note: "可低价转卖", sellHint: "桌椅一套，可拆装" },
  { re: /床垫/, name: "床垫", resale: 0, discardFee: 150, haulFee: 100, note: "旧床垫建议直接清运", sellHint: "不建议转卖" },
  { re: /落地灯|台灯/, name: "落地灯", resale: 80, discardFee: 0, haulFee: 50, note: "易碎，建议转卖", sellHint: "自提" },
  { re: /床(?!垫)/, name: "床架", resale: 250, discardFee: 0, haulFee: 180, note: "可拆后转卖", sellHint: "北京自提" },
];

const LIVE_FALLBACK_ITEMS = [
  { name: "书桌", resale: 180, discardFee: 0, haulFee: 120, note: "跨城不搬，本地出清", sellHint: "北京自提，不邮寄" },
  { name: "显示器", resale: 280, discardFee: 0, haulFee: 80, note: "建议装箱带走", sellHint: "可自提" },
  { name: "行李箱", resale: 0, discardFee: 0, haulFee: 50, note: "衣服被褥随身带走", sellHint: "不转卖" },
];

const LIVE_FALLBACK_BUY = [
  { name: "床", planned: 1400, downgraded: 800 },
  { name: "衣柜", planned: 700, downgraded: null },
  { name: "灯", planned: 280, downgraded: null },
];

const DEMO_ITEM_NAMES = ["沙发", "桌椅", "床垫"];

function mentionsDemoTrio(sentence) {
  const sofa = /沙发/.test(sentence);
  const table = /桌椅/.test(sentence) || (/桌/.test(sentence) && /椅/.test(sentence));
  const mattress = /床垫/.test(sentence);
  return [sofa, table, mattress].filter(Boolean).length >= 2;
}

function itemNames(plan, catalog) {
  return plan.items.map((item) => itemSpec(catalog, item.id)?.name).filter(Boolean);
}

function looksLikeDemoItems(plan, catalog) {
  const names = itemNames(plan, catalog);
  if (!names.length) return true;
  const ids = plan.items.map((item) => item.id);
  if (ids.every((id) => ["item-sofa", "item-table", "item-mattress"].includes(id))) return true;
  return names.every((name) => DEMO_ITEM_NAMES.includes(name));
}

function inferLiveItems(sentence) {
  const seen = new Set();
  const items = [];
  for (const row of ITEM_LEXICON) {
    if (!row.re.test(sentence) || seen.has(row.name) || items.length >= 4) continue;
    seen.add(row.name);
    items.push({ ...row });
  }
  for (const row of LIVE_FALLBACK_ITEMS) {
    if (items.length >= 3) break;
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    items.push({ ...row });
  }
  return items.slice(0, 4);
}

function inferLiveBuy(sentence) {
  if (/床/.test(sentence) && /桌|椅/.test(sentence) && /灯/.test(sentence)) {
    return [
      { name: "床", planned: 1500, downgraded: null },
      { name: "桌椅", planned: 600, downgraded: null },
      { name: "灯", planned: 300, downgraded: null },
    ];
  }
  return LIVE_FALLBACK_BUY.map((row) => ({ ...row }));
}

function stampLiveDates(plan, sentence) {
  const hasMonth = /\d{1,2}\s*月/.test(sentence) || /\d{1,2}\s*[/.]\s*\d{1,2}/.test(sentence);
  if (hasMonth) return;
  if (plan.dates.moveOut === MOVE_OUT) plan.dates.moveOut = "2026-10-31";
  if (plan.dates.reportBy === DEFAULT_REPORT) plan.dates.reportBy = "2026-11-15";
}

function liveHouseNote(plan) {
  const pet = hasPetConstraint(plan) ? "，要能养宠物" : "";
  return `陆家嘴附近，通勤 ${plan.listings.commuteCap} 分钟内${pet}。`.slice(0, 36);
}

function seedLiveContent(plan, sentence, catalog) {
  stampLiveDates(plan, sentence);
  applyGeneratedContent(
    plan,
    {
      items: inferLiveItems(sentence),
      buy: inferLiveBuy(sentence),
      houseNote: liveHouseNote(plan),
    },
    catalog,
  );
}

function applyGeneratedContent(plan, raw, catalog) {
  const items = normalizeGeneratedItems(raw.items);
  if (items) {
    catalog.items = catalog.items.filter((item) => !String(item.id).startsWith("item-gen-")).concat(items.specs);
    plan.items = items.rows;
  }
  const buy = normalizeGeneratedBuy(raw.buy);
  if (buy) {
    catalog.buy = catalog.buy.filter((item) => !String(item.id).startsWith("buy-gen-")).concat(buy.specs);
    plan.buy = buy.rows;
  }
  const houseNote = String(raw.houseNote || "").trim().slice(0, 36);
  if (houseNote) plan.houseNote = houseNote;
}

function cleanMarks(list, sentence) {
  if (!Array.isArray(list)) return [];
  const marks = [];
  for (const row of list) {
    const text = String(row || "").trim().slice(0, 16);
    if (!text || text.length < 2 || !sentence.includes(text)) continue;
    if (!marks.includes(text)) marks.push(text);
    if (marks.length >= 12) break;
  }
  return marks;
}

export function localBrief(plan, catalog) {
  const names = itemNames(plan, catalog).join("、");
  const pet = hasPetConstraint(plan) ? "，要能养宠物" : "";
  return `${formatMD(plan.dates.moveOut)}退租，${formatMD(plan.dates.reportBy)}报到，预算${formatYuan(plan.ledger.oneOffBudget)}，通勤${plan.listings.commuteCap}分钟${pet}。旧物：${names}。`.slice(0, 64);
}

export function readingChips(plan, catalog) {
  const chips = [
    `退租 ${formatMD(plan.dates.moveOut)}`,
    `报到 ${formatMD(plan.dates.reportBy)}`,
    `预算 ${formatYuan(plan.ledger.oneOffBudget)}`,
    `通勤 ${plan.listings.commuteCap} 分钟`,
  ];
  if (hasPetConstraint(plan)) chips.push("要养宠物");
  itemNames(plan, catalog).forEach((name) => chips.push(name));
  return chips;
}

export function highlightTerms(sentence, plan, catalog) {
  const terms = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text.length >= 2 && sentence.includes(text) && !terms.includes(text)) terms.push(text);
  };
  (plan.marks || []).forEach(push);
  itemNames(plan, catalog).forEach(push);
  push(String(plan.ledger.oneOffBudget));
  push(`${plan.listings.commuteCap}分钟`);
  push(`不超过${plan.listings.commuteCap}分钟`);
  const dateBits = (iso) => {
    const parts = String(iso || "").split("-");
    if (parts.length < 3) return [];
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    return [`${month}月${day}日`, `${month}月${day}`, `${month}/${day}`];
  };
  dateBits(plan.dates.moveOut).forEach(push);
  dateBits(plan.dates.reportBy).forEach(push);
  ["陆家嘴", "北京", "上海", "杭州", "广州", "深圳", "南京", "成都", "退租", "报到", "养猫", "宠物", "一次性预算"].forEach(push);
  const extras = sentence.match(/一次性预算\s*\d{3,6}|预算\s*\d{3,6}|预算\s*[一二三四五六七八九十两零\d.万千]+|不超过\s*\d{2,3}\s*分钟|\d{2,3}\s*分钟|\d{1,2}\s*月\s*\d{1,2}\s*日/g);
  (extras || []).forEach(push);
  return terms.sort((a, b) => b.length - a.length);
}

export function sanitizeGeneratedPlan(raw, sentence, defaultPlan, catalog, options = {}) {
  const plan = buildPlanFromSentence(sentence, defaultPlan);
  const live = Boolean(options.live);
  if (raw && typeof raw === "object") {
    const budget = Number(raw.ledger?.oneOffBudget);
    if (budget >= 1000 && budget <= 200000) plan.ledger.oneOffBudget = budget;
    const cap = Number(raw.listings?.commuteCap);
    if (cap >= 20 && cap <= 120) plan.listings.commuteCap = cap;
    if (typeof raw.dates?.moveOut === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dates.moveOut)) {
      plan.dates.moveOut = raw.dates.moveOut;
    }
    if (typeof raw.dates?.reportBy === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dates.reportBy)) {
      plan.dates.reportBy = raw.dates.reportBy;
    }
    const modelPet = raw.pet === true || (Array.isArray(raw.constraints) && raw.constraints.some((item) => item?.kind === "pet"));
    const sentencePet = /猫|狗|宠物|养猫/.test(sentence);
    if ((modelPet || sentencePet) && !plan.constraints.some((item) => item.kind === "pet")) {
      plan.constraints.push({
        id: "c-pet",
        text: sentence.trim(),
        kind: "pet",
        source: "start",
      });
    }
    applyGeneratedContent(plan, raw, catalog);
    plan.brief = String(raw.brief || "").trim().slice(0, 48);
    plan.marks = cleanMarks(raw.marks, sentence);
  }
  if (live && looksLikeDemoItems(plan, catalog) && !mentionsDemoTrio(sentence)) {
    seedLiveContent(plan, sentence, catalog);
  } else if (live) {
    stampLiveDates(plan, sentence);
  }
  if (live && !plan.houseNote) plan.houseNote = liveHouseNote(plan);
  if (live && !plan.brief) plan.brief = localBrief(plan, catalog);
  plan.listings.selectedId = null;
  autoCutFurnishings(plan, catalog);
  syncPlan(plan, catalog);
  return plan;
}

function occupiedSnapshot(plan) {
  return plan.ledger.occupiedOneOff;
}

export function setDisposition(plan, catalog, itemId, disposition) {
  const item = plan.items.find((row) => row.id === itemId);
  if (!item) return { changed: false };
  item.disposition = item.disposition === disposition ? "pending" : disposition;
  autoCutFurnishings(plan, catalog);
  syncPlan(plan, catalog);
  return { changed: true };
}

export function selectListing(plan, catalog, listingId) {
  const listing = listingSpec(catalog, listingId);
  if (!listing) return { explained: false };
  const allowed = filterListings(plan, catalog).some((row) => row.id === listingId);
  if (!allowed) return { explained: false };

  const before = occupiedSnapshot(plan);
  plan.listings.selectedId = listingId;
  const cutDiffs = autoCutFurnishings(plan, catalog);
  syncPlan(plan, catalog);
  const nights = plan.dates.transitionNights;
  const occupiedChanged = occupiedSnapshot(plan) !== before || cutDiffs.length > 0;
  const explained = nights > 0 || occupiedChanged;

  if (!explained) {
    return { explained: false, listing };
  }

  const diffs = [`选中「${listing.title}」，月租 ${formatYuan(listing.monthlyRent)}，起租 ${formatMD(listing.availableFrom)}，通勤 ${listing.commuteMinutes} 分钟`];
  if (nights > 0) {
    diffs.push(`起租晚于退租，插入过渡住宿 ${nights} 晚，加 ${formatYuan(nights * TRANSITION_PER_NIGHT)}`);
  }
  diffs.push(...cutDiffs);

  plan.lastChange = makeChange({
    trigger: `选房：${listing.title}`,
    source: "listing",
    diffs,
    occupiedFrom: before,
    occupiedTo: plan.ledger.occupiedOneOff,
    needReselectHousing: false,
  });
  return { explained: true, listing };
}

export function setCommuteCap(plan, catalog, cap) {
  const before = occupiedOneOff(plan, catalog);
  plan.listings.commuteCap = cap;
  const selected = listingSpec(catalog, plan.listings.selectedId);
  if (selected && !filterListings(plan, catalog).some((row) => row.id === selected.id)) {
    plan.listings.selectedId = null;
    autoCutFurnishings(plan, catalog);
    syncPlan(plan, catalog);
    plan.lastChange = makeChange({
      trigger: `通勤上限改为 ${cap} 分钟`,
      source: "listing",
      diffs: [`已清空「${selected.title}」，超出当前通勤上限`],
      occupiedFrom: before,
      occupiedTo: plan.ledger.occupiedOneOff,
      needReselectHousing: true,
    });
    return { cleared: true };
  }
  syncPlan(plan, catalog);
  return { cleared: false };
}

export function applyConstraint(plan, catalog, text, classified) {
  const before = occupiedSnapshot(plan);
  const beforeLease = plan.dates.leaseStart;
  const beforeSelected = plan.listings.selectedId;
  const kind = classified?.kind || "note";
  const diffs = [];
  let needReselectHousing = false;
  let housingFlash = false;

  if (kind === "pet") {
    plan.constraints.push({
      id: nextId("c"),
      text,
      kind: "pet",
      source: "append",
    });
    const selected = listingSpec(catalog, plan.listings.selectedId);
    if (selected && !selected.petsAllowed) {
      plan.listings.selectedId = null;
      needReselectHousing = true;
      housingFlash = true;
      diffs.push(`已清空「${selected.title}」，该房不允许宠物`);
    } else {
      diffs.push("已加入宠物约束，之后筛房只显示可养宠物的房子");
    }
  } else if (kind === "budget") {
    const nextBudget = classified.oneOffBudget;
    const prevBudget = plan.ledger.oneOffBudget;
    plan.constraints.push({
      id: nextId("c"),
      text,
      kind: "budget",
      source: "append",
    });
    plan.ledger.oneOffBudget = nextBudget;
    diffs.push(`一次性预算由 ${formatYuan(prevBudget)} 改为 ${formatYuan(nextBudget)}`);
    diffs.push(...autoCutFurnishings(plan, catalog));
  } else if (kind === "deadline") {
    const prev = plan.dates.reportBy;
    plan.constraints.push({
      id: nextId("c"),
      text,
      kind: "deadline",
      source: "append",
    });
    plan.dates.reportBy = classified.reportBy;
    diffs.push(`上海报到由 ${formatMD(prev)} 改为 ${formatMD(classified.reportBy)}`);
    const selected = listingSpec(catalog, plan.listings.selectedId);
    if (selected && selected.availableFrom > classified.reportBy) {
      plan.listings.selectedId = null;
      needReselectHousing = true;
      housingFlash = true;
      diffs.push(`「${selected.title}」可起租日晚于新报到日，已清空新房`);
      diffs.push("报到日早于可入住日，需换更早起租的房或接受空档");
    }
  } else {
    plan.constraints.push({
      id: nextId("c"),
      text,
      kind: "note",
      source: "append",
    });
    plan.notes.push({ id: nextId("n"), text });
    syncPlan(plan, catalog);
    plan.lastChange = null;
    return { kind: "note", housingFlash: false };
  }

  const extraCuts = autoCutFurnishings(plan, catalog);
  extraCuts.forEach((line) => {
    if (!diffs.includes(line)) diffs.push(line);
  });
  syncPlan(plan, catalog);

  if (beforeSelected && !plan.listings.selectedId && beforeLease) {
    diffs.push("上海起租已清空，退租日存在空窗风险");
  }

  plan.lastChange = makeChange({
    trigger: text,
    source: "constraint",
    diffs,
    occupiedFrom: before,
    occupiedTo: plan.ledger.occupiedOneOff,
    needReselectHousing,
  });

  return { kind, housingFlash, needReselectHousing };
}

export function makeChange({ trigger, source, diffs, occupiedFrom, occupiedTo, needReselectHousing }) {
  const delta = occupiedTo - occupiedFrom;
  return {
    trigger,
    source,
    reasons: diffs,
    diffs,
    occupiedFrom,
    occupiedTo,
    delta,
    needReselectHousing,
    explanation: templateExplanation({
      trigger,
      diffs,
      occupiedFrom,
      occupiedTo,
      needReselectHousing,
    }),
  };
}

export function templateExplanation({ trigger, diffs, occupiedFrom, occupiedTo, needReselectHousing }) {
  const parts = [`因「${trigger}」，计划已改写。`];
  if (diffs.length) parts.push(diffs.join("；") + "。");
  if (occupiedFrom !== occupiedTo) {
    const delta = occupiedTo - occupiedFrom;
    const verb = delta > 0 ? "增加" : "减少";
    parts.push(
      `一次性已占用由 ${formatYuan(occupiedFrom)} 变为 ${formatYuan(occupiedTo)}（${verb} ${formatYuan(Math.abs(delta))}）。回款只展示，不抵扣已占用。`,
    );
  } else {
    parts.push("一次性已占用未变。回款只展示，不抵扣已占用。");
  }
  if (needReselectHousing) parts.push("需要重新选房。");
  return parts.join("");
}

export function setBuyStatus(plan, catalog, buyId, status) {
  const row = plan.buy.find((item) => item.id === buyId);
  const spec = buySpec(catalog, buyId);
  if (!row || !spec) return;
  if (status === "downgraded" && spec.downgraded == null) return;
  row.status = status;
  autoCutFurnishings(plan, catalog);
  syncPlan(plan, catalog);
}

export function composePostText(post) {
  const tags = (post.tags || []).map((tag) => `#${tag}`).join(" ");
  return `${post.title}\n\n${post.body}\n\n${tags}`;
}
