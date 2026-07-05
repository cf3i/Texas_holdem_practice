#!/usr/bin/env python3
"""Static server plus poker AI decision endpoint."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DECISION_SCHEMA_PATH = ROOT / "server" / "codex_decision_schema.json"
REVIEW_SCHEMA_PATH = ROOT / "server" / "codex_review_schema.json"
CODEX_BIN = os.getenv("CODEX_BIN") or shutil.which("codex") or "/Applications/Codex.app/Contents/Resources/codex"
AI_PROVIDER = os.getenv("POKER_AI_PROVIDER", "codex-cli")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.3-codex")
CODEX_MODEL = os.getenv("CODEX_MODEL", "")
AI_TIMEOUT_SECONDS = int(os.getenv("POKER_AI_TIMEOUT_SECONDS", "60"))
REVIEW_TIMEOUT_SECONDS = int(os.getenv("POKER_REVIEW_TIMEOUT_SECONDS", "180"))


SYSTEM_PROMPT = """你是德州扑克 AI 玩家，只负责为当前这一手牌选择一个合法动作。

规则：
- 只能根据输入 JSON 里的 visibleState、holeCards、legalActions 和 characterPrompt 决策。
- 只能输出 JSON，字段必须是 action、amount、confidence、reason。
- action 必须是 legalActions 里的一个 type。
- 如果 action 是 raise，amount 表示本街总下注要加注到多少，必须在 minTo 和 maxTo 之间。
- 如果 action 是 fold/check/call/allIn，amount 可以填对应 legal action 的 amount，不能编造额外动作。
- 不要解释德州扑克规则，不要输出 Markdown，不要调用工具，不要读写文件。
- 你可以诈唬，但要符合角色性格和当前筹码压力。
"""

REVIEW_PROMPT = """你是德州扑克初学者教练。你会拿到完整 hand history，包括所有玩家手牌、行动、底池、筹码和 AI 决策理由。

规则：
- 只输出 JSON，字段必须是 summary、keyDecisions、goodMoves、mistakes、nextHandFocus。
- 面向初学者，用中文，具体、短句、可执行。
- 必须引用具体街道、行动、下注额或底池信息，不要泛泛而谈。
- 可以指出玩家错误，也可以指出 AI 角色行为对玩家判断的影响。
- 不要编造输入 JSON 中没有的牌、下注或结果。
- 不要输出 Markdown。
"""


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/ai-status":
            self.write_json(
                {
                    "provider": AI_PROVIDER,
                    "codexAvailable": Path(CODEX_BIN).exists() or shutil.which(CODEX_BIN) is not None,
                    "codexModel": CODEX_MODEL or "codex default",
                    "openaiModel": OPENAI_MODEL,
                    "openaiKeyConfigured": bool(os.getenv("OPENAI_API_KEY")),
                }
            )
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/ai-decision":
            self.handle_ai_decision()
            return
        if self.path == "/api/hand-review":
            self.handle_hand_review()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_ai_decision(self) -> None:
        try:
            payload = self.read_json()
            decision = decide_with_provider(payload)
            self.write_json({"ok": True, "decision": decision, "provider": AI_PROVIDER})
        except Exception as exc:  # Keep the game running; frontend falls back.
            self.write_json({"ok": False, "error": str(exc), "provider": AI_PROVIDER}, HTTPStatus.OK)

    def handle_hand_review(self) -> None:
        try:
            payload = self.read_json()
            review = review_with_provider(payload)
            self.write_json({"ok": True, "review": review, "provider": AI_PROVIDER})
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc), "provider": AI_PROVIDER}, HTTPStatus.OK)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def write_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def decide_with_provider(payload: dict) -> dict:
    if AI_PROVIDER == "openai":
        return decide_with_openai(payload)
    if AI_PROVIDER == "codex-cli":
        return decide_with_codex_cli(payload)
    raise RuntimeError(f"Unsupported POKER_AI_PROVIDER: {AI_PROVIDER}")


def review_with_provider(payload: dict) -> dict:
    if AI_PROVIDER == "openai":
        return review_with_openai(payload)
    if AI_PROVIDER == "codex-cli":
        return review_with_codex_cli(payload)
    raise RuntimeError(f"Unsupported POKER_AI_PROVIDER: {AI_PROVIDER}")


def decide_with_codex_cli(payload: dict) -> dict:
    codex_path = CODEX_BIN if Path(CODEX_BIN).exists() else shutil.which(CODEX_BIN)
    if not codex_path:
        raise RuntimeError("Codex CLI not found. Set CODEX_BIN or POKER_AI_PROVIDER=openai.")

    prompt = build_prompt(payload)
    return coerce_decision(run_codex_json(prompt, DECISION_SCHEMA_PATH, AI_TIMEOUT_SECONDS), payload)


def review_with_codex_cli(payload: dict) -> dict:
    prompt = REVIEW_PROMPT + "\n\n完整 hand history JSON：\n" + json.dumps(payload, ensure_ascii=False, indent=2)
    return coerce_review(run_codex_json(prompt, REVIEW_SCHEMA_PATH, REVIEW_TIMEOUT_SECONDS))


def run_codex_json(prompt: str, schema_path: Path, timeout_seconds: int) -> dict:
    codex_path = CODEX_BIN if Path(CODEX_BIN).exists() else shutil.which(CODEX_BIN)
    if not codex_path:
        raise RuntimeError("Codex CLI not found. Set CODEX_BIN or POKER_AI_PROVIDER=openai.")

    cmd = [
        codex_path,
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-schema",
        str(schema_path),
        "-C",
        str(ROOT),
    ]
    if CODEX_MODEL:
        cmd.extend(["--model", CODEX_MODEL])

    with tempfile.NamedTemporaryFile("r", encoding="utf-8", delete=True) as output_file:
        cmd.extend(["--output-last-message", output_file.name, "-"])
        try:
            subprocess.run(
                cmd,
                input=prompt,
                text=True,
                cwd=str(ROOT),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or "").strip()
            raise RuntimeError(f"Codex CLI failed with exit {exc.returncode}: {detail[:800]}") from exc
        text = output_file.read().strip()

    return json.loads(extract_json(text))


def decide_with_openai(payload: dict) -> dict:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    schema = json.loads(DECISION_SCHEMA_PATH.read_text(encoding="utf-8"))
    body = {
        "model": OPENAI_MODEL,
        "input": [
            {
                "role": "system",
                "content": [{"type": "input_text", "text": SYSTEM_PROMPT}],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": json.dumps(payload, ensure_ascii=False)}],
            },
        ],
        "reasoning": {"effort": "low"},
        "text": {
            "verbosity": "low",
            "format": {
                "type": "json_schema",
                "name": "poker_ai_decision",
                "schema": schema,
                "strict": True,
            },
        },
        "max_output_tokens": 260,
    }

    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=AI_TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {exc.code}: {detail[:500]}") from exc

    text = result.get("output_text") or collect_response_text(result)
    return coerce_decision(json.loads(extract_json(text)), payload)


def review_with_openai(payload: dict) -> dict:
    schema = json.loads(REVIEW_SCHEMA_PATH.read_text(encoding="utf-8"))
    text = call_openai_json(REVIEW_PROMPT, payload, schema, "poker_hand_review", 850)
    return coerce_review(json.loads(extract_json(text)))


def call_openai_json(system_prompt: str, payload: dict, schema: dict, name: str, max_output_tokens: int) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    body = {
        "model": OPENAI_MODEL,
        "input": [
            {
                "role": "system",
                "content": [{"type": "input_text", "text": system_prompt}],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": json.dumps(payload, ensure_ascii=False)}],
            },
        ],
        "reasoning": {"effort": "low"},
        "text": {
            "verbosity": "low",
            "format": {
                "type": "json_schema",
                "name": name,
                "schema": schema,
                "strict": True,
            },
        },
        "max_output_tokens": max_output_tokens,
    }

    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=AI_TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {exc.code}: {detail[:500]}") from exc

    return result.get("output_text") or collect_response_text(result)


def build_prompt(payload: dict) -> str:
    return SYSTEM_PROMPT + "\n\n当前输入 JSON：\n" + json.dumps(payload, ensure_ascii=False, indent=2)


def collect_response_text(result: dict) -> str:
    parts = []
    for item in result.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and content.get("text"):
                parts.append(content["text"])
    return "\n".join(parts).strip()


def extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError(f"Model did not return JSON: {text[:200]}")
    return text[start : end + 1]


def coerce_decision(decision: dict, payload: dict) -> dict:
    legal_actions = payload.get("legalActions") or []
    by_type = {item.get("type"): item for item in legal_actions}
    action = decision.get("action")
    if action not in by_type:
        raise RuntimeError(f"Illegal model action: {action}")

    legal = by_type[action]
    amount = int(decision.get("amount") or legal.get("amount") or 0)
    if action == "raise":
        min_to = int(legal.get("minTo", 0))
        max_to = int(legal.get("maxTo", min_to))
        amount = max(min_to, min(max_to, amount))
    else:
        amount = int(legal.get("amount") or amount or 0)

    return {
        "action": action,
        "amount": amount,
        "confidence": float(decision.get("confidence", 0.5)),
        "reason": str(decision.get("reason", ""))[:220],
    }


def coerce_review(review: dict) -> dict:
    return {
        "summary": str(review.get("summary") or "Codex 已完成本手复盘。")[:280],
        "keyDecisions": coerce_string_list(review.get("keyDecisions"), 5, "本手关键点需要回看下注大小和位置。"),
        "goodMoves": coerce_string_list(review.get("goodMoves"), 4, "你完成了这一手的决策流程。"),
        "mistakes": coerce_string_list(review.get("mistakes"), 4, "继续重点关注翻前选牌和面对下注时的理由。"),
        "nextHandFocus": coerce_string_list(review.get("nextHandFocus"), 3, "下一手先判断起手牌强度、跟注价格和后续压力。"),
    }


def coerce_string_list(value, limit: int, fallback: str) -> list[str]:
    if not isinstance(value, list):
        return [fallback]
    cleaned = [str(item)[:260] for item in value if str(item).strip()]
    return (cleaned or [fallback])[:limit]


def main() -> None:
    os.chdir(ROOT)
    port = int(os.getenv("PORT", "5173"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving poker trainer on http://127.0.0.1:{port}/")
    print(f"AI provider: {AI_PROVIDER}")
    server.serve_forever()


if __name__ == "__main__":
    main()
