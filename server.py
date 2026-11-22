#!/usr/bin/env python3
"""EvalLab 本地服务：静态页面 + 模型评测接口。

只依赖 Python 3.9 标准库。模型通过 OpenAI 兼容的 /chat/completions 接口调用，
API Key 只保存在服务端（环境变量或 eval_config.json），不会下发到浏览器。

启动：Windows 双击上一级目录的「启动EvalLab.bat」，或在本目录运行 python3 server.py，默认 http://127.0.0.1:4174

目录：程序/ 是页面与服务代码（静态文件只从这里提供）；数据/ 存放网关配置、评测记录、隐藏列表和日志；
本副本评测报告目录中的指定报告可通过 /project/ 只读访问，供内置历史评测读取原文。
"""

import hashlib
import json
import math
import os
import py_compile
import re
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT.parent / "数据"
PROJECT_DIR = ROOT.parent
CONFIG_PATH = DATA_DIR / "eval_config.json"
RUNS_DIR = DATA_DIR / "runs"
# /project/ 下只开放这些类型的文件
PROJECT_SUFFIXES = {".md"}
PROJECT_FILES = {"评测报告/第三轮评测报告.md", "评测报告/简介与创作方向评价体系.md"}
# 不允许通过静态服务读取的文件：配置里可能有密钥
PRIVATE_FILES = {"eval_config.json", "server.py", ".env", "hidden.json", "server.log"}
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_BODY = 8 * 1024 * 1024
MAX_DOCUMENT = 60000
MAX_OUTPUT_TOKENS = 32000


# ---------------------------------------------------------------- 交给模型的资料不超长
# 统一规则：资料太长时按内容裁剪并明确告诉模型省略了什么，绝不在文字或 JSON 的中间硬截断
def clip_text(text, limit):
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "\n…（原文过长，后面还有 %s 字没有提供）" % (len(text) - limit)


def _shorten(value, cap):
    if isinstance(value, str):
        return value if len(value) <= cap else value[:cap] + "…（省略 %s 字）" % (len(value) - cap)
    if isinstance(value, list):
        return [_shorten(v, cap) for v in value]
    if isinstance(value, dict):
        return {k: _shorten(v, cap) for k, v in value.items()}
    return value


def _longest_list(value, path=()):
    best = (len(value), path) if isinstance(value, list) else (0, path)
    children = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else []
    for key, child in children:
        if isinstance(child, (list, dict)):
            found = _longest_list(child, path + (key,))
            if found[0] > best[0]:
                best = found
    return best


def fit_json(data, limit):
    """把资料序列化为不超过 limit 字的合法 JSON：先缩短过长的文字，仍超长时减少最长列表的条数，并在列表末尾注明省略了多少条。"""
    text = json.dumps(data, ensure_ascii=False)
    cap = 4000
    while len(text) > limit and cap >= 200:
        data = _shorten(data, cap)
        text = json.dumps(data, ensure_ascii=False)
        cap //= 2
    while len(text) > limit:
        size, path = _longest_list(data)
        if size <= 1:
            break
        node = data
        for key in path:
            node = node[key]
        kept = [v for v in node if not (isinstance(v, str) and v.startswith("…（另有"))]
        keep = max(1, len(kept) // 2)
        dropped = len(kept) - keep + sum(int(re.search(r"\d+", v).group()) for v in node if isinstance(v, str) and v.startswith("…（另有"))
        node[:] = kept[:keep] + ["…（另有 %s 条因篇幅省略）" % dropped]
        text = json.dumps(data, ensure_ascii=False)
    return text


def load_config():
    config = read_store(CONFIG_PATH, {})
    config = config if isinstance(config, dict) else {}
    api_base = os.environ.get("EVAL_API_BASE") or config.get("api_base") or ""
    api_key = os.environ.get("EVAL_API_KEY") or config.get("api_key") or ""
    return {
        "api_base": api_base.rstrip("/"),
        "api_key": api_key,
        # 鉴权头：默认 Authorization: Bearer <key>；网关若要求 X-Api-Key 等，可在页面里切换
        "auth_header": (os.environ.get("EVAL_AUTH_HEADER") or config.get("auth_header") or "Authorization"),
        "auth_prefix": os.environ.get("EVAL_AUTH_PREFIX") if os.environ.get("EVAL_AUTH_PREFIX") is not None
                       else config.get("auth_prefix", "Bearer "),
        "models": config.get("models") or [],
        "timeout": int(config.get("timeout", 300)),
        "extra_headers": config.get("extra_headers") or {},
    }


# ---------------------------------------------------------------- 模型调用

class ModelError(Exception):
    pass


def http_json(method, url, config, body=None):
    headers = {"Content-Type": "application/json", **config["extra_headers"]}
    if config["api_key"]:
        headers[config.get("auth_header") or "Authorization"] = (config.get("auth_prefix") or "") + config["api_key"]
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=config["timeout"]) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:600]
        raise ModelError("模型网关返回 HTTP %s：%s" % (error.code, detail)) from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, socket.timeout):
            raise ModelError("模型响应超时（超过 %s 秒），可以在报告里重试失败样本" % config["timeout"]) from None
        raise ModelError("无法连接模型网关：%s" % error.reason) from None
    # Python 3.9 中读取超时抛出的是 socket.timeout，不属于 TimeoutError；漏接会让连接直接断开，页面只看到 Failed to fetch
    except (socket.timeout, TimeoutError):
        raise ModelError("模型响应超时（超过 %s 秒），可以在报告里重试失败样本" % config["timeout"]) from None
    except (OSError, ValueError) as error:
        raise ModelError("模型网关连接中断或返回内容无法解析：%s" % error) from None


def chat(config, model, messages, think=True):
    if not config["api_base"]:
        raise ModelError("服务端未配置模型网关：请设置 EVAL_API_BASE / EVAL_API_KEY 或填写 eval_config.json")
    url = config["api_base"] + "/chat/completions"
    # 显式给足输出长度：不写时部分网关按 4096 截断，思考过程会先占掉大半，JSON 写到一半就被截断
    body = {"model": model, "messages": messages, "temperature": 0, "max_tokens": MAX_OUTPUT_TOKENS,
            "response_format": {"type": "json_object"}}
    if not think:
        # 关闭模型的思考过程（DeepSeek 等支持 thinking 参数）；不支持的模型会报 400，下面会去掉该参数重试
        body["thinking"] = {"type": "disabled"}
    while True:
        try:
            result = http_json("POST", url, config, body)
            break
        except ModelError as error:
            # 不同模型支持的参数不一样（有的不支持 response_format、thinking，有的只允许 temperature=1）：按报错去掉对应参数后重试
            message = str(error)
            if "HTTP 400" not in message and "HTTP 422" not in message:
                raise
            if "max_tokens" in body and ("max_tokens" in message or "max_completion_tokens" in message):
                # 超过该模型的上限：先降到 8192，仍不行就不传，交给网关默认值
                if body["max_tokens"] > 8192:
                    body["max_tokens"] = 8192
                else:
                    body.pop("max_tokens")
            elif "thinking" in body and ("thinking" in message or "Extra inputs" in message or "unknown" in message.lower()):
                body.pop("thinking")
            elif "temperature" in message and "temperature" in body:
                body.pop("temperature")
            elif "response_format" in body:
                body.pop("response_format")
            elif "thinking" in body:
                body.pop("thinking")
            elif "temperature" in body:
                body.pop("temperature")
            else:
                raise
    try:
        choice = result["choices"][0]
        content = choice["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ModelError("模型返回格式无法识别：%s" % json.dumps(result, ensure_ascii=False)[:400]) from None
    if choice.get("finish_reason") == "length":
        raise ModelError("模型输出达到长度上限被截断（本次上限 %s tokens，思考过程也计入）。可换用思考更少的模型，或减少样本数后重试"
                         % body.get("max_tokens", "网关默认"))
    return content, result.get("usage") or {}


def repair_json(text):
    """修复模型 JSON 里最常见的两类格式错误：字符串里没转义的英文双引号（引用原文时常见）和换行符，以及多余的结尾逗号。"""
    out, in_string, i = [], False, 0
    while i < len(text):
        ch = text[i]
        if not in_string:
            if ch == '"':
                in_string = True
            out.append(ch)
        elif ch == "\\":
            out.append(text[i:i + 2])
            i += 1
        elif ch == '"':
            rest = text[i + 1:].lstrip()
            # 后面紧跟 , : } ] 或已到结尾时才是字符串结束，否则是正文里的引号
            if not rest or rest[0] in ",:}]":
                in_string = False
                out.append(ch)
            else:
                out.append('\\"')
        elif ch in "\n\r\t":
            out.append({"\n": "\\n", "\r": "\\r", "\t": "\\t"}[ch])
        else:
            out.append(ch)
        i += 1
    return re.sub(r",\s*([}\]])", r"\1", "".join(out))


def extract_json(text):
    text = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("回复中没有 JSON 对象")
    body = text[start:end + 1]
    try:
        return json.loads(body)
    except ValueError as error:
        try:
            return json.loads(repair_json(body))
        except ValueError:
            raise error from None


def chat_json(config, model, messages, think=True):
    """调用模型并解析 JSON；先在本地修复常见格式错误，仍不合法时才把错误回传给模型重写一次。"""
    content, usage = chat(config, model, messages, think)
    try:
        return extract_json(content), content, usage
    except ValueError as error:
        repair = messages + [
            {"role": "assistant", "content": content},
            {"role": "user", "content": "上面的回复不是合法 JSON（%s）。请只输出符合要求结构的 JSON，不要任何其他文字。" % error},
        ]
        content, usage = chat(config, model, repair, think)
        try:
            return extract_json(content), content, usage
        except ValueError as error2:
            raise ModelError("模型两次都没有返回合法 JSON：%s" % error2) from None


_models_cache = {"at": 0, "data": None}
_models_lock = threading.Lock()


def list_models(config):
    """优先读取网关的 /models；网关不可用时回退到 eval_config.json 中的列表。"""
    configured = [{"id": m["id"], "name": m.get("name", m["id"]), "group": m.get("group", "已配置")}
                  for m in config["models"] if m.get("id")]
    if not config["api_base"]:
        return {"source": "config", "models": configured, "error": "未配置模型网关"}
    with _models_lock:
        if _models_cache["data"] and time.time() - _models_cache["at"] < 300:
            return _models_cache["data"]
    try:
        result = http_json("GET", config["api_base"] + "/models", config)
        names = {m["id"]: m for m in configured}
        remote = []
        for item in result.get("data") or []:
            model_id = item.get("id")
            if model_id:
                known = names.get(model_id, {})
                remote.append({"id": model_id, "name": known.get("name", model_id), "group": known.get("group", "网关")})
        data = {"source": "gateway", "models": remote or configured}
    except ModelError as error:
        data = {"source": "config", "models": configured, "error": str(error)}
    with _models_lock:
        _models_cache.update(at=time.time(), data=data)
    return data
# ---------------------------------------------------------------- 评测提示词与计分

JUDGE_SYSTEM = (
    "你是严格、克制的内容评测员。你只依据给定的评价体系、数据源和待评测内容找出问题并定级，"
    "不补充评价体系之外的标准。每个问题都要能在原文中找到依据，并逐字引用原文片段作为证据；"
    "数据源中没有、也无法由通用知识确认的具体事实，按评价体系视为无来源。"
    "没有提供数据源时，不臆测数据源内容；依赖数据源的指标按评价体系的规定处理，评价体系没有规定时只依据待评测内容本身判断，并在问题说明中写明。"
    "你只输出 JSON，不输出任何解释性文字。"
)

# 默认扣分表：按问题等级扣该指标满分的比例；P0 该指标记 0 分并触发直接不通过。评价体系里写了自己的档位时以评价体系为准
DEFAULT_DEDUCTION = {"P0": 1.0, "P1": 0.3, "P2": 0.15, "P3": 0.05}
LEVELS = ("P0", "P1", "P2", "P3")


def deduction_of(rubric):
    table = dict(DEFAULT_DEDUCTION)
    for level, value in ((rubric or {}).get("deduction") or {}).items():
        ratio = to_number(value)
        if level in LEVELS and ratio is not None:
            table[level] = ratio / 100 if ratio > 1 else ratio
    table["P0"] = 1.0
    return table


def describe_deduction(rubric):
    table = deduction_of(rubric)
    return "P0 该指标记 0 分并直接不通过；" + "；".join("%s 扣该指标满分的 %s%%" % (level, round(table[level] * 100, 2)) for level in LEVELS[1:]) \
        + "；同一指标扣到 0 为止。"


PER_ISSUE_RE = re.compile(r"每[^，,；;。\n]{0,8}?(?:处|个|次|条|项)[^；;。\n]{0,20}?扣\s*(\d+(?:\.\d+)?)\s*分")


def per_issue_points(dim):
    """评价体系在指标说明里写了“每出现 1 处……扣 N 分”时，返回 N；P1–P3 都按这个分值扣。"""
    if to_number(dim.get("perIssue")) is not None:
        return to_number(dim.get("perIssue"))
    match = PER_ISSUE_RE.search(" ".join(str(dim.get(k) or "") for k in ("measure", "desc")))
    return float(match.group(1)) if match else None


def dim_kind(dim, rubric=None):
    """指标的计分方式（全平台只用这一处判断）：
    scale 档位型、check 判定型（含必须达标项）由指标自己声明，始终按自己的方式计；
    其余指标在评价体系是“错误扣分累计”（如 MQM）时为 penalty，否则为 deduct 扣分型（满分 N，按问题扣分）。"""
    if dim.get("kind") in ("scale", "check"):
        return dim["kind"]
    return "penalty" if (dim.get("kind") == "penalty" or (rubric is not None and penalty_of(rubric))) else "deduct"


def penalty_of(rubric):
    """罚分累计：{"points": {"P0": 25, "P1": 5, "P3": 1}, "max": 5}。每个问题按等级罚分，条目罚分合计不超过 max 才通过。"""
    raw = rubric.get("penalty") if isinstance(rubric.get("penalty"), dict) else None
    if not raw:
        return None
    points = {lv: to_number(v) for lv, v in (raw.get("points") if isinstance(raw.get("points"), dict) else {}).items() if lv in LEVELS and to_number(v) is not None}
    if not points:
        return None
    labels = {lv: str(v) for lv, v in (raw.get("labels") if isinstance(raw.get("labels"), dict) else {}).items() if lv in points}
    # fatal：最重一级错误是否直接不通过（评价体系写了“致命错误直接不通过”时为真）；否则最重一级也只是扣分
    return {"points": points, "labels": labels, "max": to_number(raw.get("max")), "fatal": bool(raw.get("fatal"))}


def heaviest(penalty):
    return next(lv for lv in LEVELS if lv in penalty["points"])


def penalty_level(level, penalty):
    """模型用了罚分表里没有的等级时，取最接近的、更严重的已定义等级。"""
    if level in penalty["points"]:
        return level
    order = list(LEVELS)
    heavier = [lv for lv in order[:order.index(level)][::-1] if lv in penalty["points"]]
    lighter = [lv for lv in order[order.index(level) + 1:] if lv in penalty["points"]]
    return (heavier or lighter)[0]


def dim_scale(dim):
    """档位型指标的量程，统一为从低到高；没写或写错时按 1–5。"""
    return tuple(parse_scale(dim.get("scale")) or (1, 5))


def pass_rules(rubric):
    """通过规则：百分制分数线、达标项数、档位平均分、单项最低档。评价体系都没写时沿用百分制 85 分。"""
    rules = rubric.get("rules") or {}
    out = {k: to_number(rules.get(k)) for k in ("passScore", "passCount", "passMean", "minLevel", "passItems")}
    out["passAll"] = bool(rules.get("passAll"))
    penalty = penalty_of(rubric)
    out["maxPenalty"] = penalty["max"] if penalty else None
    gates = any(d.get("gate") for obj in rubric["objects"] for d in obj["dims"])
    # 默认的百分制 85 分只用于什么规则都没写的旧评价体系；错误扣分体系、有必须达标项的体系不套用默认分数线（与 canonical_rubric 一致）
    if all(v is None for k, v in out.items() if k != "passAll") and not out["passAll"] and not gates and not penalty:
        out["passScore"] = 85.0
    return out


def describe_rules(rubric):
    r = pass_rules(rubric)
    parts = ["无直接不通过项"]
    if r["passScore"] is not None:
        parts.append("总分（换算为百分制）≥ %s" % fmt_points(r["passScore"]))
    if r["passAll"]:
        parts.append("判定型指标全部达标")
    elif r["passCount"] is not None:
        parts.append("达标的判定型指标 ≥ %s 项" % fmt_points(r["passCount"]))
    if r["passMean"] is not None:
        parts.append("档位型指标的平均档位 ≥ %s" % fmt_points(r["passMean"]))
    if r["minLevel"] is not None:
        parts.append("每个档位型指标都不低于 %s" % fmt_points(r["minLevel"]))
    if r["maxPenalty"] is not None:
        parts.append("错误扣分合计 ≤ %s" % fmt_points(r["maxPenalty"]))
    gates = [d["name"] for obj in rubric["objects"] for d in obj["dims"] if d.get("gate")]
    if gates:
        parts.append("必须达标项（%s）全部达标" % "、".join(gates))
    text = "，且".join(parts) if len(parts) > 1 else "无直接不通过项"
    if r["passItems"] is not None:
        text = "每个条目：%s；评价对象：至少 %s 个条目通过" % (text, fmt_points(r["passItems"]))
    return text


def kinds_of(rubric):
    return {dim_kind(d, rubric) for obj in rubric["objects"] for d in obj["dims"]}


def describe_rubric(rubric, with_verdict=True):
    """评分结构说明。逐样本评测时不给通过规则（with_verdict=False）：评测员只找问题定级，通过与否由程序判定，避免它向及格线靠拢。"""
    lines = ["评价体系：%s" % rubric.get("name", "")]
    for principle in rubric.get("principles") or []:
        lines.append("总则：" + principle)
    for obj in rubric["objects"]:
        scope = ("对待评测内容中的每一个%s分别评分" % obj.get("itemName", "条目")) if obj.get("scope") == "each" \
            else "把待评测内容作为一个整体评分一次"
        expected = obj.get("expectedItems")
        count_rule = "必须返回 %s 个评分项。" % expected if expected is not None else ""
        lines.append("\n【评价对象 %s：%s】%s。%s%s" % (obj["key"], obj["label"], scope, obj.get("desc", ""), count_rule))
        for dim in obj["dims"]:
            kind = dim_kind(dim, rubric)
            if kind == "scale":
                low, high = dim_scale(dim)
                how = "档位型 %s–%s：按评价体系的档位描述选一个整数档位写入 levels，同时列出拉低档位的问题" % (fmt_points(low), fmt_points(high))
            elif kind == "check":
                how = "判定型：出现 P0–P2 问题即不达标，只有 P3 问题仍算达标" + ("；必须达标项，不计分，不达标则该条目不通过" if dim.get("gate") else "")
            elif kind == "penalty":
                how = "错误扣分型：每个问题按等级记扣分，在条目内累计"
            else:
                fixed = per_issue_points(dim)
                how = "扣分型，满分 %s" % fmt_points(float(dim["weight"])) + ("，每个 P1–P3 问题固定扣 %s 分" % fmt_points(fixed) if fixed is not None else "")
            lines.append("- 指标「%s」（%s%s）：%s 直接不通过条件：%s" % (
                dim["name"], "维度：%s；" % dim["dimension"] if dim.get("dimension") else "", how, dim.get("measure", ""), dim.get("fail") or "无"))
    if with_verdict:
        lines.append("\n判定（由程序执行）：通过 = %s；否则不通过。" % describe_rules(rubric))
    penalty = penalty_of(rubric)
    if penalty:
        lines.append("\n罚分表（只使用这些等级）：" + "；".join("%s%s 罚 %s 分" % (lv, "（%s）" % penalty["labels"][lv] if lv in penalty["labels"] else "", fmt_points(pt))
                                                for lv, pt in sorted(penalty["points"].items())))
    if any(dim_kind(d, rubric) == "deduct" for obj in rubric["objects"] for d in obj["dims"]):
        lines.append("\n扣分表（扣分型指标的分数由程序按问题等级计算，你只需找出问题并定级）：" + describe_deduction(rubric))
    issue_types = rubric.get("issueTypes") or []
    if issue_types:
        lines.append("\n问题类型（定级时参照这些类型及其等级）：")
        for issue in issue_types:
            lines.append("- %s（%s）：%s" % (issue["key"], issue["level"], issue["title"]))
    return "\n".join(lines)


def output_schema(rubric, checks=False):
    objects = {}
    for obj in rubric["objects"]:
        item = {
            "label": "条目标题（整体评分时写“整体”）",
            "problems": [{"dim": "问题所属的指标名（只能用该评价对象下的指标）", "level": "P0/P1/P2/P3",
                          "detail": "具体问题，40 字以内", "evidence": "待评测内容中的原文，逐字摘录"}],
        }
        scales = [d for d in obj["dims"] if dim_kind(d) == "scale"]
        if scales:
            # 先写依据再写档位：让模型逐项对照档位描述后再选，避免不核对就给最高档
            item["levels"] = {d["name"]: {"basis": "对照该指标各档位描述的具体依据（如字数、遗漏或不符之处），30 字以内",
                                          "level": "整数档位（%s–%s）" % tuple(fmt_points(v) for v in dim_scale(d))} for d in scales}
        if checks:
            item = {"checks": [{"claim": "条目中的一处具体事实、数字、人物、事件、需求承接或制作规格", "basis": "数据源/通用知识/无依据/与数据源冲突"}], **item}
        objects[obj["key"]] = {"items": [item]}
    return {"objects": objects, "summary": "一句话概括该样本的主要问题；没有问题时写主要优点。不写分数、达标项数或是否通过，这些由程序计算"}


def kind_rules(rubric):
    kinds, out = kinds_of(rubric), ""
    penalty = penalty_of(rubric)
    if penalty:
        out += "错误扣分型指标按罚分表定级，只能使用罚分表里列出的等级，每个错误单独记一条。"
        if "P0" in penalty["points"]:
            out += "罚分表里的 P0 是最重一级错误%s。" % ("，出现即直接不通过" if penalty["fatal"] else "，只扣分、不直接判不通过")
    if "scale" in kinds:
        out += ("档位型指标是唯一需要你给出数值的地方：在 levels 里为每个档位型指标先写对照档位描述的依据（basis），再选一个整数档位（level）；"
                "选的档位低于最高档时，拉低档位的问题也要写进 problems。")
    if "check" in kinds:
        out += "判定型指标不用写结论，按问题定级即可：P0–P2 会使该指标不达标，P3 只记录。"
    return out


def build_messages(rubric, sample, input_labels, guide="", checks=False):
    # 评价体系、评分细则和输出要求放在前面、每个样本都完全相同，样本内容放在最后：便于网关缓存相同前缀
    parts = []
    if rubric.get("document"):
        parts.append("===== 评价体系原文（评分依据以原文为准）=====\n" + clip_text(rubric["document"], MAX_DOCUMENT))
        parts.append("\n===== 评分结构（由原文整理，只用于统一输出格式）=====")
    parts.append(describe_rubric(rubric, with_verdict=False))
    if guide:
        parts.append("\n===== 本次评测的评分细则（评测开始时统一制定，所有样本按同一尺度执行）=====\n" + clip_text(guide, MAX_DOCUMENT))
    # 不让模型隐式思考时，要求它先在 checks 里逐条核对具体内容再列问题，避免不核对就判定没有问题
    check_rule = ("每个条目先在 checks 里逐条列出其中的具体事实、数字、人物、事件、对用户需求的承接和制作规格，并对照数据源标注依据；"
                  "标为「无依据」或「与数据源冲突」的内容必须作为问题写入 problems。") if checks else ""
    parts.append("\n===== 输出要求 =====\n按下面的 JSON 结构输出。" + check_rule +
                 "不要输出分数，也不要判断是否通过：每个条目只列出发现的问题（problems），分数和结论由程序计算；没有问题的条目 problems 写空数组。"
                 + kind_rules(rubric) +
                 "每个问题写明所属指标（dim，必须是该评价对象下的指标名）、等级、具体问题和原文证据；"
                 "触发评价体系「直接不通过」条件的问题必须定为 P0；除错误扣分型指标外，没有直接不通过条件的指标不要定 P0。依据的优先级：评价体系原文 > 评分细则 > 本段的通用要求，三者冲突时按优先级高的执行。同一处问题只记一次，不要拆成多条重复扣分；评分细则没有另行规定时，同一句原文只记在最直接相关的一个指标下，只有它在另一个指标上还造成了另一处独立缺陷、并且有不同的原文证据时，才在另一个指标下另记；"
                 "同一条目里不同位置的同类问题可以分别记录。evidence 必须从待评测内容中逐字摘录、尽量短而准确。"
                 "所有文字里需要加引号时一律用「」，不要使用英文双引号，以免破坏 JSON。\n"
                 + json.dumps(output_schema(rubric, checks), ensure_ascii=False, indent=2))
    for key, label in input_labels:
        value = (sample.get("inputs") or {}).get(key, "")
        if value:
            # 字数由程序统计后告诉模型：模型自己数字数不可靠，评价体系常有字数要求
            parts.append("\n===== %s（程序统计：%s 字，不含空白和 Markdown 标记）=====\n%s" % (label, count_chars(value), value))
    parts.append("\n===== 请按上面的输出要求评测这一个样本 =====")
    return [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": "\n".join(parts)}]


def fmt_points(value):
    return ("%.2f" % value).rstrip("0").rstrip(".")


def count_chars(text):
    return len(re.sub(r"\s|[#*>|`]", "", str(text)))


def to_number(value):
    """把各种写法的数字读成有限的浮点数；读不出、或是无穷大 / NaN 时返回 None。"""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        match = re.search(r"-?\d+(\.\d+)?", str(value))
        number = float(match.group()) if match else None
    return number if number is not None and math.isfinite(number) else None
def match_dim(obj, name):
    """把模型写的指标名对应到评价对象下的唯一指标：完全相同 > 去掉空白和标点后相同 > 只有一个指标与它互相包含。
    “流畅”和“流畅度”这类同时包含的情况取名字最接近的一个；仍有两个以上候选时不猜，返回 None。"""
    name = str(name or "").strip()
    dims = obj["dims"]
    exact = next((d for d in dims if d["name"] == name), None)
    if exact or not name:
        return exact
    plain = lambda text: re.sub(r"[\s\W_]+", "", str(text)).lower()
    same = [d for d in dims if plain(d["name"]) == plain(name)]
    if len(same) == 1:
        return same[0]
    near = [d for d in dims if plain(name) and (plain(name) in plain(d["name"]) or plain(d["name"]) in plain(name))]
    if not near:
        return None
    near.sort(key=lambda d: abs(len(plain(d["name"])) - len(plain(name))))
    return near[0] if len(near) == 1 or abs(len(plain(near[0]["name"])) - len(plain(name))) < abs(len(plain(near[1]["name"])) - len(plain(name))) else None


def levels_by_dim(obj, levels):
    """模型给出的档位按指标归位：完全一致的名字先占位，避免“流畅”把“流畅度”的档位拿走。"""
    out = {}
    keys = sorted(levels, key=lambda k: 0 if any(d["name"] == k for d in obj["dims"]) else 1)
    for key in keys:
        dim = match_dim(obj, key)
        if dim and dim["name"] not in out:
            out[dim["name"]] = levels[key]
    return out


def score_result(rubric, judged):
    """分数由问题推导：模型只列问题和等级，程序按扣分表从各指标满分里扣除；P0 该指标记 0 分并直接不通过。"""
    rules = pass_rules(rubric)
    pass_score = rules["passScore"]
    penalty = penalty_of(rubric)
    p0_types = any(t.get("level") == "P0" for t in rubric.get("issueTypes") or [])
    table = deduction_of(rubric)
    warnings, objects, issues, highlights = [], {}, [], []
    for obj in rubric["objects"]:
        raw_items = ((judged.get("objects") or {}).get(obj["key"]) or {}).get("items") or []
        if not raw_items:
            warnings.append("%s：模型没有返回评分" % obj["label"])
        items = []
        for index, raw in enumerate(raw_items):
            label = raw.get("label") or "第%s条" % (index + 1)
            per_dim = {d["name"]: [] for d in obj["dims"]}
            for problem in raw.get("problems") or []:
                if not isinstance(problem, dict):
                    continue
                dim = match_dim(obj, problem.get("dim"))
                level = problem.get("level") if problem.get("level") in LEVELS else "P3"
                if not dim:
                    warnings.append("%s「%s」的问题没有对应到任何指标（%s），未计入扣分" % (obj["label"], label, problem.get("dim") or "未写指标"))
                    continue
                kind_of_dim = dim_kind(dim, rubric)
                # P0 只表示“直接不通过”（或错误扣分表里的最重一级）；指标既没有直接不通过条件、又不在错误扣分表里时按 P1 计
                if level == "P0" and not dim.get("fail") and not p0_types and not (kind_of_dim == "penalty" and "P0" in penalty["points"]):
                    level = "P1"
                    warnings.append("%s「%s」的「%s」没有直接不通过条件，模型标的 P0 已按 P1 计" % (obj["label"], label, dim["name"]))
                fixed = per_issue_points(dim)
                if kind_of_dim == "penalty":
                    level = penalty_level(level, penalty)
                    deduct = penalty["points"][level]
                else:
                    deduct = fixed if fixed is not None and level != "P0" else float(dim["weight"]) * table[level]
                entry = {"level": level, "detail": str(problem.get("detail") or "").strip(), "evidence": str(problem.get("evidence") or "").strip(),
                         "deduct": round(deduct, 2)}
                if problem.get("review"):
                    entry["review"] = str(problem["review"])
                per_dim[dim["name"]].append(entry)
                issues.append({"type": dim["name"], "dim": dim["name"], "level": level, "evidence": entry["evidence"],
                               "detail": ("%s：%s" % (label, entry["detail"])) if obj.get("scope") == "each" else entry["detail"]})
                if len(entry["evidence"]) >= 2:
                    highlights.append({"text": entry["evidence"], "level": level, "note": entry["detail"]})
            dims, fails = [], []
            levels = levels_by_dim(obj, raw.get("levels") if isinstance(raw.get("levels"), dict) else {})
            for dim in obj["dims"]:
                found = per_dim[dim["name"]]
                kind, weight, extra = dim_kind(dim, rubric), float(dim["weight"]), {}
                worst = next((lv for lv in LEVELS if any(p["level"] == lv for p in found)), None)
                if kind == "penalty":
                    score = sum(p["deduct"] for p in found)
                    if dim.get("gate"):
                        extra["gate"] = True
                elif kind == "check":
                    if dim.get("gate"):
                        extra["gate"] = True
                    extra["met"] = worst not in ("P0", "P1", "P2")
                    score = weight if extra["met"] else 0.0
                    for p in found:
                        p["deduct"] = None
                elif kind == "scale":
                    low, high = dim_scale(dim)
                    chosen = levels.get(dim["name"])
                    if isinstance(chosen, dict):
                        extra["basis"] = str(chosen.get("basis") or "").strip()
                        chosen = chosen.get("level")
                    picked = to_number(chosen)
                    if picked is None and any(p["level"] == "P0" for ps in per_dim.values() for p in ps):
                        # 条目已触发直接不通过、评价体系要求“不再打分”时，模型不给档位是对的：记最低档，不提示
                        picked = low
                        extra["basis"] = "已直接不通过，未打分"
                    if picked is None:
                        # 模型漏写档位时按最严重问题推一个档位，并提示
                        picked = high - {"P0": high - low, "P1": 2, "P2": 1}.get(worst, 0)
                        warnings.append("%s「%s」的「%s」没有给出档位，已按问题等级推定为 %s" % (obj["label"], label, dim["name"], fmt_points(max(low, picked))))
                    extra["level"] = max(low, min(high, round(picked)))
                    extra["scale"] = [low, high]
                    score = weight * extra["level"] / high
                    for p in found:
                        p["deduct"] = None
                else:
                    score = max(0.0, weight - sum(p["deduct"] for p in found))
                if kind == "penalty":
                    # 错误扣分型：只有评价体系写了“最重一级错误直接不通过”时才直接不通过，否则最重一级也只是扣分
                    top = heaviest(penalty)
                    if penalty["fatal"] and worst == top:
                        fails += [{"condition": "最重一级错误（%s）" % penalty["labels"].get(top, top), "evidence": p["evidence"] or p["detail"]}
                                  for p in found if p["level"] == top]
                elif worst == "P0":
                    score = 0.0
                    fails += [{"condition": dim.get("fail") or "P0 问题", "evidence": p["evidence"] or p["detail"]} for p in found if p["level"] == "P0"]
                reason = "；".join("%s%s：%s" % (p["level"], " 扣 %s 分" % p["deduct"] if p.get("deduct") else "", p["detail"]) for p in found)
                dims.append({"name": dim["name"], "kind": kind, "score": round(score, 2), "weight": dim["weight"], "reason": reason, "problems": found, **extra})
            # 总分统一换算成百分制，评价体系是 5 分制、10 分制或权重合计不是 100 时，及格线仍按百分制比较
            full = sum(float(d["weight"]) for d in dims if d["kind"] != "penalty")
            penalty_sum = sum(d["score"] for d in dims if d["kind"] == "penalty")
            if penalty:
                # 罚分型：百分制总分 = 100 − 罚分合计（每罚 1 分扣 1 分，最低 0），只用于展示和跨评测比较
                total = round(max(0.0, 100 - penalty_sum), 2)
            else:
                total = round(sum(d["score"] for d in dims) / full * 100, 2) if full else 0.0
            checks_ = [d for d in dims if d["kind"] == "check"]
            scales = [d for d in dims if d["kind"] == "scale"]
            met = sum(1 for d in checks_ if d["met"] and not d.get("gate"))
            counted = [d for d in checks_ if not d.get("gate")]
            # “全部达标”“至少 N 项达标”只数判定型指标；N 超过实际指标数时按全部达标；没有判定型指标时这条不起作用
            required = None if not counted else len(counted) if rules["passAll"] else \
                (min(int(rules["passCount"]), len(counted)) if rules["passCount"] is not None else None)
            mean = round(sum(d["level"] for d in scales) / len(scales), 2) if scales else None
            failed = bool(fails) or (pass_score is not None and total < pass_score) \
                or (required is not None and met < required) \
                or (rules["passMean"] is not None and mean is not None and mean < rules["passMean"]) \
                or (rules["minLevel"] is not None and any(d["level"] < rules["minLevel"] for d in scales)) \
                or (rules["maxPenalty"] is not None and penalty_sum > rules["maxPenalty"]) \
                or any(d.get("gate") and not d.get("met", True) for d in dims)
            # 原单位的结果：全是判定型时给达标项数，全是同一量程的档位型时给平均档位
            native = None
            if penalty:
                native = {"kind": "penalty", "value": round(penalty_sum, 2), "max": rules["maxPenalty"]}
            elif checks_ and len(checks_) == len(dims):
                native = {"kind": "count", "value": met, "max": len(dims)}
            elif scales and len(scales) == len([d for d in dims if not d.get("gate")]) and len({tuple(d["scale"]) for d in scales}) == 1:
                native = {"kind": "mean", "value": mean, "max": scales[0]["scale"][1]}
            items.append({"label": label, "dims": dims, "total": total, "directFail": fails, "native": native,
                          "status": "不通过" if failed else "通过"})
        count = len(items)
        score = round(sum(i["total"] for i in items) / count, 2) if count else 0.0
        any_fail = any(i["directFail"] for i in items)
        dim_avg = [round(sum(i["dims"][k]["score"] for i in items) / count, 2) if count else 0.0
                   for k in range(len(obj["dims"]))]
        # 各指标按自己的计分方式汇总，供报告和对比页展示：扣分型看平均得分，档位型看平均档位，判定型看达标率，错误扣分型看平均扣分
        dim_stats = []
        for k, dim in enumerate(obj["dims"]):
            values = [i["dims"][k] for i in items]
            stat = {"kind": dim_kind(dim, rubric), "gate": bool(dim.get("gate")), "score": dim_avg[k]}
            if stat["kind"] == "scale":
                stat["level"] = round(sum(v["level"] for v in values) / count, 2) if count else None
                stat["scale"] = list(dim_scale(dim))
            elif stat["kind"] == "check":
                stat["met"] = round(sum(1 for v in values if v.get("met")) / count, 4) if count else None
            elif stat["kind"] == "penalty":
                stat["penalty"] = dim_avg[k]
            dim_stats.append(stat)
        natives = [i["native"] for i in items if i["native"]]
        native = {**natives[0], "value": round(sum(n["value"] for n in natives) / len(natives), 2)} if natives and len(natives) == count else None
        # 只有百分制分数线时沿用“对象均分”判定；有达标项数、平均档位等规则时，任一条目不通过即该对象不通过
        other_rules = rules["passAll"] or any(rules[k] is not None for k in ("passCount", "passMean", "minLevel", "maxPenalty")) \
            or any(d.get("gate") for d in obj["dims"])
        passed_items = sum(1 for i in items if i["status"] == "通过")
        if rules["passItems"] is not None:
            # 评价体系写了“至少 N 个条目合格”：对象是否通过只看合格条目数，单个条目不合格不连带
            failed = not count or passed_items < rules["passItems"]
        else:
            failed = any_fail or not count or (pass_score is not None and score < pass_score) \
                or (other_rules and any(i["status"] != "通过" for i in items))
        objects[obj["key"]] = {"score": score, "dimAvg": dim_avg, "dimStats": dim_stats, "items": items, "directFail": any_fail, "native": native, "passedItems": passed_items,
                               "status": "不通过" if failed else "通过"}
    return {"objects": objects, "issues": issues, "highlights": highlights[:30], "summary": judged.get("summary", ""),
            "warnings": warnings, "scoring": "issues"}


def validate_rubric(rubric):
    if not isinstance(rubric, dict) or not isinstance(rubric.get("objects"), list) or not rubric["objects"]:
        raise ValueError("评价体系缺少 objects")
    for obj in rubric["objects"]:
        if not obj.get("key") or not obj.get("label") or not obj.get("dims"):
            raise ValueError("评价对象需要 key、label 和 dims")
        for dim in obj["dims"]:
            weight = to_number(dim.get("weight"))
            if not dim.get("name") or weight is None:
                raise ValueError("指标需要 name 和 weight")
            dim["weight"] = weight


def validate_judged_result(rubric, judged):
    """模型返回的结构不完整时按接口错误处理，不进入计分。"""
    if not isinstance(judged, dict):
        raise ModelError("模型返回的评测结果不是 JSON 对象")
    raw_objects = judged.get("objects")
    if not isinstance(raw_objects, dict):
        raise ModelError("模型返回缺少 objects")
    for obj in rubric["objects"]:
        raw_object = raw_objects.get(obj["key"])
        raw_items = raw_object.get("items") if isinstance(raw_object, dict) else None
        if not isinstance(raw_items, list):
            raise ModelError("模型返回缺少「%s」评分项" % obj["label"])
        for item in raw_items:
            if not isinstance(item, dict):
                raise ModelError("模型返回的「%s」评分项格式不对（应为对象，实际是 %s）" % (obj["label"], type(item).__name__))
            if not isinstance(item.get("problems", []), list) or not isinstance(item.get("levels", {}), dict):
                raise ModelError("模型返回的「%s」评分项里 problems 或 levels 格式不对" % obj["label"])
        expected = obj.get("expectedItems")
        if expected is not None and len(raw_items) != expected:
            raise ModelError("模型返回的「%s」数量为 %s，期望为 %s" % (obj["label"], len(raw_items), expected))


RUBRIC_PLAN_PROMPT = (
    "下面是一份评价体系文件，格式不限（Markdown、JSON、纯文本或表格都可能）。请完整阅读并理解它，"
    "整理出后续逐样本打分要用的评分结构，只输出 JSON，结构如下：\n"
    '{"name": "体系名称", "principles": ["总则原文"], '
    '"objects": [{"key": "英文小写标识", "label": "评价对象名称", "scope": "each 或 whole", "itemName": "条目叫法", "desc": "评分方式说明", '
    '"dims": [{"dimension": "所属维度", "name": "指标名", "weight": 权重数字, "kind": "deduct/scale/check", "scale": [最低档, 最高档], "gate": false, '
    '"measure": "含义与测量方式（档位型照抄各档位描述）", "fail": "直接不通过条件，没有写空字符串"}]}], '
    '"rules": {"passScore": 百分制分数线, "passAll": 判定型指标是否必须全部达标, "passCount": 至少几项判定型指标达标, "passMean": 平均档位线, "minLevel": 单项最低档, "passItems": 至少几个条目合格, '
    '"pass": "通过条件原文", "fail": "不通过条件原文"}, '
    '"penalty": {"points": {"P0": 致命错误罚分, "P1": 严重错误罚分, "P2": 一般错误罚分, "P3": 轻微错误罚分}, "labels": {"P0": "原文等级名"}, "max": 罚分上限, "fatal": 最重一级错误是否直接不通过}, '
    '"issueTypes": [{"key": "英文小写标识", "level": "P0/P1/P2/P3", "title": "问题类型"}], '
    '"deduction": {"P1": 扣分比例, "P2": 扣分比例, "P3": 扣分比例}}\n'
    "要求：scope 在需要对内容中的多个条目逐条打分时写 each（例如逐个创作方向），整体打一次分时写 whole；"
    "文件写了权重或分值就照抄；文件没写时 weight 写 null，不要自行编造权重；"
    "定量指标和定性指标都列为指标；kind 按文件的计分方式填写：给满分、按问题扣分的写 deduct；按 1–5、1–10 等档位打分的写 scale 并在 scale 填量程；"
    "只判断达标/不达标、是/否、0/1 的写 check（scale 写 null）。rules 只填文件写了的规则，没写的填 null："
    "passScore 是总分线并换算成百分制（例如满分 15 分、12 分及格写 80）；passCount 是至少几项达标；passMean 是平均档位线（例如平均 ≥ 3.5）；"
    "minLevel 是任一档位型指标不得低于的档位；passAll 和 passCount 只针对判定型指标，“判定型指标全部达标才通过”时 passAll 写 true；scale 一律从低到高写；"
    "scope 为 each 时，“一组里至少 N 个条目合格这组才通过”写 passItems，“每个条目……算合格”的条件照常写进其他规则；"
    "判定型指标在其他指标都有分值、它自己没有分值、只决定能否通过时，加 \"gate\": true；"
    "文件按错误逐个罚分累计（例如 MQM：轻微 1 分、严重 5 分、致命 25 分，罚分合计不超过 N 通过）时填写 penalty："
    "把文件里的等级从重到轻对应到 P0–P3（致命对应 P0），没有对应等级的不写，max 写罚分上限，此时 passScore 写 null；不是罚分累计时 penalty 写 null。"
    "文件一条通过规则都没写时 passScore 写 85；"
    "文件定义了问题分级时写入 issueTypes，否则写空数组；文件写了各等级问题扣多少（按指标满分的比例）时写入 deduction（例如扣 30% 写 0.3），"
    "没写时 deduction 写空对象；不增删文件中的指标，不补充文件没有的标准。\n\n"
)


# ---------------------------------------------------------------- 评价体系的统一解读
# 评价体系无论来自页面识别（表格、JSON）还是模型解析，都只经过这里的 canonical_rubric 解读：
# 计分方式、量程、真假权重、门槛项、通过规则、扣分表都按同一套规则判断。页面只负责把原文里的结构抽出来，
# 不自己下结论，所以页面展示的规则和程序实际执行的规则永远一致。

# 量程：0 或 1 开头、跨度至少 2 档、最高不超过 20，例如“1–5 分”“0~10 档”
SCALE_RANGE = r"([01])\s*分?\s*[-–—~～到至]\s*(\d{1,2})\s*(?:分|档|级)?"
CHECK_WORDS = re.compile(r"0\s*[/／或]\s*1|是\s*[/／]\s*否|达标\s*[/／]\s*不达标|满足\s*[/／]\s*不满足|合格\s*[/／]\s*不合格|通过\s*[/／]\s*不通过|✓\s*[/／]\s*✗")
DOC_SCOPE = r"(?:每项|各项|每个指标|所有指标|各指标|每一项)"
EMPTY_CELL = re.compile(r"^[\s—\-–无/]*$")


def valid_range(match):
    if not match:
        return None
    low, high = int(match.group(1)), int(match.group(2))
    return [low, high] if high - low >= 2 and high <= 20 else None


def parse_scale(value):
    """量程可以写成 [1, 5]、[5, 1]、"1-10"、"1 到 5 分"；统一为从低到高的两个整数，看不懂时返回 None。"""
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        nums = [to_number(v) for v in value[:2]]
        if None not in nums and nums[0] != nums[1]:
            low, high = sorted(nums)
            return [int(low) if low == int(low) else low, int(high) if high == int(high) else high]
        return None
    match = re.search(r"(\d+(?:\.\d+)?)\s*分?\s*[-–—~～到至]\s*(\d+(?:\.\d+)?)", str(value or ""))
    return parse_scale([match.group(1), match.group(2)]) if match else None


def doc_scoring(text):
    """全文统一说明的计分方式（“每项按 1–5 分打分”“每项只判断是否达标”），用于没有单独说明的指标。"""
    scale = valid_range(re.search(DOC_SCOPE + r"[^。\n]{0,12}?" + SCALE_RANGE, text))
    if scale:
        return "scale", scale
    if re.search(DOC_SCOPE + r"[^。\n]{0,15}?(?:0\s*[/／或]\s*1|是否达标|判断是否|达标或不达标|只判断)", text):
        return "check", None
    return "deduct", None


def interpret_dim(raw, doc_kind, doc_scale):
    """一项指标的计分方式。只看“计分方式/分值”这类说明计分的字段；指标描述里偶然出现的“是/否”不改变计分方式。"""
    method = " ".join(str(raw.get(k) or "") for k in ("method", "weightText"))
    measure = str(raw.get("measure") or "").strip()
    fail = str(raw.get("fail") or "").strip()
    dim = {"dimension": str(raw.get("dimension") or "").strip(), "name": str(raw.get("name")).strip(),
           "weight": to_number(raw.get("weight")), "measure": measure, "fail": "" if EMPTY_CELL.match(fail) else fail}
    if dim["dimension"] == dim["name"]:
        dim["dimension"] = ""
    kind = raw.get("kind") if raw.get("kind") in ("deduct", "scale", "check") else None
    scale = parse_scale(raw.get("scale"))
    if kind is None:
        found = valid_range(re.search(SCALE_RANGE, method)) or valid_range(re.search(r"(?:按|打|评)\s*" + SCALE_RANGE, measure))
        if found:
            kind, scale = "scale", scale or found
        elif CHECK_WORDS.search(method):
            kind = "check"
        else:
            kind, scale = doc_kind, scale or doc_scale
    if kind == "scale":
        dim["kind"], dim["scale"] = "scale", scale or doc_scale or [1, 5]
        # “分值”一栏写的是量程（1–5）时，那不是权重
        if dim["weight"] in dim["scale"]:
            dim["weight"] = None
    elif kind == "check":
        dim["kind"] = "check"
        # 判定型的“分值”写 0 或 1 只表示达标与否，不是权重
        if dim["weight"] in (0, 1):
            dim["weight"] = None
        if raw.get("gate"):
            dim["gate"] = True
    points = per_issue_points(dim)
    if points is not None and kind not in ("scale", "check"):
        dim["perIssue"] = points
    return dim


def rules_from_text(text, has_each):
    """从原文的判定说明里读通过规则；没写的规则留空。"""
    def num(pattern):
        match = re.search(pattern, text)
        return to_number(match.group(1)) if match else None
    rules = {k: None for k in RULE_KEYS}
    rules["passAll"] = bool(re.search(r"(?:全部|所有|每项|各项)(?:指标)?(?:均|都)?(?:须|需|要|必须)?(?:达标|满足)|任一(?:项|指标)?不达标(?:即|则|就)?(?:为|判为|判)?不通过", text))
    count = num(r"(?:至少|不少于|≥|>=)\s*(\d+)\s*(?:项|个)[^。\n]{0,6}?(?:达标|满足|为\s*1|合格|通过)")
    # 逐条评分时“至少 N 个合格”说的是条目，整体评分时说的是指标
    rules["passItems" if has_each else "passCount"] = count
    rules["passMean"] = num(r"平均(?:分|档|档位)?\s*(?:≥|>=|不低于|达到|大于等于)\s*(\d+(?:\.\d+)?)")
    rules["minLevel"] = num(r"(?:任一|任何|单项|有)(?:项|指标)?[^。；\n]{0,8}?(?:低于|<|小于|不足)\s*(\d+(?:\.\d+)?)\s*(?:分|档)[^。；\n]{0,8}?不通过")
    explicit = num(r"总分\s*(?:≥|>=|不低于|大于等于|达到)\s*(\d{1,3}(?:\.\d+)?)")
    others = rules["passAll"] or any(rules.get(k) is not None for k in ("passCount", "passItems", "passMean", "minLevel"))
    if explicit is None and not others:
        # 没有其他规则时，原文里第一个“≥ N”就是总分线
        match = re.search(r"(?:≥|>=|不低于|大于等于)\s*(\d{1,3}(?:\.\d+)?)", text)
        explicit = to_number(match.group(1)) if match else None
    rules["passScore"] = explicit
    return rules


RULE_KEYS = ("passScore", "passCount", "passMean", "minLevel", "passItems")


def canonical_rubric(draft, document="", structure_by="page"):
    if not isinstance(draft, dict):
        raise ValueError("评价体系结构不是对象")
    text = str(document or draft.get("document") or "")
    doc_kind, doc_scale = doc_scoring(text)
    objects, keys, notes = [], set(), []
    for index, group in enumerate(draft.get("objects") or []):
        if not isinstance(group, dict):
            continue
        dims, names = [], set()
        for raw in group.get("dims") or []:
            raw = {"name": raw} if isinstance(raw, str) else raw
            if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
                continue
            dim = interpret_dim(raw, doc_kind, doc_scale)
            # 指标名必须唯一，否则问题和档位无法对应到唯一的指标
            base, n = dim["name"], 2
            while dim["name"] in names:
                dim["name"], n = "%s（%s）" % (base, n), n + 1
            names.add(dim["name"])
            dims.append(dim)
        if not dims:
            continue
        # 门槛项：其他指标都有真实权重、它自己没有权重的判定型指标，只决定能否通过，不计分
        weighted_names = {d["name"] for d in dims if d["weight"] and d["weight"] > 0}
        for d in dims:
            if d.get("kind") == "check" and not (d["weight"] and d["weight"] > 0) and (d.get("gate") or weighted_names - {d["name"]}):
                d["gate"], d["weight"] = True, 0.0
            else:
                d.pop("gate", None)
        scored = [d for d in dims if not d.get("gate")]
        known = [d["weight"] for d in scored if d["weight"] and d["weight"] > 0]
        fill = sum(known) / len(known) if known else (100 / len(scored) if scored else 0)
        for d in scored:
            if not (d["weight"] and d["weight"] > 0):
                d["weight"] = round(fill, 2)
        key = re.sub(r"[^a-z0-9_]", "", str(group.get("key") or "").lower()) or "obj%s" % (index + 1)
        while key in keys:
            key += "_"
        keys.add(key)
        level = str(group.get("level") or "")
        scope = group.get("scope") if group.get("scope") in ("each", "whole") else ("each" if re.search(r"单|逐|每", level) else "whole")
        obj = {"key": key, "label": str(group.get("label") or "评价指标"), "scope": scope,
               "itemName": str(group.get("itemName") or level or "条目"), "desc": str(group.get("desc") or ""),
               "weighted": bool(known), "dims": dims}
        expected = to_number(group.get("expectedItems"))
        if expected:
            obj["expectedItems"] = int(expected)
        objects.append(obj)
    if not objects:
        raise ValueError("没有识别出任何指标")

    # 通过规则：结构里明确给了的规则优先；一条都没给时，从原文的判定说明里读
    given = draft.get("rules") if isinstance(draft.get("rules"), dict) else {}
    rules = {k: to_number(given.get(k)) for k in RULE_KEYS}
    rules["passAll"] = bool(given.get("passAll"))
    if not rules["passAll"] and all(rules[k] is None for k in RULE_KEYS):
        rule_text = "；".join(str(v) for v in (draft.get("ruleText"), given.get("pass")) if v) or text
        rules = rules_from_text(rule_text, any(o["scope"] == "each" for o in objects))
    checks = [d for o in objects for d in o["dims"] if d.get("kind") == "check" and not d.get("gate")]
    if (rules["passAll"] or rules["passCount"] is not None) and not checks:
        notes.append("评价体系要求“指标达标”，但没有达标判定类指标；这条要求由各指标的分数和直接不通过条件体现，不单独执行")
        rules["passAll"], rules["passCount"] = False, None
    if rules["passItems"] is not None and not any(o["scope"] == "each" for o in objects):
        # 整体评分时没有“条目”可数，“至少 N 个合格”指的是指标
        if rules["passCount"] is None and checks:
            rules["passCount"] = rules["passItems"]
        rules["passItems"] = None
    penalty = penalty_of({"penalty": draft.get("penalty")})
    if penalty and not penalty["fatal"]:
        # 原文写了“致命错误直接不通过”这类话时，最重一级错误直接不通过
        top_label = penalty["labels"].get(heaviest(penalty), "致命")
        penalty["fatal"] = bool(re.search(re.escape(top_label) + r"[^。；\n]{0,12}?(?:直接不通过|直接判不合格|一票否决|直接不合格)", text + str(given.get("fail") or "")))
    # 及格线按原始分值写（例如满分 15、12 分及格）时换算成百分制
    totals = [sum(d["weight"] for d in o["dims"]) for o in objects]
    if rules["passScore"] is not None and all("kind" not in d for o in objects for d in o["dims"]) \
            and all(abs(t - totals[0]) < 0.01 for t in totals) and abs(totals[0] - 100) > 0.01 and rules["passScore"] <= totals[0]:
        rules["passScore"] = round(rules["passScore"] / totals[0] * 100, 1)
    if not penalty and not rules["passAll"] and all(rules[k] is None for k in RULE_KEYS) \
            and not any(d.get("gate") for o in objects for d in o["dims"]):
        rules["passScore"] = 85.0
    rules["pass"], rules["fail"] = str(given.get("pass") or draft.get("ruleText") or ""), str(given.get("fail") or "")

    deduction = draft.get("deduction") if isinstance(draft.get("deduction"), dict) else {}
    if not deduction:
        for level in ("P1", "P2", "P3"):
            match = re.search(level + r"[^\n%％]{0,24}?(\d+(?:\.\d+)?)\s*[%％]", text)
            if match:
                deduction[level] = float(match.group(1)) / 100
    deduction = {k: v for k, v in deduction_of({"deduction": deduction}).items() if k != "P0" and k in deduction}
    as_list = lambda v: [str(x) for x in v if x] if isinstance(v, list) else ([str(v)] if v else [])
    issue_types = [{"key": str(t["key"]), "level": t["level"], "title": str(t.get("title") or t["key"])}
                   for t in draft.get("issueTypes") or [] if isinstance(t, dict) and t.get("key") and t.get("level") in LEVELS]
    return {"name": str(draft.get("name") or ""), "principles": as_list(draft.get("principles"))[:8], "notes": as_list(draft.get("notes")) + notes,
            "objects": objects, "issueTypes": issue_types, "penalty": penalty, "rules": rules, "deduction": deduction,
            "structureBy": structure_by}


def normalize_rubric(raw, document=""):
    """模型解析出的评分结构，与页面识别的结构走同一套解读。"""
    if not isinstance(raw, dict):
        raise ModelError("模型没有返回评分结构")
    try:
        return canonical_rubric(raw, document, "model")
    except ValueError as error:
        raise ModelError("模型没有从评价体系中整理出可用的指标：%s" % error) from None


PROMPT_STRATEGY_PROMPT = (
    "你是提示词工程师。下面给出：被评测的生成提示词原文、评价体系、这次评测的得分概况，以及全部样本发现的问题和原文证据。"
    "请把所有问题作为一个整体来看，先诊断再给方案，不要一个问题对应一条修改：\n"
    "1. 先做全局诊断（diagnosis）：找出反复出现、或源于提示词里同一处写法、冲突或缺失的问题模式，每个诊断写明涉及的问题、样本 ID，"
    "以及 cause：提示词里导致它的具体原文（引用原句）或缺失（写「缺少……」）。个别样本的偶发问题不值得改提示词，不要列入诊断。\n"
    "2. 再按诊断出的根因给策略：一条策略应尽量同时解决同一根因下的多个问题（problems 列出它覆盖的全部问题）；"
    "不同策略之间不能互相冲突，合起来要构成一套完整的修改方案。没有证据支持的通用建议（如“表述更清晰”）不要写。\n"
    "3. before 引用提示词中要改的原文（新增内容时写空字符串，并在 location 说明插入位置）；after 写可以直接粘贴进提示词的完整文本。"
    "引用原文里的英文双引号请改写为「」，避免破坏 JSON。\n"
    "4. 修改不能违背评价体系，也不能破坏提示词已经做好的部分；risk 写副作用；verify 写用哪些样本 ID 复测、看哪个指标。\n"
    "5. 策略按影响排序（严重程度 × 涉及样本数），一般 3–6 条；plan 说明这套修改建议的落地顺序；keep 列出应保留的写法。\n"
    "只输出 JSON：\n"
    '{"summary": "一段话概括这一版提示词的整体问题与改进方向", '
    '"diagnosis": [{"pattern": "问题模式或共同根因", "problems": ["涉及的问题"], "ids": ["样本 ID"], "cause": "提示词中导致它的原文或缺失"}], '
    '"strategies": [{"priority": "高/中/低", "title": "策略名称", "problems": ["该策略覆盖的问题"], "level": "覆盖问题中最严重的等级 P0/P1/P2/P3", "ids": ["样本 ID"], '
    '"root_cause": "提示词中的共同成因", "location": "修改位置", "before": "提示词原文片段", "after": "建议的提示词文本", '
    '"expected": "预期改善的指标", "verify": "复测方法", "risk": "可能的副作用"}], '
    '"plan": "落地顺序与整体预期", "keep": ["应保留的写法"]}\n\n'
)


def normalize_prompt_strategy(raw, known_ids):
    if not isinstance(raw, dict):
        raise ModelError("模型没有返回提示词策略")
    text = lambda value: str(value or "").strip()
    texts = lambda values: [text(v) for v in (values if isinstance(values, list) else [values]) if text(v)]
    ids_of = lambda values: [str(i) for i in values or [] if str(i) in known_ids]
    strategies = []
    for item in raw.get("strategies") or []:
        if not isinstance(item, dict) or not text(item.get("title")) or not text(item.get("after")):
            continue
        problems = texts(item.get("problems")) or texts(item.get("problem"))
        strategies.append({
            "priority": item.get("priority") if item.get("priority") in ("高", "中", "低") else "中",
            "title": text(item.get("title")), "problems": problems, "problem": "；".join(problems),
            "level": item.get("level") if item.get("level") in ("P0", "P1", "P2", "P3") else "",
            "ids": ids_of(item.get("ids")),
            "rootCause": text(item.get("root_cause")), "location": text(item.get("location")),
            "before": text(item.get("before")), "after": text(item.get("after")),
            "expected": text(item.get("expected")), "verify": text(item.get("verify")), "risk": text(item.get("risk")),
        })
    if not strategies:
        raise ModelError("模型没有给出可用的提示词修改策略")
    diagnosis = [{"pattern": text(d.get("pattern")), "problems": texts(d.get("problems")), "ids": ids_of(d.get("ids")),
                  "cause": text(d.get("cause")), "scope": text(d.get("scope"))} for d in raw.get("diagnosis") or [] if isinstance(d, dict) and text(d.get("pattern"))]
    return {"summary": text(raw.get("summary")), "diagnosis": diagnosis, "strategies": strategies[:8],
            "plan": text(raw.get("plan")), "keep": texts(raw.get("keep"))}


CALIBRATE_PROMPT = (
    "你是评测负责人。下面给出评价体系，以及本评测集各样本的数据源（不提供任何待评测的输出）。"
    "请制定一份评分细则。这份细则会固定下来：同一评测集之后的每一轮评测（包括提示词迭代后的新输出）都按它执行，"
    "所以它只能依据评价体系和数据源，不能针对某一版输出：\n"
    "1. 评测员只找问题并定级，分数和结论由程序按评分结构计算。所以细则的重点是定级：逐项指标写清什么情况算 P0、P1、P2、P3，"
    "什么情况不算问题；只有评价体系写了直接不通过条件的指标才有 P0，对应的问题一律定为 P0。{kind_part}\n"
    "2. 写清同一处问题怎样算一条、不要重复记录，以及严重程度相近时如何取舍等级，保证不同样本之间定级一致。"
    "必须给出一条不含糊的规则：同一句原文能否在多个指标下分别记录（能的话在什么条件下），并配一个判例；不要写成既允许又限制的两可表述。\n"
    "3. 判例只来自数据源：结合各样本数据源里的事实、规则和边界，写清可以写到什么程度、超出后属于哪一级问题"
    "（例如什么样的补充内容算无来源事实，什么样的算合理的通用知识）。不要假设或引用任何具体输出；没有数据源时只依据评价体系写通用判例。\n"
    "4. 评价体系里写明的计分规则（例如每处扣多少分、及格线）由程序执行，细则不要改写或另立分值。\n"
    "只依据评价体系制定，不新增评价体系之外的标准，不改变权重；细则控制在 2500 字以内，写成可直接执行的条目。"
    '只输出 JSON：{"guide": "评分细则全文（Markdown）"}\n\n'
)

ANALYSIS_HEAD = (
    "你是评测负责人。所有样本已经逐条评完，下面给出评价体系、每个样本的得分，以及全部样本发现的问题和原文证据。"
    "请把它们作为一个整体分析，完成下面这一项任务。资料里标有“省略”的部分是因篇幅没有提供的内容，不要据此下结论。\n"
)
ANALYSIS_GROUPS_PART = (
    "问题整合（groups）：把问题整合成“核心问题 → 分级问题”两层。第一层按问题本质归类（通常对应某个评价指标），"
    "第二层在每个核心问题下按严重程度列出具体问题，同类同级的问题合并为一条并合并样本 ID。不新增问题，不改变严重程度，ids 只用清单中出现过的样本 ID。\n"
)
ANALYSIS_REVIEW_PART = (
    "复核修正（review）：逐样本评测时评测员一次只看一条样本，你要横向检查全部样本的问题记录，把记错的地方修正过来。"
    "分数和通过与否由程序根据修正后的问题重新计算，你只修正问题记录本身；计分方式和判定规则见 rules，不要按其他及格线判断，也不要检查总结的文字。\n"
    "修正分两类，严格区分：\n"
    "（一）corrections：有确凿依据、可以直接修正的，只限下面五种，每条都要在 basis 里写明依据（引用评价体系、评分细则的条文，或 outputs 里的原文）：\n"
    "  1. remove 重复记录：同一句原文在多个指标下各记了一次，删掉不该记的那条（按评分细则对重复记录的规定判断哪条该留）；\n"
    "  2. move 记错指标：问题明显属于另一个指标，toDim 写应归入的指标；\n"
    "  3. relevel 等级与规则冲突：评价体系或评分细则明确规定了这种情况的等级，评测员定成了别的等级，level 写规定的等级；\n"
    "  4. add 漏判：确实存在、但没有记录的问题，evidence 必须从 outputs 的输出原文中逐字摘录，写明 dim、level、detail；\n"
    "  5. setLevel 档位不符（只用于档位型指标）：所选档位明显不符合档位描述，或同类情况选了不同的档，level 写应选的整数档位。\n"
    "  定位原问题时，dim 写原问题所在的指标，evidence 照抄原问题记录里的 evidence。\n"
    "（二）doubts：需要人来判断的，只记录、不修正：轻重两可（例如 P2 和 P3 都说得通）、评分细则本身写得两可或互相矛盾、拿不出原文依据的怀疑。\n"
    "按指标类型看不同的东西：档位型看所选档位是否符合档位描述（问题的 P 等级在档位型里只是说明，不修正）；"
    "判定型只关心问题落在 P0–P2（不达标）还是 P3（达标）；扣分型看问题等级。只处理会改变得分、档位或达标结论的情况；"
    "没有需要修正或存疑的地方时，corrections 和 doubts 都写空数组。\n"
)
ANALYSIS_STRATEGY_PART = (
    "提示词优化策略（strategy）：资料里的问题记录已经过复核修正，问题整合（issues）也是按修正后的问题归类的，以它们为依据；"
    "doubts 是复核存疑、需要人判断的情况，不作为修改提示词的理由，涉及的问题若可能是评测尺度造成的，在 summary 里单独说明。"
    "对照被评测的提示词原文，把所有问题作为一个整体诊断。先做全局诊断（diagnosis）：找出反复出现、"
    "或源于提示词里同一处写法、冲突或缺失的问题模式，cause 写提示词里导致它的具体原文（引用原句）或缺失（写「缺少……」）；"
    "个别样本的偶发问题不列入诊断。再按根因给 3–6 条策略，"
    "一条策略尽量同时解决同一根因下的多个问题，策略之间不能冲突，合起来构成一套完整方案。没有证据支持的通用建议不要写。"
    "before 引用提示词中要改的原文（新增时写空字符串并在 location 说明插入位置），after 写可直接粘贴的完整文本；"
    "引用原文里的英文双引号改写为「」。修改不能违背评价体系或破坏已经做好的部分；risk 写副作用；verify 写用哪些样本复测、看哪个指标；"
    "plan 写落地顺序；keep 列出应保留的写法。\n"
)


def analysis_schema(with_strategy):
    schema = {
        "groups": [{"title": "核心问题名称", "issues": [{"level": "P0/P1/P2/P3", "title": "具体问题名称", "desc": "一句话说明", "ids": ["样本 ID"]}]}],
        "review": {"summary": "一句话概括复核结果",
                   "corrections": [{"id": "样本 ID", "object": "评价对象名称", "item": "条目标题（整体评分时写“整体”）",
                                    "action": "remove/move/relevel/add/setLevel", "type": "重复记录/记错指标/等级与规则冲突/漏判/档位不符",
                                    "dim": "原问题所在指标（add 写要补的指标）", "evidence": "原问题记录里的 evidence（add 写输出原文，逐字）",
                                    "toDim": "move 时应归入的指标", "level": "relevel/add 写 P0–P3，setLevel 写整数档位",
                                    "detail": "add 时的问题说明，40 字以内", "basis": "修正依据：引用评价体系、评分细则或输出原文"}],
                   "doubts": [{"ids": ["样本 ID"], "problem": "需要人判断的情况", "suggestion": "建议的处理"}]},
    }
    if with_strategy:
        schema["strategy"] = {
            "summary": "一段话概括这一版提示词的整体问题与改进方向",
            "diagnosis": [{"pattern": "问题模式或共同根因", "problems": ["涉及的问题"], "ids": ["样本 ID"], "cause": "提示词中导致它的原文或缺失"}],
            "strategies": [{"priority": "高/中/低", "title": "策略名称", "problems": ["覆盖的问题"], "level": "P0/P1/P2/P3", "ids": ["样本 ID"],
                            "root_cause": "共同成因", "location": "修改位置", "before": "提示词原文片段", "after": "建议的提示词文本",
                            "expected": "预期改善的指标", "verify": "复测方法", "risk": "可能的副作用"}],
            "plan": "落地顺序与整体预期", "keep": ["应保留的写法"]}
    return schema


def required(value, name):
    if value is None:
        raise ModelError("模型没有返回%s结果" % name)
    return value


def analysis_tasks():
    full = analysis_schema(True)
    return {
        "groups": (ANALYSIS_GROUPS_PART, {"groups": full["groups"]}, lambda raw, known: normalize_issue_groups(raw or {}, known)),
        "review": (ANALYSIS_REVIEW_PART, {"review": full["review"]}, lambda raw, known: required(normalize_review((raw or {}).get("review", raw), known), "全局复核")),
        "strategy": (ANALYSIS_STRATEGY_PART, full["strategy"], lambda raw, known: normalize_prompt_strategy((raw or {}).get("strategy", raw), known)),
    }


REVIEW_ACTIONS = ("remove", "move", "relevel", "add", "setLevel")


def normalize_review(raw, known_ids):
    """复核结果：corrections 是待程序核对执行的修正，findings 是展示给用户的存疑项（旧记录里的 findings 也按存疑项展示）。"""
    if not isinstance(raw, dict):
        return None
    text = lambda v: str(v if v is not None else "").strip()
    doubts = raw.get("doubts") if isinstance(raw.get("doubts"), list) else raw.get("findings") or []
    findings = [{"ids": [str(i) for i in f.get("ids") or [] if str(i) in known_ids], "problem": text(f.get("problem")),
                 "suggestion": text(f.get("suggestion"))}
                for f in doubts if isinstance(f, dict) and text(f.get("problem"))]
    corrections = [{k: text(c.get(k)) for k in ("id", "object", "item", "action", "type", "dim", "evidence", "toDim", "level", "detail", "basis")}
                   for c in raw.get("corrections") or [] if isinstance(c, dict) and c.get("action") in REVIEW_ACTIONS and text(c.get("id")) in known_ids]
    return {"summary": text(raw.get("summary")), "findings": findings, "corrections": corrections}


# ---------------------------------------------------------------- 复核修正的核对与执行
# 模型给出的修正先由程序逐条核对：样本、条目、指标、等级要真实存在，引用的原文要真的出现在问题记录或输出里。
# 核对通过的才执行；核对不过的不执行，改为存疑项交给用户。修正后由 score_result 按同一套规则重新计分。
def judged_of(result):
    """从评测结果还原模型交出的问题记录（新结果里存有 judged，旧结果从各指标的问题还原）。"""
    if isinstance(result.get("judged"), dict):
        return json.loads(json.dumps(result["judged"], ensure_ascii=False))
    objects = {}
    for key, obj in (result.get("objects") or {}).items():
        items = []
        for item in obj.get("items") or []:
            problems = [{"dim": d.get("name"), "level": p.get("level"), "detail": p.get("detail"), "evidence": p.get("evidence")}
                        for d in item.get("dims") or [] for p in d.get("problems") or []]
            levels = {d["name"]: {"level": d.get("level"), "basis": d.get("basis", "")} for d in item.get("dims") or [] if d.get("kind") == "scale"}
            items.append({"label": item.get("label"), "problems": problems, "levels": levels})
        objects[key] = {"items": items}
    return {"objects": objects, "summary": result.get("summary", "")}


def same_text(a, b):
    plain = lambda t: re.sub(r"\s+", "", str(t or ""))
    return bool(plain(a)) and (plain(a) == plain(b) or plain(a) in plain(b) or plain(b) in plain(a))


def apply_corrections(rubric, sample, corrections):
    """对一条样本执行核对通过的修正，返回 (新的评测结果, 已执行, 未通过核对)。"""
    result = sample.get("result") or {}
    judged = judged_of(result)
    outputs = " ".join(str(v) for k, v in (sample.get("inputs") or {}).items() if k != "source")
    applied, rejected = [], []
    for c in corrections:
        obj = next((o for o in rubric["objects"] if o["label"] == c["object"] or o["key"] == c["object"]), None) or \
            (rubric["objects"][0] if len(rubric["objects"]) == 1 else None)
        items = ((judged.get("objects") or {}).get(obj["key"]) or {}).get("items") if obj else None
        item = None
        if items:
            item = next((i for i in items if str(i.get("label") or "") == c["item"]), None) or (items[0] if len(items) == 1 else None)
        def fail(reason):
            rejected.append({**c, "reason": reason})
        if not item:
            fail("找不到对应的评价对象或条目")
            continue
        dim = match_dim(obj, c["dim"])
        problems = item.setdefault("problems", [])
        target = next((p for p in problems if match_dim(obj, p.get("dim")) is dim and same_text(c["evidence"], p.get("evidence") or p.get("detail"))), None) if dim else None
        level = c["level"].upper() if c["level"].upper() in LEVELS else None
        if c["action"] in ("remove", "move", "relevel") and not target:
            fail("问题记录里找不到这条问题")
        elif c["action"] == "remove":
            problems.remove(target)
            applied.append(c)
        elif c["action"] == "move":
            to = match_dim(obj, c["toDim"])
            if not to or to is dim:
                fail("要归入的指标不存在")
            else:
                target["dim"], target["review"] = to["name"], "复核改归「%s」" % to["name"]
                applied.append(c)
        elif c["action"] == "relevel":
            if not level:
                fail("等级不是 P0–P3")
            elif level == "P0" and not dim.get("fail") and dim_kind(dim, rubric) != "penalty":
                fail("该指标没有直接不通过条件，不能定为 P0")
            else:
                target["review"] = "复核由 %s 改为 %s" % (target.get("level"), level)
                target["level"] = level
                applied.append(c)
        elif c["action"] == "add":
            if not dim:
                fail("指标不存在")
            elif not level:
                fail("等级不是 P0–P3")
            elif not re.sub(r"\s+", "", c["evidence"]) or re.sub(r"\s+", "", c["evidence"]) not in re.sub(r"\s+", "", outputs):
                fail("补充问题引用的原文在输出里找不到")
            else:
                problems.append({"dim": dim["name"], "level": level, "detail": c["detail"] or c["type"], "evidence": c["evidence"], "review": "复核补充"})
                applied.append(c)
        elif c["action"] == "setLevel":
            picked = to_number(c["level"])
            if not dim or dim_kind(dim, rubric) != "scale":
                fail("只有档位型指标可以调整档位")
            elif picked is None or not (dim_scale(dim)[0] <= picked <= dim_scale(dim)[1]):
                fail("档位不在量程内")
            else:
                levels = item.setdefault("levels", {})
                levels[dim["name"]] = {"level": int(round(picked)), "basis": "复核修正：" + c["basis"]}
                applied.append(c)
    new = score_result(rubric, judged)
    new.update({k: result[k] for k in ("id", "model", "elapsed", "usage") if k in result})
    new["judged"] = judged
    return new, applied, rejected





ISSUE_GROUP_PROMPT = (
    "下面是一次评测中各样本发现的问题清单（JSON）。请把它们整合成“核心问题 → 分级问题”两层："
    "第一层按问题本质归类（通常对应某个评价指标，如“表达质量”“事实准确性”），"
    "第二层在每个核心问题下按严重程度列出具体问题（同一类、同等级的问题合并为一条，并合并样本 ID）。"
    "只依据清单内容整合，不新增问题，不改变问题的严重程度，ids 只能使用清单中出现过的样本 ID。只输出 JSON：\n"
    '{"groups": [{"title": "核心问题名称", "issues": [{"level": "P0/P1/P2/P3", "title": "具体问题名称", "desc": "一句话说明", "ids": ["样本 ID"]}]}]}\n\n'
)


def normalize_issue_groups(raw, known_ids):
    groups = []
    for group in (raw or {}).get("groups") or []:
        if not isinstance(group, dict):
            continue
        issues = []
        for issue in group.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            ids = [str(i) for i in issue.get("ids") or [] if str(i) in known_ids]
            level = issue.get("level") if issue.get("level") in ("P0", "P1", "P2", "P3") else "P3"
            if ids:
                issues.append({"level": level, "title": str(issue.get("title") or "未命名问题"), "desc": str(issue.get("desc") or ""), "ids": ids})
        if issues:
            groups.append({"title": str(group.get("title") or "其他问题"), "issues": sorted(issues, key=lambda i: i["level"])})
    if not groups:
        raise ModelError("模型没有返回可用的问题整合结果")
    return groups


ANALYSIS_TASKS = analysis_tasks()
# ---------------------------------------------------------------- 删除与隐藏
# 删除的评测记录移到 runs/.trash，可以手动恢复；内置的评测与评价体系只记录为隐藏

HIDDEN_PATH = DATA_DIR / "hidden.json"
TRASH_DIR = RUNS_DIR / ".trash"
HIDDEN_KINDS = ("runs", "rubrics", "types")


# ---------------------------------------------------------------- 存档文件的统一读写
_STORE_LOCKS = {}
_STORE_GUARD = threading.Lock()


def store_lock(path):
    with _STORE_GUARD:
        return _STORE_LOCKS.setdefault(str(path), threading.RLock())


def read_store(path, default):
    with store_lock(path):
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            broken = path.with_name("%s.broken-%s" % (path.name, time.strftime("%Y%m%d-%H%M%S")))
            try:
                path.replace(broken)
            except OSError:
                pass
            print("存档文件 %s 无法读取（%s），已备份为 %s，按空文件继续" % (path.name, error, broken.name), flush=True)
            return default


def write_store(path, data, private=False):
    with store_lock(path):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(".%s.%s.tmp" % (path.name, threading.get_ident()))
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        if private:
            os.chmod(temp, 0o600)
        os.replace(temp, path)


def page_version():
    """页面文件的版本：任一页面文件被修改，版本就变。页面据此发现自己是旧代码，提示刷新。"""
    return max(int((ROOT / name).stat().st_mtime) for name in ("app.js", "index.html", "styles.css", "data.js") if (ROOT / name).exists())


def load_hidden():
    data = read_store(HIDDEN_PATH, {})
    data = data if isinstance(data, dict) else {}
    return {kind: [str(i) for i in data.get(kind) or []] for kind in HIDDEN_KINDS}


def hide(kind, item_id):
    if kind not in HIDDEN_KINDS or not RUN_ID_RE.match(item_id or ""):
        raise ValueError("非法的隐藏项")
    with store_lock(HIDDEN_PATH):
        hidden = load_hidden()
        if item_id not in hidden[kind]:
            hidden[kind].append(item_id)
        write_store(HIDDEN_PATH, hidden)
    return hidden


# 评分细则按「评价体系 + 各样本数据源」固定：提示词和输出怎么变，同一指纹都沿用同一份细则；重新制定或手工修改会追加新版本
GUIDES_PATH = DATA_DIR / "guides.json"
GUIDE_KEY_RE = re.compile(r"^[0-9a-f]{16}$")


def guide_key(rubric, samples):
    basis = str(rubric.get("document") or "") or describe_rubric(rubric)
    sources = sorted((str(s.get("id", "")), re.sub(r"\s+", "", str(s.get("source") or ""))) for s in samples)
    return hashlib.sha256(json.dumps([re.sub(r"\s+", "", basis), sources], ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def load_guides():
    data = read_store(GUIDES_PATH, {})
    return data if isinstance(data, dict) else {}


def latest_guide(key):
    versions = load_guides().get(key) or []
    return versions[-1] if versions else None


def save_guide(key, guide, model, origin):
    with store_lock(GUIDES_PATH):
        guides = load_guides()
        versions = guides.setdefault(key, [])
        entry = {"version": len(versions) + 1, "guide": guide, "model": model, "origin": origin,
                 "createdAt": time.strftime("%Y/%m/%d %H:%M:%S")}
        versions.append(entry)
        write_store(GUIDES_PATH, guides)
        return entry
# ---------------------------------------------------------------- 评测记录存储

def list_runs():
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    runs = []
    for path in sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with store_lock(path):
                run = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        run["sampleCount"] = len([s for s in run.get("samples") or [] if s.get("scores")])
        run.pop("samples", None)
        runs.append(run)
    return runs


def run_path(run_id):
    if not RUN_ID_RE.match(run_id or ""):
        raise ValueError("非法的评测 ID")
    return RUNS_DIR / (run_id + ".json")


def validate_run(run):
    """只保存历史报告能够渲染的记录。"""
    if not isinstance(run, dict):
        raise ValueError("评测记录必须是 JSON 对象")
    run_path(run.get("id"))
    rubric = run.get("rubric")
    validate_rubric(rubric)
    if not isinstance(run.get("objects"), dict):
        raise ValueError("评测记录缺少汇总评分")
    for obj in rubric["objects"]:
        result = run["objects"].get(obj["key"])
        if not isinstance(result, dict) or to_number(result.get("score")) is None:
            raise ValueError("评测记录缺少「%s」汇总评分" % obj["label"])
    if not isinstance(run.get("samples"), list):
        raise ValueError("评测记录缺少样本明细")


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    # 单个连接读写超过 120 秒没有动静就断开，避免请求体没发完时一直占着线程
    timeout = 120

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            super().log_message(fmt, *args)

    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("请求体为空或过大")
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(body, dict):
            raise ValueError("请求内容应为 JSON 对象")
        return body

    # 安全边界：接口只听平台自己页面的请求。
    # 1) Host 必须是本机地址加本端口（防止恶意网站用改写域名的方式冒充本机）；
    # 2) 浏览器带了 Origin 时，必须与 Host 一致（防止别的网站在你的浏览器里偷偷调用接口）；
    # 3) 写操作必须是 JSON 请求（跨站的 JSON 请求会被浏览器先拦下询问，平台不放行）。
    def request_allowed(self, write):
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").strip().lower()
        bound = self.server.server_address[0]
        local = {"127.0.0.1:%s" % port, "localhost:%s" % port, "[::1]:%s" % port}
        host_ok = host in local or (bound not in ("127.0.0.1", "::1", "localhost") and host.endswith(":%s" % port))
        origin = (self.headers.get("Origin") or "").strip().lower()
        origin_ok = not origin or origin == "http://" + host
        type_ok = not write or (self.headers.get("Content-Type") or "").lower().startswith("application/json")
        if host_ok and origin_ok and type_ok:
            return True
        self.send_json({"error": "拒绝访问：只接受来自 EvalLab 页面本身的请求"}, HTTPStatus.FORBIDDEN)
        return False

    # 页面文件白名单：只开放平台目录里的页面文件（html/js/css/图片），其余一律当作不存在
    PAGE_SUFFIXES = {".html", ".js", ".css", ".svg", ".png", ".jpg", ".ico"}

    def guard_private(self):
        name = unquote(urlparse(self.path).path).lstrip("/") or "index.html"
        target = ROOT / name
        allowed = "/" not in name and "\\" not in name and not name.startswith(".") \
            and Path(name).suffix.lower() in self.PAGE_SUFFIXES and name.lower() not in {f.lower() for f in PRIVATE_FILES} and target.is_file()
        if not allowed:
            self.send_error(HTTPStatus.NOT_FOUND)
            return True
        return False

    def fail_safely(self, error):
        """任何没预料到的错误都返回一条能看懂的说明，而不是直接断开连接（页面上只显示 Failed to fetch）。"""
        self.log_message("服务内部错误：%s", "".join(traceback.format_exception(type(error), error, error.__traceback__))[-1500:])
        try:
            return self.send_json({"error": "服务内部错误（%s：%s），详情已写入 数据/server.log" % (type(error).__name__, error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        except OSError:
            return None

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # 显式给出页面文件类型：Windows 上 Python 会读注册表猜类型，.js 常被识别成 text/plain，
    # 加上 nosniff 后浏览器会拒绝执行脚本，页面变成空白
    STATIC_TYPES = {".md": "text/markdown; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                    ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml"}

    def guess_type(self, path):
        suffix = Path(str(path)).suffix.lower()
        if suffix in self.STATIC_TYPES:
            return self.STATIC_TYPES[suffix]
        return super().guess_type(path)

    def do_HEAD(self):
        if not self.guard_private():
            super().do_HEAD()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/") and not self.request_allowed(write=False):
            return
        try:
            if path == "/api/config":
                config = load_config()
                return self.send_json({"api_base": config["api_base"], "has_key": bool(config["api_key"]),
                                       "auth_header": config["auth_header"], "auth_prefix": config["auth_prefix"],
                                       "models": len(config["models"]), "env_locked": bool(os.environ.get("EVAL_API_KEY"))})
            if path == "/api/status":
                config = load_config()
                return self.send_json({"configured": bool(config["api_base"]), "pageVersion": page_version(),
                                       "gateway": urlparse(config["api_base"]).netloc if config["api_base"] else ""})
            if path == "/api/models":
                return self.send_json(list_models(load_config()))
            if path == "/api/runs":
                return self.send_json({"runs": list_runs()})
            if path == "/api/hidden":
                return self.send_json(load_hidden())
            if path.startswith("/api/runs/"):
                target = run_path(path.rsplit("/", 1)[-1])
                if not target.exists():
                    return self.send_json({"error": "评测记录不存在"}, HTTPStatus.NOT_FOUND)
                run = read_store(target, None)
                if run is None:
                    return self.send_json({"error": "评测记录文件已损坏，已备份到 数据/runs，请重新评测"}, HTTPStatus.NOT_FOUND)
                return self.send_json(run)
        except ValueError as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # noqa: BLE001 —— 兜底，保证总有回应
            return self.fail_safely(error)
        if path.startswith("/project/"):
            return self.send_project_file(unquote(path[len("/project/"):]))
        if self.guard_private():
            return
        super().do_GET()

    def send_project_file(self, name):
        """只读提供本副本明确列出的历史报告，拒绝其他路径和符号链接。"""
        candidate = PROJECT_DIR / name
        target = candidate.resolve()
        inside = PROJECT_DIR in target.parents
        linked = candidate.is_symlink() or candidate.parent.is_symlink()
        if name not in PROJECT_FILES or not inside or linked or target.suffix.lower() not in PROJECT_SUFFIXES or not target.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/markdown; charset=utf-8" if target.suffix == ".md" else "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        if not self.request_allowed(write=True):
            return
        try:
            body = self.read_json()
            if path == "/api/config":
                return self.send_json(self.save_config(body))
            if path == "/api/config/test":
                return self.send_json(self.test_config(body))
            if path == "/api/evaluate":
                return self.send_json(self.evaluate(body))
            if path == "/api/plan-rubric":
                # 评测开始时由模型阅读评价体系原文；上传文件本身不经过这里
                document = str(body.get("document") or "").strip()
                if not document:
                    raise ValueError("评价体系原文为空")
                model = str(body.get("model") or "")
                if not model:
                    raise ValueError("缺少 model")
                messages = [{"role": "user", "content": RUBRIC_PLAN_PROMPT + clip_text(document, MAX_DOCUMENT)}]
                raw, _, _ = chat_json(load_config(), model, messages)
                return self.send_json({"rubric": normalize_rubric(raw, document)})
            if path == "/api/apply-review":
                # 复核修正：程序逐条核对后执行，按修正后的问题重新计分；核对不过的修正返回为存疑项
                rubric = body.get("rubric")
                validate_rubric(rubric)
                corrections = [c for c in body.get("corrections") or [] if isinstance(c, dict)]
                out = {"samples": {}, "applied": [], "rejected": []}
                for sample in body.get("samples") or []:
                    if not isinstance(sample, dict) or not isinstance(sample.get("result"), dict):
                        continue
                    mine = [c for c in corrections if str(c.get("id")) == str(sample.get("id"))]
                    if not mine:
                        continue
                    new, applied, rejected = apply_corrections(rubric, sample, mine)
                    if applied:
                        out["samples"][str(sample.get("id"))] = new
                    out["applied"] += applied
                    out["rejected"] += rejected
                return self.send_json(out)
            if path == "/api/normalize-rubric":
                # 页面从表格或 JSON 里抽出的结构草稿，由这里按统一规则解读后再展示和计分
                return self.send_json({"rubric": canonical_rubric(body.get("draft"), str(body.get("document") or ""))})
            if path == "/api/runs":
                run = body.get("run") or {}
                validate_run(run)
                target = run_path(run.get("id"))
                write_store(target, run, private=True)
                return self.send_json({"ok": True, "id": run["id"]})
            if path == "/api/calibrate":
                # 正式评测前统一制定评分细则：只做一次，开启思考；之后每个样本带着细则评分
                rubric = body.get("rubric")
                validate_rubric(rubric)
                model = str(body.get("model") or "")
                if not model:
                    raise ValueError("缺少 model")
                samples = [s for s in body.get("samples") or [] if isinstance(s, dict)]
                key = guide_key(rubric, samples)
                stored = None if body.get("regenerate") else latest_guide(key)
                if stored:
                    return self.send_json({**stored, "key": key, "reused": True})
                # 只给数据源、不给待评测的输出：细则不随某一版输出变化
                excerpts, used = [], 0
                for sample in samples:
                    source = str(sample.get("source") or "").strip()
                    if not source or used > MAX_DOCUMENT:
                        continue
                    excerpts.append("### 样本 %s\n%s" % (sample.get("id", ""), source[:2000]))
                    used += min(len(source), 2000)
                document = ("===== 评价体系原文 =====\n" + clip_text(rubric["document"], MAX_DOCUMENT) + "\n\n") if rubric.get("document") else ""
                sources = ("===== 各样本的数据源 =====\n" + "\n\n".join(excerpts)) if excerpts else "===== 本评测集没有数据源，只依据评价体系制定细则 ====="
                kind_part = {"deduct": "扣分型指标的扣分比例见评分结构末尾的扣分表。",
                             "scale": "档位型指标要把每个档位的描述写成可核对的判据，让不同样本选档一致。",
                             "check": "判定型指标要写清达标线：P0–P2 即不达标，P3 只记录。"}
                content = CALIBRATE_PROMPT.replace("{kind_part}", "".join(kind_part[k] for k in ("deduct", "scale", "check") if k in kinds_of(rubric))) + document + "===== 评分结构 =====\n" + describe_rubric(rubric) + "\n\n" + sources
                started = time.time()
                raw, _, usage = chat_json(load_config(), model, [{"role": "user", "content": content}], think=True)
                guide = str((raw or {}).get("guide") or "").strip()
                if not guide:
                    raise ModelError("模型没有返回评分细则")
                entry = save_guide(key, guide, model, "model")
                return self.send_json({**entry, "key": key, "reused": False, "elapsed": round(time.time() - started, 1), "usage": usage})
            if path == "/api/guide/save":
                key = str(body.get("key") or "")
                guide = str(body.get("guide") or "").strip()
                if not GUIDE_KEY_RE.match(key) or not guide:
                    raise ValueError("缺少细则内容或细则编号")
                return self.send_json({**save_guide(key, guide[:MAX_DOCUMENT], str(body.get("model") or ""), "edited"), "key": key})
            if path == "/api/analyze":
                # 全部样本评完后的收尾分析，按任务拆成三次独立调用（问题整合 / 全局复核 / 提示词策略），可并行，互不影响
                model = str(body.get("model") or "")
                task = str(body.get("task") or "")
                if not model or task not in ANALYSIS_TASKS:
                    raise ValueError("缺少 model 或 task 不正确")
                context = body.get("context") or {}
                prompt = str(body.get("prompt") or "").strip()
                if task == "strategy" and not prompt:
                    raise ValueError("生成提示词策略需要提示词原文")
                known = {str(i) for i in context.get("sampleIds") or []}
                part, schema, normalize = ANALYSIS_TASKS[task]
                instruction = ANALYSIS_HEAD + part + "只输出 JSON：\n" + json.dumps(schema, ensure_ascii=False) + "\n\n"
                content = instruction + ("===== 被评测的提示词 =====\n" + clip_text(prompt, MAX_DOCUMENT) + "\n\n" if task == "strategy" else "") \
                    + "===== 评测结果与问题（JSON）=====\n" + fit_json(context, MAX_DOCUMENT * 2)
                started = time.time()
                raw, _, _ = chat_json(load_config(), model, [{"role": "user", "content": content}], think=True)
                return self.send_json({task: normalize(raw, known), "elapsed": round(time.time() - started, 1)})
            if path == "/api/prompt-strategy":
                prompt = str(body.get("prompt") or "").strip()
                model = str(body.get("model") or "")
                if not prompt or not model:
                    raise ValueError("缺少提示词或 model")
                context = body.get("context") or {}
                known = {str(i) for i in context.get("sampleIds") or []}
                content = (PROMPT_STRATEGY_PROMPT + "===== 被评测的提示词 =====\n" + clip_text(prompt, MAX_DOCUMENT)
                           + "\n\n===== 评测概况与问题（JSON）=====\n" + fit_json(context, MAX_DOCUMENT))
                raw, _, _ = chat_json(load_config(), model, [{"role": "user", "content": content}])
                return self.send_json({"strategy": normalize_prompt_strategy(raw, known)})
            if path == "/api/summarize-issues":
                issues = [i for i in body.get("issues") or [] if isinstance(i, dict)][:400]
                if not issues:
                    return self.send_json({"groups": []})
                model = str(body.get("model") or "")
                if not model:
                    raise ValueError("缺少 model")
                known = {str(i.get("id")) for i in issues}
                messages = [{"role": "user", "content": ISSUE_GROUP_PROMPT + fit_json(issues, MAX_DOCUMENT)}]
                raw, _, _ = chat_json(load_config(), model, messages)
                return self.send_json({"groups": normalize_issue_groups(raw, known)})
            if path == "/api/runs/delete":
                target = run_path(str(body.get("id") or ""))
                if target.exists():
                    TRASH_DIR.mkdir(parents=True, exist_ok=True)
                    # 回收站里同名文件不覆盖：加上删除时间
                    target.replace(TRASH_DIR / ("%s.%s.json" % (target.stem, time.strftime("%Y%m%d-%H%M%S"))))
                    return self.send_json({"ok": True, "moved": True})
                # 不是本地保存的记录（例如内置导入的评测），记为隐藏
                return self.send_json({"ok": True, "hidden": hide("runs", str(body.get("id")))})
            if path == "/api/hide":
                return self.send_json({"ok": True, "hidden": hide(str(body.get("kind") or ""), str(body.get("id") or ""))})
            return self.send_json({"error": "未知接口"}, HTTPStatus.NOT_FOUND)
        except ModelError as error:
            self.log_message("模型调用失败：%s", error)
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
        except (ValueError, KeyError, TypeError) as error:
            return self.send_json({"error": "请求无效：%s" % error}, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # noqa: BLE001 —— 兜底，保证总有回应
            return self.fail_safely(error)

    def loopback_only(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self.send_json({"error": "只允许在本机修改网关配置"}, HTTPStatus.FORBIDDEN)
            return False
        return True

    def save_config(self, body):
        if not self.loopback_only():
            return
        config = read_store(CONFIG_PATH, {})
        base = str(body.get("api_base") or "").strip().rstrip("/")
        if base and not re.match(r"^https?://", base):
            raise ValueError("网关地址需要以 http:// 或 https:// 开头")
        if base:
            config["api_base"] = base
        if body.get("api_key"):
            config["api_key"] = str(body["api_key"]).strip()
        if body.get("models"):
            config["models"] = body["models"]
        if body.get("auth_header"):
            header = str(body["auth_header"]).strip()
            if not re.match(r"^[A-Za-z0-9-]{1,60}$", header):
                raise ValueError("鉴权头名称不合法")
            config["auth_header"] = header
        if "auth_prefix" in body:
            config["auth_prefix"] = str(body.get("auth_prefix") or "")
        config.setdefault("timeout", 300)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        write_store(CONFIG_PATH, config, private=True)
        with _models_lock:
            _models_cache.update(at=0, data=None)
        saved = load_config()
        return {"ok": True, "api_base": saved["api_base"], "has_key": bool(saved["api_key"]),
                "env_override": bool(os.environ.get("EVAL_API_BASE") or os.environ.get("EVAL_API_KEY"))}

    def test_config(self, body):
        if not self.loopback_only():
            return
        saved = load_config()
        config = dict(saved)
        config["api_base"] = (str(body.get("api_base") or saved["api_base"]).strip().rstrip("/"))
        if body.get("api_key"):
            config["api_key"] = str(body["api_key"]).strip()
        if body.get("auth_header"):
            config["auth_header"] = str(body["auth_header"]).strip()
        if "auth_prefix" in body:
            config["auth_prefix"] = str(body.get("auth_prefix") or "")
        if not config["api_base"]:
            return {"ok": False, "error": "还没有填写网关地址"}
        try:
            result = http_json("GET", config["api_base"] + "/models", config)
            ids = [m.get("id") for m in (result.get("data") or []) if m.get("id")]
            return {"ok": True, "models": ids[:30], "total": len(ids)}
        except ModelError as error:
            return {"ok": False, "error": str(error)}

    def evaluate(self, body):
        rubric = body.get("rubric")
        validate_rubric(rubric)
        model = str(body.get("model") or "")
        if not model:
            raise ValueError("缺少 model")
        sample = body.get("sample") or {}
        labels = [(item["key"], item["label"]) for item in body.get("inputs") or []]
        think = bool(body.get("think"))
        messages = build_messages(rubric, sample, labels, str(body.get("guide") or ""), checks=not think)
        started = time.time()
        judged, raw, usage = chat_json(load_config(), model, messages, think=think)
        validate_judged_result(rubric, judged)
        result = score_result(rubric, judged)
        result.update({"id": sample.get("id"), "model": model, "elapsed": round(time.time() - started, 1),
                       "usage": usage, "raw": raw, "judged": judged})
        return result


def watch_self(server):
    """server.py 被修改且能通过编译时，原地重启服务；页面文件改动只需刷新浏览器，不经过这里。"""
    source = Path(__file__).resolve()
    seen = source.stat().st_mtime
    while True:
        time.sleep(1)
        try:
            mtime = source.stat().st_mtime
        except OSError:
            continue
        if mtime == seen:
            continue
        seen = mtime
        try:
            py_compile.compile(str(source), doraise=True)
        except py_compile.PyCompileError as error:
            print("server.py 有语法错误，继续使用旧版本：%s" % error.msg)
            continue
        print("检测到 server.py 更新，正在重启…", flush=True)
        server.restart = True
        server.shutdown()
        return


def main():
    host = os.environ.get("EVAL_HOST", "127.0.0.1")
    port = int(os.environ.get("EVAL_PORT", "4174"))
    config = load_config()
    server = ThreadingHTTPServer((host, port), Handler)
    server.restart = False
    print("EvalLab 已启动：http://%s:%s/index.html" % (host, port), flush=True)
    print("模型网关：%s" % (config["api_base"] or "未配置（页面可浏览，评测无法调用模型）"), flush=True)
    threading.Thread(target=watch_self, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    if server.restart:
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve())] + sys.argv[1:])


if __name__ == "__main__":
    main()
