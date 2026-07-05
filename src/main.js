(() => {
  "use strict";

  const {
    SUIT_SYMBOL,
    RED_SUITS,
    STREET_LABEL,
    CATEGORY_LABEL,
    createShuffledDeck,
    cardText,
    evaluateBest,
    hasFlushDraw,
    hasStraightDraw,
    estimatePreflop,
    distributeShowdownPots,
    clamp,
    randomInt,
  } = window.PokerCore;

  const PLAYER_BLUEPRINTS = [
    {
      id: "hero",
      name: "你",
      isHuman: true,
      chips: 800,
      publicDesc: "用这一手练判断，复盘后继续下一手。",
      codexPrompt: "人类玩家，不由模型控制。",
      profile: { aggression: 0.5, bluffRate: 0.1, callLooseFactor: 0.35, trapFrequency: 0.1 },
    },
    {
      id: "dave",
      name: "戴夫",
      chips: 1600,
      publicDesc: "下注很快，看起来有点急躁。",
      codexPrompt: "戴夫是急躁、喜欢施压的牌手。倾向主动加注和偷底池，能用半诈唬持续开火，但不要每次都乱冲；短码或遇到明显强阻力时会收敛。",
      profile: {
        aggression: 0.86,
        bluffRate: 0.32,
        callLooseFactor: 0.62,
        trapFrequency: 0.08,
        tiltSensitivity: 0.7,
      },
    },
    {
      id: "steve",
      name: "史蒂夫",
      chips: 450,
      publicDesc: "很少主动开火，似乎比较谨慎。",
      codexPrompt: "史蒂夫是小心谨慎、偏紧的牌手。倾向用好牌入池，弱牌面对压力会弃牌；偶尔用强牌慢打，不喜欢无意义大诈唬。",
      profile: {
        aggression: 0.28,
        bluffRate: 0.06,
        callLooseFactor: 0.24,
        trapFrequency: 0.3,
        tiltSensitivity: 0.18,
      },
    },
  ];

  const app = document.getElementById("app");
  let state = null;

  function createPlayers() {
    return PLAYER_BLUEPRINTS.map((blueprint) => ({
      ...blueprint,
      profile: { ...blueprint.profile },
      hole: [],
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      lastAction: "",
      rebuyCount: 0,
    }));
  }

  function newSession() {
    state = {
      players: createPlayers(),
      dealerIndex: -1,
      buttonIndex: -1,
      smallBlindIndex: -1,
      bigBlindIndex: -1,
      handNumber: 0,
      smallBlind: 5,
      bigBlind: 10,
      deck: [],
      board: [],
      pot: 0,
      street: "preflop",
      currentBet: 0,
      minRaise: 10,
      currentPlayerIndex: -1,
      phase: "playing",
      handHistory: null,
      lastReview: null,
      codexReview: {
        status: "idle",
        data: null,
        error: "",
        provider: "",
      },
      message: "",
      thinkingPlayerId: null,
      thinkingSource: "",
      aiStatus: {
        provider: "codex-cli",
        label: "Codex",
        available: false,
        detail: "检查中",
      },
      lastModelError: "",
      aiTimer: null,
    };
    startHand();
    loadAiStatus();
  }

  function startHand() {
    clearPendingTimer();
    handleRebuys();
    state.handNumber += 1;
    state.deck = createShuffledDeck();
    state.board = [];
    state.pot = 0;
    state.street = "preflop";
    state.currentBet = 0;
    state.minRaise = state.bigBlind;
    state.phase = "playing";
    state.lastReview = null;
    state.codexReview = {
      status: "idle",
      data: null,
      error: "",
      provider: "",
    };
    state.message = "新一手开始。";
    state.thinkingPlayerId = null;

    for (const player of state.players) {
      player.hole = [];
      player.bet = 0;
      player.committed = 0;
      player.folded = false;
      player.allIn = false;
      player.hasActed = false;
      player.lastAction = "";
    }

    state.dealerIndex = nextSeatedIndex(state.dealerIndex);
    assignPositions();

    state.handHistory = {
      handNumber: state.handNumber,
      startStacks: state.players.map((player) => ({ id: player.id, name: player.name, chips: player.chips })),
      positions: {
        button: state.players[state.buttonIndex].id,
        smallBlind: state.players[state.smallBlindIndex].id,
        bigBlind: state.players[state.bigBlindIndex].id,
      },
      blinds: { small: state.smallBlind, big: state.bigBlind },
      holeCards: {},
      actions: [],
      boardByStreet: {},
      showdown: null,
      result: null,
      endStacks: [],
    };

    dealHoleCards();
    for (const player of state.players) {
      state.handHistory.holeCards[player.id] = player.hole.map(cardText);
    }

    postBlind(state.smallBlindIndex, state.smallBlind, "smallBlind");
    postBlind(state.bigBlindIndex, state.bigBlind, "bigBlind");

    state.currentBet = Math.max(...state.players.map((player) => player.bet));
    state.currentPlayerIndex = nextSeatedIndex(state.bigBlindIndex);
    render();
    processTurn();
  }

  function handleRebuys() {
    for (const player of state.players) {
      if (player.chips > 0) continue;
      player.rebuyCount += 1;
      if (player.isHuman) {
        player.chips = 800;
        state.message = "你的筹码归零，系统为你补到 80BB，继续练习。";
      } else {
        const base = player.id === "dave" ? 1400 : 550;
        player.chips = base + randomInt(-120, 180);
      }
    }
  }

  function assignPositions() {
    const seated = state.players.map((_, index) => index).filter((index) => state.players[index].chips > 0);
    state.buttonIndex = state.dealerIndex;
    if (seated.length === 2) {
      state.smallBlindIndex = state.buttonIndex;
      state.bigBlindIndex = nextSeatedIndex(state.smallBlindIndex);
      return;
    }
    state.smallBlindIndex = nextSeatedIndex(state.buttonIndex);
    state.bigBlindIndex = nextSeatedIndex(state.smallBlindIndex);
  }

  function dealHoleCards() {
    let dealIndex = nextSeatedIndex(state.buttonIndex);
    for (let round = 0; round < 2; round += 1) {
      for (let count = 0; count < state.players.length; count += 1) {
        const player = state.players[dealIndex];
        if (player.chips > 0) player.hole.push(drawCard());
        dealIndex = nextSeatedIndex(dealIndex);
      }
    }
  }

  function postBlind(playerIndex, amount, action) {
    const player = state.players[playerIndex];
    const paid = commitChips(player, amount);
    player.lastAction = action === "smallBlind" ? `小盲 ${paid}` : `大盲 ${paid}`;
    recordAction(playerIndex, action, paid, { forced: true, toCallBefore: 0, currentBetBefore: state.currentBet });
  }

  function processTurn() {
    if (state.phase !== "playing") return;
    if (onlyOnePlayerLeft()) {
      finishByFold();
      return;
    }
    if (isBettingRoundComplete()) {
      advanceStreet();
      return;
    }

    const player = state.players[state.currentPlayerIndex];
    if (!player || !needsAction(player)) {
      state.currentPlayerIndex = findNextActionIndex(state.currentPlayerIndex);
      render();
      processTurn();
      return;
    }

    if (player.isHuman) {
      state.thinkingPlayerId = null;
      render();
      return;
    }

    state.thinkingPlayerId = player.id;
    state.thinkingSource = state.aiStatus.label;
    state.message = `${player.name} 正在用 ${state.aiStatus.label} 思考。`;
    render();
    state.aiTimer = window.setTimeout(async () => {
      state.thinkingPlayerId = null;
      const playerIndex = state.currentPlayerIndex;
      if (state.players[playerIndex]?.id !== player.id || state.phase !== "playing") return;
      const decision = await decideAiAction(player);
      applyAction(playerIndex, decision.type, decision.amount, decision);
    }, aiThinkDelay(player));
  }

  function clearPendingTimer() {
    if (state?.aiTimer) {
      window.clearTimeout(state.aiTimer);
      state.aiTimer = null;
    }
  }

  function aiThinkDelay(player) {
    if (state.aiStatus.provider === "codex-cli") {
      return 900 + Math.round((1 - player.profile.aggression) * 450) + randomInt(0, 350);
    }
    return 1700 + Math.round((1 - player.profile.aggression) * 850) + randomInt(0, 650);
  }

  async function loadAiStatus() {
    try {
      const response = await fetch("/api/ai-status", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const provider = data.provider || "heuristic";
      state.aiStatus = {
        provider,
        label: provider === "codex-cli" ? "Codex" : provider === "openai" ? `OpenAI ${data.openaiModel}` : "规则 AI",
        available: provider === "codex-cli" ? Boolean(data.codexAvailable) : Boolean(data.openaiKeyConfigured),
        detail: provider === "codex-cli" ? `Codex CLI · ${data.codexModel}` : `Responses API · ${data.openaiModel}`,
      };
    } catch (error) {
      state.aiStatus = {
        provider: "heuristic",
        label: "规则 AI",
        available: false,
        detail: "本地 AI 接口不可用",
      };
    }
    render();
  }

  async function decideAiAction(player) {
    const fallback = { ...decideBotAction(player), source: "规则 AI", reason: "模型不可用时的本地回退决策。", confidence: 0.35 };
    const context = buildAiDecisionContext(player);

    try {
      const response = await fetch("/api/ai-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "AI decision failed");
      const normalized = normalizeAiDecision(data.decision, player, fallback);
      state.lastModelError = "";
      return {
        ...normalized,
        source: data.provider === "codex-cli" ? "Codex" : "OpenAI",
      };
    } catch (error) {
      state.lastModelError = error.message || String(error);
      return fallback;
    }
  }

  function buildAiDecisionContext(player) {
    const toCall = Math.max(0, state.currentBet - player.bet);
    return {
      task: "Choose exactly one legal Texas Hold'em action for this AI player.",
      player: {
        id: player.id,
        name: player.name,
        publicDescription: player.publicDesc,
        characterPrompt: player.codexPrompt,
        chips: player.chips,
        currentStreetBet: player.bet,
        committedThisHand: player.committed,
        toCall,
      },
      visibleState: {
        handNumber: state.handNumber,
        street: STREET_LABEL[state.street] ?? state.street,
        smallBlind: state.smallBlind,
        bigBlind: state.bigBlind,
        pot: state.pot,
        currentBet: state.currentBet,
        minRaise: state.minRaise,
        board: state.board.map(displayCardText),
        buttonPlayerId: state.players[state.buttonIndex]?.id,
        activePlayerId: player.id,
      },
      holeCards: player.hole.map(displayCardText),
      opponents: state.players.filter((other) => other.id !== player.id).map((other) => ({
        id: other.id,
        name: other.name,
        chips: other.chips,
        currentStreetBet: other.bet,
        committedThisHand: other.committed,
        folded: other.folded,
        allIn: other.allIn,
        publicDescription: other.publicDesc,
        isHuman: other.isHuman,
      })),
      recentActions: state.handHistory.actions.slice(-12).map((action) => ({
        street: STREET_LABEL[action.street] ?? action.street,
        playerName: action.playerName,
        action: actionLabel(action),
        potAfter: action.potAfter,
      })),
      legalActions: legalActionsFor(player),
      outputContract: {
        action: "one of legalActions.type",
        amount: "for raise, target total bet; otherwise legal action amount",
        reason: "short Chinese reason visible after the hand",
      },
    };
  }

  function legalActionsFor(player) {
    const toCall = Math.max(0, state.currentBet - player.bet);
    const maxTarget = player.bet + player.chips;
    const actions = [];
    if (toCall > 0) {
      actions.push({ type: "fold", label: "弃牌", amount: 0 });
      actions.push({ type: "call", label: `跟注 ${Math.min(toCall, player.chips)}`, amount: Math.min(toCall, player.chips) });
    } else {
      actions.push({ type: "check", label: "过牌", amount: 0 });
    }

    const minTo = legalMinRaiseTo(player);
    if (maxTarget > state.currentBet && maxTarget >= minTo) {
      actions.push({
        type: "raise",
        label: `加注到 ${minTo}-${maxTarget}`,
        minTo,
        maxTo: maxTarget,
        amount: minTo,
      });
    }
    if (player.chips > 0) {
      actions.push({ type: "allIn", label: `All-in 到 ${maxTarget}`, amount: maxTarget });
    }
    return actions;
  }

  function normalizeAiDecision(decision, player, fallback) {
    const legal = legalActionsFor(player);
    const byType = Object.fromEntries(legal.map((item) => [item.type, item]));
    let type = decision?.action || decision?.type;
    if (type === "bet") type = "raise";
    if (type === "all-in" || type === "allin") type = "allIn";
    if (!byType[type]) return fallback;

    let amount = Number(decision.amount ?? byType[type].amount ?? 0);
    if (type === "raise") {
      const minTo = byType.raise.minTo;
      const maxTo = byType.raise.maxTo;
      amount = Math.round(amount / state.smallBlind) * state.smallBlind;
      amount = Math.max(minTo, Math.min(maxTo, amount));
    } else {
      amount = byType[type].amount ?? 0;
    }

    return {
      type,
      amount,
      reason: String(decision.reason || "Codex 根据当前牌局选择了这个动作。").slice(0, 220),
      confidence: Number(decision.confidence ?? 0.5),
    };
  }

  function applyAction(playerIndex, type, requestedAmount = 0, decisionMeta = null) {
    if (state.phase !== "playing") return;
    const player = state.players[playerIndex];
    const toCallBefore = Math.max(0, state.currentBet - player.bet);
    const currentBetBefore = state.currentBet;
    const potBefore = state.pot;

    if (type === "fold") {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = "弃牌";
      state.message = `${player.name} 弃牌。`;
      recordAction(playerIndex, "fold", 0, { toCallBefore, currentBetBefore, potBefore, ...actionMeta(decisionMeta) });
    } else if (type === "check") {
      if (toCallBefore > 0) return;
      player.hasActed = true;
      player.lastAction = "过牌";
      state.message = `${player.name} 过牌。`;
      recordAction(playerIndex, "check", 0, { toCallBefore, currentBetBefore, potBefore, ...actionMeta(decisionMeta) });
    } else if (type === "call") {
      const paid = commitChips(player, toCallBefore);
      player.hasActed = true;
      player.lastAction = player.allIn ? `跟注 All-in ${paid}` : `跟注 ${paid}`;
      state.message = player.allIn ? `${player.name} 跟注并 All-in。` : `${player.name} 跟注 ${paid}。`;
      recordAction(playerIndex, player.allIn ? "callAllIn" : "call", paid, {
        toCallBefore,
        currentBetBefore,
        potBefore,
        ...actionMeta(decisionMeta),
      });
    } else if (type === "raise" || type === "allIn") {
      const maxTarget = player.bet + player.chips;
      let target = type === "allIn" ? maxTarget : Number(requestedAmount);
      if (!Number.isFinite(target)) return;
      target = Math.max(0, Math.floor(target));
      target = Math.min(target, maxTarget);

      if (target <= state.currentBet && type !== "allIn") {
        applyAction(playerIndex, "call");
        return;
      }

      if (target > state.currentBet && target < legalMinRaiseTo(player) && target < maxTarget) {
        target = legalMinRaiseTo(player);
      }

      const paid = commitChips(player, target - player.bet);
      player.hasActed = true;

      if (target > state.currentBet) {
        const raiseSize = target - state.currentBet;
        if (raiseSize >= state.minRaise) state.minRaise = raiseSize;
        state.currentBet = target;
        for (const other of state.players) {
          if (!other.folded && !other.allIn) other.hasActed = false;
        }
        player.hasActed = true;
      }

      const isAggressiveAllIn = target > currentBetBefore;
      const actionName = player.allIn && !isAggressiveAllIn ? "callAllIn" : player.allIn ? "raiseAllIn" : "raise";
      player.lastAction = player.allIn && !isAggressiveAllIn ? `跟注 All-in ${paid}` : player.allIn ? `All-in 到 ${player.bet}` : `加注到 ${player.bet}`;
      state.message = player.allIn && !isAggressiveAllIn ? `${player.name} 跟注并 All-in。` : player.allIn ? `${player.name} All-in 到 ${player.bet}。` : `${player.name} 加注到 ${player.bet}。`;
      recordAction(playerIndex, actionName, paid, { toCallBefore, currentBetBefore, potBefore, targetBet: player.bet, ...actionMeta(decisionMeta) });
    }

    if (onlyOnePlayerLeft()) {
      finishByFold();
      return;
    }
    if (isBettingRoundComplete()) {
      advanceStreet();
      return;
    }
    state.currentPlayerIndex = findNextActionIndex(playerIndex);
    render();
    processTurn();
  }

  function actionMeta(decisionMeta) {
    if (!decisionMeta) return {};
    return {
      decisionSource: decisionMeta.source || "",
      decisionReason: decisionMeta.reason || "",
      decisionConfidence: decisionMeta.confidence ?? null,
    };
  }

  function commitChips(player, requested) {
    const paid = Math.max(0, Math.min(player.chips, Math.floor(requested)));
    player.chips -= paid;
    player.bet += paid;
    player.committed += paid;
    state.pot += paid;
    if (player.chips === 0) player.allIn = true;
    return paid;
  }

  function advanceStreet() {
    if (state.street === "river") {
      finishByShowdown();
      return;
    }

    if (activePlayers().filter((player) => !player.allIn).length <= 1) {
      while (state.board.length < 5) {
        dealNextBoardStreet();
      }
      finishByShowdown();
      return;
    }

    dealNextBoardStreet();
    resetBettingForNewStreet();
    state.currentPlayerIndex = findFirstPostflopActionIndex();

    if (state.currentPlayerIndex === -1) {
      advanceStreet();
      return;
    }

    render();
    processTurn();
  }

  function dealNextBoardStreet() {
    if (state.board.length === 0) {
      state.street = "flop";
      state.board.push(drawCard(), drawCard(), drawCard());
    } else if (state.board.length === 3) {
      state.street = "turn";
      state.board.push(drawCard());
    } else if (state.board.length === 4) {
      state.street = "river";
      state.board.push(drawCard());
    }
    state.handHistory.boardByStreet[state.street] = state.board.map(cardText);
    state.message = `${STREET_LABEL[state.street]}发出。`;
  }

  function resetBettingForNewStreet() {
    for (const player of state.players) {
      player.bet = 0;
      player.hasActed = false;
      if (!player.folded) player.lastAction = "";
    }
    state.currentBet = 0;
    state.minRaise = state.bigBlind;
  }

  function finishByFold() {
    const winner = activePlayers()[0];
    const amount = state.pot;
    winner.chips += amount;
    state.handHistory.result = {
      type: "fold",
      winners: [{ id: winner.id, name: winner.name, amount }],
      board: state.board.map(cardText),
      pot: amount,
    };
    state.pot = 0;
    finishHand(`${winner.name} 拿下无人争抢的底池 ${amount}。`);
  }

  function finishByShowdown() {
    state.street = "showdown";
    const { awards, sidePots, evaluations } = distributeShowdownPots(state.players, state.board);
    for (const award of awards) {
      const winner = state.players.find((player) => player.id === award.id);
      winner.chips += award.amount;
    }

    state.handHistory.showdown = {
      board: state.board.map(cardText),
      evaluations,
      sidePots: sidePots.map((pot) => ({ amount: pot.amount, eligibleIds: [...pot.eligibleIds] })),
    };
    state.handHistory.result = {
      type: "showdown",
      winners: awards,
      board: state.board.map(cardText),
      pot: awards.reduce((sum, item) => sum + item.amount, 0),
    };
    state.pot = 0;

    const winnerText = awards.map((award) => `${award.name} ${award.label} 赢 ${award.amount}`).join("；");
    finishHand(winnerText);
  }

  function finishHand(message) {
    state.phase = "review";
    state.currentPlayerIndex = -1;
    state.thinkingPlayerId = null;
    state.message = message;
    state.handHistory.endStacks = state.players.map((player) => ({ id: player.id, name: player.name, chips: player.chips }));
    state.lastReview = analyzeHand(state.handHistory);
    state.codexReview = {
      status: "loading",
      data: null,
      error: "",
      provider: state.aiStatus.label,
    };
    render();
    requestCodexReview(state.handHistory.handNumber, buildHandReviewContext(state.handHistory));
  }

  async function requestCodexReview(handNumber, reviewContext) {
    try {
      const response = await fetch("/api/hand-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewContext),
      });
      const data = await response.json();
      if (state.handHistory?.handNumber !== handNumber || state.phase !== "review") return;
      if (!data.ok) throw new Error(data.error || "Codex review failed");
      state.codexReview = {
        status: "ready",
        data: data.review,
        error: "",
        provider: data.provider === "codex-cli" ? "Codex" : "OpenAI",
      };
    } catch (error) {
      if (state.handHistory?.handNumber !== handNumber || state.phase !== "review") return;
      state.codexReview = {
        status: "error",
        data: null,
        error: error.message || String(error),
        provider: state.aiStatus.label,
      };
    }
    render();
  }

  function buildHandReviewContext(history) {
    return {
      task: "Review one completed Texas Hold'em hand for a beginner.",
      handNumber: history.handNumber,
      blinds: history.blinds,
      positions: history.positions,
      players: state.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHuman: player.isHuman,
        publicDescription: player.publicDesc,
        characterPrompt: player.codexPrompt,
        startChips: history.startStacks.find((item) => item.id === player.id)?.chips,
        endChips: history.endStacks.find((item) => item.id === player.id)?.chips,
        holeCards: player.hole.map(displayCardText),
      })),
      board: state.board.map(displayCardText),
      boardByStreet: Object.fromEntries(Object.entries(history.boardByStreet).map(([street, cards]) => [STREET_LABEL[street] ?? street, cards.map(displayRawCardText)])),
      actions: history.actions.map((action) => ({
        street: STREET_LABEL[action.street] ?? action.street,
        playerId: action.playerId,
        playerName: action.playerName,
        action: actionLabel(action),
        amount: action.amount,
        toCallBefore: action.toCallBefore ?? 0,
        potBefore: action.potBefore ?? null,
        potAfter: action.potAfter,
        betAfter: action.betAfter,
        chipsAfter: action.chipsAfter,
        decisionSource: action.decisionSource || "",
        decisionReason: action.decisionReason || "",
      })),
      showdown: history.showdown,
      result: history.result,
      heroId: "hero",
    };
  }

  function decideBotAction(player) {
    const toCall = Math.max(0, state.currentBet - player.bet);
    const strength = estimateStrength(player);
    const profile = player.profile;
    const stackPressure = toCall / Math.max(1, player.chips + player.bet);
    const potOdds = toCall > 0 ? toCall / Math.max(1, state.pot + toCall) : 0;
    const noise = (Math.random() - 0.5) * 0.13;
    const pressureBonus = profile.aggression * 0.12 - stackPressure * 0.16;
    const willingness = strength + profile.callLooseFactor * 0.16 + pressureBonus + noise;
    const canRaise = player.chips > toCall && player.bet + player.chips > state.currentBet;
    const wantsBluff = Math.random() < profile.bluffRate * (toCall === 0 ? 1 : 0.45);
    const wantsValue = strength > 0.66 || (strength > 0.5 && profile.aggression > 0.7);

    if (toCall === 0) {
      if (canRaise && (wantsValue || wantsBluff || Math.random() < profile.aggression * 0.28)) {
        return { type: "raise", amount: chooseBotRaiseTo(player, strength, wantsBluff) };
      }
      return { type: "check" };
    }

    const callThreshold = Math.min(0.72, potOdds + 0.16 + stackPressure * 0.28);
    const pressureRaise = strength > 0.48 && profile.aggression > 0.7 && Math.random() < profile.aggression * 0.42;
    if (canRaise && (strength > 0.68 || pressureRaise || (wantsBluff && profile.aggression > 0.65 && toCall <= state.pot * 0.55))) {
      return { type: "raise", amount: chooseBotRaiseTo(player, strength, wantsBluff) };
    }
    if (willingness >= callThreshold || toCall >= player.chips) {
      return { type: "call" };
    }
    return { type: "fold" };
  }

  function chooseBotRaiseTo(player, strength, isBluff) {
    const maxTarget = player.bet + player.chips;
    const minimum = legalMinRaiseTo(player);
    const potFactor = isBluff ? 0.48 + Math.random() * 0.26 : 0.55 + strength * 0.55;
    const desiredRaise = roundToBlind(Math.max(state.bigBlind, state.pot * potFactor));
    let target = Math.max(minimum, state.currentBet + desiredRaise);
    if (player.chips < state.bigBlind * 8 && strength > 0.55) target = maxTarget;
    return Math.min(maxTarget, target);
  }

  function estimateStrength(player) {
    if (state.board.length === 0) return estimatePreflop(player.hole);
    const score = evaluateBest([...player.hole, ...state.board]);
    const baseByCategory = [0.18, 0.36, 0.56, 0.68, 0.78, 0.84, 0.9, 0.96, 0.99];
    let strength = baseByCategory[score.category] + score.ranks[0] / 140;
    if (score.category <= 1) {
      if (hasFlushDraw([...player.hole, ...state.board])) strength += 0.08;
      if (hasStraightDraw([...player.hole, ...state.board])) strength += 0.06;
    }
    return clamp(strength, 0.05, 0.99);
  }

  function analyzeHand(history) {
    const hero = state.players.find((player) => player.isHuman);
    const heroStart = history.startStacks.find((item) => item.id === hero.id)?.chips ?? 0;
    const heroEnd = history.endStacks.find((item) => item.id === hero.id)?.chips ?? hero.chips;
    const heroActions = history.actions.filter((action) => action.playerId === "hero" && !action.forced);
    const resultLine = buildResultLine(history);
    const notes = [];
    const positives = [];
    const nextSteps = [];

    for (const action of heroActions) {
      const street = STREET_LABEL[action.street] ?? action.street;
      const potBefore = action.potBefore ?? Math.max(0, action.potAfter - action.amount);
      const largeBet = action.toCallBefore > Math.max(state.bigBlind * 2, potBefore * 0.58);
      const preflopScore = estimatePreflop(hero.hole);

      if (action.street === "preflop" && ["call", "callAllIn"].includes(action.action) && preflopScore < 0.38) {
        notes.push(`${street}你用偏弱起手牌跟注。作为初学者，弱牌被动入池最容易在后面街道被迫猜。`);
      }

      if (action.street === "preflop" && heroStart <= state.bigBlind * 30 && ["call", "callAllIn"].includes(action.action)) {
        notes.push(`你开局只有 ${Math.round(heroStart / state.bigBlind)}BB，短码时更偏向“推或弃”，单纯跟注会让后续决策很难。`);
      }

      if (["call", "callAllIn"].includes(action.action) && largeBet) {
        notes.push(`${street}你面对较大下注选择跟注。这里要先问自己：我是在用成牌赢，还是只是在希望对手诈唬？`);
      }

      if (["raise", "raiseAllIn"].includes(action.action)) {
        const ratio = action.amount / Math.max(1, potBefore);
        if (ratio > 0.75) {
          positives.push(`${street}你选择主动加注，至少没有只被动跟着对手走。复盘时重点看这次加注是价值下注还是诈唬。`);
        }
      }

      if (action.action === "fold" && action.toCallBefore <= Math.max(state.bigBlind, potBefore * 0.25)) {
        notes.push(`${street}你面对小额下注弃牌。小注不代表一定要跟，但要注意别被激进玩家用低成本持续赶走。`);
      }

      if (action.action === "check" && action.street !== "preflop") {
        positives.push(`${street}你没有在信息不足时强行扩大底池，这对初学阶段是可以接受的保守选择。`);
      }
    }

    const heroShowdown = history.showdown?.evaluations.find((item) => item.id === "hero");
    if (heroShowdown && heroShowdown.category >= 2 && heroActions.some((action) => action.action === "check" && action.street === "river")) {
      notes.push(`河牌你有 ${heroShowdown.label} 但选择过牌。强牌在河牌经常需要价值下注，否则赢到的底池会偏小。`);
    }

    if (history.result?.winners.some((winner) => winner.id === "hero")) {
      positives.push("这手你赢下底池。继续关注过程是否合理，不要只用结果判断打法。");
    } else {
      nextSteps.push("这手没有赢也没关系，先把注意力放在“入池是否合理”和“面对大注是否有清晰理由”。");
    }

    if (notes.length === 0) {
      notes.push("这手没有明显的大错误。下一手继续关注翻前选牌和面对下注时的理由。");
    }
    if (positives.length === 0) {
      positives.push("你完成了这一手的所有决策。现在先从每次跟注前说出一个理由开始训练。");
    }
    nextSteps.push("下一手开始前，先记住两个问题：我的牌够不够主动下注？如果只是跟注，我能承受后续更大的下注吗？");

    return {
      resultLine,
      heroDelta: heroEnd - heroStart,
      notes: unique(notes).slice(0, 4),
      positives: unique(positives).slice(0, 3),
      nextSteps: unique(nextSteps).slice(0, 3),
    };
  }

  function buildResultLine(history) {
    if (!history.result) return "本手还没有结果。";
    if (history.result.type === "fold") {
      const winner = history.result.winners[0];
      return `${winner.name} 赢下底池 ${winner.amount}，没有进入摊牌。`;
    }
    return history.result.winners.map((winner) => `${winner.name} 用 ${winner.label} 赢 ${winner.amount}`).join("；");
  }

  function recordAction(playerIndex, action, amount, extra = {}) {
    const player = state.players[playerIndex];
    state.handHistory.actions.push({
      street: state.street,
      playerId: player.id,
      playerName: player.name,
      action,
      amount,
      betAfter: player.bet,
      potAfter: state.pot,
      chipsAfter: player.chips,
      board: state.board.map(cardText),
      ...extra,
    });
  }

  function drawCard() {
    return state.deck.pop();
  }

  function nextSeatedIndex(fromIndex) {
    for (let offset = 1; offset <= state.players.length; offset += 1) {
      const index = (fromIndex + offset + state.players.length) % state.players.length;
      if (state.players[index].chips > 0) return index;
    }
    return 0;
  }

  function findNextActionIndex(fromIndex) {
    for (let offset = 1; offset <= state.players.length; offset += 1) {
      const index = (fromIndex + offset + state.players.length) % state.players.length;
      if (needsAction(state.players[index])) return index;
    }
    return -1;
  }

  function findFirstPostflopActionIndex() {
    let index = state.buttonIndex;
    for (let offset = 1; offset <= state.players.length; offset += 1) {
      index = (index + 1) % state.players.length;
      if (needsAction(state.players[index])) return index;
    }
    return -1;
  }

  function needsAction(player) {
    return !player.folded && !player.allIn && player.chips > 0 && (!player.hasActed || player.bet < state.currentBet);
  }

  function isBettingRoundComplete() {
    const playersWhoCanAct = state.players.filter((player) => !player.folded && !player.allIn && player.chips > 0);
    if (playersWhoCanAct.length === 0) return true;
    return playersWhoCanAct.every((player) => player.hasActed && player.bet === state.currentBet);
  }

  function activePlayers() {
    return state.players.filter((player) => !player.folded);
  }

  function onlyOnePlayerLeft() {
    return activePlayers().length === 1;
  }

  function legalMinRaiseTo(player) {
    const maxTarget = player.bet + player.chips;
    if (state.currentBet === 0) return Math.min(maxTarget, state.bigBlind);
    return Math.min(maxTarget, state.currentBet + state.minRaise);
  }

  function roundToBlind(value) {
    return Math.max(state.bigBlind, Math.round(value / state.smallBlind) * state.smallBlind);
  }

  function render() {
    const hero = state.players.find((player) => player.isHuman);
    app.innerHTML = `
      <section class="table-area">
        <div class="topbar">
          <div class="title">
            <h1>德州扑克单手训练</h1>
            <span>第 ${state.handNumber} 手 · 小盲 ${state.smallBlind} / 大盲 ${state.bigBlind}</span>
          </div>
          <div class="status-line">${escapeHtml(state.message)}</div>
        </div>
        <div class="table-shell">
          <div class="felt-mark"></div>
          ${renderSeat(state.players[1], 1)}
          ${renderSeat(state.players[2], 2)}
          ${renderBoard()}
          ${renderSeat(hero, 0)}
        </div>
        ${renderControls(hero)}
      </section>
      <aside class="side-panel">
        ${state.phase === "review" ? renderReview() : renderLivePanel()}
      </aside>
    `;
    bindEvents();
  }

  function renderSeat(player, seatNumber) {
    const index = state.players.indexOf(player);
    const isButton = index === state.buttonIndex;
    const blind = index === state.smallBlindIndex ? "SB" : index === state.bigBlindIndex ? "BB" : "";
    const active = state.currentPlayerIndex === index && state.phase === "playing";
    const thinking = state.thinkingPlayerId === player.id;
    const classes = [
      "seat",
      player.isHuman ? "hero" : `seat-${seatNumber}`,
      active ? "active" : "",
      thinking ? "thinking" : "",
      player.folded ? "folded" : "",
      player.allIn ? "all-in" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `
      <article class="${classes}">
        <div class="seat-head">
          <div>
            <div class="name-row">
              <h2 class="player-name">${escapeHtml(player.name)}</h2>
              ${isButton ? '<span class="badge button">D</span>' : ""}
              ${blind ? `<span class="badge">${blind}</span>` : ""}
            </div>
            <p class="desc">${escapeHtml(player.publicDesc)}</p>
          </div>
          <div class="stack-box">
            <div class="chip">${player.chips}</div>
            <div class="seat-state">${escapeHtml(seatStateText(player, active, thinking))}</div>
          </div>
        </div>
        <div class="cards">${renderHoleCards(player)}</div>
        <div class="seat-foot">
          <span>本街下注 ${player.bet}</span>
          <span class="last-action">${thinking ? '<span class="thinking-dots">思考中</span>' : escapeHtml(player.lastAction || "等待")}</span>
        </div>
      </article>
    `;
  }

  function seatStateText(player, active, thinking) {
    if (player.folded) return "已弃牌";
    if (player.allIn) return "All-in";
    if (thinking) return state.thinkingSource || "思考";
    if (active) return "行动";
    return "等待";
  }

  function renderHoleCards(player) {
    const shouldReveal = player.isHuman || state.phase === "review" && state.handHistory?.showdown?.evaluations.some((item) => item.id === player.id);
    if (!player.hole.length) return `${renderHiddenCard()}${renderHiddenCard()}`;
    return player.hole.map((card) => (shouldReveal ? renderCard(card) : renderHiddenCard())).join("");
  }

  function renderBoard() {
    const cards = [...state.board.map(renderCard)];
    while (cards.length < 5) cards.push('<div class="empty-card"></div>');
    return `
      <section class="board-zone">
        <div class="pot">底池 ${state.pot}</div>
        <div class="cards board-cards">${cards.join("")}</div>
        <div class="street">${STREET_LABEL[state.street] ?? "准备"} · 当前最高下注 ${state.currentBet}</div>
        ${renderLatestAction()}
      </section>
    `;
  }

  function renderLatestAction() {
    const action = [...(state.handHistory?.actions ?? [])].reverse().find((item) => !item.forced);
    if (!action) return '<div class="latest-action">等待第一个行动</div>';
    return `<div class="latest-action">上一步：${escapeHtml(action.playerName)} ${escapeHtml(actionLabel(action))}</div>`;
  }

  function renderControls(hero) {
    if (state.phase === "review") {
      return `
        <section class="controls decision-panel">
          <div class="control-info decision-head">
            <strong>本手结束</strong>
            <span>看右侧复盘，然后进入下一手。</span>
          </div>
          <button class="btn primary" data-continue>继续下一手</button>
        </section>
      `;
    }

    if (state.players[state.currentPlayerIndex]?.id !== "hero") {
      const current = state.players[state.currentPlayerIndex];
      return `
        <section class="controls decision-panel ai-wait">
          <div class="control-info decision-head">
            <strong>${current ? `${escapeHtml(current.name)} 行动中` : "等待"}</strong>
            <span>先观察他的下注大小和节奏，行动轮到你时按钮会亮起。</span>
          </div>
          <div class="thinking-strip">
            <span class="thinking-dot"></span>
            <span>${current ? `${escapeHtml(current.name)} 正在把角色说明、手牌、底池和合法动作交给 ${escapeHtml(state.aiStatus.label)} 决策。` : "等待下一步。"}</span>
          </div>
        </section>
      `;
    }

    const toCall = Math.max(0, state.currentBet - hero.bet);
    const maxTarget = hero.bet + hero.chips;
    const minRaise = legalMinRaiseTo(hero);
    const defaultRaise = Math.min(maxTarget, Math.max(minRaise, state.currentBet + roundToBlind(Math.max(state.bigBlind, state.pot * 0.6))));
    const canRaise = maxTarget > state.currentBet && maxTarget >= minRaise;
    const callText = toCall > 0 ? `跟注 ${Math.min(toCall, hero.chips)}` : "过牌";
    return `
      <section class="controls decision-panel">
        <div class="control-info decision-head">
          <strong>轮到你行动</strong>
          <span>${toCall > 0 ? `需要补 ${toCall} 才能继续` : "没人下注，你可以免费看下一步或主动下注"} · 你的筹码 ${hero.chips}</span>
        </div>
        <div class="action-buttons">
          <button class="btn danger" data-action="fold" ${toCall === 0 ? "disabled" : ""}>弃牌</button>
          <button class="btn good" data-action="${toCall > 0 ? "call" : "check"}">${callText}</button>
          <div class="raise-box">
            <label for="raiseTo">加注到</label>
            <input id="raiseTo" type="number" min="${minRaise}" max="${maxTarget}" step="${state.smallBlind}" value="${defaultRaise}" ${canRaise ? "" : "disabled"} />
          </div>
          <button class="btn primary" data-action="raise" ${canRaise ? "" : "disabled"}>加注</button>
          <button class="btn" data-action="allIn">All-in ${maxTarget}</button>
        </div>
        ${renderHeroGuide(hero, toCall, minRaise, defaultRaise)}
      </section>
    `;
  }

  function renderHeroGuide(hero, toCall, minRaise, defaultRaise) {
    const guide = buildHeroGuide(hero, toCall, minRaise, defaultRaise);
    return `
      <div class="coach-guide">
        <div class="coach-card primary-note">
          <strong>${escapeHtml(guide.title)}</strong>
          <span>${escapeHtml(guide.summary)}</span>
        </div>
        ${guide.items.map((item) => `
          <div class="coach-card">
            <strong>${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(item.text)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function buildHeroGuide(hero, toCall, minRaise, defaultRaise) {
    const cards = [...hero.hole, ...state.board];
    const invested = hero.committed;
    const potAfterCall = state.pot + Math.min(toCall, hero.chips);
    const potOdds = toCall > 0 ? Math.round((Math.min(toCall, hero.chips) / Math.max(1, potAfterCall)) * 100) : 0;
    let title = "先判断：牌力、价格、对手";
    let summary = "不要急着点按钮，先用下面三步过一遍。";

    if (state.board.length === 0) {
      const preflop = estimatePreflop(hero.hole);
      const grade = preflop >= 0.74 ? "很强" : preflop >= 0.55 ? "可玩" : preflop >= 0.38 ? "边缘" : "偏弱";
      title = `翻前起手牌：${grade}`;
      summary = toCall > 0 ? "面对加注时，弱牌不要只是因为便宜就跟。" : "没人再加注时，可以考虑位置和对手风格。";
    } else {
      const made = evaluateBest(cards);
      const draws = [];
      if (hasFlushDraw(cards)) draws.push("同花听牌");
      if (hasStraightDraw(cards)) draws.push("顺子听牌");
      title = `当前牌力：${CATEGORY_LABEL[made.category]}`;
      summary = `${made.label}${draws.length ? `，还有 ${draws.join("、")}` : ""}。`;
    }

    const priceText = toCall > 0
      ? `跟注要补 ${Math.min(toCall, hero.chips)}，约占跟注后底池的 ${potOdds}%。`
      : "现在可以过牌，代表不加钱继续观察。";
    const actionText = toCall > 0
      ? "弃牌是放弃本手；跟注是补齐当前最高下注；加注到是本街总下注变成那个数字。"
      : `过牌不投入筹码；下注至少到 ${minRaise}；默认加注框是 ${defaultRaise}，可以手动改。`;

    return {
      title,
      summary,
      items: [
        { label: "价格", text: priceText },
        { label: "动作", text: actionText },
        { label: "风险", text: `你本手已投入 ${invested}。如果只是跟注，要想清楚下一街再被下注能不能继续。` },
      ],
    };
  }

  function renderLivePanel() {
    return `
      <section class="panel-section focus-panel">
        <h2>现在看什么</h2>
        ${renderFocusTips()}
      </section>
      <section class="panel-section">
        <h2>AI 决策</h2>
        <div class="ai-mode">
          <strong>${escapeHtml(state.aiStatus.label)}</strong>
          <span>${escapeHtml(state.aiStatus.detail)}</span>
          ${state.lastModelError ? `<em>上次模型调用失败，已回退规则 AI：${escapeHtml(state.lastModelError)}</em>` : ""}
        </div>
      </section>
      <section class="panel-section">
        <h2>本手信息</h2>
        <div class="mini-table">
          ${state.players.map(renderStackRow).join("")}
        </div>
      </section>
      <section class="panel-section">
        <h3>AI 外在信息</h3>
        <div class="profile-list">
          ${state.players.filter((player) => !player.isHuman).map((player) => `
            <div class="profile-row">
              <strong>${escapeHtml(player.name)}</strong>
              <span>${escapeHtml(player.publicDesc)}</span>
            </div>
          `).join("")}
        </div>
      </section>
      <section class="panel-section">
        <h3>行动记录</h3>
        <div class="log">${renderActionLog()}</div>
      </section>
    `;
  }

  function renderFocusTips() {
    const current = state.players[state.currentPlayerIndex];
    if (current?.isHuman) {
      const toCall = Math.max(0, state.currentBet - current.bet);
      return `
        <p class="muted">轮到你。先看要不要补钱，再看公共牌有没有危险，最后决定是放弃、跟注还是主动加注。</p>
        <div class="focus-metrics">
          <span>需跟 ${toCall}</span>
          <span>底池 ${state.pot}</span>
          <span>本街最高 ${state.currentBet}</span>
        </div>
      `;
    }
    if (current) {
      return `
        <p class="muted">${escapeHtml(current.name)} 正在行动。观察他是过牌、跟注还是加注，下注大小会进入复盘。</p>
        <div class="focus-metrics">
          <span>${STREET_LABEL[state.street]}</span>
          <span>底池 ${state.pot}</span>
          <span>最高下注 ${state.currentBet}</span>
        </div>
      `;
    }
    return '<p class="muted">等待下一步。</p>';
  }

  function renderReview() {
    const review = state.lastReview;
    return `
      <section class="panel-section">
        <div class="review-title">
          <h2>第 ${state.handNumber} 手复盘</h2>
          <span class="chip">${review.heroDelta >= 0 ? "+" : ""}${review.heroDelta}</span>
        </div>
        <p class="muted">${escapeHtml(review.resultLine)}</p>
        <button class="btn primary" data-continue>继续下一手</button>
      </section>
      ${renderCodexReview()}
      <section class="panel-section">
        <h3>本地兜底复盘</h3>
        <ul class="review-list">${review.notes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </section>
      <section class="panel-section">
        <h3>做得可以的地方</h3>
        <ul class="review-list">${review.positives.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </section>
      <section class="panel-section">
        <h3>下一手注意</h3>
        <ul class="review-list">${review.nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </section>
      <section class="panel-section">
        <h3>本手行动</h3>
        <div class="log">${renderActionLog()}</div>
      </section>
    `;
  }

  function renderCodexReview() {
    const review = state.codexReview;
    if (!review || review.status === "idle") return "";
    if (review.status === "loading") {
      return `
        <section class="panel-section codex-review loading">
          <h3>Codex 复盘</h3>
          <div class="thinking-strip">
            <span class="thinking-dot"></span>
            <span>正在把完整 hand history 交给 Codex 复盘，这一步可能需要几十秒。</span>
          </div>
        </section>
      `;
    }
    if (review.status === "error") {
      return `
        <section class="panel-section codex-review error">
          <h3>Codex 复盘</h3>
          <p class="muted">Codex 复盘失败，下面保留本地兜底复盘。</p>
          <p class="error-text">${escapeHtml(review.error)}</p>
        </section>
      `;
    }

    const data = review.data;
    return `
      <section class="panel-section codex-review">
        <h3>${escapeHtml(review.provider || "Codex")} 复盘</h3>
        <p class="review-summary">${escapeHtml(data.summary)}</p>
        ${renderReviewGroup("关键决策", data.keyDecisions)}
        ${renderReviewGroup("做得好的地方", data.goodMoves)}
        ${renderReviewGroup("需要改进", data.mistakes)}
        ${renderReviewGroup("下一手重点", data.nextHandFocus)}
      </section>
    `;
  }

  function renderReviewGroup(title, items) {
    return `
      <div class="review-group">
        <strong>${escapeHtml(title)}</strong>
        <ul class="review-list">${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
    `;
  }

  function renderStackRow(player) {
    const start = state.handHistory?.startStacks.find((item) => item.id === player.id)?.chips ?? player.chips;
    return `
      <div class="stack-row">
        <strong>${escapeHtml(player.name)}</strong>
        <span>${start} -> ${player.chips}${player.allIn ? " · All-in" : ""}</span>
      </div>
    `;
  }

  function renderActionLog() {
    const actions = state.handHistory?.actions ?? [];
    if (!actions.length) return '<p class="muted">暂无行动。</p>';
    return actions
      .slice()
      .reverse()
      .map((action) => {
        const label = actionLabel(action);
        return `
          <div class="action-row">
            <strong>${STREET_LABEL[action.street] ?? action.street}</strong>
            <span>${escapeHtml(action.playerName)}：${escapeHtml(label)} · 底池 ${action.potAfter}</span>
          </div>
        `;
      })
      .join("");
  }

  function actionLabel(action) {
    const labels = {
      smallBlind: `小盲 ${action.amount}`,
      bigBlind: `大盲 ${action.amount}`,
      fold: "弃牌",
      check: "过牌",
      call: `跟注 ${action.amount}`,
      callAllIn: `跟注 All-in ${action.amount}`,
      raise: `加注到 ${action.targetBet ?? action.betAfter}`,
      raiseAllIn: `All-in 到 ${action.targetBet ?? action.betAfter}`,
    };
    return labels[action.action] ?? action.action;
  }

  function bindEvents() {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.getAttribute("data-action");
        if (state.players[state.currentPlayerIndex]?.id !== "hero") return;
        if (action === "raise") {
          const amount = Number(document.getElementById("raiseTo")?.value);
          applyAction(state.currentPlayerIndex, "raise", amount);
          return;
        }
        applyAction(state.currentPlayerIndex, action);
      });
    });

    document.querySelectorAll("[data-continue]").forEach((button) => {
      button.addEventListener("click", startHand);
    });
  }

  function renderCard(card) {
    const color = RED_SUITS.has(card.suit) ? " red" : "";
    const rank = displayRank(card.rank);
    return `
      <div class="card${color}" aria-label="${cardText(card)}">
        <span class="rank">${rank}</span>
        <span class="suit">${SUIT_SYMBOL[card.suit]}</span>
      </div>
    `;
  }

  function renderHiddenCard() {
    return '<div class="card hidden" aria-label="hidden card"><span class="rank">?</span><span class="suit">◆</span></div>';
  }

  function displayCardText(card) {
    return `${displayRank(card.rank)}${SUIT_SYMBOL[card.suit]}`;
  }

  function displayRawCardText(raw) {
    const text = String(raw);
    const rank = text[0];
    const suit = text[1];
    return `${displayRank(rank)}${SUIT_SYMBOL[suit] || suit || ""}`;
  }

  function displayRank(rank) {
    return rank === "T" ? "10" : rank;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function unique(items) {
    return [...new Set(items)];
  }

  newSession();
})();
