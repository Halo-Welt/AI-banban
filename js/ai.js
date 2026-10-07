import { sanitizeGeneratedPlan } from "./engine.js";

export const DEFAULT_MODEL = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  // 仓库里留空。发布时由 Actions 从 Secret DEEPSEEK_API_KEY 写入。
  apiKey: "",
};

export function loadModelConfig() {
  return { ...DEFAULT_MODEL };
}

export function canCallModel(config) {
  return Boolean(config?.apiKey && config?.baseUrl && config?.model);
}

function extractJson(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no-json");
  return JSON.parse(match[0]);
}

async function chat({ config, system, user, timeoutMs = 45000, json = false, temperature = 0.4 }) {
  if (!canCallModel(config)) throw new Error("no-key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payload = {
    model: config.model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (json) payload.response_format = { type: "json_object" };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const body = JSON.stringify(payload);
  const directUrl = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    let response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch {
      response = null;
    }
    const proxied = response && response.ok && (response.headers.get("content-type") || "").includes("json");
    if (!proxied) {
      response = await fetch(directUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    }
    if (!response.ok) throw new Error(`http-${response.status}`);
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("empty");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const PLAN_SYSTEM = `你根据用户自己写的搬家原句，填写这一份计划。只输出一个 JSON 对象，不要 Markdown，不要解释。

这不是路演 Demo。禁止原样套用「沙发、桌椅、床垫」加「灯饰装饰、桌椅、新沙发、床」那一套，除非原句真的点了这些名字。

字段名必须与示例一致。
{
  "ledger": {"oneOffBudget": 12000, "moveCost": 2000},
  "dates": {"moveOut": "2026-10-31", "reportBy": "2026-11-15"},
  "listings": {"commuteCap": 30},
  "houseNote": "陆家嘴附近，通勤 30 分钟内，要能养猫。",
  "pet": true,
  "brief": "10月底杭州退租，预算 1.2 万，旧洗衣机和书柜就地处理。",
  "marks": ["10月20日", "杭州", "洗衣机", "书柜", "一万二", "半小时", "养猫"],
  "items": [
    {"name": "洗衣机", "note": "太重，建议本地转卖", "resale": 500, "discardFee": 0, "haulFee": 280, "sellHint": "北京自提，不邮寄"}
  ],
  "buy": [
    {"name": "床", "planned": 1400, "downgraded": 800},
    {"name": "衣柜", "planned": 700, "downgraded": null}
  ]
}

规则：
- brief：用一句不超过 36 个字复述你读到的约束，像对人说话，不要口号。
- marks：只能是用户原句里出现过的连续文字，用来划线。日期、城市、预算、通勤、物品名、宠物相关都要尽量划到。
- items：旧房要处理的东西，2 到 4 件。原句点了名就用点名的；没点名时按这句话的生活场景推断（书桌、显示器、行李箱、洗衣机、冰箱、衣柜、猫爬架等），每件 note 不超过 16 字且互不重复。
- 未点名时，不要输出沙发+桌椅+床垫这一组。
- resale、discardFee、haulFee 是整数元。能转卖的给二手合理价，discardFee 为 0。不建议转卖的 resale 为 0，discardFee 在 100 到 200。haulFee 是搬走加价，0 到 400。
- buy：新家要置办的 3 到 4 件，用来补上不带走的旧物。名称要跟旧物对应，不要永远叫灯饰装饰/新沙发。planned 是计划价。只有能换便宜款才填 downgraded，且必须小于 planned；否则为 null。
- 全部 planned 加总后再加 2000 搬家费，不要明显超过一次性预算。
- houseNote：一句话写新家地点、通勤、是否养宠物，不超过 28 字。公司默认陆家嘴。不要出现「写死」「mock」「剧本」「Demo」。
- 日期年份固定 2026，格式 YYYY-MM-DD。相对时间按 2026-10-01 理解：下个月=11月，月底=当月最后一天，月初=1日，月中=15日。
- 中文数量换成整数：八千=8000，六千五=6500，一万二=12000，1.2万=12000，一个小时=60，半小时=30，四十五分钟=45。
- 原句没写时：退租 2026-10-31，报到 2026-11-15，oneOffBudget 8000，moveCost 2000，commuteCap 45。不要用 6月30日/7月15日 那组 Demo 日期，除非原句写了。
- 原句提到猫、狗、宠物、养猫时 pet 为 true，否则 false。
- 价格、oneOffBudget、commuteCap 必须是数字。`;

const POST_SYSTEM = `你给跨城搬家写一条小红书转卖帖。只输出 JSON：{"title":"","body":"","tags":[]}
事实只来自用户给出的物品名、自提城市、预计回款。
不要编造城区、材质、成色、尺寸、品牌、是否可刀、是否已经发出。
回款为 0 时，正文写送出或出不去就清运，不要写售价。
标题不超过 20 个字，像自己发的出清。
正文写成四到六句短句，写明北京自提、不邮寄。
tags 给 3 到 5 个，不要带 #。`;

const EXPLAIN_SYSTEM = `把一次搬家计划重算写成两到三句中文，只输出正文。
只用用户 JSON 里已有的数字、房源名、置办名，不要改，不要补充没出现的名字。
occupiedFrom 与 occupiedTo 单位是元。相同就说一次性已占用没变；不同就写出前后数字和差额。
diffs 里没有回款，就不要提回款。
不要出现「不能说」「不要」「指令」「JSON」。不要排比，不要口号。`;

const CLASSIFY_SYSTEM = `把追加的一句搬家约束分类，只输出 JSON 对象，形如 {"kind":"note"}。
kind 只能是 pet、budget、deadline、note 四者之一。
养猫、宠物、猫、狗，kind 为 pet。
把一次性预算改成某个金额，kind 为 budget。
报到日提前或改到某一天，kind 为 deadline。
其余记事，kind 为 note。`;

export async function generatePlan({ config, sentence, defaultPlan, catalog }) {
  const text = await chat({
    config,
    json: true,
    temperature: 0.7,
    timeoutMs: 50000,
    system: PLAN_SYSTEM,
    user: `今天按 2026-10-01。用户原句：${sentence}`,
  });
  const raw = extractJson(text);
  return sanitizeGeneratedPlan(raw, sentence, defaultPlan, catalog, { live: true });
}

export async function generatePost({ config, item }) {
  const text = await chat({
    config,
    json: true,
    system: POST_SYSTEM,
    user: `物品：${item.name}。语境：${item.sellHint}。预计回款 ${item.resale} 元。`,
  });
  const raw = extractJson(text);
  if (!raw.title || !raw.body) throw new Error("bad-post");
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 6) : [];
  return {
    title: String(raw.title),
    body: String(raw.body),
    tags,
  };
}

export async function generateExplanation({ config, change }) {
  const text = await chat({
    config,
    system: EXPLAIN_SYSTEM,
    user: JSON.stringify({
      trigger: change.trigger,
      diffs: change.diffs,
      occupiedFrom: change.occupiedFrom,
      occupiedTo: change.occupiedTo,
      needReselectHousing: change.needReselectHousing,
    }),
  });
  const cleaned = text.replace(/^```[\s\S]*?```$/g, "").trim();
  if (!cleaned) throw new Error("empty-explain");
  return cleaned;
}

export async function classifyWithModel({ config, text }) {
  const result = await chat({
    config,
    timeoutMs: 8000,
    json: true,
    system: CLASSIFY_SYSTEM,
    user: text,
  });
  const raw = extractJson(result);
  if (!["pet", "budget", "deadline", "note"].includes(raw.kind)) throw new Error("bad-kind");
  return raw.kind;
}
