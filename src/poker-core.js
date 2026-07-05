(function attachPokerCore(global) {
  "use strict";

  const SUITS = ["S", "H", "D", "C"];
  const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const RED_SUITS = new Set(["H", "D"]);
  const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));
  const VALUE_LABEL = {
    14: "A",
    13: "K",
    12: "Q",
    11: "J",
    10: "10",
    9: "9",
    8: "8",
    7: "7",
    6: "6",
    5: "5",
    4: "4",
    3: "3",
    2: "2",
  };
  const STREET_LABEL = {
    preflop: "翻前",
    flop: "翻牌",
    turn: "转牌",
    river: "河牌",
    showdown: "摊牌",
  };
  const CATEGORY_LABEL = [
    "高牌",
    "一对",
    "两对",
    "三条",
    "顺子",
    "同花",
    "葫芦",
    "四条",
    "同花顺",
  ];

  function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ rank, suit, value: RANK_VALUE[rank] });
      }
    }
    return deck;
  }

  function createShuffledDeck(random = Math.random) {
    const deck = createDeck();
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
    }
    return deck;
  }

  function parseCard(text) {
    const rank = text[0].toUpperCase();
    const suit = text.slice(1).toUpperCase();
    if (!RANK_VALUE[rank] || !SUITS.includes(suit)) {
      throw new Error(`Invalid card: ${text}`);
    }
    return { rank, suit, value: RANK_VALUE[rank] };
  }

  function parseCards(text) {
    return text.trim().split(/\s+/).filter(Boolean).map(parseCard);
  }

  function cardText(card) {
    return `${card.rank}${card.suit}`;
  }

  function evaluateBest(cards) {
    if (!Array.isArray(cards) || cards.length < 5) {
      throw new Error("evaluateBest requires at least 5 cards");
    }

    const counts = new Map();
    for (const card of cards) counts.set(card.value, (counts.get(card.value) ?? 0) + 1);
    const valuesDesc = [...counts.keys()].sort((a, b) => b - a);

    const straightFlush = bestStraightFlush(cards);
    if (straightFlush) return makeScore(8, [straightFlush], `同花顺 ${VALUE_LABEL[straightFlush]} 高`);

    const quads = valuesDesc.filter((value) => counts.get(value) === 4);
    if (quads.length) {
      const kicker = valuesDesc.find((value) => value !== quads[0]);
      return makeScore(7, [quads[0], kicker], `四条 ${VALUE_LABEL[quads[0]]}`);
    }

    const trips = valuesDesc.filter((value) => counts.get(value) >= 3);
    const pairs = valuesDesc.filter((value) => counts.get(value) >= 2);
    if (trips.length && (pairs.length >= 2 || trips.length >= 2)) {
      const trip = trips[0];
      const pair = trips.length >= 2 ? trips[1] : pairs.find((value) => value !== trip);
      return makeScore(6, [trip, pair], `葫芦 ${VALUE_LABEL[trip]} 带 ${VALUE_LABEL[pair]}`);
    }

    const flush = bestFlush(cards);
    if (flush) return makeScore(5, flush, `同花 ${VALUE_LABEL[flush[0]]} 高`);

    const straight = bestStraight(valuesDesc);
    if (straight) return makeScore(4, [straight], `顺子 ${VALUE_LABEL[straight]} 高`);

    if (trips.length) {
      const kickers = valuesDesc.filter((value) => value !== trips[0]).slice(0, 2);
      return makeScore(3, [trips[0], ...kickers], `三条 ${VALUE_LABEL[trips[0]]}`);
    }

    if (pairs.length >= 2) {
      const [highPair, lowPair] = pairs.slice(0, 2);
      const kicker = valuesDesc.find((value) => value !== highPair && value !== lowPair);
      return makeScore(2, [highPair, lowPair, kicker], `两对 ${VALUE_LABEL[highPair]} 和 ${VALUE_LABEL[lowPair]}`);
    }

    if (pairs.length === 1) {
      const pair = pairs[0];
      const kickers = valuesDesc.filter((value) => value !== pair).slice(0, 3);
      return makeScore(1, [pair, ...kickers], `一对 ${VALUE_LABEL[pair]}`);
    }

    const highCards = valuesDesc.slice(0, 5);
    return makeScore(0, highCards, `高牌 ${VALUE_LABEL[highCards[0]]}`);
  }

  function makeScore(category, ranks, label) {
    return { category, ranks, label };
  }

  function compareScores(a, b) {
    if (a.category !== b.category) return a.category - b.category;
    const length = Math.max(a.ranks.length, b.ranks.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a.ranks[index] ?? 0) - (b.ranks[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function bestFlush(cards) {
    for (const suit of SUITS) {
      const suited = cards.filter((card) => card.suit === suit).sort((a, b) => b.value - a.value);
      if (suited.length >= 5) return suited.slice(0, 5).map((card) => card.value);
    }
    return null;
  }

  function bestStraightFlush(cards) {
    for (const suit of SUITS) {
      const suitedValues = [...new Set(cards.filter((card) => card.suit === suit).map((card) => card.value))].sort((a, b) => b - a);
      const straight = bestStraight(suitedValues);
      if (straight) return straight;
    }
    return null;
  }

  function bestStraight(valuesDesc) {
    const valueSet = new Set(valuesDesc);
    if (valueSet.has(14)) valueSet.add(1);
    for (let high = 14; high >= 5; high -= 1) {
      let complete = true;
      for (let offset = 0; offset < 5; offset += 1) {
        if (!valueSet.has(high - offset)) {
          complete = false;
          break;
        }
      }
      if (complete) return high;
    }
    return null;
  }

  function hasFlushDraw(cards) {
    return SUITS.some((suit) => cards.filter((card) => card.suit === suit).length === 4);
  }

  function hasStraightDraw(cards) {
    const values = [...new Set(cards.map((card) => (card.value === 14 ? [14, 1] : [card.value])).flat())];
    for (let high = 14; high >= 5; high -= 1) {
      let hits = 0;
      for (let offset = 0; offset < 5; offset += 1) {
        if (values.includes(high - offset)) hits += 1;
      }
      if (hits === 4) return true;
    }
    return false;
  }

  function estimatePreflop(cards) {
    const [a, b] = [...cards].sort((x, y) => y.value - x.value);
    const pair = a.value === b.value;
    const suited = a.suit === b.suit;
    const gap = Math.abs(a.value - b.value);
    let score = (a.value / 14) * 0.36 + (b.value / 14) * 0.24;
    if (pair) score = 0.46 + (a.value / 14) * 0.36;
    if (suited) score += 0.055;
    if (gap === 1) score += 0.045;
    if (gap === 2) score += 0.025;
    if (gap >= 5 && !pair) score -= 0.06;
    if (a.value < 11 && b.value < 9 && !pair) score -= 0.08;
    return clamp(score, 0.08, 0.95);
  }

  function buildSidePots(players) {
    const committedLevels = [...new Set(players.filter((player) => player.committed > 0).map((player) => player.committed))]
      .sort((a, b) => a - b);
    const pots = [];
    let previous = 0;
    for (const level of committedLevels) {
      const contributors = players.filter((player) => player.committed >= level);
      const amount = (level - previous) * contributors.length;
      const eligibleIds = contributors.filter((player) => !player.folded).map((player) => player.id);
      if (amount > 0 && eligibleIds.length > 0) {
        pots.push({ amount, eligibleIds, contributorIds: contributors.map((player) => player.id) });
      }
      previous = level;
    }
    return pots;
  }

  function distributeShowdownPots(players, board) {
    const contenders = players.filter((player) => !player.folded);
    const evaluations = contenders.map((player) => ({
      player,
      score: evaluateBest([...player.hole, ...board]),
    }));
    const sidePots = buildSidePots(players);
    const awards = [];

    for (const sidePot of sidePots) {
      const eligibleEvaluations = evaluations.filter((item) => sidePot.eligibleIds.includes(item.player.id));
      eligibleEvaluations.sort((a, b) => compareScores(b.score, a.score));
      const best = eligibleEvaluations[0].score;
      const winners = eligibleEvaluations.filter((item) => compareScores(item.score, best) === 0);
      const share = Math.floor(sidePot.amount / winners.length);
      let remainder = sidePot.amount % winners.length;
      for (const winner of winners) {
        const paid = share + (remainder > 0 ? 1 : 0);
        remainder -= 1;
        awards.push({
          id: winner.player.id,
          name: winner.player.name,
          amount: paid,
          label: winner.score.label,
          category: winner.score.category,
          potAmount: sidePot.amount,
        });
      }
    }

    return {
      awards,
      sidePots,
      evaluations: evaluations.map((item) => ({
        id: item.player.id,
        name: item.player.name,
        cards: item.player.hole.map(cardText),
        label: item.score.label,
        category: item.score.category,
        ranks: [...item.score.ranks],
      })),
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  global.PokerCore = {
    SUITS,
    SUIT_SYMBOL,
    RED_SUITS,
    RANKS,
    RANK_VALUE,
    VALUE_LABEL,
    STREET_LABEL,
    CATEGORY_LABEL,
    createDeck,
    createShuffledDeck,
    parseCard,
    parseCards,
    cardText,
    evaluateBest,
    compareScores,
    bestStraight,
    hasFlushDraw,
    hasStraightDraw,
    estimatePreflop,
    buildSidePots,
    distributeShowdownPots,
    clamp,
    randomInt,
  };
})(typeof window !== "undefined" ? window : globalThis);
