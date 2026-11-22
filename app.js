// 页面只依赖 data.js 中的通用结构（MODULE_TYPES / RUBRICS / IMPORTED_RUNS），
// 模型调用、计分和评测记录存储由 server.py 提供的 /api/* 完成。

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fmt = (value) => Number((Number(value) + 1e-9).toFixed(1)).toFixed(1);
// 缺失或非数字时显示“—”，用于报告里所有可能缺字段的分数
const isNum = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const fmtOr = (value) => (isNum(value) ? fmt(value) : "—");
const fmtNum = (value) => String(Math.round(Number(value) * 100) / 100);
// 原单位结果：判定型给达标项数，档位型给平均档位
const nativeText = (n) => (!n || !isNum(n.value) ? "" : n.kind === "count" ? `${fmtNum(n.value)}/${fmtNum(n.max)} 项达标`
  : n.kind === "penalty" ? `错误扣分 ${fmtNum(n.value)}${isNum(n.max) ? ` / 上限 ${fmtNum(n.max)}` : ""}` : `${fmtNum(n.value)} / ${fmtNum(n.max)}`);
// 指标的计分方式，与 server.py 的 dim_kind 一致：档位型、判定型按指标自己的方式；其余在错误扣分体系里是错误扣分型，否则是扣分型
const kindOf = (d, rubric) => (d.kind === "scale" || d.kind === "check" ? d.kind : d.kind === "penalty" || rubric?.penalty ? "penalty" : "deduct");
// 一项指标的汇总结果怎么展示：text 是原单位的数值，ratio 是“好坏程度”（0–1，越大越好，用于进度条和短板标记），
// value/lowerBetter 用于两次评测对比。stat 来自 server 的 dimStats；旧记录没有时用平均分推算
function dimView(dim, stat, rubric) {
  const kind = stat?.kind || kindOf(dim, rubric);
  const score = isNum(stat?.score) ? Number(stat.score) : null;
  const weight = Number(dim.weight) || 0;
  if (kind === "scale") {
    const [low, high] = stat?.scale || dim.scale || [1, 5];
    const level = isNum(stat?.level) ? Number(stat.level) : score !== null && weight ? (score / weight) * high : null;
    return { text: level === null ? "—" : `${fmtNum(level)} / ${fmtNum(high)} 档`, ratio: level === null ? 0 : Math.max(0, (level - low) / ((high - low) || 1)), value: level, lowerBetter: false };
  }
  if (kind === "check") {
    const met = isNum(stat?.met) ? Number(stat.met) : score !== null && weight ? score / weight : null;
    return { text: met === null ? "—" : `${fmtNum(met * 100)}% 达标`, ratio: met ?? 0, value: met === null ? null : met * 100, lowerBetter: false };
  }
  if (kind === "penalty") {
    const points = isNum(stat?.penalty) ? Number(stat.penalty) : score;
    const max = Number(rubric?.penalty?.max) || 0;
    return { text: points === null ? "—" : `平均扣 ${fmtNum(points)} 分`, ratio: points === null ? 0 : max ? Math.max(0, 1 - points / max) : points > 0 ? 0 : 1, value: points, lowerBetter: true };
  }
  return { text: score === null ? "—" : `${fmt(score)}${weight ? ` / ${fmtNum(weight)}` : ""}`, ratio: score !== null && weight ? score / weight : 0, value: score, lowerBetter: false };
}
const dimRange = (d, rubric) => (kindOf(d, rubric) === "penalty" ? "错误扣分" : d.kind === "scale" ? `${fmtNum(d.scale?.[0] ?? 1)}–${fmtNum(d.scale?.[1] ?? 5)} 档`
  : d.kind === "check" ? (d.gate ? "必须达标项" : "达标判定") : `满分 ${fmtNum(d.weight)}`);
const DIM_COLORS = ["#3ee6dc", "#5b8cff", "#b48cff", "#5ff0a8", "#ffaa5c", "#ff7fb0", "#7fd4ff"];
const ISSUE_COLORS = { P0: "#ff5f72", P1: "#ffaa5c", P2: "#b48cff", P3: "#7fd4ff" };
const NEW_TYPE = "__new__";
const TEXT_ACCEPT = ".md,.markdown,.txt,.json,.jsonl,.csv,.yaml,.yml";
const INPUT_ACCEPT = ".md,.markdown,.txt,.json,.jsonl,.csv,.tsv";

const state = {
  typeId: MODULE_TYPES[0].id,
  customTypes: [],          // 来自已保存评测的自定义类型
  customRubric: null,       // 本次上传的评价体系原文 { name, source, document }，评测开始时由模型阅读
  files: {},                // key -> { name, content }
  samples: [],              // 从文件中切分出的样本
  splitMode: "auto",        // 样本切分方式，见 SPLIT_MODES
  parserName: "",
  models: [],
  modelSource: "",
  modelId: "",
  gateway: { configured: false },
  savedRuns: [],
  running: null,
  progress: null,           // 最近一次评测的进度：{ typeId, status, run }
  hidden: { runs: [], rubrics: [], types: [] },
  openGroup: null,
  openSamples: new Set(),
  issueFilter: null,
  recordCache: {}
};

function toast(message, ms = 2800) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), ms);
}

function countUp(node, target, duration = 1100) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    node.textContent = fmt(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(() => { node.textContent = fmt(target); }, duration + 100);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/* ---------- 背景网格与时钟 ---------- */
function startBackground() {
  const canvas = $("#bgGrid");
  const ctx = canvas.getContext("2d");
  let width, height, points;
  const resize = () => {
    width = canvas.width = innerWidth * devicePixelRatio;
    height = canvas.height = innerHeight * devicePixelRatio;
    points = Array.from({ length: 46 }, (_, i) => ({
      x: ((i * 97) % 100) / 100 * width, y: ((i * 61) % 100) / 100 * height,
      vx: (((i * 13) % 7) - 3) * 0.06 * devicePixelRatio, vy: (((i * 29) % 7) - 3) * 0.06 * devicePixelRatio
    }));
  };
  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    const gap = 48 * devicePixelRatio;
    ctx.strokeStyle = "rgba(110,180,200,0.05)";
    ctx.beginPath();
    for (let x = 0; x < width; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = 0; y < height; y += gap) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
    points.forEach((p) => { p.x = (p.x + p.vx + width) % width; p.y = (p.y + p.vy + height) % height; });
    const linkDist = 160 * devicePixelRatio;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        if (d < linkDist) {
          ctx.strokeStyle = `rgba(62,230,220,${0.14 * (1 - d / linkDist)})`;
          ctx.beginPath(); ctx.moveTo(points[i].x, points[i].y); ctx.lineTo(points[j].x, points[j].y); ctx.stroke();
        }
      }
      ctx.fillStyle = "rgba(62,230,220,0.5)";
      ctx.fillRect(points[i].x - 1, points[i].y - 1, 2 * devicePixelRatio, 2 * devicePixelRatio);
    }
    requestAnimationFrame(draw);
  };
  addEventListener("resize", resize);
  resize();
  draw();
  setInterval(() => { $("#clock").textContent = new Date().toTimeString().slice(0, 8); }, 1000);
}

/* ---------- 视图切换 ---------- */
const VIEW_LABELS = { create: "新建评测", history: "历史评测", report: "评测报告", rubric: "评价体系" };
function showView(view) {
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active-view", panel.dataset.viewPanel === view));
  const navView = view === "report" ? "history" : view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === navView));
  $("#pathLabel").textContent = VIEW_LABELS[view];
  if (view === "history") renderHistory();
  scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- 网关与模型 ---------- */
async function loadGateway() {
  const box = $("#gatewayStatus");
  try {
    state.gateway = await api("/api/status");
  } catch {
    state.gateway = { configured: false, offline: true };
  }
  const { configured, gateway, offline } = state.gateway;
  box.classList.toggle("ok", configured);
  $("small", box).textContent = offline ? "未连接本地服务（请双击 启动EvalLab.bat）" : configured ? `已连接 · ${gateway}` : "未配置网关 · 无法调用模型";
  $("#topConnection").innerHTML = `<i class="${configured ? "" : "warn"}"></i>${configured ? "GATEWAY READY" : "GATEWAY OFF"}`;
  try {
    const data = await api("/api/models");
    state.models = data.models.length ? data.models : FALLBACK_MODELS;
    state.modelSource = data.models.length ? (data.source === "gateway" ? "网关实时列表" : "eval_config.json") : "内置快照（未配置网关）";
  } catch {
    state.models = FALLBACK_MODELS;
    state.modelSource = "内置快照（服务未连接）";
  }
  if (!state.modelId || !state.models.some((m) => m.id === state.modelId)) selectModel(state.models[0].id);
  renderSummary();
}

function applyAuth(header, prefix) {
  const preset = `${header}|${prefix}`;
  const known = ["Authorization|Bearer ", "X-Api-Key|"];
  if (known.includes(preset)) {
    $("#gatewayAuth").value = preset;
    $("#gatewayCustom").hidden = true;
  } else {
    $("#gatewayAuth").value = "custom";
    $("#gatewayCustom").hidden = false;
    $("#gatewayHeader").value = header;
    $("#gatewayPrefix").value = prefix;
  }
}

function syncAuthForm() {
  const custom = $("#gatewayAuth").value === "custom";
  $("#gatewayCustom").hidden = !custom;
  if (custom && !$("#gatewayHeader").value) $("#gatewayHeader").value = "X-Api-Key";
}

function authValues() {
  const value = $("#gatewayAuth").value;
  if (value === "custom") {
    return { auth_header: $("#gatewayHeader").value.trim() || "X-Api-Key", auth_prefix: $("#gatewayPrefix").value };
  }
  const [header, prefix] = value.split("|");
  return { auth_header: header, auth_prefix: prefix };
}

function renderModels(keyword = "") {
  const word = keyword.trim();
  const lower = word.toLowerCase();
  const groups = {};
  state.models.filter((m) => !lower || `${m.name} ${m.id}`.toLowerCase().includes(lower)).forEach((m) => { (groups[m.group || "其他"] ||= []).push(m); });
  const custom = word && !state.models.some((m) => m.id.toLowerCase() === lower)
    ? `<button type="button" class="model-item" data-model="${esc(word)}"><b>使用「${esc(word)}」</b><i>自定义</i><span>直接把该名称作为网关模型名</span></button>` : "";
  $("#modelList").innerHTML = `<div class="model-group">来源：${esc(state.modelSource)}</div>` + custom + Object.entries(groups).map(([group, models]) => `
    <div class="model-group">${esc(group)} · ${models.length}</div>
    ${models.map((m) => `<button type="button" class="model-item ${m.id === state.modelId ? "selected" : ""}" data-model="${esc(m.id)}">
      <b>${esc(m.name)}</b><i>${esc(m.id)}</i><span>${esc(m.group || "")}</span></button>`).join("")}`).join("");
}

function selectModel(modelId) {
  state.modelId = modelId;
  const model = state.models.find((m) => m.id === modelId);
  $("#modelName").textContent = model ? model.name : modelId;
  $("#modelMeta").textContent = model ? `${model.id} · ${model.group || ""}` : `${modelId} · 自定义模型名`;
  $("#modelPanel").hidden = true;
  renderSummary();
}
/* ---------- 评测类型与评价体系 ---------- */
const NEW_TYPE_DEF = {
  id: NEW_TYPE, name: "新建评测类型", desc: "上传新的评价体系与内容", rubricId: null, titleField: null,
  inputs: [
    { key: "source", label: "数据源", hint: "可选，用于核对事实与边界", format: "markdown", optional: true },
    { key: "output", label: "内容结果", hint: "待评测的输出", format: "markdown" }
  ],
  parsers: [GENERIC_PARSER]
};
const allTypes = () => [...MODULE_TYPES, ...state.customTypes, NEW_TYPE_DEF];
// 被删除（隐藏）的类型不再出现在新建评测里，但历史报告仍能找到它
const visibleTypes = () => allTypes().filter((type) => type.id === NEW_TYPE || !state.hidden.types.includes(type.id));
const typeById = (id) => allTypes().find((type) => type.id === id);
const currentType = () => typeById(state.typeId);
const rubricOf = (type) => (type.rubricId ? RUBRICS[type.rubricId] : type.rubric) || null;
const currentRubric = () => state.customRubric || rubricOf(currentType());
const allRuns = () => [...state.savedRuns, ...IMPORTED_RUNS].filter((run) => !state.hidden.runs.includes(run.id));
const runsOfType = (typeId) => allRuns().filter((run) => run.typeId === typeId);
const CN = "一二三四五六七八九十";

// 按历史评测名称里最大的“第N版”顺延；名称里没有版次时用“新一轮”
function nextRunName(type, history) {
  const toNum = (ch) => (/^\d+$/.test(ch) ? Number(ch) : CN.indexOf(ch) + 1);
  const max = Math.max(0, ...history.map((run) => { const m = run.name.match(/第([一二三四五六七八九十]|\d+)版/); return m ? toNum(m[1]) : 0; }));
  return max ? `${type.name}第${CN[max] ?? max + 1}版评测` : `${type.name}新一轮评测`;
}

// 被评测的提示词属于某一次评测：切换或新建评测时清空，上一版标签只作为占位提示
function resetPromptFields() {
  $("#promptText").value = "";
  $("#promptTag").value = "";
  $("#promptFile").value = "";
  $("#promptFileName").textContent = "选择 .md / .txt 文件";
  state.promptFile = "";
}

function selectType(typeId) {
  state.typeId = typeId;
  state.files = {};
  state.samples = [];
  state.customRubric = null;
  resetPromptFields();
  const type = currentType();
  const history = runsOfType(typeId);
  $("#evaluationName").value = history.length ? nextRunName(type, history) : "";
  const lastPrompt = promptVersions(typeId)[0];
  $("#promptTag").placeholder = lastPrompt ? `上一版：${lastPrompt.tag}` : "例如 创作方向 V1.0.8";
  renderTypes();
  renderRubricSlot();
  renderSlots();
  renderScan();
  renderSummary();
  syncProgressCard();
}

function renderTypes() {
  $("#typeOptions").innerHTML = visibleTypes().map((type) => {
    const count = runsOfType(type.id).length;
    const tag = type.id === NEW_TYPE ? "全新类型" : count ? `历史 ${count} 轮` : "尚无历史";
    return `<button type="button" class="type-option ${type.id === state.typeId ? "selected" : ""}" data-type="${esc(type.id)}">
      <b>${esc(type.name)}</b><small>${esc(type.desc)}</small><em>${tag}</em></button>`;
  }).join("");
}

function rubricBrief(rubric) {
  if (!rubric.objects?.length) return `<span class="chip"><b>原文</b>${rubric.document?.length || 0} 字 · 评测时由模型完整阅读</span>`;
  return rubric.objects.map((obj) => {
    const dims = obj.dims || [];
    const total = dims.reduce((sum, dim) => sum + (Number(dim.weight) || 0), 0);
    const scope = obj.scope === "each" ? `逐条${esc(obj.itemName || "条目")}评分` : "整体评分";
    return `<span class="chip"><b>${esc(obj.label)}</b>${dims.length} 项指标${obj.weighted !== false && total ? ` · 满分 ${fmtNum(total)}` : ""} · ${scope}</span>`;
  }).join("");
}

function renderRubricSlot() {
  const rubric = currentRubric();
  const isNew = state.typeId === NEW_TYPE;
  $("#rubricHint").textContent = isNew
    ? "上传评价体系文件，格式不限（.md / .json / .txt 等）；页面只展示原文，评测时由模型完整阅读"
    : "评测类型绑定的评价体系；也可上传任意格式的文件替换，评测时由模型完整阅读";
  // 页面识别成功时直接可用，模型解析只是识别不准时的补救；页面识别不出时才把模型解析作为主要入口
  const recognized = Boolean(rubric?.objects?.length);
  const how = !rubric?.document ? ""
    : recognized ? `<p class="note top0 ok-note">✓ ${rubric.structureBy === "model" ? "模型已解析出" : "页面已从原文表格识别出"}下面的指标结构，可以直接运行。
        若指标或权重与原文不符，<button type="button" class="link-button" data-parse-rubric>让模型重新解析</button></p>`
    : `<p class="note top0">页面没有从原文中识别出指标表格。可以 <button type="button" class="link-button" data-parse-rubric>现在让模型解析</button> 并核对结构；也可以直接运行，评测开始时模型会先阅读原文再打分。</p>`;
  $("#rubricSlot").innerHTML = `
    ${rubric ? `<div class="rubric-bound">
        <div><span class="slot-key">${state.customRubric ? "本次上传" : "已绑定"}</span><b>${esc(rubric.name || "未命名体系")}</b><small>${esc(rubric.source || "")}</small></div>
        <button type="button" class="ghost-button" data-show-rubric>查看完整体系 ↗</button>
      </div><div class="chip-row">${rubricBrief(rubric)}</div>${how}` : `<div class="empty small">尚未提供评价体系</div>`}
    <label class="slot slot-inline"><input type="file" accept="${TEXT_ACCEPT}" data-rubric-file />
      <span class="slot-file"><i>↥</i>${isNew && !rubric ? "上传评价体系文件" : "上传新的评价体系替换（可选）"}</span></label>`;
}

// 任意格式的评价体系都可以交给模型解析；解析失败不影响原文，评测时仍会把原文完整交给模型
async function parseRubricWithModel() {
  const rubric = currentRubric();
  if (!rubric?.document) return;
  if (!state.gateway.configured) return toast("用模型解析需要先配置模型网关");
  if (!state.modelId) return toast("请先在 E 区选择模型");
  const button = $("[data-parse-rubric]");
  button.disabled = true;
  button.textContent = "模型解析中…";
  try {
    const planned = (await api("/api/plan-rubric", { body: { model: state.modelId, document: rubric.document } })).rubric;
    state.customRubric = { ...planned, name: planned.name || rubric.name, source: rubric.source, document: rubric.document, structureBy: "model" };
    toast(`模型解析出 ${planned.objects.reduce((n, o) => n + o.dims.length, 0)} 项指标，可在“查看完整体系”中核对`);
  } catch (error) {
    toast(`模型解析失败，原文保持不变：${error.message}`, 5000);
  }
  renderRubricSlot();
  renderSummary();
}

// 上传只在本地读取原文：能从表格或 JSON 中识别出指标就按结构展示，识别不了就只展示原文，评测时再交给模型阅读
async function loadRubricFile(file) {
  const text = await file.text();
  if (!text.trim()) return toast("评价体系文件是空的");
  const draft = extractRubric(text, file.name);
  let found = null;
  if (draft) {
    // 计分方式、权重、门槛和通过规则统一由服务端按同一套规则解读，页面展示的就是程序实际执行的规则
    try { found = (await api("/api/normalize-rubric", { body: { draft, document: text } })).rubric; } catch { found = null; }
  }
  state.customRubric = { ...(found || {}), name: found?.name || file.name.replace(/\.\w+$/, ""), source: file.name, document: text };
  renderRubricSlot();
  renderSummary();
  toast(found ? `已识别 ${found.objects.reduce((n, o) => n + o.dims.length, 0)} 项指标，原文会在评测时完整交给模型` : "评价体系已载入，评测时由模型完整阅读");
}

/* ---------- 从评价体系原文中识别指标（只做展示和统一计分，原文仍是评分依据） ---------- */
const RUBRIC_COLS = [
  ["fail", /直接不通过|否决|红线|一票|veto|fail/i], ["weight", /权重|分值|满分|分数|占比|weight|points?|score/i], ["object", /评价对象|对象|object|target/i],
  ["level", /层级|级别|level|scope/i], ["name", /指标|评价项|考核项|项目|名称|metric|criteri|indicator|item|name/i], ["dimension", /维度|dimension|category/i],
  ["measure", /含义|说明|测量|怎么评|评分标准|标准|描述|定义|要求|desc|definition|guideline|how/i],
  ["method", /判定|评分方式|计分方式|打分方式|方式|scoring|type/i]
];
const HEADER_HINT = /指标|维度|评价项|考核项|metric|criteri|indicator|dimension/i;
const toNum = (value) => { const m = String(value ?? "").match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const cleanText = (value) => String(value ?? "").replace(/\*\*/g, "").trim();
const emptyCell = (value) => /^[\s—\-–无/]*$/.test(value || "");

function htmlGrid(html) {
  const grid = [];
  [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("tr")].forEach((tr, r) => {
    grid[r] ||= [];
    let c = 0;
    [...tr.children].forEach((cell) => {
      while (grid[r][c] !== undefined) c++;
      const rows = Number(cell.getAttribute("rowspan")) || 1, cols = Number(cell.getAttribute("colspan")) || 1;
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) (grid[r + i] ||= [])[c + j] = cell.textContent.trim();
      c += cols;
    });
  });
  return grid.map((row) => Array.from(row, (cell) => cell ?? ""));
}

function tableGrids(text) {
  const grids = [...text.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => htmlGrid(m[0]));
  let rows = [];
  const flush = () => { if (rows.length) grids.push(rows); rows = []; };
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!/^\|.*\|$/.test(line)) return flush();
    if (!/^\|[\s:|-]+\|$/.test(line)) rows.push(line.replace(/^\||\|$/g, "").split("|").map((cell) => cleanText(cell)));
  });
  flush();
  return grids;
}

function dimsFromGrid(grid) {
  const head = grid.findIndex((row) => row.length >= 2 && row.some((cell) => HEADER_HINT.test(cell)));
  if (head < 0) return [];
  const cols = {};
  grid[head].forEach((cell, i) => {
    const hit = RUBRIC_COLS.find(([key, re]) => cols[key] === undefined && re.test(cell));
    if (hit) cols[hit[0]] = i;
  });
  if (cols.name === undefined && cols.dimension === undefined) return [];
  // 表头是“5 分 / 3 分 / 1 分”这类档位时，把各档描述并入指标说明，并据此认出档位型
  const anchors = grid[head].map((cell, i) => [cell.match(/^(\d{1,2})\s*(?:分|档|级)$/)?.[1], i]).filter(([n]) => n !== undefined);
  return grid.slice(head + 1).filter((row) => new Set(row).size > 1).map((row) => {
    const pick = (key) => (cols[key] === undefined ? "" : cleanText(row[cols[key]]));
    const levels = anchors.map(([n, i]) => Number(n));
    const anchorText = anchors.length >= 2 ? anchors.map(([n, i]) => `${n} 分：${cleanText(row[i])}`).join("；") : "";
    const name = pick("name") || pick("dimension");
    const group = [pick("object"), pick("level")].filter((v, i, all) => v && all.indexOf(v) === i).join(" · ");
    return { group, level: pick("level"), dim: { dimension: pick("dimension") === name ? "" : pick("dimension"), name,
      weight: cols.weight === undefined ? null : toNum(row[cols.weight]), weightText: pick("weight"), method: pick("method"),
      measure: [pick("measure"), anchorText].filter(Boolean).join("；"), fail: emptyCell(pick("fail")) ? "" : pick("fail"),
      ...(anchorText ? { kind: "scale", scale: [Math.min(...levels, 1), Math.max(...levels)] } : {}) } };
  }).filter((row) => row.dim.name);
}

function dimFromAny(item) {
  if (!item || typeof item !== "object") return typeof item === "string" ? { name: item, weight: null } : null;
  const pick = (...keys) => { const k = keys.find((key) => item[key] !== undefined && item[key] !== null && item[key] !== ""); return k === undefined ? undefined : item[k]; };
  const weight = pick("weight", "权重", "分值", "满分", "points", "max_score", "maxScore", "score");
  const method = pick("scoring", "评分方式", "计分方式", "判定方式", "判定", "type", "scale", "量程");
  return { dimension: cleanText(pick("dimension", "维度")), name: cleanText(pick("name", "指标", "指标名", "名称", "title", "metric", "dimension", "维度")),
    weight: toNum(weight), weightText: typeof weight === "string" ? cleanText(weight) : "", method: typeof method === "string" ? cleanText(method) : "",
    measure: cleanText(pick("measure", "desc", "description", "评分说明", "评分标准", "含义", "说明", "定义", "criteria")),
    fail: cleanText(pick("fail", "直接不通过", "一票否决", "否决", "红线", "veto")), kind: item.kind, gate: item.gate, scale: item.scale ?? null };
}

// 扣分表展示：比例和“每处扣 N 分”都由服务端解读后写在 rubric 里，这里只负责显示
const DEFAULT_DEDUCTION = { P1: 0.3, P2: 0.15, P3: 0.05 };
function deductionRows(rubric) {
  const own = rubric.deduction || {};
  const ratio = (level) => { const v = Number(own[level] ?? DEFAULT_DEDUCTION[level]); return Number.isFinite(v) ? (v > 1 ? v / 100 : v) : DEFAULT_DEDUCTION[level]; };
  return `<div class="rule-row"><b style="color:${ISSUE_COLORS.P0}">P0</b><span>该指标记 0 分，并直接不通过</span></div>` +
    ["P1", "P2", "P3"].map((level) => `<div class="rule-row"><b style="color:${ISSUE_COLORS[level]}">${level}</b><span>扣该指标满分的 ${fmtNum(ratio(level) * 100)}%</span></div>`).join("") +
    (rubric.objects || []).flatMap((obj) => obj.dims || []).filter((dim) => isNum(dim.perIssue))
      .map((dim) => `<div class="rule-row"><b>${esc(dim.name)}</b><span>评价体系写明每处问题扣 ${fmtNum(dim.perIssue)} 分，P1–P3 都按此扣（P0 仍记 0 分）</span></div>`).join("");
}

// 页面只把原文里的结构抽成草稿（指标、分值、计分方式、说明、判定原文），不做解读；解读见 server.py 的 canonical_rubric
function draftRubric(groups, extras = {}) {
  const objects = groups.map((group) => ({ ...group, dims: (group.dims || []).filter((d) => d && d.name) })).filter((group) => group.dims.length);
  return objects.length ? { ...extras, objects } : null;
}

function extractRubric(text, name = "") {
  try {
    const trimmed = text.trim();
    if (/\.json$/i.test(name) || /^[[{]/.test(trimmed)) {
      let data = null;
      try { data = JSON.parse(trimmed); } catch { /* 不是合法 JSON 时按文本识别 */ }
      if (data) {
        // 指标列表的字段名不固定：先认常见名称，再退到第一个“元素是带名称的对象”的数组
        const named = (v) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && Object.keys(x).some((k) => /name|title|metric|指标|名称|维度/i.test(k)));
        const listOf = (o) => o?.dims || o?.indicators || o?.metrics || o?.criteria || o?.指标 || (o && typeof o === "object" ? Object.values(o).find(named) : null);
        const groups = Array.isArray(data) ? [{ dims: data.map(dimFromAny) }]
          : Array.isArray(data.objects) ? data.objects.map((o) => ({ label: o.label || o.name, scope: o.scope, itemName: o.itemName, desc: o.desc, dims: (listOf(o) || []).map(dimFromAny) }))
          : Array.isArray(listOf(data)) ? [{ label: data.label, dims: listOf(data).map(dimFromAny) }] : [];
        const rules = data.rules && typeof data.rules === "object" ? data.rules : {};
        const ruleText = [data.pass, data.通过标准, data.判定, data.通过条件, rules.pass].filter((v) => typeof v === "string").join("；");
        return draftRubric(groups, { name: data.name || data.评测名称 || data.标题, rules, ruleText,
          principles: data.principles, notes: data.notes, issueTypes: data.issueTypes, deduction: data.deduction, penalty: data.penalty });
      }
    }
    const groups = new Map();
    tableGrids(text).forEach((grid) => dimsFromGrid(grid).forEach(({ group, level, dim }) => {
      if (!groups.has(group)) groups.set(group, { label: group, level, dims: [] });
      groups.get(group).dims.push(dim);
    }));
    const plain = text.replace(/<table[\s\S]*?<\/table>/gi, "").split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !/^(#|\||```|<)/.test(line)).map((line) => cleanText(line.replace(/^[-*]\s+/, "")));
    const verdict = (word) => plain.map((line) => line.match(new RegExp(`^${word}[:：]\\s*(.+)$`))).find(Boolean)?.[1] || "";
    const judged = plain.filter((line) => /^(判定|通过|不通过|通过标准|通过条件)[:：]/.test(line)).join("；");
    return draftRubric([...groups.values()], {
      name: cleanText(text.match(/^#\s+(.+)$/m)?.[1]),
      rules: { pass: verdict("通过"), fail: verdict("不通过") }, ruleText: judged,
      principles: plain.filter((line) => !/^(通过|不通过)[:：]/.test(line)).slice(0, 8)
    });
  } catch {
    return null;
  }
}

/* ---------- 输入文件与样本切分 ---------- */
function renderSlots() {
  $("#inputSlots").innerHTML = currentType().inputs.map((input) => {
    const file = state.files[input.key];
    return `<label class="slot ${file ? "filled" : ""}">
      <input type="file" accept="${INPUT_ACCEPT}" data-key="${esc(input.key)}" />
      <span class="slot-key">${esc(input.key.toUpperCase())}${input.optional ? " · 可选" : ""}</span>
      <b>${esc(input.label)}</b><small>${esc(input.hint)}</small>
      <span class="slot-file"><i>${file ? "✓" : "↥"}</i>${file ? esc(file.name) : "点击导入文件（本地读取）"}</span></label>`;
  }).join("");
}

function splitRecords(text, parser, mode = "auto") {
  if (parser.record === "auto") return autoRecords(text, mode, Object.values(parser.sections || {}).flat());
  const lines = text.split(/\r?\n/);
  const re = new RegExp(parser.record);
  const starts = [];
  lines.forEach((line, i) => { const m = line.match(re); if (m) starts.push({ i, id: m[1].trim() }); });
  return starts.map((start, k) => {
    let end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    for (let j = start.i + 1; j < end; j++) if (/^(<a id=|## )/.test(lines[j])) { end = j; break; }
    return { id: start.id, line: start.i + 1, heading: lines[start.i], lines: lines.slice(start.i + 1, end) };
  });
}

// 样本边界的几种切分方式；auto 依次尝试：最浅一级出现两次以上、且不全是小节名的标题 → 行首递增编号 → 分隔线。
// 代码块里的内容不参与判断。切不出两个以上样本时返回空，由调用方把整份文件当作一个样本
const SPLIT_MODES = { auto: "自动判断", heading: "按标题", numbered: "按行首编号", separator: "按 --- 分隔线", line: "每行一个样本", whole: "整份文件作为一个样本" };
function autoRecords(text, mode = "auto", sectionNames = []) {
  const lines = text.split(/\r?\n/);
  let fence = false;
  const plain = lines.map((line) => { if (/^\s*```/.test(line)) { fence = !fence; return false; } return !fence; });
  const pick = (test) => lines.map((line, i) => (plain[i] ? test(line) : null)).map((m, i) => (m ? { i, m } : null)).filter(Boolean);
  const slice = (starts, idOf, endAt = () => false) => starts.map((start, k) => {
    let end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    for (let j = start.i + 1; j < end; j++) if (plain[j] && endAt(lines[j])) { end = j; break; }
    return { id: idOf(start), line: start.i + 1, heading: lines[start.i], lines: lines.slice(start.i + 1, end) };
  });
  const isSection = (title) => sectionNames.some((name) => title.replace(/[*:：\s]/g, "") === name);
  // 样本边界的统一规则：边界标题必须各不相同。在多个样本里重复出现的标题（如“问题”“回答”“输入”）是样本内部的小节，
  // 不是样本边界；去掉它们后不足两个边界时，这种切分方式不成立
  const boundaries = (starts) => {
    const count = new Map();
    starts.forEach((s) => count.set(s.m[1].trim(), (count.get(s.m[1].trim()) || 0) + 1));
    const unique = starts.filter((s) => count.get(s.m[1].trim()) === 1 && !isSection(s.m[1]));
    return unique.length >= 2 ? unique : [];
  };
  const byHeading = () => {
    for (let level = 1; level <= 6; level++) {
      const starts = boundaries(pick((line) => line.match(new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`))));
      // 样本到下一个边界、或更高一级的标题为止；同级的小节标题留在样本里
      if (starts.length) return slice(starts, (s) => s.m[1].trim(), (line) => level > 1 && new RegExp(`^#{1,${level - 1}}\\s`).test(line));
    }
    return [];
  };
  // 【第1组】【商品A】[Case 3] 这类独占一行的方括号标题
  const byBracket = () => {
    const starts = boundaries(pick((line) => line.match(/^\s*[【\[]([^】\]]{1,40})[】\]](?!\()\s*(.*)$/)));
    return starts.length >= 2 ? slice(starts, (s) => s.m[1].trim()).map((record, k) => ({ ...record, lines: starts[k].m[2] ? [starts[k].m[2], ...record.lines] : record.lines })) : [];
  };
  const byNumber = () => {
    const starts = pick((line) => line.match(/^\s{0,3}(\d{1,5})\s*[.、)）:：]\s*(.*)$/));
    if (starts.length < 2 || !starts.every((s, k) => k === 0 || Number(s.m[1]) > Number(starts[k - 1].m[1]))) return [];
    return slice(starts, (s) => s.m[1]).map((record, k) => ({ ...record, heading: starts[k].m[2].slice(0, 40), lines: [starts[k].m[2], ...record.lines] }));
  };
  const bySeparator = () => {
    const seps = pick((line) => line.match(/^\s*(-{3,}|\*{3,}|_{3,}|={3,})\s*$/));
    const bounds = [-1, ...seps.map((s) => s.i), lines.length];
    const chunks = bounds.slice(0, -1).map((b, k) => ({ line: b + 2, lines: lines.slice(b + 1, bounds[k + 1]) })).filter((c) => c.lines.some((line) => line.trim()));
    return chunks.length >= 2 ? chunks.map((c, k) => ({ ...c, id: String(k + 1), heading: c.lines.find((line) => line.trim()).trim().slice(0, 40) })) : [];
  };
  const byLine = () => lines.map((line, i) => ({ line, i })).filter((l) => l.line.trim())
    .map((l, k) => ({ id: String(k + 1), line: l.i + 1, heading: l.line.trim().slice(0, 40), lines: [l.line] }));
  const tag = (records, method) => Object.assign(records, { method });
  if (mode === "heading") { const h = byHeading(); return tag(h.length ? h : byBracket(), SPLIT_MODES.heading); }
  if (mode === "numbered") return tag(byNumber(), SPLIT_MODES.numbered);
  if (mode === "separator") return tag(bySeparator(), SPLIT_MODES.separator);
  if (mode === "line") return tag(byLine(), SPLIT_MODES.line);
  if (mode === "whole") return tag([], SPLIT_MODES.whole);
  for (const [split, method] of [[byHeading, "heading"], [byBracket, "heading"], [byNumber, "numbered"], [bySeparator, "separator"]]) {
    const records = split();
    if (records.length >= 2) return tag(records, `自动 · ${SPLIT_MODES[method]}`);
  }
  return tag([], "自动 · 整份文件作为一个样本");
}

// 小节可以写成 “#### 数据源”（固定前缀匹配），也可以只写名称：此时任意级别标题、**加粗**行、“名称：”开头的行都算；
// “输入：xxx”同一行后面的内容也计入该小节。小节到下一个标题或下一个已知小节名为止
const sectionLabel = (line) => line.match(/^\s*(?:#{1,6}\s+)?(?:\*\*)?\s*([^*#:：]{1,20}?)\s*(?:\*\*)?\s*(?:[:：]\s*(?:\*\*)?\s*(.*))?$/);
function extractSection(record, headings = [], names = headings) {
  const hit = (line, list) => list.some((h) => (h.startsWith("#") ? line.startsWith(h) : sectionLabel(line)?.[1] === h));
  const from = record.lines.findIndex((line) => hit(line, headings));
  if (from < 0) return null;
  const bare = names.filter((name) => !name.startsWith("#"));
  let to = record.lines.findIndex((line, i) => i > from && (/^#{1,6} /.test(line) || /^\[返回/.test(line) || hit(line, bare)));
  if (to < 0) to = record.lines.length;
  const first = headings.some((h) => !h.startsWith("#")) ? sectionLabel(record.lines[from])?.[2] || "" : "";
  return { text: [first, ...record.lines.slice(from + 1, to)].join("\n").trim(), line: record.line + from + 1 };
}

// JSON 数组或 JSONL：每个元素是一个样本，优先用 id 字段对齐不同文件，没有时按顺序编号
function jsonRecords(text) {
  let items;
  try {
    const data = JSON.parse(text);
    items = Array.isArray(data) ? data : [data];
  } catch {
    items = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return line; } });
  }
  return items.map((item, i) => {
    const obj = item && typeof item === "object" ? item : null;
    const idKey = obj && Object.keys(obj).find((k) => /^(id|sample_?id|lead_id|no|编号|序号|样本编号|样本id)$/i.test(k));
    const rawId = idKey && obj[idKey] !== null && obj[idKey] !== "" ? (typeof obj[idKey] === "object" ? JSON.stringify(obj[idKey]) : obj[idKey]) : null;
    const title = obj ? (obj.title ?? obj.topic_norm ?? obj.name) : null;
    const body = obj ? JSON.stringify(item, null, 2) : String(item);
    return { id: rawId !== null ? String(rawId) : String(i + 1), line: i + 1, heading: title ? String(title) : "", lines: body.split("\n"), fields: obj };
  });
}

// CSV / TSV：首行是表头，之后每行一个样本（支持带引号、含逗号和换行的单元格）
function csvRecords(text) {
  const delimiter = (text.split(/\r?\n/)[0].match(/\t/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && !cell.trim()) { quoted = true; cell = ""; }
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head || !body.length) return [];
  const records = jsonRecords(JSON.stringify(body.map((r) => Object.fromEntries(head.map((h, k) => [h.trim() || `列${k + 1}`, (r[k] ?? "").trim()])))));
  return Object.assign(records, { method: "CSV 逐行" });
}

// 某个输入可能使用的名称：输入自身的 key、标签，以及各切分规则里为它登记的小节名
function inputAliases(type, key) {
  const input = type.inputs.find((i) => i.key === key);
  return [key, input?.label, ...type.parsers.flatMap((p) => p.sections?.[key] || [])]
    .filter(Boolean).map((name) => String(name).replace(/^#+\s*/, "").replace(/原文$/, "").toLowerCase());
}

// JSON 记录里与该输入对应的字段（字段名包含任一别名即可，例如“输出答案”“model_output”）
function jsonField(fields, type, key) {
  const aliases = inputAliases(type, key);
  const name = Object.keys(fields || {}).find((field) => aliases.some((alias) => field.toLowerCase() === alias))
    || Object.keys(fields || {}).find((field) => aliases.some((alias) => alias.length >= 2 && field.toLowerCase().includes(alias)));
  if (name === undefined) return null;
  const value = fields[name];
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// 一个文件是否也包含其他输入的内容（Markdown 小节名或 JSON 字段名），用于上传时自动填入其他输入
function fileCovers(content, fileName, type, key) {
  if (/\.jsonl?$/i.test(fileName)) return Boolean(jsonRecords(content).slice(0, 3).some((r) => r.fields && jsonField(r.fields, type, key) !== null));
  const names = inputAliases(type, key);
  return content.split(/\r?\n/).some((raw) => {
    const line = raw.replace(/^\s{0,3}\d{1,5}\s*[.、)）]\s*/, "");
    if (!/^\s*(#{1,6}\s|\*\*|[^\s].{0,20}[:：])/.test(line)) return false;
    const label = sectionLabel(line)?.[1]?.toLowerCase();
    return label && names.includes(label.replace(/原文$/, ""));
  });
}

// 不同文件的样本对齐方式：标题完全一致 → 标题里的编号一致 → 条数相同时按顺序
const alignKey = (id) => {
  const m = String(id).match(/^\D{0,6}?(\d+)/);
  return m ? `#${Number(m[1])}` : String(id).replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
};
const ALIGNERS = [
  { name: "样本标题", key: (record) => record.id },
  { name: "样本编号", key: (record) => alignKey(record.id) },
  { name: "先后顺序", key: (record, index) => `@${index + 1}` }
];

function buildSamples() {
  const type = currentType();
  const byFile = {};
  type.inputs.forEach((input) => {
    const file = state.files[input.key];
    if (file) (byFile[file.batchId || `${input.key}:${file.name}`] ||= { file, keys: [] }).keys.push(input.key);
  });
  const methods = new Set();
  const perFile = Object.values(byFile).map(({ file, keys }) => {
    const table = !["whole", "line"].includes(state.splitMode);
    const json = table && /\.jsonl?$/i.test(file.name) ? jsonRecords(file.content) : table && /\.(csv|tsv)$/i.test(file.name) ? csvRecords(file.content) : null;
    let best = { parser: null, records: json || [] };
    if (!json) type.parsers.forEach((parser) => {
      const records = splitRecords(file.content, parser, state.splitMode);
      if (records.length > best.records.length) best = { parser, records };
    });
    const records = best.records.length ? best.records : [{ id: "1", line: 1, heading: file.name, lines: file.content.split(/\r?\n/) }];
    methods.add(json ? json.method || "JSON 逐条" : best.records.method || (best.parser && best.records.length ? best.parser.name : "整份文件"));
    // 整份文件作为一个样本时，仍按第一个切分规则的小节名提取各输入
    return { file, keys, parser: best.parser || (json ? null : type.parsers[0] || null), records };
  });

  // 多个文件的切分要对得上：自动切分出的条数不一致时（例如输出里的“1. 2. 3.”步骤被当成了样本），
  // 在各文件其他可行的切分方式里找一个所有文件都能切出的相同条数，优先采用切分依据最明确的那个文件的结果
  if (state.splitMode === "auto" && perFile.length > 1 && new Set(perFile.map((f) => f.records.length)).size > 1) {
    const ORDER = ["heading", "numbered", "separator", "whole"];
    const options = perFile.map((f) => {
      if (!f.parser || f.parser.record !== "auto") return [{ mode: "fixed", records: f.records }];
      const sections = Object.values(f.parser.sections || {}).flat();
      return ORDER.map((mode) => ({ mode, records: mode === "whole" ? [] : autoRecords(f.file.content, mode, sections) }))
        .map((o) => ({ ...o, records: o.records.length ? o.records : [{ id: "1", line: 1, heading: f.file.name, lines: f.file.content.split(/\r?\n/) }] }));
    });
    const common = [...new Set(options[0].map((o) => o.records.length))].filter((n) => options.every((list) => list.some((o) => o.records.length === n)));
    if (common.length) {
      const rank = (n) => Math.min(...options.map((list) => { const k = list.findIndex((o) => o.records.length === n); return k < 0 ? 99 : k; }));
      const count = common.sort((a, b) => rank(a) - rank(b) || b - a)[0];
      perFile.forEach((f, k) => { f.records = options[k].find((o) => o.records.length === count).records; });
      methods.clear();
      methods.add(count === 1 ? "各文件都按整份文件作为一个样本（对齐后统一）" : `各文件统一切成 ${count} 条`);
    }
  }

  // 多个文件时，选第一种能让各文件样本完全对上的对齐方式；都对不全时，条数相同就按顺序，否则取对上最多的
  let aligner = ALIGNERS[0];
  if (perFile.length > 1) {
    const counts = perFile.map((f) => f.records.length);
    const overlap = (a) => {
      const [first, ...rest] = perFile.map((f) => new Set(f.records.map(a.key)));
      return [...first].filter((k) => rest.every((set) => set.has(k))).length;
    };
    aligner = ALIGNERS.slice(0, 2).find((a) => overlap(a) === Math.min(...counts))
      || (counts.every((c) => c === counts[0]) ? ALIGNERS[2] : ALIGNERS.slice(0, 2).sort((a, b) => overlap(b) - overlap(a))[0]);
  }

  const merged = new Map();
  const duplicates = [];
  perFile.forEach(({ file, keys, parser, records }) => {
    const seen = new Map();
    const names = parser ? Object.values(parser.sections || {}).flat() : [];
    // 没有小节时，整段记录归给该文件承担的第一个必需输入
    const wholeKey = keys.find((key) => !type.inputs.find((i) => i.key === key).optional) || keys[0];
    records.forEach((record, index) => {
      let mergeKey = aligner.key(record, index);
      let id = record.id;
      const times = (seen.get(mergeKey) || 0) + 1;
      seen.set(mergeKey, times);
      if (times > 1) {
        // 同一个文件里出现重复编号：不覆盖前一条，改名保留，并在识别结果里提示
        mergeKey = `${mergeKey}#${times}`;
        id = `${record.id}（重复${times}）`;
        duplicates.push(`${file.name}：${record.id}`);
      }
      const sample = merged.get(mergeKey) || { id, heading: record.heading, inputs: {}, lines: {} };
      const fieldTexts = record.fields ? Object.fromEntries(keys.map((key) => [key, jsonField(record.fields, type, key)])) : {};
      const sections = parser ? Object.fromEntries(keys.map((key) => [key, extractSection(record, parser.sections?.[key] || [], names)])) : {};
      const anyPart = keys.some((key) => fieldTexts[key] !== null && fieldTexts[key] !== undefined) || keys.some((key) => sections[key]);
      keys.forEach((key) => {
        const text = fieldTexts[key] ?? sections[key]?.text ?? (!anyPart && key === wholeKey ? record.lines.join("\n").trim() : "");
        if (text) { sample.inputs[key] = text; sample.lines[key] = `${file.name}:${sections[key]?.line || record.line}`; }
      });
      merged.set(mergeKey, sample);
    });
  });
  const required = type.inputs.filter((input) => !input.optional).map((input) => input.key);
  const all = [...merged.values()];
  state.samples = all.filter((s) => required.every((key) => s.inputs[key])).map((s) => ({ ...s, title: sampleTitle(s, type) }));
  state.missingInputs = required.filter((key) => !state.files[key]);
  state.skipped = state.missingInputs.length ? [] : all.filter((s) => !required.every((key) => s.inputs[key]))
    .map((s) => ({ id: s.id, missing: required.filter((key) => !s.inputs[key]).map((key) => type.inputs.find((i) => i.key === key).label) }));
  state.duplicates = duplicates;
  state.parserName = [...methods].join(" + ");
  state.alignBy = perFile.length > 1 ? aligner.name : "";
}

function sampleTitle(sample, type) {
  if (type.titleField && sample.inputs.source) {
    const m = sample.inputs.source.match(new RegExp(`"${type.titleField}"\\s*:\\s*"([^"]*)"`));
    if (m && m[1]) return m[1];
  }
  return (sample.heading || "").replace(/^#+\s*/, "").slice(0, 60) || `样本 ${sample.id}`;
}

function renderScan() {
  const box = $("#sampleScan");
  if (!Object.keys(state.files).length) { box.innerHTML = ""; return; }
  const type = currentType();
  const missing = (state.missingInputs || []).map((key) => type.inputs.find((i) => i.key === key)?.label || key);
  const skipped = state.skipped || [];
  const dups = state.duplicates || [];
  const notes = [
    dups.length ? `<p class="warn-text">${dups.length} 个样本编号重复，已分别保留并加上“重复”标记：${dups.slice(0, 10).map(esc).join("；")}${dups.length > 10 ? " …" : ""}。请检查文件里是否有重复的样本，或换一种切分方式。</p>` : "",
    missing.length ? `<p class="warn-text">还需要导入：${missing.map(esc).join("、")}</p>` : "",
    skipped.length ? `<p class="warn-text">${skipped.length} 个样本缺少对应内容、已跳过：${skipped.slice(0, 20).map((s) => `${esc(s.id)}（缺${s.missing.map(esc).join("、")}）`).join("；")}${skipped.length > 20 ? " …" : ""}<br />可以换一种切分方式；数据源和输出分在两个文件时，两边的样本标题、编号或顺序需要能对上。</p>` : ""
  ].join("");
  const modes = Object.entries(SPLIT_MODES).map(([key, label]) => `<option value="${key}" ${state.splitMode === key ? "selected" : ""}>${label}</option>`).join("");
  box.innerHTML = `<div class="scan-head"><b>识别到 <em>${state.samples.length}</em> 个样本</b>
      <span>切分：${esc(state.parserName)}${state.alignBy ? ` · 对齐：${esc(state.alignBy)}` : ""}</span>
      <select class="input scan-mode" data-split-mode title="样本切分方式">${modes}</select></div>
    <div class="id-chips">${state.samples.slice(0, 60).map((s) => `<span title="${esc(s.title)}">${esc(s.id)}</span>`).join("")}${state.samples.length > 60 ? `<span>…</span>` : ""}</div>${notes}`;
}

function renderSummary() {
  const type = currentType();
  const rubric = currentRubric();
  const model = state.models.find((m) => m.id === state.modelId);
  const limit = Number($("#sampleLimit").value) || state.samples.length;
  const rows = [
    ["评测类型", esc(type.name), ""],
    ["评测名称", esc($("#evaluationName").value || "未填写"), $("#evaluationName").value ? "" : "warn"],
    ["评价体系", rubric ? esc(rubric.name) : "未提供", rubric ? "" : "warn"],
    ...type.inputs.map((input) => {
      const file = state.files[input.key];
      return [input.label, file ? esc(file.name) : input.optional ? "未上传（可选）" : "未上传", file ? "ok" : input.optional ? "" : "warn"];
    }),
    ["样本", state.samples.length ? `${Math.min(limit, state.samples.length)} / ${state.samples.length}` : "0", state.samples.length ? "ok" : "warn"],
    ["提示词", $("#promptText").value.trim() ? `${esc($("#promptTag").value.trim() || "未填标签")}${$("#promptStrategy").checked ? " · 生成策略" : ""}` : "未填写（可选）",
      $("#promptText").value.trim() ? ($("#promptTag").value.trim() ? "ok" : "warn") : ""],
    ["评测模型", esc(model ? model.name : state.modelId || "未选择"), ""],
    ["评分方式", [$("#calibrate").checked ? ($("#regenGuide").checked ? "重新制定细则" : "统一细则") : "", $("#fastMode").checked ? "快速模式" : "深度评分", `并发 ${$("#concurrency").value}`].filter(Boolean).join(" · "), ""],
    ["模型网关", state.gateway.configured ? "已连接" : "未配置", state.gateway.configured ? "ok" : "warn"]
  ];
  $("#runSummary").innerHTML = rows.map(([label, value, cls]) => `<div class="summary-row"><span>${label}</span><b class="${cls}">${value}</b></div>`).join("");
  $("#runNote").innerHTML = state.gateway.configured
    ? "评测开始时模型先完整阅读评价体系，再逐样本给出逐指标分数与证据；总分和通过判定由程序按体系计算。"
    : "服务端未配置模型网关，暂时无法运行。在右侧 MODEL GATEWAY 点“配置”，填写网关地址与密钥后保存即可（保存到 数据/eval_config.json）。";
}
/* ---------- 运行评测 ---------- */
function aggregate(run) {
  const rubric = run.rubric;
  const ok = run.samples.filter((s) => s.result);
  run.objects = {};
  rubric.objects.forEach((obj) => {
    const results = ok.map((s) => s.result.objects[obj.key]).filter(Boolean);
    const n = results.length || 1;
    const itemCount = results.reduce((sum, r) => sum + r.items.length, 0);
    run.objects[obj.key] = {
      score: results.reduce((sum, r) => sum + r.score, 0) / n,
      pass: results.filter((r) => r.status === "通过").length,
      fail: results.filter((r) => r.status !== "通过").length,
      unit: obj.scope === "each" ? `${itemCount} 条${obj.itemName || "条目"}` : `${results.length} 组`,
      dimAvg: obj.dims.map((_, k) => results.reduce((sum, r) => sum + (r.dimAvg[k] || 0), 0) / n),
      native: results.length && results.every((r) => r.native) ? { ...results[0].native, value: results.reduce((sum, r) => sum + r.native.value, 0) / results.length } : null,
      // 各指标按自己的计分方式汇总（平均档位、达标率、平均扣分）；旧结果没有 dimStats 时为空，展示时按平均分推算
      dimStats: results.length && results.every((r) => r.dimStats) ? obj.dims.map((_, k) => {
        const stats = results.map((r) => r.dimStats[k] || {});
        const avg = (key) => (stats.every((st) => isNum(st[key])) ? stats.reduce((sum, st) => sum + Number(st[key]), 0) / stats.length : undefined);
        return { ...stats[0], score: avg("score"), level: avg("level"), met: avg("met"), penalty: avg("penalty") };
      }) : null
    };
  });
  run.rawIssues = [];
  ok.forEach((s) => (s.result.issues || []).forEach((issue) => {
    const known = (rubric.issueTypes || []).find((t) => t.key === issue.type);
    run.rawIssues.push({ id: s.id, dim: issue.dim || "", type: known?.title || issue.type || "", level: /^P[0-3]$/.test(issue.level) ? issue.level : known?.level || "P3", detail: issue.detail || "", evidence: issue.evidence || "" });
  }));
  setIssueGroups(run, localIssueGroups(run.rawIssues));
  run.errors = run.samples.filter((s) => s.error).map((s) => ({ id: s.id, error: s.error }));
  run.excluded = run.errors.length ? `接口错误 ID ${run.errors.map((e) => e.id).join("、")} 不计入均值` : "";
  run.samples.forEach((s) => {
    if (!s.result) return;
    s.scores = {}; s.status = {}; s.native = {};
    rubric.objects.forEach((obj) => {
      const r = s.result.objects[obj.key];
      if (r?.native) s.native[obj.key] = r.native;
      s.scores[obj.key] = r ? Math.round(r.score * 10) / 10 : 0;
      s.status[obj.key] = r ? r.status : "不通过";
    });
    s.summary = s.result.summary;
  });
}

// 问题整合为两层：核心问题（多为某个指标）→ 按 P0–P3 分级的具体问题。
// run.issues 是具体问题的平铺列表（样本筛选用下标），run.issueGroups 记录每个核心问题包含哪些下标
function setIssueGroups(run, groups) {
  run.issues = [];
  run.issueGroups = groups.map((group) => ({
    title: group.title,
    issues: group.issues.slice().sort((a, b) => a.level.localeCompare(b.level)).map((issue) => run.issues.push({ ...issue, group: group.title }) - 1)
  }));
}

// 本地兜底：按关联指标归类，同一指标、同一等级的问题合并
function localIssueGroups(rawIssues) {
  const groups = new Map();
  rawIssues.forEach((raw) => {
    const title = raw.dim || raw.type || "其他问题";
    const group = groups.get(title) || new Map();
    const sub = group.get(raw.level) || { level: raw.level, title: raw.type && raw.type !== title ? raw.type : `${title}问题`, ids: [], details: [] };
    if (!sub.ids.includes(raw.id)) sub.ids.push(raw.id);
    if (raw.detail) sub.details.push(`ID ${raw.id}：${raw.detail}`);
    group.set(raw.level, sub);
    groups.set(title, group);
  });
  return [...groups.entries()].map(([title, subs]) => ({
    title, issues: [...subs.values()].map((sub) => ({ ...sub, desc: sub.details.slice(0, 3).join("；") }))
  }));
}

// 没有分组信息的旧记录（如导入的报告）：每个问题单独作为一个核心问题
function ensureIssueGroups(run) {
  run.issues = (run.issues || []).filter((issue) => issue && Array.isArray(issue.ids));
  if (!Array.isArray(run.issueGroups)) run.issueGroups = run.issues.map((issue, index) => ({ title: issue.title || "未分类问题", issues: [index] }));
  run.issueGroups = run.issueGroups.map((group) => ({ ...group, issues: (group.issues || []).filter((i) => run.issues[i]) })).filter((group) => group.issues.length);
}

const fmtDuration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒` : `${s}秒`; };
const shortId = (id) => { const text = String(id); return text.length > 14 ? `${text.slice(0, 14)}…` : text; };
// 页面上的样本 ID 只显示编号：标题以数字开头时取这串数字，否则截短显示；完整标题仍在“样本”一栏
const idText = (id) => { const m = String(id).match(/^\s*(\d{1,8})(?!\d)/); return m ? m[1] : shortId(id); };

// 进度卡片：总进度条 + 累计耗时 + 阶段状态；样本日志只保留失败项，避免长标题刷屏
const STEP_LABELS = { rubric: "读评价体系", calibrate: "制定评分细则", samples: "逐样本评测", review: "复核修正", groups: "问题整合", strategy: "提示词策略", save: "保存" };
function setStep(key, status, note = "") {
  state.progress.steps[key] = { status, note };
  renderProgress();
}
function logFailure(id, message) {
  $("#progressLog").insertAdjacentHTML("beforeend", `<div class="log-row err" title="${esc(id)}"><b>${esc(idText(id))}</b><span>${esc(message)}</span></div>`);
}
function renderProgress() {
  const p = state.progress;
  if (!p) return;
  $("#progressText").textContent = `${p.done} / ${p.total}`;
  $("#progressBar").style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
  const elapsed = (p.endedAt || Date.now()) - p.startedAt;
  $("#progressMeta").textContent = [p.model, `累计 ${fmtDuration(elapsed)}`, p.active ? `进行中 ${p.active}` : "", p.failed ? `失败 ${p.failed}` : ""].filter(Boolean).join(" · ");
  $("#progressSteps").innerHTML = Object.entries(p.steps).map(([key, step]) =>
    `<span class="step ${step.status}" title="${esc(step.note)}">${STEP_LABELS[key]}${step.status === "busy" ? "…" : step.status === "ok" ? " ✓" : step.status === "err" ? " ✕" : ""}</span>`).join("");
}

// 进度卡片只属于发起评测的那个类型；结束后显示结果状态和报告入口
const PROGRESS_LABELS = { running: "RUNNING", done: "已完成", stopped: "已停止", failed: "未完成" };
function setProgress(status, extra = {}) {
  state.progress = { ...state.progress, ...extra, status };
  if (status !== "running") { state.progress.endedAt ||= Date.now(); clearInterval(state.progressTimer); }
  $("#progressState").textContent = PROGRESS_LABELS[status];
  $("#progressState").classList.toggle("live", status === "running");
  $("#stopRun").hidden = status !== "running";
  $("#openRunReport").hidden = !state.progress.run;
  renderProgress();
  syncProgressCard();
}
function syncProgressCard() {
  $("#progressCard").hidden = !state.progress || state.progress.typeId !== state.typeId;
}

// 逐样本调用模型评分；新评测和“重试失败样本”共用。onDone 在每个样本结束时回调
async function evaluateSamples(run, samples, { concurrency, signal, onStart, onDone }) {
  const inputs = runType(run).inputs.map(({ key, label }) => ({ key, label }));
  let cursor = 0;
  const worker = async () => {
    while (cursor < samples.length && !signal?.aborted) {
      const sample = samples[cursor++];
      onStart?.(sample);
      try {
        sample.result = await api("/api/evaluate", { body: { model: run.model, rubric: run.rubric, inputs, guide: run.calibration?.guide || "", think: run.think !== false, sample: { id: sample.id, inputs: sample.inputs } }, signal });
        delete sample.error;
      } catch (error) {
        if (signal?.aborted) break;
        sample.error = error.message === "Failed to fetch" ? "与本地服务的连接中断（服务可能正在重启），可以重试" : error.message;
      }
      onDone?.(sample);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

// 收尾分析拆成三次独立调用并行执行：问题整合、全局复核、提示词策略（填写了提示词且勾选时）。
// 任一项失败只影响它自己：问题整合失败时按指标在本地归类，报告里对应位置可以单独重新生成
const ANALYSIS_NOTES = {
  groups: (run) => `${run.issueGroups.length} 类核心问题`,
  review: (run) => [`修正 ${run.review.applied?.length || 0} 处`, `存疑 ${run.review.findings.length} 处`].join(" · "),
  strategy: (run) => `${run.strategy.strategies.length} 条策略`
};
function applyAnalysis(run, task, result) {
  if (task === "groups") setIssueGroups(run, result.groups);
  if (task === "review") run.review = result.review;
  if (task === "strategy") run.strategy = result.strategy;
  if (run.analysisErrors) delete run.analysisErrors[task];
}
// 复核修正：把模型给出的修正交给程序逐条核对并执行，按修正后的问题重新计分。
// 第一次修正前记下初评的分数和结论（s.initial、run.initialObjects），报告里同时展示初评与复核后的结果
async function applyReview(run, signal) {
  const review = run.review;
  review.applied = [];
  review.rejected = [];
  const corrections = review.corrections || [];
  if (!corrections.length) return;
  const ids = new Set(corrections.map((c) => c.id));
  const samples = run.samples.filter((s) => s.result && ids.has(s.id)).map((s) => ({ id: s.id, inputs: s.inputs, result: s.result }));
  const out = await api("/api/apply-review", { body: { rubric: run.rubric, corrections, samples }, signal });
  review.applied = out.applied || [];
  review.rejected = out.rejected || [];
  // 核对没通过的修正不执行，改为存疑项交给用户判断
  review.findings = [...review.findings, ...review.rejected.map((c) => ({ ids: [c.id],
    problem: `复核提出“${c.type || c.action}”的修正（${c.dim || ""}），但程序核对未通过：${c.reason}`, suggestion: c.basis || "" }))];
  if (!Object.keys(out.samples || {}).length) return;
  run.initialObjects ||= JSON.parse(JSON.stringify(run.objects || {}));
  run.samples.forEach((s) => {
    const fresh = out.samples[s.id];
    if (!fresh) return;
    s.initial ||= { scores: { ...(s.scores || {}) }, status: { ...(s.status || {}) }, native: { ...(s.native || {}) } };
    s.result = fresh;
  });
  aggregate(run);
}

function analysisFailed(run, task, message) {
  if (task === "strategy") run.strategy = { error: message };
  else (run.analysisErrors ||= {})[task] = message;
}
async function runAnalysis(run, task, report = () => {}, signal) {
  if (signal?.aborted) { report(task, "skip", "已停止"); return false; }
  report(task, "busy");
  try {
    const result = await api("/api/analyze", { body: { model: run.model, task, prompt: task === "strategy" ? run.prompt.text : "", context: strategyContext(run, task) }, signal });
    applyAnalysis(run, task, result);
    if (task === "review") await applyReview(run, signal);
    report(task, "ok", `${ANALYSIS_NOTES[task](run)} · 用时 ${fmtDuration(result.elapsed * 1000)}`);
    return true;
  } catch (error) {
    if (signal?.aborted) { report(task, "skip", "已停止"); return false; }
    analysisFailed(run, task, error.message);
    report(task, "err", task === "groups" ? `问题已按指标归类：${error.message}` : error.message);
    return false;
  }
}

async function finalizeRun(run, report = () => {}, signal) {
  aggregate(run);
  run.review = null;
  run.analysisErrors = {};
  const withStrategy = Boolean(run.prompt?.text && run.prompt.wantStrategy);
  // 依次进行：先复核修正（可能补出漏判，所以没有问题时也要复核），再按修正后的问题整合，最后出提示词策略
  await runAnalysis(run, "review", report, signal);
  if (run.rawIssues.length) await runAnalysis(run, "groups", report, signal);
  else report("groups", "skip", "没有发现问题");
  if (withStrategy) await runAnalysis(run, "strategy", report, signal);
  report("save", "busy");
  try {
    await api("/api/runs", { body: { run } });
    await loadSavedRuns();
    report("save", "ok");
    return true;
  } catch (error) {
    report("save", "err", error.message);
    toast(`评测完成，但保存失败：${error.message}`, 5000);
    return false;
  }
}

// 全局分析和提示词策略用的评测概况：评价体系、各样本得分、全部问题和原文证据
function strategyContext(run, task = "") {
  const rubric = runRubric(run);
  const objects = rubric.objects.map((obj) => {
    const result = objResult(run, obj.key);
    return { label: obj.label, score: result.score, pass: result.pass, fail: result.fail,
      dims: obj.dims.map((dim, i) => ({ name: dim.name, kind: rubric.penalty ? "错误扣分型" : dim.kind === "scale" ? "档位型" : dim.kind === "check" ? (dim.gate ? "必须达标项" : "判定型") : "扣分型", range: dimRange(dim, rubric),
        weight: dim.weight, avg: result.dimAvg?.[i], measure: dim.measure, fail: dim.fail })) };
  });
  const samples = run.samples.filter((s) => s.result).map((s) => ({ id: s.id, title: s.title,
    scores: Object.fromEntries(rubric.objects.map((obj) => {
      const r = s.result.objects?.[obj.key];
      // 档位型给所选档位和依据，判定型给是否达标：复核要看的是这些，而不是换算后的分数
      const items = (r?.items || []).map((item) => ({ label: item.label, dims: Object.fromEntries((item.dims || []).map((d) => [d.name,
        d.kind === "scale" ? { level: d.level, basis: d.basis || "" } : d.kind === "check" ? { met: d.met } : { score: d.score, full: d.weight }])) }));
      return [obj.label, r ? { total: r.score, status: r.status, items } : null];
    })), summary: s.result.summary }));
  const issues = run.issueGroups.map((group) => ({ title: group.title, issues: group.issues.map((i) => run.issues[i]).map((issue) => ({ level: issue.level, title: issue.title, desc: issue.desc, ids: issue.ids })) }));
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const evidence = run.rawIssues.slice().sort((a, b) => (order[a.level] ?? 4) - (order[b.level] ?? 4)).slice(0, task === "groups" ? 600 : 200)
    .map((raw) => ({ id: raw.id, level: raw.level, dim: raw.dim, detail: raw.detail, evidence: raw.evidence }));
  // 判定规则和计分方式照实传给模型，避免它按默认的 85 分及格线重新判定
  const rules = { pass: passRuleText(rubric.rules || {}, rubric), text: rubric.rules?.pass || "",
    kinds: { 扣分型: "按问题等级从满分扣分", 档位型: "模型按档位描述选档", 判定型: "P0–P2 不达标，P3 只记录", 必须达标项: "不计分，不达标则该条目不通过", 错误扣分型: "每个错误按等级记扣分、条目内累计，合计不超过上限才通过" } };
  const sampleIds = run.samples.filter((s) => s.result).map((s) => s.id);
  // 每项收尾分析只拿它需要的输入，避免把别的步骤的派生结果当成依据：
  // 问题整合只看逐条问题；全局复核看问题、原文和评分细则，不看总结与问题整合；提示词策略看得分、问题和总结
  if (task === "groups") return { rubric: rubric.name, objects, evidence, sampleIds };
  if (task === "review") {
    const budget = Math.max(400, Math.floor(60000 / Math.max(1, sampleIds.length)));
    return { rubric: rubric.name, rules, objects, evidence, sampleIds, guide: run.calibration?.guide || "",
      samples: samples.map(({ summary, ...rest }) => rest),
      outputs: run.samples.filter((s) => s.result).map((s) => ({ id: s.id,
        inputs: Object.fromEntries(Object.entries(s.inputs || {}).map(([k, v]) => [k, String(v).slice(0, budget)])) })) };
  }
  const context = { rubric: rubric.name, rules, objects, samples, issues, evidence, sampleIds };
  if (task === "strategy") context.doubts = (run.review?.findings || []).map((f) => ({ ids: f.ids, problem: f.problem }));
  return context;
}

async function runEvaluation() {
  const type = currentType();
  let rubric = currentRubric();
  const name = $("#evaluationName").value.trim();
  if (!state.gateway.configured) return toast("服务端未配置模型网关，无法调用模型", 4000);
  // 平台代码更新后，没刷新的页面还在跑旧逻辑：发现版本变了就先提示刷新
  try {
    const latest = (await api("/api/status")).pageVersion;
    if (state.gateway.pageVersion && latest && latest !== state.gateway.pageVersion) return toast("平台已更新，请先按 Cmd+Shift+R（Windows 为 Ctrl+F5）刷新页面再运行", 8000);
  } catch { /* 取不到版本时不拦截 */ }
  if (!name) return toast("请填写本次评测名称");
  if (!rubric) return toast("请先提供评价体系");
  if (!state.samples.length) return toast("没有识别到可评测的样本，请检查上传的文件");
  if (!state.modelId) return toast("请选择评测模型");
  const promptText = $("#promptText").value.trim();
  const promptTag = $("#promptTag").value.trim();
  if (promptText && !promptTag) return toast("填写了提示词时，请给它一个版本标签，方便在历史里区分");

  const limit = Number($("#sampleLimit").value) || state.samples.length;
  const queue = state.samples.slice(0, limit);
  const controller = new AbortController();
  state.running = controller;
  $("#progressLog").innerHTML = "";
  const steps = { ...(rubric.objects?.length ? {} : { rubric: { status: "wait" } }), ...($("#calibrate").checked ? { calibrate: { status: "wait" } } : {}),
    samples: { status: "wait" }, review: { status: "wait" }, groups: { status: "wait" },
    ...(promptText && $("#promptStrategy").checked ? { strategy: { status: "wait" } } : {}), save: { status: "wait" } };
  state.progress = { typeId: state.typeId, run: null, model: state.modelId, total: queue.length, done: 0, active: 0, failed: 0, startedAt: Date.now(), endedAt: null, steps };
  clearInterval(state.progressTimer);
  state.progressTimer = setInterval(renderProgress, 1000);
  setProgress("running");
  $("#runEvaluation").disabled = true;
  $("#runEvaluation").firstElementChild.textContent = "评测中…";
  const finish = (status) => {
    $("#runEvaluation").disabled = false;
    $("#runEvaluation").firstElementChild.textContent = "运行评测";
    state.running = null;
    setProgress(status);
  };

  // 评价体系只有原文、页面也没识别出结构时：先让模型通读，整理出统一的评分结构
  if (!rubric.objects?.length) {
    setStep("rubric", "busy");
    try {
      const planned = (await api("/api/plan-rubric", { body: { model: state.modelId, document: rubric.document }, signal: controller.signal })).rubric;
      rubric = { ...planned, name: planned.name || rubric.name, source: rubric.source, document: rubric.document, structureBy: "model" };
      setStep("rubric", "ok", rubric.objects.map((obj) => `${obj.label} ${obj.dims.length} 项指标`).join(" · "));
    } catch (error) {
      if (controller.signal.aborted) { finish("stopped"); return toast("已停止"); }
      setStep("rubric", "err", error.message);
      logFailure("评价体系", error.message);
      finish("failed");
      return toast(`模型未能读懂评价体系：${error.message}`, 6000);
    }
  }

  const custom = type.id === NEW_TYPE;
  const typeDef = custom
    ? { ...NEW_TYPE_DEF, id: `custom-${Date.now()}`, name: rubric.name || name, desc: "自定义评测类型", rubric, custom: true }
    : { ...type, rubric: rubric };
  const run = {
    id: `run-${Date.now()}`, source: "live", name, typeId: typeDef.id, typeName: typeDef.name, typeDef,
    rubric, model: state.modelId, createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    files: Object.fromEntries(Object.entries(state.files).map(([key, file]) => [key, file.name])),
    prompt: promptText ? { tag: promptTag, text: promptText, file: state.promptFile || "", wantStrategy: $("#promptStrategy").checked } : null,
    think: !$("#fastMode").checked, calibration: null,
    samples: queue.map((s) => ({ id: s.id, title: s.title, inputs: s.inputs, lines: s.lines }))
  };

  // 评分细则只依据评价体系和各样本数据源制定；同一评价体系 + 同一批数据源已有细则时直接沿用，保证多次评测用同一把尺子
  if ($("#calibrate").checked) {
    setStep("calibrate", "busy");
    try {
      const samples = queue.map((s) => ({ id: s.id, source: s.inputs?.source || "" }));
      const regenerate = $("#regenGuide").checked;
      $("#regenGuide").checked = false;
      renderSummary();
      const result = await api("/api/calibrate", { body: { model: run.model, rubric, samples, regenerate }, signal: controller.signal });
      run.calibration = { guide: result.guide, key: result.key, version: result.version, origin: result.origin, reused: result.reused,
        createdAt: result.createdAt, elapsed: result.elapsed, model: result.model || run.model };
      setStep("calibrate", "ok", result.reused ? `沿用评分细则 v${result.version}（${result.createdAt} 制定）` : `已制定评分细则 v${result.version}，用时 ${fmtDuration(result.elapsed * 1000)}`);
    } catch (error) {
      if (controller.signal.aborted) { finish("stopped"); return toast("已停止"); }
      setStep("calibrate", "err", `未能制定评分细则，按评价体系直接评分：${error.message}`);
      logFailure("评分细则", error.message);
    }
  }

  setStep("samples", "busy");
  await evaluateSamples(run, run.samples, {
    concurrency: Number($("#concurrency").value), signal: controller.signal,
    onStart: () => { state.progress.active++; renderProgress(); },
    onDone: (sample) => {
      state.progress.active--;
      state.progress.done++;
      if (sample.error) { state.progress.failed++; logFailure(sample.id, sample.error); }
      renderProgress();
    }
  });

  const stopped = controller.signal.aborted;
  state.progress.active = 0;
  run.samples = run.samples.filter((s) => s.result || s.error);
  if (!run.samples.some((s) => s.result)) {
    setStep("samples", "err", "没有完成的样本");
    finish(stopped ? "stopped" : "failed");
    return toast(stopped ? "已停止，没有完成的样本" : "所有样本都调用失败，请查看失败原因", 5000);
  }
  setStep("samples", state.progress.failed ? "err" : "ok", state.progress.failed ? `${state.progress.failed} 条失败，可在报告中重试` : "");
  if (stopped) run.name += "（已停止）";
  const saved = await finalizeRun(run, setStep, controller.signal);
  finish(stopped ? "stopped" : "done");
  setProgress(state.progress.status, { run });
  if (saved) toast("评测完成，已保存到历史评测");
  if (state.typeId === state.progress.typeId) {
    // 评测已保存：表单清空，回到新建页时是一张干净的表；未保存或中途停止时保留，便于重新运行
    if (saved && !stopped) selectType(state.typeId);
    openReport(run);
  }
}

// 报告里重试调用失败的样本：沿用这次评测的模型和评分结构，完成后重新汇总并覆盖保存
async function retryFailed(button) {
  const run = state.reportRun;
  const failed = run.samples.filter((s) => s.error && !s.result);
  if (!failed.length || !run.rubric || !run.model) return;
  if (!state.gateway.configured) return toast("模型网关未配置，无法重试");
  button.disabled = true;
  let done = 0;
  button.textContent = `重试中 0 / ${failed.length}`;
  await evaluateSamples(run, failed, { concurrency: 4, onDone: () => { button.textContent = `重试中 ${++done} / ${failed.length}`; } });
  const still = failed.filter((s) => s.error).length;
  await finalizeRun(run);
  toast(still ? `重试完成，仍有 ${still} 条失败` : "失败样本已全部重试成功");
  openReport(run);
}

async function loadSavedRuns() {
  try {
    state.savedRuns = (await api("/api/runs")).runs;
    state.hidden = await api("/api/hidden");
  } catch {
    state.savedRuns = [];
  }
  const seen = new Set(MODULE_TYPES.map((t) => t.id));
  state.customTypes = [];
  state.savedRuns.forEach((run) => {
    if (run.typeDef?.custom && !seen.has(run.typeDef.id)) { seen.add(run.typeDef.id); state.customTypes.push(run.typeDef); }
  });
  renderTypes();
}

function bindCreate() {
  $("#typeOptions").addEventListener("click", (event) => {
    const option = event.target.closest(".type-option");
    if (option) selectType(option.dataset.type);
  });
  $("#rubricSlot").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) loadRubricFile(file);
    event.target.value = "";
  });
  $("#rubricSlot").addEventListener("click", (event) => {
    if (event.target.closest("[data-parse-rubric]")) return parseRubricWithModel();
    if (!event.target.closest("[data-show-rubric]")) return;
    showRubric(currentRubric());
  });
  $("#inputSlots").addEventListener("change", async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    if (!INPUT_ACCEPT.split(",").some((ext) => file.name.toLowerCase().endsWith(ext))) return toast("支持 .md / .txt / .json / .jsonl 文件");
    const content = await file.text();
    const importedFile = { name: file.name, content, batchId: `${file.name}:${file.size}:${file.lastModified}:${Date.now()}` };
    // 文件里带有其他输入的小节标题时（例如一份文件同时含数据源与内容结果），同时填入这些尚未上传的输入
    const type = currentType();
    type.inputs.forEach((slot) => {
      const ownSection = !state.files[slot.key] && fileCovers(content, file.name, type, slot.key);
      if (slot.key === input.dataset.key || ownSection) state.files[slot.key] = importedFile;
    });
    buildSamples();
    renderSlots();
    renderScan();
    renderSummary();
    toast(`已载入 ${file.name}，识别到 ${state.samples.length} 个样本`);
  });
  $("#sampleScan").addEventListener("change", (event) => {
    if (!event.target.matches("[data-split-mode]")) return;
    state.splitMode = event.target.value;
    buildSamples();
    renderScan();
    renderSummary();
  });
  $("#promptFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    $("#promptText").value = await file.text();
    state.promptFile = file.name;
    $("#promptFileName").textContent = file.name;
    if (!$("#promptTag").value.trim()) $("#promptTag").value = file.name.replace(/\.\w+$/, "");
    event.target.value = "";
    renderSummary();
  });
  ["#promptText", "#promptTag"].forEach((sel) => $(sel).addEventListener("input", renderSummary));
  ["#promptStrategy", "#calibrate", "#regenGuide", "#fastMode", "#concurrency"].forEach((sel) => $(sel).addEventListener("change", renderSummary));
  ["#evaluationName", "#sampleLimit"].forEach((sel) => $(sel).addEventListener("input", renderSummary));
  $("#modelTrigger").addEventListener("click", () => {
    const panel = $("#modelPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderModels($("#modelSearch").value); $("#modelSearch").focus(); }
  });
  $("#modelSearch").addEventListener("input", (event) => renderModels(event.target.value));
  $("#modelSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.value.trim()) selectModel(event.target.value.trim());
  });
  $("#modelList").addEventListener("click", (event) => {
    const item = event.target.closest(".model-item");
    if (item) selectModel(item.dataset.model);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".model-picker")) $("#modelPanel").hidden = true;
  });
  $("#runEvaluation").addEventListener("click", runEvaluation);
  $("#gatewayToggle").addEventListener("click", async () => {
    const form = $("#gatewayForm");
    form.hidden = !form.hidden;
    if (form.hidden) return;
    try {
      const cfg = await api("/api/config");
      $("#gatewayBase").value = cfg.api_base || "";
      $("#gatewayKey").placeholder = cfg.has_key ? "已保存密钥，留空表示不修改" : "填写 API Key";
      applyAuth(cfg.auth_header || "Authorization", cfg.auth_prefix || "");
    } catch (error) {
      toast(`读取配置失败：${error.message}`);
    }
  });
  $("#gatewayAuth").addEventListener("change", () => syncAuthForm());
  $("#gatewayTest").addEventListener("click", async () => {
    const box = $("#gatewayResult");
    box.className = "gateway-result";
    box.textContent = "正在连接…";
    try {
      const result = await api("/api/config/test", { body: { api_base: $("#gatewayBase").value.trim(), api_key: $("#gatewayKey").value.trim(), ...authValues() } });
      box.className = `gateway-result ${result.ok ? "ok" : "err"}`;
      box.textContent = result.ok
        ? `连接成功，网关返回 ${result.total} 个模型：\n${result.models.join("\n")}`
        : `连接失败：${result.error}`;
    } catch (error) {
      box.className = "gateway-result err";
      box.textContent = `连接失败：${error.message}`;
    }
  });
  $("#gatewaySave").addEventListener("click", async () => {
    const box = $("#gatewayResult");
    try {
      const result = await api("/api/config", { body: { api_base: $("#gatewayBase").value.trim(), api_key: $("#gatewayKey").value.trim(), ...authValues() } });
      $("#gatewayKey").value = "";
      $("#gatewayKey").placeholder = result.has_key ? "已保存密钥，留空表示不修改" : "填写 API Key";
      box.className = "gateway-result ok";
      box.textContent = `已保存到 eval_config.json：${result.api_base}${result.has_key ? "（含密钥）" : "（未设置密钥）"}${result.env_override ? "\n注意：环境变量优先生效，修改配置文件可能不生效" : ""}`;
      await loadGateway();
      toast("网关配置已保存");
    } catch (error) {
      box.className = "gateway-result err";
      box.textContent = `保存失败：${error.message}`;
    }
  });
  $("#stopRun").addEventListener("click", () => { state.running?.abort(); toast("正在停止，已完成的样本会保留"); });
  $("#openRunReport").addEventListener("click", () => { if (state.progress?.run) openReport(state.progress.run); });
}

// 二次确认弹窗：返回 Promise<boolean>
function confirmAction(title, text) {
  const modal = $("#confirmModal");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  modal.hidden = false;
  return new Promise((resolve) => {
    modal.onclick = (event) => {
      const choice = event.target.closest("[data-confirm]")?.dataset.confirm;
      if (!choice && event.target !== modal) return;
      modal.hidden = true;
      modal.onclick = null;
      resolve(choice === "yes");
    };
  });
}

async function deleteRun(run) {
  if (!(await confirmAction("删除这条评测记录？", `「${run.name || run.id}」将从历史评测中移除。本地保存的记录会移到 runs/.trash，可手动恢复。`))) return;
  try {
    const result = await api("/api/runs/delete", { body: { id: run.id } });
    if (result.hidden) state.hidden = result.hidden;
    await loadSavedRuns();
    renderHistory();
    toast("已删除");
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
}
/* ---------- 历史评测 ---------- */
// 报告与历史只按记录里实际存在的字段展示：有则展示，缺则留空，不因缺字段报错
const INPUT_LABELS = { source: "数据源", intro: "简介", output: "内容结果" };
const runRubric = (run) => {
  const rubric = run.rubric || RUBRICS[run.rubricId] || { name: "未记录评价体系" };
  return { ...rubric, objects: (rubric.objects || []).filter((obj) => obj && obj.key) };
};
const runType = (run) => {
  const type = run.typeDef || typeById(run.typeId);
  if (type?.inputs?.length) return type;
  const keys = [...new Set((run.samples || []).flatMap((s) => Object.keys(s.inputs || {})))];
  return { id: run.typeId, name: type?.name || run.typeName || "未知类型", desc: type?.desc || "", parsers: type?.parsers || [],
    inputs: keys.map((key) => ({ key, label: INPUT_LABELS[key] || key, format: "markdown" })) };
};
const objResult = (run, key) => run.objects?.[key] || {};
const overallScore = (run) => {
  const values = runRubric(run).objects.map((obj) => objResult(run, obj.key).score).filter(isNum).map(Number);
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
};

// 时间统一换算成毫秒用于排序：优先 createdAt，其次 run-<时间戳> 形式的 ID
const runTime = (run) => {
  const parsed = Date.parse(String(run.createdAt || "").replace(/\//g, "-").replace(" ", "T"));
  if (Number.isFinite(parsed)) return parsed;
  const m = String(run.id || "").match(/(\d{12,})/);
  return m ? Number(m[1]) : 0;
};
const TYPE_COLORS = ["#3ee6dc", "#5b8cff", "#b48cff", "#5ff0a8", "#ffaa5c", "#ff7fb0", "#7fd4ff"];
const typeColor = (typeId) => TYPE_COLORS[[...String(typeId || "")].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % TYPE_COLORS.length];

// 某个评测类型下的提示词版本：按评测时间从新到旧；同一标签且原文相同的视为同一版本，记录它参与过的各次评测
function promptVersions(typeId) {
  const versions = [];
  allRuns().filter((run) => run.typeId === typeId && run.prompt?.text).sort((a, b) => runTime(b) - runTime(a)).forEach((run) => {
    const same = versions.find((v) => v.tag === run.prompt.tag && v.text === run.prompt.text);
    if (same) same.runs.push(run);
    else versions.push({ tag: run.prompt.tag || "未命名版本", text: run.prompt.text, file: run.prompt.file, runs: [run] });
  });
  return versions;
}

function renderPromptVersions(typeId) {
  const versions = promptVersions(typeId);
  if (!versions.length) return "";
  const index = Math.min(state.promptVersion || 0, versions.length - 1);
  const shown = versions[index];
  const rows = versions.map((v, i) => {
    const latest = v.runs[0];
    return `<button class="version-row ${i === index ? "active" : ""}" data-version="${i}"><b>${esc(v.tag)}</b>${i === 0 ? `<em>最新</em>` : ""}
      <span>${esc(latest.createdAt || "")} · ${v.runs.length} 次评测</span><strong>${fmtOr(overallScore(latest))}</strong></button>`;
  }).join("");
  return `<section class="card prompt-versions">
      <header class="card-head"><span class="card-index">P</span><div><h2>提示词版本</h2><p>按评测时间排列；点击版本查看原文，分数取该版本最近一次评测的总分</p></div></header>
      <div class="version-grid"><div class="version-list">${rows}</div>
        <div class="version-body"><div class="version-title"><b>${esc(shown.tag)}</b><span>${esc(shown.file || "")}${shown.file ? " · " : ""}用于：${shown.runs.map((run) => esc(run.name || run.id)).join("、")}</span></div>
          <pre class="doc-pre">${esc(shown.text)}</pre></div></div>
    </section>`;
}

function renderHistory() {
  const runs = allRuns();
  const types = new Map(runs.map((run) => [run.typeId || "unknown", runType(run)]));
  const filter = $("#historyType");
  const chosen = types.has(filter.value) ? filter.value : "all";
  filter.innerHTML = `<option value="all">全部类型 · ${runs.length}</option>` + [...types.entries()].map(([id, type]) =>
    `<option value="${esc(id)}">${esc(type?.name || "未知类型")} · ${runs.filter((run) => (run.typeId || "unknown") === id).length}</option>`).join("");
  filter.value = chosen;
  const sort = $("#historySort").value;
  const score = (run) => overallScore(run) ?? -1;
  const list = runs.filter((run) => chosen === "all" || (run.typeId || "unknown") === chosen).sort((a, b) =>
    sort === "old" ? runTime(a) - runTime(b) : sort === "high" ? score(b) - score(a) : sort === "low" ? score(a) - score(b) : runTime(b) - runTime(a));
  const versions = chosen === "all" ? "" : renderPromptVersions(chosen);
  $("#historyGroups").innerHTML = versions + (list.length ? `<div class="run-list">${list.map((run) => {
    const type = types.get(run.typeId || "unknown");
    const count = run.sampleCount ?? run.samples?.filter((s) => s.scores).length;
    const meta = [run.createdAt, run.model, isNum(count) ? `${count} 个样本` : "", run.source === "imported" ? "导入报告" : ""].filter(Boolean).map(esc).join(" · ");
    const reusable = type && typeById(type.id) && !state.hidden.types.includes(type.id);
    return `<article class="card run-row" data-run="${esc(run.id)}" style="--t:${typeColor(run.typeId)}">
        <div class="run-main"><span class="type-tag">${esc(type?.name || "未知类型")}</span>${run.prompt?.tag ? `<span class="prompt-tag" title="被评测的提示词版本">提示词 ${esc(run.prompt.tag)}</span>` : ""}
          <h3>${esc(run.name || run.id)}</h3><p>${meta}</p></div>
        <div class="run-total"><strong>${fmtOr(overallScore(run))}</strong><span>/ 100</span></div>
        <div class="run-actions">
          <button class="ghost-button primary-ghost" data-open>查看报告</button>
          ${reusable ? `<button class="ghost-button" data-reuse="${esc(type.id)}">以此类型新建</button>` : ""}
          <button class="ghost-button danger-button" data-delete>删除</button>
        </div>
      </article>`;
  }).join("")}</div>` : `<div class="empty">还没有评测记录</div>`);
}

function bindHistory() {
  ["#historyType", "#historySort"].forEach((sel) => $(sel).addEventListener("change", () => { state.promptVersion = 0; renderHistory(); }));
  $("#historyGroups").addEventListener("click", async (event) => {
    const version = event.target.closest("[data-version]");
    if (version) { state.promptVersion = Number(version.dataset.version); return renderHistory(); }
    const card = event.target.closest(".run-row");
    if (!card) return;
    const reuse = event.target.closest("[data-reuse]");
    if (reuse) { selectType(reuse.dataset.reuse); showView("create"); return toast("已带入该类型的输入结构与评价体系"); }
    const run = allRuns().find((item) => item.id === card.dataset.run);
    if (!run) return;
    if (event.target.closest("[data-delete]")) return deleteRun(run);
    if (run.source === "imported") return openReport(run);
    try {
      openReport(await api(`/api/runs/${encodeURIComponent(run.id)}`));
    } catch (error) {
      toast(`读取评测记录失败：${error.message}`);
    }
  });
}

/* ---------- 评分细则版本 ---------- */
const guideLabel = (run) => (run.calibration?.version ? `评分细则 v${run.calibration.version}` : "评分细则（未固定版本）");
function guideNote(run) {
  const c = run.calibration || {};
  if (!c.version) return "旧版本评测：细则在当次评测时参考输出临时制定，不能保证与其他评测一致";
  const how = c.origin === "edited" ? "手工修改" : "依据评价体系和数据源制定";
  return `${how}，${c.reused ? "本次沿用" : "本次新制定"} · ${c.createdAt || ""}`;
}
// 两次评测是否用同一版细则：都有指纹时比指纹和版本，旧记录比细则原文
function sameGuide(a, b) {
  const ca = a.calibration || {}, cb = b.calibration || {};
  if (ca.key && cb.key) return ca.key === cb.key && ca.version === cb.version;
  return normText(ca.guide) === normText(cb.guide);
}

function editGuide(button) {
  const run = state.reportRun;
  const card = button.closest(".guide-card");
  const body = $(".guide-body", card);
  if ($("textarea", card)) return;
  body.innerHTML = `<textarea class="input guide-editor" rows="18">${esc(run.calibration.guide)}</textarea>
    <div class="guide-tools"><button class="ghost-button" data-save-guide>保存为新版本</button><button class="ghost-button" data-cancel-guide>取消</button></div>`;
  card.open = true;
}

async function saveGuide(button) {
  const run = state.reportRun;
  const text = $(".guide-editor", button.closest(".guide-card")).value.trim();
  if (!text) return toast("细则不能为空");
  button.disabled = true;
  try {
    const saved = await api("/api/guide/save", { body: { key: run.calibration.key, guide: text, model: "手工修改" } });
    toast(`已保存为评分细则 v${saved.version}，下一次用同一评价体系和评测集评测时自动使用`, 5000);
    openReport(run);
  } catch (error) {
    button.disabled = false;
    toast(`保存失败：${error.message}`);
  }
}

/* ---------- 评测报告 ---------- */
function openReport(run) {
  const rubric = runRubric(run);
  const type = runType(run);
  const total = overallScore(run);
  run.samples ||= [];
  ensureIssueGroups(run);
  state.reportRun = run;
  state.openGroup = null;
  state.openSamples.clear();
  state.issueFilter = null;
  const objects = rubric.objects;
  const formula = objects.length > 1 ? `<div class="formula">总分 = ( ${objects.map((obj) => `${esc(obj.label)} <b>${fmtOr(objResult(run, obj.key).score)}</b>`).join(" + ")} ) ÷ ${objects.length}</div>` : "";
  const sampleCount = run.samples.filter((s) => s.scores).length;
  const failedCount = run.samples.filter((s) => s.error && !s.result).length;
  const errors = run.errors?.length ? `<div class="warn-box"><b>${run.errors.length} 个样本调用失败，未计入均值</b>${run.errors.map((e) => `<span title="${esc(e.id)}">${esc(idText(e.id))}：${esc(e.error)}</span>`).join("")}
    ${failedCount && run.source === "live" ? `<div><button class="ghost-button" data-retry>重试失败的 ${failedCount} 个样本</button></div>` : ""}</div>` : "";
  const chip = (label, value) => (value ? `<span class="chip">${label} <b>${value}</b></span>` : "");
  const objGrid = objects.length ? `<div class="obj-grid">${objects.map((obj) => renderObject(obj, { ...objResult(run, obj.key), initialScore: run.initialObjects?.[obj.key]?.score }, rubric)).join("")}</div>` : "";
  const redo = (task, label) => (run.analysisErrors?.[task] ? `<div class="empty small">${label}生成失败：${esc(run.analysisErrors[task])}${run.source === "live" ? ` <button class="ghost-button" data-redo="${task}">重新生成</button>` : ""}</div>` : "");
  const issueGrid = run.issues.length ? `${redo("groups", "问题整合（当前按指标归类）")}<div class="issue-groups" id="issueGroups">${renderIssueGroups(run)}</div>` : "";
  let section = 0;
  const no = () => String(++section).padStart(2, "0");
  // 全局复核放在样本明细之后，默认收起：它是对打分尺度的旁注，不打断主内容的阅读
  // 复核：已修正的列出改了什么、依据是什么（分数已按修正后重新计算）；存疑项需要人来判断，不自动修改
  const findings = run.review?.findings || [];
  const applied = run.review?.applied || [];
  const fixRow = (c) => `<div class="diag-row"><span class="lvl" style="--c:var(--cyan)">已修正</span><div><b>${esc(c.type || c.action)} · ${esc(c.dim || "")}${c.toDim ? ` → ${esc(c.toDim)}` : ""}${c.level ? ` · ${esc(c.level)}` : ""}</b>
        <p>样本 ${esc(idText(c.id))}${c.evidence ? ` · 「${esc(c.evidence)}」` : ""}${c.basis ? ` · 依据：${esc(c.basis)}` : ""}</p></div></div>`;
  const review = run.review && (run.review.summary || findings.length || applied.length) ? `<details class="card review-card"><summary><b>全局复核</b>
      <span>${applied.length ? `已修正 ${applied.length} 处` : "无需修正"} · ${findings.length ? `存疑 ${findings.length} 处待你判断` : "无存疑"} · 点击展开</span></summary>
      ${run.review.summary ? `<p class="note top0">${esc(run.review.summary)}</p>` : ""}
      ${findings.map((f) => `<div class="diag-row"><span class="lvl" style="--c:var(--orange)">存疑</span><div><b>${esc(f.problem)}</b>
        <p>${f.ids.length ? `样本 ${f.ids.map((id) => esc(idText(id))).join("、")} · ` : ""}${esc(f.suggestion)}</p></div></div>`).join("")}
      ${applied.length ? `<p class="note">以下修正有确凿依据，已由程序核对后执行，分数和结论按修正后的问题重新计算；各样本的初评结果仍保留。</p>${applied.map(fixRow).join("")}` : ""}</details>` : "";
  const guide = run.calibration?.guide ? `<details class="card prompt-card guide-card"><summary><b>${esc(guideLabel(run))}</b><span>${esc(guideNote(run))} · 点击展开</span></summary>
      ${run.calibration.key && run.source === "live" ? `<div class="guide-tools"><button class="ghost-button" data-edit-guide>修改细则</button><span>保存后生成新版本，从下一次评测起生效；本次结果不变</span></div>` : ""}
      <div class="doc-body guide-body">${renderDocument(run.calibration.guide, "guide.md")}</div></details>` : "";
  const reviewBox = review || redo("review", "全局复核");
  const detailSection = objGrid || issueGrid || guide ? `<section class="section">
      <div class="section-head"><h2><i>${no()}</i>细致表现</h2><p>按评价对象拆分；低于该指标满分 75% 的标记为短板</p></div>
      ${objGrid}${issueGrid}${guide}
    </section>` : "";
  const samplesNo = no();
  const promptSection = run.prompt?.text ? `<section class="section">
      <div class="section-head"><h2><i>${no()}</i>提示词优化策略</h2><p>由模型对照本次发现的问题与提示词原文生成；每条策略都标明对应问题、样本和复测方法</p></div>
      ${renderStrategy(run)}
    </section>` : "";

  $("#reportRoot").innerHTML = `
    <div class="report-bar"><button class="ghost-button" data-back>← 历史评测</button><span class="crumb">REPORT / ${esc(String(run.id || "").toUpperCase())}</span></div>
    <section class="card hero">
      <div>
        <div class="kicker">${run.source === "imported" ? "IMPORTED REPORT" : "LIVE EVALUATION"}</div>
        <h1>${esc(run.name || run.id)}</h1>
        <div class="hero-meta">
          ${chip("输入", type.inputs.map((i) => esc(i.label)).join(" → "))}
          ${chip("样本", sampleCount)}
          ${chip("模型", esc(run.model || ""))}
          ${chip("体系", esc(rubric.name || ""))}
          ${chip("提示词", esc(run.prompt?.tag || ""))}
          ${run.rubric || run.rubricId ? `<button type="button" class="chip chip-button" data-run-rubric>查看评价体系 ↗</button>` : ""}
          ${run.source === "live" ? `<button type="button" class="chip chip-button" data-compare>对比历史评测 ⇄</button>` : ""}
          ${chip("来源", esc(run.reportFile || ""))}
        </div>
        ${formula}
        ${run.excluded ? `<div class="formula">${esc(run.excluded)}</div>` : ""}
      </div>
      <div class="ring">
        <svg viewBox="0 0 200 200"><defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ee6dc"/><stop offset="1" stop-color="#5b8cff"/></linearGradient></defs>
          <circle class="track" cx="100" cy="100" r="86" fill="none" stroke-width="12"/>
          <circle class="bar" cx="100" cy="100" r="86" fill="none" stroke-width="12" stroke-dasharray="540.4" stroke-dashoffset="540.4"/></svg>
        <div class="ring-center"><span>总分</span><strong id="totalScore">${isNum(total) ? "0.0" : "—"}</strong><small>/ 100</small></div>
      </div>
    </section>
    ${errors}

    ${detailSection}

    <section class="section">
      <div class="section-head"><h2><i>${samplesNo}</i>样本明细</h2>
        <div class="sample-tools">
          <span class="filter-pill" id="filterPill"><span id="filterText"></span><button data-clear>✕</button></span>
          <input id="sampleSearch" class="input" placeholder="搜索 ID / 标题 / 问题" />
          <select id="statusFilter" class="input"><option value="all">全部结论</option><option value="通过">通过</option><option value="不通过">不通过</option></select>
        </div>
      </div>
      <div class="sample-table" style="--obj-count:${objects.length}">
        <div class="s-head"><span>ID</span><span>样本</span>${objects.map((obj) => `<span class="h-score">${esc(obj.label)}</span>`).join("")}<span>结论</span><span class="h-issue">主要问题</span><span></span></div>
        <div id="sampleRows"></div>
      </div>
      <p class="note">样本结论 = 所有评价对象均通过。点击任一行，在原位展开该样本的原文${run.source === "live" ? "及逐指标评分理由" : ""}。</p>
      ${reviewBox}
    </section>
    ${promptSection}`;

  showView("report");
  setTimeout(() => {
    if (isNum(total)) {
      $(".ring .bar").style.strokeDashoffset = String(540.4 * (1 - Math.min(Number(total), 100) / 100));
      countUp($("#totalScore"), Number(total));
    }
    $$(".dim-track i").forEach((bar) => { bar.style.width = bar.dataset.w; });
    $$("[data-count]").forEach((node) => countUp(node, Number(node.dataset.count)));
  }, 60);
  renderSamples();
}

function renderObject(obj, result = {}, rubric = null) {
  const pass = Number(result.pass), fail = Number(result.fail);
  const hasPass = Number.isFinite(pass) && Number.isFinite(fail) && pass + fail > 0;
  const dims = Array.isArray(result.dimAvg) ? (obj.dims || []).map((dim, i) => {
    if (!isNum(result.dimAvg[i])) return "";
    const view = dimView(dim, result.dimStats?.[i] || { score: result.dimAvg[i] }, rubric);
    const ratio = view.ratio;
    const over = ratio > 1 ? `<span class="anomaly" title="平均分超过该指标满分，按原报告如实展示">超出满分</span>` : "";
    return `<div class="dim ${ratio < 0.75 ? "low" : ""} ${ratio > 1 ? "over" : ""}"><span class="dim-name">${esc(dim.name)}${over}</span>
      <span class="dim-val"><b>${esc(view.text)}</b></span>
      <span class="dim-track"><i data-w="${Math.min(ratio, 1) * 100}%"></i></span></div>`;
  }).join("") : "";
  return `<article class="card">
    <div class="obj-head"><div><h3>${esc(obj.label)}</h3>${result.unit ? `<p>${esc(result.unit)}</p>` : ""}</div>
      <div class="obj-score">${isNum(result.score) ? `<strong data-count="${Number(result.score)}">0.0</strong>` : "<strong>—</strong>"}${nativeText(result.native) ? `<small class="native">平均 ${esc(nativeText(result.native))}</small>` : ""}${isNum(result.initialScore) && Math.abs(result.initialScore - result.score) > 0.05 ? `<small class="native">初评 ${esc(fmt(result.initialScore))}</small>` : ""}</div></div>
    ${hasPass ? `<div class="passbar"><i style="width:${(pass / (pass + fail)) * 100}%"></i></div>
    <div class="passlegend"><span>通过样本 <b>${pass}</b> / ${pass + fail}</span><span>不通过 <b class="f">${fail}</b></span></div>` : ""}
    ${dims}
  </article>`;
}
/* ---------- 样本明细与原文展开 ---------- */
const sampleVerdict = (sample) => {
  const values = Object.values(sample.status || {});
  return values.length ? (values.every((v) => v === "通过") ? "通过" : "不通过") : "";
};

function renderSamples() {
  const run = state.reportRun;
  const rubric = runRubric(run);
  const word = $("#sampleSearch").value.trim().toLowerCase();
  const status = $("#statusFilter").value;
  const issueIds = state.issueFilter === null ? null : run.issues[state.issueFilter]?.ids || null;
  const list = run.samples.filter((s) => s.scores &&
    (!word || `${s.id} ${s.title || ""} ${s.summary || ""}`.toLowerCase().includes(word)) &&
    (status === "all" || sampleVerdict(s) === status) &&
    (!issueIds || issueIds.includes(s.id)));
  $("#sampleRows").innerHTML = list.map((s) => {
    const open = state.openSamples.has(s.id);
    const scores = rubric.objects.map((obj) => {
      const value = s.scores?.[obj.key];
      if (!isNum(value)) return `<span class="s-score"><b>—</b></span>`;
      const color = s.status?.[obj.key] === "通过" ? "var(--cyan)" : s.status?.[obj.key] ? "var(--red)" : "var(--ink-3)";
      return `<span class="s-score"><b>${esc(nativeText(s.native?.[obj.key]) || value)}</b><i style="--w:${Math.min(Number(value), 100)}%;--c:${color}"></i></span>`;
    }).join("");
    const verdict = sampleVerdict(s);
    return `<div class="s-row ${open ? "open" : ""}" data-id="${esc(s.id)}">
        <span class="s-id" title="${esc(s.id)}">${esc(idText(s.id))}</span>
        <span class="s-topic"><b>${esc(s.title || "")}</b></span>
        ${scores}
        <span>${verdict ? `<span class="badge ${verdict === "通过" ? "pass" : "fail"}">${verdict}</span>` : "—"}${s.initial ? `<em class="review-mark" title="复核修正过问题记录，展开可看初评结果">复核</em>` : ""}</span>
        <span class="s-issue">${esc(s.summary || "")}</span>
        <span class="s-chevron">⌄</span>
      </div>
      <div class="s-detail ${open ? "open" : ""}" data-detail="${esc(s.id)}">${open ? renderDetail(s) : ""}</div>`;
  }).join("") || `<div class="empty">没有符合条件的样本</div>`;
  $$(".s-detail.open").forEach((node) => fillRaw(node, node.dataset.detail));
}

function renderDetail(sample) {
  const run = state.reportRun;
  const rubric = runRubric(run);
  const verdicts = rubric.objects.map((obj) => {
    const score = sample.scores?.[obj.key], status = sample.status?.[obj.key];
    if (!isNum(score) && !status) return "";
    const native = nativeText(sample.native?.[obj.key]);
    const before = sample.initial && (sample.initial.scores?.[obj.key] !== score || sample.initial.status?.[obj.key] !== status)
      ? `<small class="initial">初评 ${esc(fmtOr(sample.initial.scores?.[obj.key]))} 分 · ${esc(sample.initial.status?.[obj.key] || "")} → 复核后</small>` : "";
    return `<div><span>${esc(obj.label)}</span>${before}<b>${native ? `${esc(native)} · ` : ""}${isNum(score) ? `${esc(score)} 分` : ""}${status ? ` <em class="badge ${status === "通过" ? "pass" : "fail"}">${esc(status)}</em>` : ""}</b></div>`;
  }).filter(Boolean);
  const comment = sample.summary ? `<div class="comment"><span>评测意见</span><b>${esc(sample.summary)}</b></div>` : "";
  const judged = sample.result?.objects ? rubric.objects.map((obj) => renderJudged(obj, sample.result.objects[obj.key])).join("") : "";
  const warnings = sample.result?.warnings?.length ? `<div class="warn-box"><b>计分校验提示</b>${sample.result.warnings.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : "";
  const verdictBox = verdicts.length || comment ? `<div class="verdict" style="--cols:${verdicts.length + (comment ? 1 : 0)}">${verdicts.join("")}${comment}</div>` : "";
  return `${verdictBox}${warnings}${judged}
    <div class="raw-grid" data-raw><div class="loading">正在读取原文…</div></div>`;
}

function renderJudged(obj, result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  if (!items.length) return "";
  const dims = obj.dims || [];
  const head = dims.map((d) => `<span title="${esc(d.name)}">${esc(d.name)}<i>${esc(dimRange(d, runRubric(state.reportRun)))}</i></span>`).join("");
  // 每个指标得分配一条小进度条，扣分的指标标成橙色，一眼能看出扣在哪里
  const cell = (d, got) => {
    const value = got?.score;
    const max = Number(runRubric(state.reportRun)?.penalty?.max) || 0;
    const ratio = got?.kind === "penalty" ? (max ? Math.max(0, 1 - Number(value) / max) : Number(value) > 0 ? 0 : 1) : got?.kind === "check" ? (got.met ? 1 : 0)
      : got?.kind === "scale" ? Math.max(0, (Number(got.level) - (got.scale?.[0] ?? 1)) / (((got.scale?.[1] ?? 5) - (got.scale?.[0] ?? 1)) || 1))
      : isNum(value) && d.weight ? Math.max(0, Math.min(1, Number(value) / Number(d.weight))) : 0;
    const text = got?.kind === "check" ? (got.met ? "达标" : "不达标") : got?.kind === "scale" ? `${fmtNum(got.level)}/${fmtNum(got.scale?.[1] ?? 5)}`
      : got?.kind === "penalty" ? (Number(value) ? `扣 ${fmtNum(value)}` : "无错误") : fmtOr(value);
    return `<span class="ji-score ${isNum(value) && ratio < 1 ? "lost" : ""}"><em>${esc(text)}</em><i><b style="width:${ratio * 100}%"></b></i></span>`;
  };
  const dimTitle = (d) => (d.kind === "check" ? `${d.name} · ${d.met ? "达标" : "不达标"}` : d.kind === "penalty" ? `${d.name} · 扣 ${fmtNum(d.score)} 分`
    : d.kind === "scale" ? `${d.name} · 第 ${fmtNum(d.level)} 档 / ${fmtNum(d.scale?.[1] ?? 5)}`
    : `${d.name} ${fmtOr(d.score)}/${fmtNum(d.weight)}`);
  const effect = (d, p) => (p.level === "P0" ? "该指标记 0 分" : d.kind === "check" ? (p.level === "P3" ? "仅记录，不影响达标" : "不达标")
    : d.kind === "scale" ? "拉低档位" : d.kind === "penalty" ? `记 ${fmtNum(p.deduct)} 分` : `扣 ${fmtNum(p.deduct)} 分`);
  const rows = items.map((item) => {
    const byName = new Map((item.dims || []).map((d) => [d.name, d]));
    // 展开后只列扣过分的指标；分数由问题推导时逐条列出问题、等级和扣分，全部满分时给一句说明
    const lost = (item.dims || []).filter((d) => d.problems?.length || (d.kind !== "penalty" && isNum(d.score) && isNum(d.weight) && Number(d.score) < Number(d.weight)));
    const lines = (d) => (d.problems?.length
      ? d.problems.map((p) => `<p class="ji-problem" style="--c:${ISSUE_COLORS[p.level] || ISSUE_COLORS.P3}"><span class="lvl">${esc(p.level)}</span>
          ${esc(effect(d, p))} · ${esc(p.detail)}${p.review ? ` <em class="ji-review">${esc(p.review)}</em>` : ""}${p.evidence ? `<em>「${esc(p.evidence)}」</em>` : ""}</p>`).join("")
      : `<p class="ji-problem">${esc(d.reason || "")}</p>`);
    const reasons = lost.length ? lost.map((d) => `<div class="ji-dim"><b>${esc(dimTitle(d))}</b>${lines(d)}</div>`).join("")
      : (item.directFail || []).length ? "" : `<p class="ji-ok">没有发现问题。</p>`;
    return `
    <details class="judge-item ${item.status === "通过" ? "" : "bad"}">
      <summary><span class="ji-label">${esc(item.label || "")}</span>${dims.map((d) => cell(d, byName.get(d.name))).join("")}<span class="ji-total">${esc(nativeText(item.native) || fmtOr(item.total))}</span></summary>
      ${(item.directFail || []).map((f) => `<p class="ji-fail">直接不通过：${esc(f.condition || "")}${f.evidence ? ` —— “${esc(f.evidence)}”` : ""}</p>`).join("")}
      ${reasons}
    </details>`;
  }).join("");
  return `<section class="judge" style="--n:${dims.length}">
    <header><b>${esc(obj.label)} · 逐指标评分</b><span>点击条目展开理由</span></header>
    <div class="judge-head"><span class="ji-label">条目</span>${head}<span class="ji-total" title="各指标得分合计换算成百分制">总分</span></div>${rows}</section>`;
}

async function loadText(file) {
  state.recordCache[file] ||= fetch(`./${encodeURI(file)}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
  return state.recordCache[file];
}

const renderInput = (input, text) => (input.format === "code" || /^\s*(```|[[{])/.test(text) ? renderCode(text) : renderMarkdown(text));

// 原文固定两栏：左栏是数据源，右栏把其余输入（如简介、创作方向）按顺序合在一起
async function fillRaw(node, id) {
  const run = state.reportRun;
  const type = runType(run);
  const sample = run.samples.find((s) => s.id === id);
  const target = $("[data-raw]", node);
  if (!target || !sample) return;
  try {
    let inputs = sample.inputs, lines = { ...(sample.lines || {}) };
    if (!inputs && run.rawRef) {
      const parser = type.parsers?.[run.rawRef.parser];
      if (!parser) throw new Error("没有记录原文的切分方式");
      const record = splitRecords(await loadText(run.rawRef.file), parser).find((r) => r.id === id);
      if (!record) throw new Error("原文中未找到该样本");
      inputs = {};
      type.inputs.forEach((input) => {
        const section = extractSection(record, parser.sections[input.key]);
        if (section) { inputs[input.key] = section.text; lines[input.key] = `${run.rawRef.file}:${section.line}`; }
      });
    }
    inputs ||= {};
    const left = type.inputs.find((input) => input.key === "source") || type.inputs[0];
    const right = type.inputs.filter((input) => input !== left);
    const pane = (title, meta, body, color) => `<section class="raw-pane" style="--c:${color}">
        <header><b>${esc(title)}</b><span>${esc(meta || "")}</span></header>
        <div class="raw-body">${body || `<span class="loading">未提供</span>`}</div></section>`;
    const rightParts = right.filter((input) => inputs[input.key]);
    const rightBody = rightParts.map((input) => `${rightParts.length > 1 ? `<div class="raw-part">${esc(input.label)}</div>` : ""}${renderInput(input, inputs[input.key])}`).join("");
    target.innerHTML = [
      left ? pane(left.label, lines[left.key], inputs[left.key] ? renderInput(left, inputs[left.key]) : "", DIM_COLORS[0]) : "",
      right.length ? pane(right.map((input) => input.label).join(" + "), rightParts.length === 1 ? lines[rightParts[0].key] : "", rightBody, DIM_COLORS[1]) : ""
    ].join("");
    const outputPane = right.length ? target.lastElementChild : null;
    const marks = problemPhrases(sample);
    if (outputPane && marks.length) {
      const found = highlightPhrases($(".raw-body", outputPane), marks);
      if (found) $("header span", outputPane).textContent = `标出 ${found} 处问题`;
    }
  } catch (error) {
    target.innerHTML = `<div class="empty">无法读取原文（${esc(error.message)}）。请双击 启动EvalLab.bat 打开页面。</div>`;
  }
}

// 从模型结果里收集需要标出的原文片段：优先 highlights，其次问题证据和直接不通过证据
function problemPhrases(sample) {
  const result = sample.result || {};
  const notes = new Map();
  const add = (text, note) => {
    String(text || "").split(/[“”"「」『』]|……|\.\.\./).map((part) => part.trim().replace(/^[，。；、,.;:：\s]+|[，。；、,.;:：\s]+$/g, ""))
      .filter((part) => part.length >= 2).forEach((part) => { if (!notes.has(part)) notes.set(part, note || ""); });
  };
  (result.highlights || []).forEach((h) => add(h.text, [h.level, h.note].filter(Boolean).join(" · ")));
  (result.issues || []).forEach((issue) => add(issue.evidence, [issue.level, issue.detail].filter(Boolean).join(" · ")));
  Object.values(result.objects || {}).forEach((obj) => (obj.items || []).forEach((item) =>
    (item.directFail || []).forEach((f) => add(f.evidence, `直接不通过 · ${f.condition || ""}`))));
  return [...notes.entries()].map(([text, note]) => ({ text, note })).sort((a, b) => b.text.length - a.text.length);
}

// 在已渲染的原文里逐个文本节点查找片段并包上 <mark>；跨越格式边界的片段找不到时跳过，不影响展示
function highlightPhrases(root, phrases) {
  let count = 0;
  phrases.forEach(({ text, note }) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest("mark")) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      let rest = node;
      let index = rest.nodeValue.indexOf(text);
      while (index >= 0) {
        const match = rest.splitText(index);
        rest = match.splitText(text.length);
        const mark = document.createElement("mark");
        mark.className = "hl";
        mark.title = note;
        match.replaceWith(mark);
        mark.appendChild(match);
        count++;
        index = rest.nodeValue.indexOf(text);
      }
    });
  });
  return count;
}

function renderCode(body) {
  const code = body.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
  const html = esc(code)
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/(:\s*)(&quot;.*?&quot;)/g, '$1<span class="s">$2</span>');
  return `<pre>${html}</pre>`;
}

function renderMarkdown(body) {
  const inline = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "", inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  body.split("\n").forEach((raw) => {
    const line = raw.trim();
    if (!line) return closeList();
    if (/^-{3,}$/.test(line)) { closeList(); html += "<hr />"; return; }
    if (/^[-*] /.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(line.slice(2))}</li>`; return; }
    closeList();
    if (/^\*\*[^*]+\*\*$/.test(line) || /^#{1,6} /.test(line)) html += `<div class="dir-title">${esc(line.replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, ""))}</div>`;
    else html += `<p>${inline(line)}</p>`;
  });
  closeList();
  return `<div class="md">${html}</div>`;
}

// 评价体系原文展示：JSON 格式化显示；Markdown 支持标题、列表、表格和表格类 HTML 标签；其他格式按纯文本显示
const SAFE_TAG = /&lt;(\/?)(table|thead|tbody|tr|th|td|code|strong|b|em|br)((?:\s+(?:rowspan|colspan)=&quot;\d+&quot;)*)\s*\/?&gt;/gi;
const docInline = (text) => esc(text)
  .replace(SAFE_TAG, (_, close, tag, attrs) => `<${close}${tag.toLowerCase()}${attrs.replace(/&quot;/g, '"')}>`)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/`([^`]+)`/g, "<code>$1</code>");

function renderPipeTable(rows) {
  const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const [head, ...body] = rows.filter((row) => !/^\|[\s:|-]+\|$/.test(row));
  if (!head) return "";
  return `<table><thead><tr>${cells(head).map((c) => `<th>${docInline(c)}</th>`).join("")}</tr></thead>
    <tbody>${body.map((row) => `<tr>${cells(row).map((c) => `<td>${docInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderDocument(text, name = "") {
  const trimmed = text.trim();
  if (/\.jsonl?$/i.test(name) || /^[[{]/.test(trimmed)) {
    try { return renderCode(JSON.stringify(JSON.parse(trimmed), null, 2)); } catch { /* 不是合法 JSON 时按文本展示 */ }
  }
  if (!/\.(md|markdown)$/i.test(name) && !/(^|\n)(#{1,6} |\||<table)/.test(text)) return `<pre class="doc-pre">${esc(text)}</pre>`;
  const out = [];
  let list = false, table = null, code = null;
  const closeBlocks = () => {
    if (list) { out.push("</ul>"); list = false; }
    if (table) { out.push(renderPipeTable(table)); table = null; }
  };
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (code) {
      if (line.startsWith("```")) { out.push(`<pre class="doc-pre">${esc(code.join("\n"))}</pre>`); code = null; } else code.push(raw);
      return;
    }
    if (line.startsWith("```")) { closeBlocks(); code = []; return; }
    if (/^\|.*\|$/.test(line)) { if (list) { out.push("</ul>"); list = false; } (table ||= []).push(line); return; }
    closeBlocks();
    if (!line) return;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { const level = Math.min(heading[1].length + 2, 6); out.push(`<h${level}>${docInline(heading[2])}</h${level}>`); return; }
    if (/^[-*]\s+/.test(line)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${docInline(line.replace(/^[-*]\s+/, ""))}</li>`); return; }
    out.push(/^<\/?(table|thead|tbody|tr|th|td)\b/i.test(line) ? docInline(line) : `<p>${docInline(line)}</p>`);
  });
  if (code) out.push(`<pre class="doc-pre">${esc(code.join("\n"))}</pre>`);
  closeBlocks();
  return `<div class="doc">${out.join("")}</div>`;
}

// 核心问题卡片：点击展开该问题下按 P0–P3 分级的具体问题，再点击具体问题筛选样本
function renderIssueGroups(run) {
  const cards = run.issueGroups.map((group, g) => {
    const issues = group.issues.map((i) => run.issues[i]);
    const ids = new Set(issues.flatMap((issue) => issue.ids));
    const worst = issues.map((issue) => issue.level).sort()[0] || "P3";
    const levels = ["P0", "P1", "P2", "P3"].map((level) => {
      const n = issues.filter((issue) => issue.level === level).length;
      return n ? `<span class="lvl" style="--c:${ISSUE_COLORS[level]}">${level}${n > 1 ? ` × ${n}` : ""}</span>` : "";
    }).join("");
    return `<button class="issue issue-group ${state.openGroup === g ? "active" : ""}" style="--c:${ISSUE_COLORS[worst]}" data-group="${g}">
        <div class="issue-top"><b>${esc(group.title)}</b><em>${ids.size}</em></div>
        <div class="lvl-row">${levels}</div><p>${issues.length} 个具体问题 · 涉及 ${ids.size} 个样本</p></button>`;
  }).join("");
  const open = run.issueGroups[state.openGroup];
  const detail = open ? `<div class="issue-detail">${open.issues.map((i) => {
    const issue = run.issues[i];
    return `<button class="issue issue-item ${state.issueFilter === i ? "active" : ""}" style="--c:${ISSUE_COLORS[issue.level] || ISSUE_COLORS.P3}" data-issue="${i}">
        <div class="issue-top"><span class="lvl">${esc(issue.level || "—")}</span><b>${esc(issue.title || "未命名问题")}</b><em>${issue.ids.length}</em></div>
        ${issue.desc ? `<p>${esc(issue.desc)}</p>` : ""}<div class="ids">ID ${issue.ids.map((id) => esc(idText(id))).join(" · ")}</div></button>`;
  }).join("")}</div>` : "";
  return `<div class="issue-grid">${cards}</div>${detail}`;
}

// 提示词优化策略：每条策略写明对应问题、成因、修改位置、原文与建议文本、预期改善、复测方法和副作用
const PRIORITY_COLORS = { 高: "#ff5f72", 中: "#ffaa5c", 低: "#7fd4ff" };
function renderStrategy(run) {
  const prompt = `<details class="card prompt-card"><summary><b>被评测的提示词 · ${esc(run.prompt.tag || "未命名版本")}</b><span>${esc(run.prompt.file || "")} 点击展开原文</span></summary>
      <pre class="doc-pre">${esc(run.prompt.text)}</pre></details>`;
  const strategy = run.strategy;
  if (!strategy || strategy.error) {
    const reason = strategy?.error ? `上次生成失败：${esc(strategy.error)}` : "这次评测没有选择生成提示词策略。";
    return `${prompt}<div class="empty small">${reason}${run.source === "live" ? ` <button class="ghost-button" data-gen-strategy>现在生成</button>` : ""}</div>`;
  }
  const field = (label, value) => (value ? `<div class="st-field"><span>${label}</span><p>${esc(value)}</p></div>` : "");
  const cards = strategy.strategies.map((s, i) => `<article class="card strategy" style="--c:${PRIORITY_COLORS[s.priority] || PRIORITY_COLORS.中}">
      <header><span class="lvl">优先级 ${esc(s.priority)}</span>${s.level ? `<span class="lvl" style="--c:${ISSUE_COLORS[s.level]}">${esc(s.level)}</span>` : ""}<h3>${esc(s.title)}</h3></header>
      ${s.problem ? `<p class="st-problem">对应问题：${esc(s.problem)}${s.ids.length ? ` · 样本 ${s.ids.map((id) => esc(idText(id))).join("、")}` : ""}</p>` : ""}
      ${field("提示词中的成因", s.rootCause)}${field("修改位置", s.location)}
      <div class="st-diff">
        <div><span>原提示词</span><pre>${s.before ? esc(s.before) : "（新增内容）"}</pre></div>
        <div><span>建议改为 <button class="link-button" data-copy="${i}">复制</button></span><pre>${esc(s.after)}</pre></div>
      </div>
      ${field("预期改善", s.expected)}${field("复测方法", s.verify)}${field("可能的副作用", s.risk)}
    </article>`).join("");
  const keep = strategy.keep?.length ? `<div class="card keep-card"><div class="kicker">建议保留</div><ul class="plain-list">${strategy.keep.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></div>` : "";
  // 诊断标签写实际影响面：涉及几条样本、其中最严重的问题等级
  const evaluated = run.samples.filter((s) => s.scores).length;
  const worstLevel = (ids) => ["P0", "P1", "P2", "P3"].find((lv) => (run.rawIssues || []).some((r) => r.level === lv && ids.includes(r.id))) || "";
  const diagnosis = strategy.diagnosis?.length ? `<div class="card diagnosis-card"><div class="kicker">全局诊断 · 问题模式与提示词成因</div>${strategy.diagnosis.map((d) => {
      const lv = worstLevel(d.ids);
      return `<div class="diag-row">
      <span class="lvl" style="--c:${ISSUE_COLORS[lv] || "var(--purple)"}">${d.ids.length ? `${d.ids.length}/${evaluated} 条` : "模式"}${lv ? ` · ${lv}` : ""}</span>
      <div><b>${esc(d.pattern)}</b>${d.cause ? `<p class="diag-cause">提示词成因：${esc(d.cause)}</p>` : ""}${d.problems.length || d.ids.length ? `<p>${d.problems.map(esc).join("、")}${d.ids.length ? ` · 样本 ${d.ids.map((id) => esc(idText(id))).join("、")}` : ""}</p>` : ""}</div></div>`;
    }).join("")}</div>` : "";
  const plan = strategy.plan ? `<p class="st-summary">落地顺序：${esc(strategy.plan)}</p>` : "";
  return `${prompt}${strategy.summary ? `<p class="st-summary">${esc(strategy.summary)}</p>` : ""}${diagnosis}<div class="strategy-list">${cards}</div>${plan}${keep}`;
}

// 对已保存的评测补生成（或重新生成）提示词策略，并覆盖保存
// 报告里单独补生成或重新生成某一项收尾分析（问题整合 / 全局复核 / 提示词策略），完成后覆盖保存
const generateStrategy = (button) => redoAnalysis(button, "strategy");
async function redoAnalysis(button, task = button.dataset.redo) {
  const run = state.reportRun;
  if (task === "strategy" && !run.prompt?.text) return;
  if (!state.gateway.configured) return toast("模型网关未配置，无法生成");
  button.disabled = true;
  button.textContent = "生成中…";
  const ok = await runAnalysis(run, task);
  if (ok && task === "strategy") run.prompt.wantStrategy = true;
  // 重新复核会改变问题记录，问题整合和策略要跟着重新生成
  if (ok && task === "review") {
    if (run.rawIssues.length) await runAnalysis(run, "groups");
    if (run.prompt?.text && run.strategy && !run.strategy.error) await runAnalysis(run, "strategy");
  }
  try {
    await api("/api/runs", { body: { run } });
    await loadSavedRuns();
  } catch (error) {
    toast(`保存失败：${error.message}`);
  }
  toast(ok ? `${STEP_LABELS[task]}已生成` : `生成失败：${(task === "strategy" ? run.strategy?.error : run.analysisErrors?.[task]) || ""}`, ok ? 2600 : 5000);
  openReport(run);
}

/* ---------- 历史评测对比 ----------
   同一评测类型下、评测集一致（样本编号与数据源完全相同）的两次评测才能对比；只展示数据，不做分析 */
function openSheet(title, body) {
  const sheet = document.createElement("div");
  sheet.className = "modal";
  sheet.innerHTML = `<div class="modal-box card sheet-box"><div class="sheet-head"><h3>${esc(title)}</h3><button class="ghost-button" data-close>关闭</button></div>${body}</div>`;
  sheet.addEventListener("click", (event) => { if (event.target === sheet || event.target.closest("[data-close]")) sheet.remove(); });
  document.body.appendChild(sheet);
  return sheet;
}

const sampleTotal = (sample) => {
  const values = Object.values(sample?.scores || {}).filter(isNum).map(Number);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};
const normText = (text) => String(text || "").replace(/\s+/g, "");

// 评测集是否一致：两边样本编号完全相同，且每个样本的数据源原文相同（输出结果允许不同）
function datasetDiff(a, b) {
  const mapA = new Map(a.samples.filter((s) => s.scores).map((s) => [s.id, s]));
  const mapB = new Map(b.samples.filter((s) => s.scores).map((s) => [s.id, s]));
  const onlyA = [...mapA.keys()].filter((id) => !mapB.has(id));
  const onlyB = [...mapB.keys()].filter((id) => !mapA.has(id));
  const changed = [...mapA.keys()].filter((id) => mapB.has(id) && normText(mapA.get(id).inputs?.source) !== normText(mapB.get(id).inputs?.source));
  // 两边都没有数据源时，只能按编号对应，无法核实是不是同一批样本：交给用户确认
  const unverifiable = [...mapA.values(), ...mapB.values()].every((s) => !normText(s.inputs?.source));
  return { onlyA, onlyB, changed, unverifiable, same: !onlyA.length && !onlyB.length && !changed.length && mapA.size > 0 };
}

function explainUnverifiable(a, b) {
  const sheet = openSheet("无法核实是不是同一批样本", `<p class="note top0">这两次评测都没有数据源，平台只能按样本编号把两边对应起来，无法确认它们是同一批样本。</p>
    <p class="note">如果你确认两次评测用的是同一批样本（只是输出不同），可以继续对比；否则对比结果没有意义。</p>
    <div class="guide-tools"><button class="ghost-button" data-force-compare>确认是同一批，继续对比</button></div>`);
  sheet.addEventListener("click", (event) => {
    if (!event.target.closest("[data-force-compare]")) return;
    sheet.remove();
    if (!sameGuide(a, b)) return explainGuideMismatch(a, b);
    startCompare(a, b);
  });
}

function openComparePicker() {
  const run = state.reportRun;
  const candidates = state.savedRuns.filter((r) => r.id !== run.id && r.typeId === run.typeId).sort((x, y) => runTime(y) - runTime(x));
  if (!candidates.length) {
    openSheet("对比历史评测", `<p class="note top0">这个评测类型下还没有其他评测记录。下一轮请在历史评测里点这条记录的“以此类型新建”，用同一批样本跑新版本的输出，之后就能在这里对比。</p>`);
    return;
  }
  const sheet = openSheet("选择要对比的历史评测", `<p class="note top0">只列出同一评测类型下的评测；两次评测的样本编号和数据源完全一致时才能对比。</p>
    <div class="pick-list">${candidates.map((r) => `<button class="pick-row" data-pick="${esc(r.id)}">
      <b>${esc(r.name || r.id)}</b>${r.prompt?.tag ? `<span class="prompt-tag">提示词 ${esc(r.prompt.tag)}</span>` : ""}
      <span>${[r.createdAt, r.model, isNum(r.sampleCount) ? `${r.sampleCount} 个样本` : ""].filter(Boolean).map(esc).join(" · ")}</span>
      <strong>${fmtOr(overallScore(r))}</strong></button>`).join("")}</div>`);
  sheet.addEventListener("click", async (event) => {
    const pick = event.target.closest("[data-pick]");
    if (!pick) return;
    pick.disabled = true;
    try {
      const other = await api(`/api/runs/${encodeURIComponent(pick.dataset.pick)}`);
      const diff = datasetDiff(run, other);
      sheet.remove();
      if (!diff.same) return explainMismatch(run, other, diff);
      if (diff.unverifiable) return explainUnverifiable(run, other);
      if (!sameGuide(run, other)) return explainGuideMismatch(run, other);
      startCompare(run, other);
    } catch (error) {
      pick.disabled = false;
      toast(`读取评测记录失败：${error.message}`);
    }
  });
}

function explainMismatch(a, b, diff) {
  const titleOf = (run, id) => run.samples.find((s) => s.id === id)?.title || id;
  const list = (ids, run) => ids.slice(0, 6).map((id) => `<li>${esc(idText(id))} · ${esc(titleOf(run, id))}</li>`).join("") + (ids.length > 6 ? `<li>…共 ${ids.length} 个</li>` : "");
  openSheet("评测集不一致，无法对比", `<p class="note top0">对比需要两次评测使用同一批样本：样本编号相同，且每个样本的数据源原文相同（输出结果可以不同）。这两次评测的差异如下：</p>
    ${diff.onlyA.length ? `<div class="mismatch"><b>只在本次评测中出现的样本（${diff.onlyA.length}）</b><ul>${list(diff.onlyA, a)}</ul></div>` : ""}
    ${diff.onlyB.length ? `<div class="mismatch"><b>只在「${esc(b.name || b.id)}」中出现的样本（${diff.onlyB.length}）</b><ul>${list(diff.onlyB, b)}</ul></div>` : ""}
    ${diff.changed.length ? `<div class="mismatch"><b>编号相同但数据源内容不同的样本（${diff.changed.length}）</b><ul>${list(diff.changed, a)}</ul></div>` : ""}
    <p class="note">若只是评测样本数设置不同，请用相同的样本数重新运行后再对比。</p>`);
}

function explainGuideMismatch(a, b) {
  const sheet = openSheet("两次评测的评分细则不同", `<p class="note top0">评测集一致，但两次评测使用的评分细则不同：
      本次是「${esc(guideLabel(a))}」，「${esc(b.name || b.id)}」是「${esc(guideLabel(b))}」。细则决定了问题怎么定级，分数差异可能来自尺子变化，而不只是输出变化。</p>
    <p class="note">要得到可比的结果，请用同一版细则重新评测其中一次（运行评测时不勾选“重新制定评分细则”即自动沿用最新版）。</p>
    <div class="guide-tools"><button class="ghost-button" data-force-compare>仍然对比</button></div>`);
  sheet.addEventListener("click", (event) => {
    if (!event.target.closest("[data-force-compare]")) return;
    sheet.remove();
    startCompare(a, b);
  });
}

function startCompare(current, other) {
  // 较早的一次放左边、较新的放右边，符合提示词迭代的阅读顺序
  const [left, right] = runTime(current) <= runTime(other) ? [current, other] : [other, current];
  [left, right].forEach(ensureIssueGroups);
  state.compare = { current, left, right, open: new Set() };
  renderCompare();
}

// 显示 B 相对 A 的变化；lowerBetter 用于问题条数这类越少越好的数据，只影响颜色
const delta = (a, b, lowerBetter = false) => {
  if (!isNum(a) || !isNum(b)) return `<span class="delta">—</span>`;
  const d = Number(b) - Number(a);
  const same = Math.abs(d) < 0.05;
  const good = lowerBetter ? d < 0 : d > 0;
  return `<span class="delta ${same ? "same" : good ? "up" : "down"}">${same ? "持平" : `${d > 0 ? "▲" : "▼"} ${Number.isInteger(d) ? Math.abs(d) : fmt(Math.abs(d))}`}</span>`;
};
const runLabel = (run) => run.prompt?.tag || run.name || run.id;

function renderCompare() {
  const { left, right } = state.compare;
  const rubric = runRubric(left);
  const side = (run, tag) => `<div class="card cmp-side">
      <div class="kicker">${tag}</div><h2>${esc(runLabel(run))}</h2><p>${esc(run.name || "")}</p>
      <div class="chip-row">${[run.prompt?.tag ? `提示词 <b>${esc(run.prompt.tag)}</b>` : "", run.model ? `模型 <b>${esc(run.model)}</b>` : "", run.createdAt ? esc(run.createdAt) : ""]
        .filter(Boolean).map((c) => `<span class="chip">${c}</span>`).join("")}</div>
      <div class="cmp-total"><strong>${fmtOr(overallScore(run))}</strong><span>/ 100 总分</span></div></div>`;
  const objectCards = rubric.objects.map((obj) => {
    const ra = objResult(left, obj.key), rb = objResult(right, obj.key);
    const passText = (r) => (isNum(r.pass) && isNum(r.fail) ? `${r.pass} / ${r.pass + r.fail}` : "—");
    const rubricB = runRubric(right);
    const dims = (obj.dims || []).map((dim, i) => {
      // 两边按指标名对应（而不是按顺序），两次评测的评价体系结构不同时也不会张冠李戴
      const j = (rubricB.objects.find((o) => o.key === obj.key)?.dims || []).findIndex((d) => d.name === dim.name);
      const view = (r, k, rub) => (k < 0 || !isNum(r.dimAvg?.[k]) ? null : dimView(rub.objects.find((o) => o.key === obj.key)?.dims[k] || dim, r.dimStats?.[k] || { score: r.dimAvg[k] }, rub));
      const a = view(ra, i, rubric), b = view(rb, j, rubricB);
      const bar = (v, cls) => `<span class="pair-bar ${cls}"><i style="width:${v ? Math.min(Math.max(v.ratio, 0), 1) * 100 : 0}%"></i><em>${esc(v ? v.text : "—")}</em></span>`;
      return `<div class="pair-row"><span class="pair-name">${esc(dim.name)}<small>${esc(dimRange(dim, rubric))}</small></span>${bar(a, "l")}${bar(b, "r")}${delta(a?.value, b?.value, Boolean(a?.lowerBetter))}</div>`;
    }).join("");
    return `<article class="card cmp-obj"><header><h3>${esc(obj.label)}</h3>
        <div class="cmp-obj-score"><span>${fmtOr(ra.score)}</span><i>→</i><span>${fmtOr(rb.score)}</span>${delta(ra.score, rb.score)}</div></header>
      <div class="pair-row head"><span>通过样本</span><span>${passText(ra)}</span><span>${passText(rb)}</span><span></span></div>${dims}</article>`;
  }).join("");
  const levelCount = (run, level) => (run.rawIssues?.length ? run.rawIssues.filter((r) => r.level === level).length : run.issues.filter((i) => i.level === level).reduce((n, i) => n + i.ids.length, 0));
  const levels = ["P0", "P1", "P2", "P3"].map((level) => `<div class="pair-row"><span class="pair-name"><span class="lvl" style="--c:${ISSUE_COLORS[level]}">${level}</span></span>
      <span class="num">${levelCount(left, level)}</span><span class="num">${levelCount(right, level)}</span>${delta(levelCount(left, level), levelCount(right, level), true)}</div>`).join("");
  const groups = (run) => run.issueGroups.length ? run.issueGroups.map((group) => {
    const issues = group.issues.map((i) => run.issues[i]);
    const ids = new Set(issues.flatMap((issue) => issue.ids));
    return `<div class="cmp-group"><b>${esc(group.title)}</b><span>${["P0", "P1", "P2", "P3"].map((level) => {
      const n = issues.filter((issue) => issue.level === level).length;
      return n ? `<em class="lvl" style="--c:${ISSUE_COLORS[level]}">${level}${n > 1 ? `×${n}` : ""}</em>` : "";
    }).join("")} ${ids.size} 个样本</span>
      <ul>${issues.map((issue) => `<li style="--c:${ISSUE_COLORS[issue.level] || ISSUE_COLORS.P3}">${esc(issue.level)} · ${esc(issue.title)}</li>`).join("")}</ul></div>`;
  }).join("") : `<div class="empty small">没有发现问题</div>`;
  $("#reportRoot").innerHTML = `
    <div class="report-bar"><button class="ghost-button" data-back-report>← 返回本次报告</button><span class="crumb">COMPARE / ${esc(String(left.id).toUpperCase())} ⇄ ${esc(String(right.id).toUpperCase())}</span></div>
    <section class="cmp-hero">${side(left, "较早 · A")}<div class="cmp-mid"><span>总分变化</span>${delta(overallScore(left), overallScore(right))}<small>同一评测集 · ${left.samples.filter((s) => s.scores).length} 个样本</small></div>${side(right, "较新 · B")}</section>
    ${sameGuide(left, right) ? "" : `<div class="warn-box"><b>两次评测的评分细则不同</b><span>A 用「${esc(guideLabel(left))}」，B 用「${esc(guideLabel(right))}」，分差可能来自细则变化</span></div>`}
    <section class="section"><div class="section-head"><h2><i>01</i>分数对比</h2><p class="legend"><span class="l">A ${esc(runLabel(left))}</span><span class="r">B ${esc(runLabel(right))}</span></p></div>
      <div class="obj-grid">${objectCards}</div></section>
    <section class="section"><div class="section-head"><h2><i>02</i>问题对比</h2><p>问题条数按等级统计；下方并列两次评测整合出的核心问题</p></div>
      <div class="card cmp-levels"><div class="pair-row head"><span>等级</span><span>A</span><span>B</span><span>变化</span></div>${levels}</div>
      <div class="cmp-cols"><div><div class="kicker">A · ${esc(runLabel(left))}</div>${groups(left)}</div><div><div class="kicker">B · ${esc(runLabel(right))}</div>${groups(right)}</div></div></section>
    <section class="section"><div class="section-head"><h2><i>03</i>样本对比</h2>
        <div class="sample-tools"><select id="cmpFilter" class="input"><option value="all">全部样本</option><option value="changed">结论有变化</option><option value="up">B 分数更高</option><option value="down">B 分数更低</option></select></div></div>
      <div class="sample-table cmp-table"><div class="s-head cmp-head"><span>ID</span><span>样本</span><span>A 结论</span><span>A 分数</span><span>B 结论</span><span>B 分数</span><span>变化</span><span></span></div><div id="cmpRows"></div></div>
      <p class="note">点击任一行展开三栏原文：数据源 / A 的结果 / B 的结果，问题片段已按各自的评测结果标出。</p></section>`;
  showView("report");
  renderCompareRows();
}

function renderCompareRows() {
  const { left, right, open } = state.compare;
  const mapB = new Map(right.samples.map((s) => [s.id, s]));
  const filter = $("#cmpFilter")?.value || "all";
  const rows = left.samples.filter((s) => s.scores && mapB.get(s.id)?.scores).filter((a) => {
    const b = mapB.get(a.id);
    const d = (sampleTotal(b) ?? 0) - (sampleTotal(a) ?? 0);
    return filter === "all" || (filter === "changed" && sampleVerdict(a) !== sampleVerdict(b)) || (filter === "up" && d > 0.05) || (filter === "down" && d < -0.05);
  });
  const verdict = (s) => { const v = sampleVerdict(s); return v ? `<span class="badge ${v === "通过" ? "pass" : "fail"}">${v}</span>` : "—"; };
  const scores = (s) => Object.values(s.scores).map((v) => `<b>${fmtOr(v)}</b>`).join(" / ");
  $("#cmpRows").innerHTML = rows.map((a) => {
    const b = mapB.get(a.id);
    const isOpen = open.has(a.id);
    return `<div class="s-row cmp-row ${isOpen ? "open" : ""}" data-id="${esc(a.id)}">
        <span class="s-id" title="${esc(a.id)}">${esc(idText(a.id))}</span><span class="s-topic"><b>${esc(a.title || "")}</b></span>
        <span>${verdict(a)}</span><span class="cmp-scores">${scores(a)}</span><span>${verdict(b)}</span><span class="cmp-scores">${scores(b)}</span>
        <span>${delta(sampleTotal(a), sampleTotal(b))}</span><span class="s-chevron">⌄</span></div>
      <div class="s-detail ${isOpen ? "open" : ""}" data-cmp-detail="${esc(a.id)}">${isOpen ? renderCompareDetail(a, b) : ""}</div>`;
  }).join("") || `<div class="empty">没有符合条件的样本</div>`;
  $$("[data-cmp-detail]").forEach((node) => { if (node.classList.contains("open")) markCompareDetail(node, node.dataset.cmpDetail); });
}

function toggleCompareRow(row) {
  const { open, left, right } = state.compare;
  const id = row.dataset.id;
  open.has(id) ? open.delete(id) : open.add(id);
  const detail = row.nextElementSibling;
  const isOpen = open.has(id);
  row.classList.toggle("open", isOpen);
  detail.classList.toggle("open", isOpen);
  detail.innerHTML = isOpen ? renderCompareDetail(left.samples.find((s) => s.id === id), right.samples.find((s) => s.id === id)) : "";
  if (isOpen) markCompareDetail(detail, id);
}

// 三栏：数据源 / A 的结果 / B 的结果；结果栏顶部是该次的分数、结论和评测意见
function renderCompareDetail(a, b) {
  const { left, right } = state.compare;
  const type = runType(left);
  const rubric = runRubric(left);
  const sourceInput = type.inputs.find((i) => i.key === "source");
  const outputs = type.inputs.filter((i) => i !== sourceInput);
  const resultPane = (sample, run, tag, color) => {
    const parts = outputs.filter((i) => sample.inputs?.[i.key]);
    const head = rubric.objects.map((obj) => {
      const status = sample.status?.[obj.key];
      return `<span>${esc(obj.label)} <b>${fmtOr(sample.scores?.[obj.key])}</b>${status ? ` <em class="badge ${status === "通过" ? "pass" : "fail"}">${esc(status)}</em>` : ""}</span>`;
    }).join("");
    return `<section class="raw-pane" style="--c:${color}" data-pane="${tag}">
      <header><b>${tag} · ${esc(runLabel(run))}</b><span></span></header>
      <div class="cmp-verdict">${head}</div>
      ${sample.summary ? `<div class="cmp-comment"><span>评测意见</span>${esc(sample.summary)}</div>` : ""}
      <div class="raw-body">${parts.map((i) => `${parts.length > 1 ? `<div class="raw-part">${esc(i.label)}</div>` : ""}${renderInput(i, sample.inputs[i.key])}`).join("") || `<span class="loading">未保存原文</span>`}</div></section>`;
  };
  const source = sourceInput ? `<section class="raw-pane" style="--c:${DIM_COLORS[0]}"><header><b>${esc(sourceInput.label)}</b><span></span></header>
      <div class="raw-body">${a.inputs?.source ? renderInput(sourceInput, a.inputs.source) : `<span class="loading">未提供</span>`}</div></section>` : "";
  return `<div class="raw-grid cmp-grid ${source ? "" : "two"}">${source}${resultPane(a, left, "A", "#3ee6dc")}${resultPane(b, right, "B", "#b48cff")}</div>`;
}

function markCompareDetail(node, id) {
  const { left, right } = state.compare;
  [["A", left], ["B", right]].forEach(([tag, run]) => {
    const pane = $(`[data-pane="${tag}"]`, node);
    const sample = run.samples.find((s) => s.id === id);
    if (!pane || !sample) return;
    const found = highlightPhrases($(".raw-body", pane), problemPhrases(sample));
    if (found) $("header span", pane).textContent = `标出 ${found} 处问题`;
  });
}

function bindReport() {
  $("#reportRoot").addEventListener("click", (event) => {
    if (event.target.closest("[data-back]")) return showView("history");
    if (event.target.closest("[data-run-rubric]")) return showRubric(runRubric(state.reportRun));
    if (event.target.closest("[data-compare]")) return openComparePicker();
    if (event.target.closest("[data-back-report]")) return openReport(state.compare.current);
    const cmpRow = event.target.closest(".cmp-row");
    if (cmpRow) return toggleCompareRow(cmpRow);
    const retry = event.target.closest("[data-retry]");
    if (retry) return retryFailed(retry);
    const gen = event.target.closest("[data-gen-strategy]");
    if (gen) return generateStrategy(gen);
    const redo = event.target.closest("[data-redo]");
    if (redo) return redoAnalysis(redo);
    const editBtn = event.target.closest("[data-edit-guide]");
    if (editBtn) { event.preventDefault(); return editGuide(editBtn); }
    const saveBtn = event.target.closest("[data-save-guide]");
    if (saveBtn) return saveGuide(saveBtn);
    if (event.target.closest("[data-cancel-guide]")) return openReport(state.reportRun);
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const text = state.reportRun.strategy?.strategies?.[Number(copy.dataset.copy)]?.after || "";
      navigator.clipboard?.writeText(text).then(() => toast("已复制建议文本"), () => toast("复制失败，请手动选择文本"));
      return;
    }
    if (event.target.closest("[data-clear]")) { state.issueFilter = null; return updateIssueFilter(); }
    const group = event.target.closest("[data-group]");
    if (group) {
      const index = Number(group.dataset.group);
      state.openGroup = state.openGroup === index ? null : index;
      $("#issueGroups").innerHTML = renderIssueGroups(state.reportRun);
      return;
    }
    const issue = event.target.closest("[data-issue]");
    if (issue) {
      const index = Number(issue.dataset.issue);
      state.issueFilter = state.issueFilter === index ? null : index;
      updateIssueFilter();
      return $("#sampleRows").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const row = event.target.closest(".s-row");
    if (!row) return;
    const id = row.dataset.id;
    state.openSamples.has(id) ? state.openSamples.delete(id) : state.openSamples.add(id);
    const open = state.openSamples.has(id);
    const detail = row.nextElementSibling;
    row.classList.toggle("open", open);
    detail.classList.toggle("open", open);
    detail.innerHTML = open ? renderDetail(state.reportRun.samples.find((s) => s.id === id)) : "";
    if (open) fillRaw(detail, id);
  });
  $("#reportRoot").addEventListener("input", (event) => { if (event.target.id === "sampleSearch") renderSamples(); });
  $("#reportRoot").addEventListener("change", (event) => {
    if (event.target.id === "statusFilter") renderSamples();
    if (event.target.id === "cmpFilter") renderCompareRows();
  });
}

function updateIssueFilter() {
  const run = state.reportRun;
  $$("[data-issue]").forEach((node) => node.classList.toggle("active", Number(node.dataset.issue) === state.issueFilter));
  $("#filterPill").classList.toggle("show", state.issueFilter !== null);
  const issue = run.issues[state.issueFilter];
  if (issue) $("#filterText").textContent = `${issue.group ? `${issue.group} · ` : ""}${issue.level} · ${issue.title}`;
  renderSamples();
}
/* ---------- 评价体系 ---------- */
function rubricOptions() {
  const list = Object.entries(RUBRICS).filter(([id]) => !state.hidden.rubrics.includes(id)).map(([id, rubric]) => ({ id, rubric }));
  state.customTypes.filter((type) => !state.hidden.types.includes(type.id)).forEach((type) => list.push({ id: `type:${type.id}`, rubric: type.rubric }));
  if (state.customRubric) list.push({ id: "upload", rubric: state.customRubric });
  return list;
}

function showRubric(rubric) {
  const options = rubricOptions();
  if (rubric && !options.some((o) => o.rubric === rubric)) options.push({ id: "view", rubric });
  showView("rubric");
  if (!options.length) {
    $("#rubricSelect").innerHTML = "";
    $("#deleteRubric").hidden = true;
    $("#rubricRoot").innerHTML = `<div class="empty">还没有评价体系，可在“新建评测”中上传</div>`;
    return;
  }
  state.rubricChoices = options;
  $("#rubricSelect").innerHTML = options.map((o) => `<option value="${esc(o.id)}">${esc(o.rubric.name || "未命名体系")}</option>`).join("");
  const match = options.find((o) => o.rubric === rubric) || options[0];
  $("#rubricSelect").value = match.id;
  selectRubricOption(match);
}

function selectRubricOption(option) {
  // 报告里查看的历史体系属于该次评测记录，不在这里删除
  $("#deleteRubric").hidden = option.id === "view";
  renderRubric(option.rubric);
}

// 删除评价体系：内置或历史类型的体系记为隐藏（连同对应的评测类型），本次上传的体系直接清空；历史报告各自保存了体系副本，不受影响
async function deleteRubric() {
  const option = state.rubricChoices?.find((o) => o.id === $("#rubricSelect").value);
  if (!option || option.id === "view") return;
  const name = option.rubric.name || "未命名体系";
  if (!(await confirmAction("删除这个评价体系？", `「${name}」将不再出现在评价体系和新建评测中；已完成的历史报告保留各自的体系，不受影响。`))) return;
  try {
    if (option.id === "upload") {
      state.customRubric = null;
    } else if (option.id.startsWith("type:")) {
      state.hidden = (await api("/api/hide", { body: { kind: "types", id: option.id.slice(5) } })).hidden;
    } else {
      await api("/api/hide", { body: { kind: "rubrics", id: option.id } });
      for (const type of MODULE_TYPES.filter((t) => t.rubricId === option.id)) {
        state.hidden = (await api("/api/hide", { body: { kind: "types", id: type.id } })).hidden;
      }
      state.hidden = await api("/api/hidden");
    }
    if (!visibleTypes().some((type) => type.id === state.typeId)) selectType(visibleTypes()[0].id);
    else { renderTypes(); renderRubricSlot(); renderSummary(); }
    toast("已删除评价体系");
    showRubric(null);
  } catch (error) {
    toast(`删除失败：${error.message}`);
  }
}

// 页面识别出的通过规则（与 server.py 的 pass_rules 一致）：都没写时按百分制 85 分
function passRuleText(rules = {}, rubric = null) {
  const has = (k) => isNum(rules[k]);
  const penalty = rubric?.penalty;
  const gates = (rubric?.objects || []).flatMap((o) => o.dims || []).filter((d) => d.gate).map((d) => d.name);
  const parts = ["无直接不通过项"];
  if (has("passScore") || (!["passCount", "passMean", "minLevel", "passItems"].some(has) && !rules.passAll && !penalty && !gates.length)) parts.push(`总分（百分制）≥ ${fmtNum(has("passScore") ? rules.passScore : 85)}`);
  if (has("passCount")) parts.push(`至少 ${fmtNum(rules.passCount)} 项达标`);
  if (has("passMean")) parts.push(`平均档位 ≥ ${fmtNum(rules.passMean)}`);
  if (has("minLevel")) parts.push(`每项不低于 ${fmtNum(rules.minLevel)} 档`);
  if (rules.passAll) parts.push("判定型指标全部达标");
  if (penalty && isNum(penalty.max)) parts.push(`错误扣分合计 ≤ ${fmtNum(penalty.max)}`);
  if (gates?.length) parts.push(`必须达标项（${gates.join("、")}）全部达标`);
  const text = parts.join("，且");
  return has("passItems") ? `每个条目：${text}；整组：至少 ${fmtNum(rules.passItems)} 个条目通过` : text;
}
function kindRows(rubric) {
  const dims = (rubric.objects || []).flatMap((obj) => obj.dims || []);
  const rows = [];
  if (dims.some((d) => d.kind === "scale")) rows.push(["档位型", "模型按评价体系的档位描述选档，问题照常记录并标出原文"]);
  if (dims.some((d) => d.kind === "check")) rows.push(["判定型", "出现 P0–P2 问题即不达标；只有 P3 问题仍算达标，问题照常记录"]);
  if (rubric.penalty) {
    rows.push(["错误扣分", "每个错误按严重程度记扣分，在条目内累计，合计不超过上限才通过"]);
    Object.entries(rubric.penalty.points || {}).sort().forEach(([lv, pt]) => rows.push([`${lv}${rubric.penalty.labels?.[lv] ? ` ${rubric.penalty.labels[lv]}` : ""}`, `每个记 ${fmtNum(pt)} 分`]));
  } else if (dims.some((d) => !d.kind)) rows.push(["扣分型", "按下方扣分表从满分中扣除"]);
  if (dims.some((d) => d.gate)) rows.push(["必须达标项", "不计分；不达标则该条目不通过"]);
  return rows.map(([k, v]) => `<div class="rule-row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("");
}

function renderRubric(rubric) {
  const objects = (rubric.objects || []).map((obj, index) => {
    const dims = obj.dims || [];
    const weighted = obj.weighted !== false;
    const total = dims.reduce((sum, dim) => sum + (Number(dim.weight) || 0), 0);
    const stack = weighted && total > 0 ? `<div class="weight-stack">${dims.map((dim, i) => `<span style="width:${((Number(dim.weight) || 0) / total) * 100}%;background:${DIM_COLORS[i % DIM_COLORS.length]}" title="${esc(dim.name)}">${esc(dim.weight)}</span>`).join("")}</div>` : "";
    const rows = dims.map((dim, i) => `<div class="r-dim">
        <i style="background:${DIM_COLORS[i % DIM_COLORS.length]}"></i>
        <div class="r-main"><div class="r-title">${dim.dimension && dim.dimension !== dim.name ? `<small>${esc(dim.dimension)}</small>` : ""}<b>${esc(dim.name)}</b></div>
          ${dim.measure ? `<p>${esc(dim.measure)}</p>` : ""}${dim.fail ? `<p class="r-fail">直接不通过：${esc(dim.fail)}</p>` : ""}</div>
        <span class="r-side">${dim.kind || rubric.penalty ? `<em class="r-kind">${esc(dimRange(dim, rubric))}</em>` : ""}${weighted && !dim.gate && !rubric.penalty ? `<strong>${esc(dim.weight)}</strong>` : ""}</span></div>`).join("");
    const meta = [obj.scope === "each" ? `逐条${esc(obj.itemName || "条目")}评分` : "整体评分", weighted && total ? `满分 ${fmtNum(total)}` : "", esc(obj.desc || "")].filter(Boolean).join(" · ");
    return `<article class="card">
      <header class="card-head"><span class="card-index">${index + 1}</span><div><h2>${esc(obj.label)}</h2><p>${meta}</p></div></header>
      ${stack}${rows}</article>`;
  }).join("");
  const list = (items) => (items || []).map((item) => `<li>${esc(item)}</li>`).join("");
  const rules = rubric.rules || {};
  const hasStructure = Boolean(rubric.objects?.length);
  const allDims = (rubric.objects || []).flatMap((obj) => obj.dims || []);
  const docBody = rubric.document ? `<div class="doc-body">${renderDocument(rubric.document, rubric.source)}</div>` : "";
  const byText = rubric.structureBy === "page" ? "由页面从原文中识别" : "由模型在评测开始时阅读原文整理";
  const doc = !rubric.document ? ""
    : hasStructure ? `<p class="note top0">下方结构${byText}，用于展示和统一计分；评测时原文完整提供给模型，评分依据以原文为准。</p>
      <details class="card doc-card"><summary><b>评价体系原文</b><span>${esc(rubric.source || "")} · 点击展开</span></summary>${docBody}</details>`
    : `<section class="card"><header class="card-head"><span class="card-index">原</span><div><h2>评价体系原文</h2><p>${esc(rubric.source || "")} · 未识别出指标表格，评测时由模型完整阅读</p></div></header>${docBody}</section>`;
  $("#rubricRoot").innerHTML = `<div class="rubric-wrap">
    <div class="rubric-objs">${doc}${objects}</div>
    <aside class="side-stack">
      <section class="card"><div class="kicker">SOURCE</div><p class="note top0">${esc(rubric.source || "—")}</p>
        <div class="kicker mt">VERDICT</div>
        <div class="rule-row"><b>通过</b><span>${esc(rules.pass || passRuleText(rules, rubric))}</span></div>
        ${rules.fail ? `<div class="rule-row"><b class="f">不通过</b><span>${esc(rules.fail)}</span></div>` : ""}
        ${hasStructure ? `<div class="kicker mt">程序执行的规则</div><div class="rule-row"><b>判定</b><span>${esc(passRuleText(rules, rubric))}</span></div>${kindRows(rubric)}` : ""}
        ${!rubric.penalty && allDims.some((d) => !d.kind) ? `<div class="kicker mt">DEDUCTION · 扣分表</div>${deductionRows(rubric)}
        <p class="note">扣分型指标的分数由问题推导：模型只找问题并定级，程序按此表从该指标满分中扣除，扣到 0 为止。${Object.keys(rubric.deduction || {}).length ? "比例取自评价体系原文。" : "评价体系没有写扣分档位，使用默认值。"}</p>` : ""}</section>
      ${rubric.principles?.length ? `<section class="card"><div class="kicker">PRINCIPLES</div><ul class="plain-list">${list(rubric.principles)}</ul></section>` : ""}
      ${rubric.notes?.length ? `<section class="card"><div class="kicker">NOTES</div><ul class="plain-list">${list(rubric.notes)}</ul></section>` : ""}
      ${rubric.issueTypes?.length ? `<section class="card"><div class="kicker">ISSUE TYPES</div>${rubric.issueTypes.map((t) => `<div class="rule-row"><b style="color:${ISSUE_COLORS[t.level] || ISSUE_COLORS.P3}">${esc(t.level)}</b><span>${esc(t.title)}</span></div>`).join("")}</section>` : ""}
    </aside></div>`;
}

function bindRubric() {
  $("#rubricSelect").addEventListener("change", (event) => {
    const option = state.rubricChoices?.find((o) => o.id === event.target.value);
    if (option) selectRubricOption(option);
  });
  $("#deleteRubric").addEventListener("click", deleteRubric);
  $$(".nav-item[data-view='rubric']").forEach((item) => item.addEventListener("click", () => showRubric(currentRubric())));
}

/* ---------- 初始化 ---------- */
$$(".nav-item").forEach((item) => item.addEventListener("click", () => { if (item.dataset.view !== "rubric") showView(item.dataset.view); }));
startBackground();
bindCreate();
bindHistory();
bindReport();
bindRubric();
selectType(state.typeId);
selectModel(FALLBACK_MODELS[0].id);
loadGateway();
loadSavedRuns().then(() => {
  // 默认类型已被删除时，切换到第一个仍可用的类型
  if (!visibleTypes().some((type) => type.id === state.typeId)) selectType(visibleTypes()[0].id);
  else renderTypes();
  // 支持直接链接到报告，例如 index.html#report/hotspot-round3
  const hash = location.hash.match(/^#report\/(.+)$/);
  if (!hash) return;
  const imported = IMPORTED_RUNS.find((run) => run.id === hash[1]);
  if (imported) openReport(imported);
  else api(`/api/runs/${encodeURIComponent(hash[1])}`).then(openReport).catch(() => toast("找不到该评测记录"));
});
