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
