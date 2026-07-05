# Texas Holdem Practice

一个轻量级德州扑克练习器：打一手牌，立刻复盘，然后继续下一手。

## 当前版本

- 你 + 2 个 AI。
- 每个玩家初始筹码不同。
- AI 有公开描述和隐藏性格参数。
- 支持翻前、翻牌、转牌、河牌、摊牌。
- 支持弃牌、过牌、跟注、加注、All-in。
- 每手结束后生成本地复盘。
- 点击“继续下一手”后筹码延续。
- AI 行动会有明显思考停顿。
- 玩家行动区会显示当前牌力、跟注价格和动作解释。
- 牌局进行中，行动记录只显示动作，不显示 Codex 的隐藏手牌理由。
- 每手结束后会请求 Codex 生成赛后复盘。

## 运行

这个版本不需要 Node，也不需要安装依赖。要启用 Codex AI，请用项目内的 Python server 启动。

```bash
python3 server.py
```

然后打开：

```text
http://localhost:5173
```

## AI 决策

默认使用本机 Codex CLI：

```bash
POKER_AI_PROVIDER=codex-cli python3 server.py
```

每次轮到 AI 行动时，前端会把角色说明、AI 手牌、公共牌、底池、筹码和合法动作发给本地后端；后端调用 Codex，让它只返回一个 JSON 动作。

每手结束后，前端会把完整 hand history 发给 `/api/hand-review`，由 Codex 生成赛后复盘。复盘会看到完整信息；牌局进行中不会把 Codex 的手牌理由显示在行动记录里。

可选环境变量：

```bash
CODEX_MODEL=gpt-5.3-codex
POKER_AI_TIMEOUT_SECONDS=60
POKER_REVIEW_TIMEOUT_SECONDS=180
```

也可以改用 OpenAI API：

```bash
OPENAI_API_KEY=你的_key POKER_AI_PROVIDER=openai OPENAI_MODEL=gpt-5.3-codex python3 server.py
```

如果 Codex/API 调用失败，游戏会自动回退到本地规则 AI，不会卡死。

注意：`codex-cli` 是真的每次 AI 行动都启动一次 Codex 非交互式决策，单次可能需要几十秒。想更流畅可以改用 `POKER_AI_PROVIDER=openai`。

## 测试

浏览器打开：

```text
http://localhost:5173/tests.html
```

当前测试覆盖：

- 52 张牌堆唯一性。
- 皇家同花顺、A2345 顺子、两组三条葫芦、四条 kicker。
- 同花取最高五张、对子/两对 kicker 比较。
- 三人 All-in 边池、弃牌玩家贡献、奇数筹码平分。
- 分池结算金额守恒。

## 后续方向

- 接入 API 生成更自然的教练式复盘。
- 增强本地复盘规则。
- 增加更多 AI 角色，但仍保持“打一手 -> 复盘 -> 继续”的主循环。
