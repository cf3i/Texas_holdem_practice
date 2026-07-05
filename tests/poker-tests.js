(function attachPokerTests(global) {
  "use strict";

  function runPokerLogicTests(core = global.PokerCore) {
    const tests = [];

    function test(name, fn) {
      tests.push({ name, fn });
    }

    function assert(condition, message) {
      if (!condition) throw new Error(message || "Assertion failed");
    }

    function equal(actual, expected, message) {
      if (actual !== expected) {
        throw new Error(`${message || "Expected equality"}: expected ${expected}, got ${actual}`);
      }
    }

    function deepEqual(actual, expected, message) {
      const actualText = JSON.stringify(actual);
      const expectedText = JSON.stringify(expected);
      if (actualText !== expectedText) {
        throw new Error(`${message || "Expected deep equality"}: expected ${expectedText}, got ${actualText}`);
      }
    }

    function cards(text) {
      return core.parseCards(text);
    }

    function score(text) {
      return core.evaluateBest(cards(text));
    }

    function player(id, committed, hole, folded = false) {
      return {
        id,
        name: id.toUpperCase(),
        committed,
        folded,
        hole: cards(hole),
      };
    }

    test("牌堆必须是 52 张且没有重复", () => {
      const deck = core.createDeck();
      equal(deck.length, 52, "deck length");
      equal(new Set(deck.map(core.cardText)).size, 52, "unique cards");
    });

    test("非法牌面会抛错", () => {
      let threw = false;
      try {
        core.parseCard("1X");
      } catch {
        threw = true;
      }
      assert(threw, "invalid card should throw");
    });

    test("皇家同花顺识别为最高同花顺", () => {
      const result = score("AS KS QS JS TS 2D 3C");
      equal(result.category, 8, "category");
      deepEqual(result.ranks, [14], "rank");
    });

    test("A2345 同花顺识别为 5 高", () => {
      const result = score("AS 2S 3S 4S 5S KD QC");
      equal(result.category, 8, "category");
      deepEqual(result.ranks, [5], "wheel straight flush");
    });

    test("A2345 普通顺子识别为 5 高", () => {
      const result = score("AS 2D 3C 4H 5S KD QC");
      equal(result.category, 4, "category");
      deepEqual(result.ranks, [5], "wheel straight");
    });

    test("重复牌点不会破坏顺子判断", () => {
      const result = score("AS AH KS QD JC TH 9S");
      equal(result.category, 4, "category");
      deepEqual(result.ranks, [14], "broadway straight");
    });

    test("两组三条时，高三条做葫芦主体", () => {
      const result = score("AS AD AC KS KD KC 2D");
      equal(result.category, 6, "category");
      deepEqual(result.ranks, [14, 13], "full house rank order");
    });

    test("四条必须使用最佳 kicker", () => {
      const result = score("9S 9H 9D 9C AS KD 2C");
      equal(result.category, 7, "category");
      deepEqual(result.ranks, [9, 14], "quad kicker");
    });

    test("同花只取同花中最高五张", () => {
      const result = score("AS KS TS 8S 2S QD JC");
      equal(result.category, 5, "category");
      deepEqual(result.ranks, [14, 13, 10, 8, 2], "flush kickers");
    });

    test("两对比较先看高对，再看低对，再看 kicker", () => {
      const left = score("AS AD KS KD QS 2H 3C");
      const right = score("AS AD QS QD KS 2H 3C");
      assert(core.compareScores(left, right) > 0, "kings-up should beat queens-up");
    });

    test("同一对子比较 kicker", () => {
      const left = score("AS AD KH QS 9C 4D 2S");
      const right = score("AS AD QH JS 9C 4D 2S");
      assert(core.compareScores(left, right) > 0, "king kicker should win");
    });

    test("听同花和听顺子能被识别", () => {
      assert(core.hasFlushDraw(cards("AS KS 9S 2S 3D")), "flush draw");
      assert(core.hasStraightDraw(cards("8S 9D TH JH 2C")), "straight draw");
    });

    test("翻前强弱估值应明显区分 AA 和 72o", () => {
      const aces = core.estimatePreflop(cards("AS AH"));
      const junk = core.estimatePreflop(cards("7C 2D"));
      assert(aces > 0.8, "AA should be premium");
      assert(junk < 0.3, "72o should be weak");
      assert(aces > junk, "AA beats junk");
    });

    test("三人 All-in 边池金额和资格正确", () => {
      const pots = core.buildSidePots([
        player("a", 50, "AS AD"),
        player("b", 100, "KS KD"),
        player("c", 200, "QS QD"),
      ]);
      deepEqual(
        pots.map((pot) => ({ amount: pot.amount, eligibleIds: pot.eligibleIds })),
        [
          { amount: 150, eligibleIds: ["a", "b", "c"] },
          { amount: 100, eligibleIds: ["b", "c"] },
          { amount: 100, eligibleIds: ["c"] },
        ],
        "side pot layout",
      );
    });

    test("弃牌玩家贡献筹码但不能赢边池", () => {
      const pots = core.buildSidePots([
        player("a", 50, "AS AD"),
        player("b", 100, "KS KD"),
        player("c", 200, "QS QD"),
        player("d", 100, "2S 2D", true),
      ]);
      deepEqual(
        pots.map((pot) => ({ amount: pot.amount, eligibleIds: pot.eligibleIds })),
        [
          { amount: 200, eligibleIds: ["a", "b", "c"] },
          { amount: 150, eligibleIds: ["b", "c"] },
          { amount: 100, eligibleIds: ["c"] },
        ],
        "folded contribution side pots",
      );
    });

    test("短码最好牌只赢主池，不能赢自己没资格的边池", () => {
      const players = [
        player("a", 50, "AS AD"),
        player("b", 100, "KH KD"),
        player("c", 200, "2C 3D"),
      ];
      const result = core.distributeShowdownPots(players, cards("AC 7H 8D 9C TS"));
      deepEqual(
        result.awards.map((award) => ({ id: award.id, amount: award.amount })),
        [
          { id: "a", amount: 150 },
          { id: "b", amount: 100 },
          { id: "c", amount: 100 },
        ],
        "award distribution",
      );
    });

    test("平分底池时总金额守恒，奇数筹码只多给一方一枚", () => {
      const players = [
        player("a", 5, "AS KD"),
        player("b", 5, "AH KC"),
        player("c", 5, "2S 3D", true),
      ];
      const result = core.distributeShowdownPots(players, cards("QS JD TC 4H 5S"));
      const awards = result.awards.filter((award) => award.id === "a" || award.id === "b");
      const total = awards.reduce((sum, award) => sum + award.amount, 0);
      equal(total, 15, "split total");
      equal(Math.abs(awards[0].amount - awards[1].amount), 1, "odd chip difference");
    });

    test("分池结算总额必须等于所有 committed 筹码", () => {
      const players = [
        player("a", 30, "AS AD"),
        player("b", 90, "KH KD"),
        player("c", 90, "QH QD"),
        player("d", 210, "JH JD"),
        player("e", 210, "2S 3S", true),
      ];
      const committed = players.reduce((sum, item) => sum + item.committed, 0);
      const result = core.distributeShowdownPots(players, cards("AC 7D 8S 9H TC"));
      const awarded = result.awards.reduce((sum, award) => sum + award.amount, 0);
      equal(awarded, committed, "chip conservation");
    });

    const results = tests.map((item) => {
      try {
        item.fn();
        return { name: item.name, ok: true };
      } catch (error) {
        return { name: item.name, ok: false, error: error.message };
      }
    });

    return {
      passed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      total: results.length,
      results,
    };
  }

  function renderResults(summary) {
    const summaryNode = document.getElementById("test-summary");
    const resultsNode = document.getElementById("test-results");
    const ok = summary.failed === 0;
    summaryNode.className = `test-summary ${ok ? "pass" : "fail"}`;
    summaryNode.textContent = `${summary.passed}/${summary.total} 通过`;
    resultsNode.innerHTML = summary.results
      .map((result) => `
        <article class="test-result ${result.ok ? "pass" : "fail"}">
          <strong>${escapeHtml(result.ok ? "通过" : "失败")}</strong>
          <span>${escapeHtml(result.name)}</span>
          ${result.error ? `<code>${escapeHtml(result.error)}</code>` : ""}
        </article>
      `)
      .join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  global.runPokerLogicTests = runPokerLogicTests;

  if (typeof document !== "undefined" && document.getElementById("test-results")) {
    renderResults(runPokerLogicTests());
  }
})(typeof window !== "undefined" ? window : globalThis);
