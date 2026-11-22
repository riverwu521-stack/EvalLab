// 评测类型、评价体系和导入的历史评测。页面渲染只读这里的通用结构，
// 新增一种内容的评测时，新增一份 RUBRICS 与 MODULE_TYPES 即可，app.js 不需要改。

// 网关不可用时的模型下拉兜底（与 eval_config.example.json 一致）；实际列表来自 GET /api/models
const FALLBACK_MODELS = [
  ["claude-opus-4.6", "Claude Opus 4.6", "海外"], ["claude-opus-4.5", "Claude Opus 4.5", "海外"],
  ["claude-sonnet-4.6", "Claude Sonnet 4.6", "海外"], ["claude-sonnet-4.5", "Claude Sonnet 4.5", "海外"],
  ["claude-haiku-4.5", "Claude Haiku 4.5", "海外"], ["gemini-3.1-pro", "Gemini 3.1 Pro", "海外"],
  ["gemini-3.0-pro", "Gemini 3.0 Pro", "海外"], ["gemini-3.0-flash", "Gemini 3.0 Flash", "海外"],
  ["gpt-5.4", "GPT-5.4", "海外"], ["gpt-5.3-codex", "GPT-5.3 Codex", "海外"], ["gpt-5.2-codex", "GPT-5.2 Codex", "海外"],
  ["minimax-m2.7", "MiniMax M2.7", "国内"], ["minimax-m2.5", "MiniMax M2.5", "国内"], ["kimi-k2.5", "Kimi K2.5", "国内"],
  ["glm-5", "GLM-5", "国内"], ["glm-5-turbo", "GLM-5-Turbo", "国内"], ["glm-4.7", "GLM-4.7", "国内"]
].map(([id, name, group]) => ({ id, name, group }));

// 逐字转写自《简介与创作方向评价体系.md》第二部分“创作方向”。
// scope: each = 对内容中的每个条目分别评分后取平均；whole = 整体评分一次。
const RUBRICS = {
  "creative-direction": {
    name: "简介与创作方向评价体系",
    source: "简介与创作方向评价体系.md",
    principles: [
      "权重按评价对象分别合计 100 分。接口错误样本不进入评测，也不计入平均分。触发直接不通过条件时，不受总分影响。",
      "创作方向允许使用主题相关的通用知识和创作能力，但不得偏离主题、造假、错搬或反转数据源事实。"
    ],
    objects: [
      { key: "intro", label: "简介", scope: "each", itemName: "简介", expectedItems: 1, desc: "逐条判断简介是否准确概括主题、需求和边界。", dims: [
        { dimension: "内容准确性", name: "选题与需求一致性", weight: 35, measure: "发布话题与 topic_norm 逐字一致；核心对象、用户想看的问题、内容类型和明确边界没有改变。", fail: "话题错误、核心对象改变、需求反转" },
        { dimension: "内容准确性", name: "事实与边界合规性", weight: 25, measure: "不新增无来源的人物、数字、事件、案例、结果或效果判断，不把限制条件写反。", fail: "出现关键无来源事实、错搬或反转" },
        { dimension: "信息完整性", name: "核心信息保真度", weight: 25, measure: "保留核心对象、场景、需求、限制和整体形式；只做简介层面的概括，不展开成具体脚本，也不压缩成空泛口号。", fail: "核心信息大面积丢失、写成脚本或泛化到无法判断" },
        { dimension: "表达可用性", name: "表达可用性", weight: 15, measure: "作者能快速理解选题范围、用户需求和创作边界，语言简洁清楚。", fail: "" }
      ] },
      { key: "single", label: "单方向", scope: "each", itemName: "创作方向", expectedItems: 6, desc: "逐条判断每个创作方向，样本分为各方向平均分；任一方向触发直接不通过条件，该样本单方向即不通过。", dims: [
        { dimension: "方向适配性", name: "方向主题适配性", weight: 25, measure: "只判断这一条方向是否围绕主题和用户需求，是否有明确的内容对象、问题、场景或处理方式；不与其他方向比较。", fail: "偏离主题、替换核心对象或只剩空泛形式" },
        { dimension: "事实合规性", name: "事实与边界合规性", weight: 25, measure: "本方向中的事实、数字、人物、事件、结果和限制准确；不造假、不错搬、不反转，不违反明确边界。", fail: "关键事实错误、无来源确定事实或边界反转" },
        { dimension: "内容完整性", name: "内容具体性与展开完整度", weight: 25, measure: "本方向正确使用相关对象、行为、场景、步骤、数字或限制；内容大纲、创作要点和表达方式能形成可执行的内容链条。", fail: "核心锚点保留不足，只有泛泛主题或没有可执行展开" },
        { dimension: "制作质量", name: "制作方案可执行性", weight: 20, measure: "体裁、画幅、时长、镜头、制作方式和风格相互一致，且与本方向内容相适配。", fail: "规格冲突或擅自改变体裁" },
        { dimension: "输出规范性", name: "正式输出规范性", weight: 5, measure: "只呈现正式创作方案，不出现字段名、评价依据、数据质量判断、提示词术语或内部思考。", fail: "出现内部分析、推理过程或内部字段" }
      ] },
      { key: "group", label: "整组", scope: "whole", expectedItems: 1, desc: "把六个方向作为一组整体判断。", dims: [
        { dimension: "需求覆盖性", name: "组内需求覆盖度", weight: 30, measure: "从六个方向整体判断用户需求和可用 angle 信息是否被覆盖；不按单个方向的执行质量重复计分。", fail: "主要需求或主要信息大面积缺失" },
        { dimension: "组合差异性", name: "方向组合差异度", weight: 30, measure: "六个方向在对象、问题、场景、对照关系或表达方式上真正不同，不靠更换标题、四字词或受众描述制造差异。", fail: "多个方向实质重复或只换包装" },
        { dimension: "主题一致性", name: "主题与边界一致性", weight: 20, measure: "六个方向整体持续围绕原始主题，且持续避开用户明确不想看的内容；只判断方向之间是否发生漂移，不重复单方向事实评分。", fail: "多个方向发生主题漂移或违反明确边界" },
        { dimension: "组合合理性", name: "信息分配与组合合理性", weight: 20, measure: "六个方向对具体信息的使用有分配、有层次，不把同一锚点反复改写，也不为凑数引入无关方向；方向数量与素材量相匹配。", fail: "具体信息大面积遗漏、重复堆叠或为凑数引入无关主题" }
      ] }
    ],
    rules: { passScore: 85, pass: "无直接不通过项，评价对象总分 ≥ 85", fail: "触发直接不通过项，或评价对象总分 < 85" },
    notes: [
      "评价结果只保留“通过 / 不通过”两种状态；分数用于说明质量和问题程度，不构成额外的修改流程。",
      "接口错误：不进入评测、不计入均值、不列入样本明细。",
      "整组需求覆盖率 = 被至少一个方向正确承接的需求单元 ÷ 需求单元总数。",
      "无来源扩写率 = 无依据、造假、错搬或反转的具体事实 ÷ 需核验的具体事实总数。"
    ],
    // 问题类型取自第三轮评测报告 §5 的问题分类，模型评测时按这些 key 归类
    issueTypes: [
      { key: "core_object", level: "P0", title: "核心对象或安全边界错误" },
      { key: "unsourced_fact", level: "P1", title: "无来源具体事实被写成确定事实" },
      { key: "internal_leak", level: "P2", title: "内部评测依据泄漏" },
      { key: "source_conflict", level: "P2", title: "源字段之间存在主题冲突" },
      { key: "combination", level: "P3", title: "方向组合精度不足" }
    ]
  }
};
// 评测类型：inputs 是这类评测需要的输入；parsers 说明如何从上传的 Markdown 中切出样本与各输入小节，
// 依次尝试，命中样本数最多的格式生效。titleField 用于从数据源里取样本标题。
const MODULE_TYPES = [
  {
    id: "hotspot-direction",
    name: "热点简介与创作方向",
    desc: "数据源 → 简介 → 创作方向",
    rubricId: "creative-direction",
    titleField: "topic_norm",
    inputs: [
      { key: "source", label: "数据源", hint: "热点兴趣点 JSON", format: "code" },
      { key: "intro", label: "简介", hint: "模型生成的用户想看简介", format: "markdown" },
      { key: "output", label: "热点创作方向", hint: "模型生成的创作方向", format: "markdown" }
    ],
    parsers: [
      { name: "评测报告附录", record: "^### ID (\\S+)\\s*$", sections: { source: ["#### 数据源"], intro: ["#### 简介原文"], output: ["#### 创作方向原文"] } },
      { name: "评测集明细", record: "^### (\\d+)\\. ", sections: { source: ["#### 输入线索 Query"], intro: ["#### 简介输出答案"], output: ["#### 创作方向输出答案"] } }
    ]
  }
];

// 新建评测类型时使用的通用切分规则：record 为 auto 时自动判断样本边界（最浅一级重复出现的标题、
// 编号列表、--- 分隔线，都没有时整份文件是一个样本）；sections 按小节名匹配各输入，不限标题级别；
// 没有小节时整段作为该文件对应的输入。
const GENERIC_PARSER = {
  name: "通用切分",
  record: "auto",
  sections: {
    source: ["数据源", "输入", "问题", "原文", "素材", "题目", "上下文", "Query", "query", "input", "Input", "question", "Question", "prompt", "Prompt", "instruction", "context", "source"],
    output: ["输出", "内容", "结果", "答案", "回答", "回复", "output", "Output", "answer", "Answer", "response", "Response", "completion", "prediction", "generated"]
  }
};

// 导入的历史评测：数字逐项取自《第三轮评测报告.md》§2、§3、§4、§5，样本原文按需读取该报告 §8 附录。
const IMPORTED_RUNS = [
  {
    id: "hotspot-round3",
    source: "imported",
    name: "热点创作方向第三版评测",
    typeId: "hotspot-direction",
    rubricId: "creative-direction",
    model: "未记录",
    createdAt: "2026-11-13",
    reportFile: "第三轮评测报告.md",
    rawRef: { file: "project/评测报告/第三轮评测报告.md", parser: 0 },
    excluded: "接口错误 ID 22、59、151 已按体系排除，不计入均值",
    objects: {
      intro: { score: 92.4, pass: 15, fail: 2, unit: "17 条简介", dimAvg: [34.1, 20.7, 22.8, 14.8] },
      single: { score: 86.2, pass: 8, fail: 9, unit: "102 条方向", dimAvg: [21.2, 20.2, 22.0, 18.1, 4.6] },
      group: { score: 84.5, pass: 11, fail: 6, unit: "17 组方向", dimAvg: [24.7, 27.8, 16.5, 15.5] }
    },
    issues: [
      { level: "P0", title: "核心对象或安全边界错误", ids: ["44", "51", "119"], desc: "护主需求被写成宠物日常；人物核心对象被替换；急救方向展示了明确排除的错误做法" },
      { level: "P1", title: "无来源具体事实被写成确定事实", ids: ["1", "15", "29", "44", "51", "166", "192"], desc: "数字、事件、播放量、技术参数和人物合作关系无法由数据源支持" },
      { level: "P2", title: "内部评测依据泄漏", ids: ["8", "97"], desc: "约 3/102 条方向，正式方案仍出现供给分析、弥补短板等内部表达" },
      { level: "P2", title: "源字段之间存在主题冲突", ids: ["128"], desc: "topic_norm 指向仙侠国漫，demand_essence 指向金庸武侠" },
      { level: "P3", title: "方向组合精度不足", ids: ["8", "44", "87", "166", "192"], desc: "部分方向通过相邻主题或额外细节拉开差异，核心需求覆盖不稳定" }
    ],
    samples: [
      ["1", "二十四节气变化", 93, "通过", 83, "不通过", 86, "通过", "加入播种深度、出苗比例、具体食材和民俗断言，事实需核验"],
      ["8", "冬储白菜大葱保鲜", 94, "通过", 89, "不通过", 84, "不通过", "有现有供给/弥补短板等内部分析；储存方向占比较高"],
      ["15", "远洋货轮船员生活纪实", 92, "通过", 86, "通过", 89, "通过", "飞鱼、夜航、设备故障等假设场景被写成确定事件"],
      ["29", "中国航母电磁弹射技术", 90, "通过", 88, "不通过", 95, "通过", "“数百公里”等技术断言缺少来源"],
      ["36", "武松醉打蒋门神", 96, "通过", 99, "通过", 96, "通过", "六个切口围绕原著、动作、心理和影视版本，整体完整"],
      ["44", "流浪狗救助成长日常", 93, "通过", 72, "不通过", 66, "不通过", "只有护主方向直接命中需求，其余仍偏宠物日常；具体护主事件疑似编造"],
      ["51", "唐国强亮相红毯", 84, "不通过", 50, "不通过", 48, "不通过", "把张国荣替换为唐国强，虚构舞台合作风险极高"],
      ["67", "上门女婿打脸逆袭", 97, "通过", 99, "通过", 96, "通过", "剧情方向完整，六个反转节点有差异"],
      ["79", "竹编篾匠手工编织", 97, "通过", 99, "通过", 94, "通过", "手艺流程、人物日常和传承切口清晰"],
      ["87", "老年大学热门课程", 94, "通过", 95, "通过", 91, "通过", "“课表之外”略接近生活记录，其他方向匹配"],
      ["97", "故宫100宫廷生活", 97, "通过", 92, "不通过", 96, "通过", "第1方向仍有弥补类内部表达"],
      ["107", "学生党汉服入门", 97, "通过", 98, "通过", 96, "通过", "形制、历史、部件和学生党选购覆盖完整"],
      ["119", "溺水自救施救要点", 97, "通过", 60, "不通过", 49, "不通过", "多个方向展示错误做法，违反不希望错误示范的边界"],
      ["128", "仙侠国漫战斗名场面", 71, "不通过", 84, "不通过", 81, "不通过", "话题符合 topic_norm，但需求指向金庸武侠，源字段未统一"],
      ["166", "东北杀猪菜家常做法", 97, "通过", 95, "通过", 92, "通过", "具体时间、用量和效果表述缺少依据"],
      ["179", "敦煌莫高窟壁画保护", 97, "通过", 95, "通过", 96, "通过", "保护、病害、修复、颜料和服饰覆盖较好"],
      ["192", "李雪健长征颂歌表演", 85, "通过", 81, "不通过", 82, "不通过", "“96万播放”、高原实景等具体事实未见数据源"]
    ].map(([id, title, intro, introStatus, single, singleStatus, group, groupStatus, summary]) => ({
      id, title, summary, scores: { intro, single, group }, status: { intro: introStatus, single: singleStatus, group: groupStatus }
    }))
  }
];
