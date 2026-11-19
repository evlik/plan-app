/* Unit tests for words/core.js (ported from the Micro-Sprint Kotlin tests + progress/merge tests).
   Run: node tools/test_words_core.js     Exit code 0 = all passed. */
"use strict";

const assert = require("assert");
const path = require("path");
const C = require(path.join(__dirname, "..", "words", "core.js"));

const results = [];

/** Register and run one named test, recording PASS / FAIL. */
function test(name, fn) {
	try {
		fn();
		results.push([true, name]);
	} catch (err) {
		results.push([false, name, err]);
	}
}

/** Deterministic pseudo-random generator (same sequence every run). */
function seeded(seed = 42) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/* ---------- MicroDeckScheduler ---------- */

let now = 0;

/** Scheduler with a fake clock and fixed randomness. */
function scheduler(words, { config = C.defaultConfig(), filler = () => null, restored = [] } = {}) {
	now = 0;
	return new C.MicroDeckScheduler(words, restored, { config, clock: () => now, random: seeded(), fillerSource: filler });
}

/** Expected card object. */
const card = (type, wordId, level) => ({ type, wordId, level });

/** First card of a fresh word must be its presentation; answer it. */
function presentFirst(s, id) {
	assert.deepStrictEqual(s.nextCard(), card("presentation", id, "L0"));
	s.reportResult(C.RESULT.CLEAN);
}

test("часова підлога ніколи не порушується", () => {
	const s = scheduler([1]);
	presentFirst(s, 1);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 1, "L0"));
	s.reportResult(C.RESULT.CLEAN);
	assert.strictEqual(s.nextCard(), null);
	now += 44999;
	assert.strictEqual(s.nextCard(), null);
	now += 1;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 1, "L1"));
});

test("вага вікна не перевищує ліміт", () => {
	const config = C.defaultConfig();
	const s = scheduler([...Array(30)].map((_, i) => i + 1), { config });
	for (let i = 0; i < 200; i++) {
		const c = s.nextCard();
		if (!c) { now += 60000; continue; }
		assert.ok(s.windowWeight() <= config.windowWeightLimit, `вага ${s.windowWeight()}`);
		s.reportResult(C.RESULT.CLEAN);
		now += 1000;
	}
});

test("випуск можливий лише через cooling-перевірку (5 чистих вводів)", () => {
	const s = scheduler([7]);
	let cleans = 0;
	while (!s.graduated.length) {
		const c = s.nextCard();
		if (!c) { now += 600000; continue; }
		s.reportResult(C.RESULT.CLEAN);
		cleans++;
		assert.ok(cleans < 20, "занадто багато вводів");
	}
	assert.strictEqual(cleans, 5);
	assert.deepStrictEqual(s.graduated, [7]);
	assert.ok(s.isFinished);
});

test("мʼякий штраф: −1 рівень, друге підглядання поспіль — L0", () => {
	const s = scheduler([3]);
	presentFirst(s, 3);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L0"));
	s.reportResult(C.RESULT.CLEAN);
	now += 45000;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L1"));
	s.reportResult(C.RESULT.CLEAN);
	now += 120000;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L2"));
	s.reportResult(C.RESULT.PEEKED);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L1"));
	s.reportResult(C.RESULT.PEEKED);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L0"));
	s.reportResult(C.RESULT.CLEAN);
});

test("жорсткий режим скидає в L0 одразу", () => {
	const config = { ...C.defaultConfig(), penaltyMode: "HARD" };
	const s = scheduler([3], { config });
	presentFirst(s, 3);
	s.nextCard();
	s.reportResult(C.RESULT.CLEAN);
	now += 45000;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L1"));
	s.reportResult(C.RESULT.PEEKED);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 3, "L0"));
});

test("підказка не підвищує рівень", () => {
	const s = scheduler([5]);
	presentFirst(s, 5);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 5, "L0"));
	s.reportResult(C.RESULT.WITH_HINT);
	assert.deepStrictEqual(s.nextCard(), card("challenge", 5, "L0"));
	s.reportResult(C.RESULT.CLEAN);
	now += 45000;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 5, "L1"));
});

test("слово, повернуте в пул, знову проходить повний цикл", () => {
	const s = scheduler([1]);
	while (!s.graduated.length) {
		if (!s.nextCard()) { now += 600000; continue; }
		s.reportResult(C.RESULT.CLEAN);
	}
	assert.ok(s.isFinished);
	s.addToPool(1);
	assert.ok(!s.isFinished);
	assert.deepStrictEqual(s.nextCard(), card("presentation", 1, "L0"));
});

test("зміна цілі дня звужує лише чергу нових слів", () => {
	const s = scheduler([1, 2, 3]);
	presentFirst(s, 1);
	assert.deepStrictEqual(s.pendingNewWordIds(), [2, 3]);
	s.retainPendingNew(new Set([2]));
	assert.deepStrictEqual(s.pendingNewWordIds(), [2]);
	assert.strictEqual(s.activeCount(), 1);
});

test("відновлене слово продовжує зі збереженого рівня без презентації", () => {
	const s = scheduler([], { restored: [{ wordId: 9, level: "L2" }] });
	assert.deepStrictEqual(s.nextCard(), card("challenge", 9, "L2"));
	s.reportResult(C.RESULT.CLEAN);
	now += 600000;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 9, "COOLING"));
	s.reportResult(C.RESULT.CLEAN);
	assert.deepStrictEqual(s.graduated, [9]);
});

test("коли мікро-колода чекає, подаються філери", () => {
	let served = 0;
	const filler = () => ({ wordId: 100 + ++served, kind: "REVIEW_DUE" });
	const s = scheduler([1], { config: { ...C.defaultConfig(), windowWeightLimit: 2 }, filler });
	presentFirst(s, 1);
	let c = s.nextCard();
	while (c && c.type === "filler") c = s.nextCard();
	assert.deepStrictEqual(c, card("challenge", 1, "L0"));
	assert.ok(served >= 2, "перед челенджем мали бути філери");
	s.reportResult(C.RESULT.CLEAN);
	const before = served;
	for (let i = 0; i < 10; i++) assert.strictEqual(s.nextCard().type, "filler");
	assert.strictEqual(served, before + 10);
	now += 45000;
	assert.deepStrictEqual(s.nextCard(), card("challenge", 1, "L1"));
});

test("dropWords прибирає поточну картку і слова з пулу", () => {
	const s = scheduler([1, 2]);
	assert.strictEqual(s.nextCard().wordId, 1);
	assert.strictEqual(s.dropWords(new Set([1, 2])), true);
	assert.ok(s.isFinished);
});

/* ---------- FSRS ---------- */

const fsrs = new C.Fsrs();

test("FSRS: перший інтервал — кілька днів", () => {
	const st = fsrs.initial(C.RATING.GOOD);
	assert.ok(st.intervalDays >= 2 && st.intervalDays <= 7, `інтервал ${st.intervalDays}`);
	assert.ok(Math.abs(st.stability - st.intervalDays) <= 1);
});

test("FSRS: успішні повторення розтягують інтервали до стелі 365", () => {
	let st = fsrs.initial(C.RATING.GOOD);
	for (let i = 0; i < 6; i++) {
		const next = fsrs.review(st.stability, st.difficulty, st.intervalDays, C.RATING.GOOD);
		assert.ok(next.intervalDays > st.intervalDays || next.intervalDays === 365);
		st = next;
	}
	assert.strictEqual(st.intervalDays, 365);
});

test("FSRS: провал скорочує стабільність", () => {
	const b = fsrs.initial(C.RATING.GOOD);
	const g = fsrs.review(b.stability, b.difficulty, b.intervalDays, C.RATING.GOOD);
	const f = fsrs.review(g.stability, g.difficulty, g.intervalDays, C.RATING.AGAIN);
	assert.ok(f.stability < g.stability);
});

test("FSRS: HARD коротше за GOOD", () => {
	const b = fsrs.initial(C.RATING.GOOD);
	assert.ok(fsrs.review(b.stability, b.difficulty, b.intervalDays, C.RATING.HARD).intervalDays
		< fsrs.review(b.stability, b.difficulty, b.intervalDays, C.RATING.GOOD).intervalDays);
});

test("FSRS: складність у межах 1–10", () => {
	let st = fsrs.initial(C.RATING.AGAIN);
	for (let i = 0; i < 20; i++) { st = fsrs.review(st.stability, st.difficulty, 1, C.RATING.AGAIN); assert.ok(st.difficulty >= 1 && st.difficulty <= 10); }
	for (let i = 0; i < 20; i++) { st = fsrs.review(st.stability, st.difficulty, st.intervalDays, C.RATING.EASY); assert.ok(st.difficulty >= 1 && st.difficulty <= 10); }
});

/* ---------- WordInput ---------- */

const W = t => new C.WordInput(t);

test("ввід: підказка додає літеру і позначає її", () => {
	const i = W("talo").userChange("ta").withHint();
	assert.strictEqual(i.text, "tal");
	assert.deepStrictEqual(i.hinted, [false, false, true]);
});

test("ввід: підказка замінює першу неправильну літеру і стирає хвіст", () => {
	const i = W("talo").userChange("tkxx").withHint();
	assert.strictEqual(i.text, "ta");
	assert.deepStrictEqual(i.hinted, [false, true]);
});

test("ввід: багаторазова підказка вписує все слово", () => {
	let i = W("yö");
	for (let k = 0; k < 5; k++) i = i.withHint();
	assert.strictEqual(i.text, "yö");
	assert.ok(i.isComplete);
	assert.strictEqual(i.hintedCount, 2);
});

test("ввід: ручний ввід після підказки зберігає її прапорець", () => {
	const i = W("talo").userChange("t").withHint().userChange("tal");
	assert.deepStrictEqual(i.hinted, [false, true, false]);
});

test("ввід: стирання і повторний ввід скидають прапорці", () => {
	let i = W("talo");
	for (let k = 0; k < 3; k++) i = i.withHint();
	i = i.userChange("t").userChange("ta");
	assert.deepStrictEqual(i.hinted, [true, false]);
});

test("ввід: регістр не важливий, ä ≠ a", () => {
	assert.ok(W("talo").userChange("Talo").isComplete);
	assert.ok(W("äiti").userChange("Äiti").isComplete);
	const typed = W("päivä").userChange("paiva");
	assert.ok(!typed.isComplete);
	assert.strictEqual(typed.resultFor(false), C.RESULT.WRONG);
	const fixed = W("päivä").userChange("pa").withHint();
	assert.strictEqual(fixed.text, "pä");
	assert.deepStrictEqual(fixed.hinted, [false, true]);
});

test("ввід: оцінка спроби", () => {
	assert.strictEqual(W("talo").userChange("talo").resultFor(false), C.RESULT.CLEAN);
	assert.strictEqual(W("talo").userChange("talo").resultFor(true), C.RESULT.PEEKED);
	assert.strictEqual(W("talo").userChange("tal").resultFor(false), C.RESULT.WRONG);
	assert.strictEqual(W("talo").userChange("ta").withHint().withHint().resultFor(false), C.RESULT.WITH_HINT);
	let many = W("kaupunki");
	for (let k = 0; k < 8; k++) many = many.withHint();
	assert.strictEqual(many.resultFor(false), C.RESULT.PEEKED);
});

test("ввід: одна неправильна літера — мʼяка помилка, дві — груба", () => {
	const near = W("päivä").userChange("paivä");
	assert.ok(near.isNearMiss);
	assert.strictEqual(near.resultFor(false), C.RESULT.WITH_HINT);
	assert.ok(!W("päivä").userChange("paiva").isNearMiss);
	assert.ok(!W("talo").userChange("tal").isNearMiss);
});

test("ввід: ввід після підказки продовжується після неї; повне слово підказка не змінює", () => {
	let i = W("talo").userChange("ta").withHint();
	i = i.userChange(i.text + "o");
	assert.deepStrictEqual(i.hinted, [false, false, true, false]);
	assert.ok(i.isComplete);
	const full = W("talo").userChange("talo").withHint();
	assert.strictEqual(full.text, "talo");
	assert.ok(!full.hinted.some(Boolean));
});

/* ---------- Progress model ---------- */

test("прогрес: випуск ставить REVIEW з датою і рахується в ціль дня", () => {
	const p = C.emptyProgress();
	C.saveMicroLevel(p, 1, "COOLING", 1000);
	assert.strictEqual(p.cards[1].st, "COOLING");
	C.graduate(p, 1, 5000);
	assert.strictEqual(p.cards[1].st, "REVIEW");
	assert.ok(p.cards[1].due > 5000);
	assert.strictEqual(C.graduatedSince(p, 4000), 1);
	assert.deepStrictEqual(C.dueReviewIds(p, p.cards[1].due), [1]);
});

test("прогрес: провал review повертає в мікро-колоду L1", () => {
	const p = C.emptyProgress();
	C.graduate(p, 2, 0);
	C.reviewAnswered(p, 2, C.RATING.AGAIN, 5 * C.DAY_MS);
	assert.strictEqual(p.cards[2].st, "MICRO");
	assert.strictEqual(p.cards[2].lv, 1);
	assert.deepStrictEqual(C.restoredWords(p), [{ wordId: 2, level: "L1" }]);
});

test("прогрес: «знаю» виключає слово з нових і планує перевірку", () => {
	const p = C.emptyProgress();
	C.setKnown(p, 1, true, 0);
	assert.deepStrictEqual(C.newWordIds(p, [1, 2, 3], 2), [2, 3]);
	assert.deepStrictEqual(C.knownCheckDue(p, 15 * C.DAY_MS, 3), [1]);
	C.setKnown(p, 1, false, 1);
	assert.deepStrictEqual(C.newWordIds(p, [1, 2, 3], 2), [1, 2]);
});

test("прогрес: злиття бере пізнішу зміну кожного слова", () => {
	const a = C.emptyProgress(), b = C.emptyProgress();
	C.saveMicroLevel(a, 1, "L1", 100);
	C.saveMicroLevel(b, 1, "L2", 200);
	C.saveMicroLevel(a, 2, "L0", 300);
	C.setKnown(b, 3, true, 50);
	b.settings.goal = 20; b.su = 10;
	const m = C.mergeProgress(a, b);
	assert.strictEqual(m.cards[1].lv, 2);
	assert.ok(m.cards[2] && m.cards[3]);
	assert.strictEqual(m.settings.goal, 20);
	assert.strictEqual(C.progressToText(C.mergeProgress(b, a)), C.progressToText(m));
});

test("прогрес: вище покоління (імпорт) замінює, а не зливає", () => {
	const old = C.emptyProgress(), imported = C.emptyProgress();
	C.setKnown(old, 425, true, Date.now() + 10 * C.DAY_MS);   // future-dated junk must not survive
	C.graduate(imported, 1, 100);
	imported.epoch = 1;
	for (const m of [C.mergeProgress(old, imported), C.mergeProgress(imported, old)]) {
		assert.strictEqual(m.epoch, 1);
		assert.ok(m.cards[1] && !m.cards[425]);
	}
	const back = C.normalizeProgress(JSON.parse(C.progressToText(imported)));
	assert.strictEqual(back.epoch, 1);
});

test("прогрес: normalizeProgress відкидає сміття і читає власний текст", () => {
	assert.throws(() => C.normalizeProgress(null));
	const p = C.emptyProgress();
	C.graduate(p, 5, 0);
	p.cards.x = { st: "BAD" };
	const back = C.normalizeProgress(JSON.parse(C.progressToText(p)));
	assert.ok(back.cards[5] && !back.cards.x);
});

/* ---------- Practice with AI ---------- */

const COURSE = {
	byFi: new Map([["talo", 1], ["koira", 2], ["vesi", 3], ["kissa", 4]]),
	topics: [{ id: "case-ine", title: "Місцевий «у» -ssa/-ssä (inessiivi)", level: "A1" }, { id: "case-par", title: "Частковий (partitiivi)", level: "A1" }, { id: "tense-past", title: "Минулий час (imperfekti)", level: "A2" }],
};
const AI_ANSWER = `Hyvää työtä! Ось підсумок:
\`\`\`plan-practice
PRACTICE 1
minutes: 20
mode: розмова
word: Talo | 3 | 0
word: koira | 1 | 2
- word: vesi | 2 | 0
word: auto | 1 | 0
topic: case-ine | 70 | 5 | 2
topic: partitiivi | 40 | 2 | 4
note: Місцевий відмінок вже добре, партитив плутаєш з називним.
\`\`\`
Kiitos!`;

test("практика: розбір блоку plan-practice", () => {
	const r = C.parsePracticeResult(AI_ANSWER, COURSE);
	assert.strictEqual(r.minutes, 20);
	assert.strictEqual(r.mode, "розмова");
	assert.deepStrictEqual(r.words.map(w => [w.fi, w.id, w.ok, w.err]), [["talo", 1, 3, 0], ["koira", 2, 1, 2], ["vesi", 3, 2, 0], ["auto", null, 1, 0]]);
	assert.deepStrictEqual(r.topics.map(t => [t.id, t.score]), [["case-ine", 70], ["case-par", 40]]);
	assert.ok(r.note.includes("партитив"));
	assert.throws(() => C.parsePracticeResult("просто текст без блоку", COURSE), /plan-practice/);
	assert.throws(() => C.parsePracticeResult("```plan-practice\nPRACTICE 1\n```", COURSE), /word:/);
});

test("практика: застосування — помилки на повторення, прострочене правильне — як повторення", () => {
	const now = 100 * C.DAY_MS;
	const p = C.emptyProgress();
	C.graduate(p, 1, 0);            // talo: overdue review, used right -> GOOD review
	C.graduate(p, 2, now - 1000);   // koira: review not due, errors -> due now
	C.setKnown(p, 3, true, now);    // vesi: known, right -> only counters
	const s = C.applyPractice(p, C.parsePracticeResult(AI_ANSWER, COURSE), now, "2026-12-08");
	assert.deepStrictEqual([s.words, s.reviewed, s.flagged, s.topics], [3, 1, 1, 2]);
	assert.ok(p.cards[1].due > now && p.cards[1].last === now);
	assert.strictEqual(p.cards[2].due, now);
	assert.deepStrictEqual([p.cards[2].pr, p.cards[2].pe], [1, 2]);
	assert.strictEqual(p.cards[3].st, "KNOWN");
	assert.strictEqual(p.topics["case-ine"].score, 70);
	assert.strictEqual(p.practice.length, 1);
	assert.deepStrictEqual(C.dueReviewIds(p, now), [2]);
	// second practice smooths the score instead of replacing it
	C.applyPractice(p, { minutes: 10, mode: "", note: "", words: [], topics: [{ id: "case-ine", score: 100 }] }, now + 1, "2026-12-09");
	assert.strictEqual(p.topics["case-ine"].score, 88);
	assert.strictEqual(p.topics["case-ine"].n, 2);
});

test("практика: теми й журнал зливаються між пристроями і переживають збереження", () => {
	const a = C.emptyProgress(), b = C.emptyProgress();
	C.applyPractice(a, { minutes: 10, mode: "", note: "", words: [], topics: [{ id: "case-ine", score: 50 }] }, 1000, "d1");
	C.applyPractice(b, { minutes: 10, mode: "", note: "", words: [], topics: [{ id: "case-ine", score: 90 }, { id: "case-par", score: 30 }] }, 2000, "d2");
	const m = C.mergeProgress(a, b);
	assert.strictEqual(m.topics["case-ine"].score, 90);
	assert.ok(m.topics["case-par"]);
	assert.strictEqual(m.practice.length, 2);
	const back = C.normalizeProgress(JSON.parse(C.progressToText(m)));
	assert.strictEqual(back.practice.length, 2);
	assert.strictEqual(back.topics["case-par"].score, 30);
	assert.strictEqual(C.progressToText(back), C.progressToText(m));
});

test("практика: підбір слів і тем, промт з форматом результату", () => {
	const now = 50 * C.DAY_MS;
	const p = C.emptyProgress();
	C.graduate(p, 1, now - 2 * C.DAY_MS);   // recent, not due
	C.graduate(p, 2, 0);                     // overdue
	C.saveMicroLevel(p, 3, "L1", now);       // in work
	C.setKnown(p, 4, true, now);             // known
	p.cards[1].pe = 3;                        // mistakes earlier
	assert.deepStrictEqual(C.selectPracticeWords(p, now, 3), [1, 2, 3]);
	p.topics["case-par"] = { score: 40, n: 1, last: 0, u: 0 };
	const rec = C.recommendTopics(p, COURSE.topics, new Map([["case-ine", 30], ["case-par", 5], ["tense-past", 50]]), 2);
	assert.deepStrictEqual(rec.map(t => t.id), ["case-par", "case-ine"]);
	assert.deepStrictEqual(C.levelStats(p, COURSE.topics, "A1"), { total: 2, mastered: 0, avg: 20 });
	assert.strictEqual(C.learnedCount(p), 3);
	const prompt = C.buildPracticePrompt({ learned: 3, goal: "A1", minutes: 15, mode: "talk", situation: "кафе", topics: [{ ...COURSE.topics[0], note: "у", table: [], score: 0, n: 0 }], words: [{ fi: "talo", tr: "будинок" }] });
	assert.ok(prompt.includes("```plan-practice") && prompt.includes("talo — будинок") && prompt.includes("case-ine") && prompt.includes("кафе"));
	// the format block of the prompt must be readable by the parser itself
	const example = prompt.slice(prompt.indexOf("```plan-practice")).replace("<слово як у моєму списку> | <скільки разів я вжив правильно> | <скільки разів з помилкою>", "talo | 1 | 0");
	assert.strictEqual(C.parsePracticeResult(example, COURSE).words[0].id, 1);
});

/* ---------- Text helpers ---------- */

test("текст: токени, вирівнювання, частини форми", () => {
	assert.deepStrictEqual(C.tokenize("Hän asuu").map(t => [t.text, t.start, t.end]), [["Hän", 0, 3], ["asuu", 4, 8]]);
	assert.deepStrictEqual(C.parseAlignment("0-0,1;1-2"), [[0, [0, 1]], [1, [2]]]);
	assert.deepStrictEqual(C.partRanges("piene+ssä"), [[0, 5], [5, 8]]);
	assert.strictEqual(C.trimNonLetters("«Puhutko?»"), "Puhutko");
});

test("словотвір: дієслово з особою і питальною часткою", () => {
	const rows = C.buildDerivation("puhua", "Puhu+t+ko", ["pos:VERB", "vtype:1"], "");
	assert.deepStrictEqual(rows.map(r => r.form), ["puhua", "Puhu-", "+ t", "+ ko"]);
	assert.ok(rows[0].explanation.includes("тип дієслова 1"));
	assert.strictEqual(rows[2].explanation, "2-га особа однини — «ти»");
	assert.ok(C.hasGradation("vesi", "vet+tä"));
	assert.ok(!C.hasGradation("talo", "talo+n"));
});

/* ---------- report ---------- */

let failed = 0;
for (const [ok, name, err] of results) {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) { failed++; console.log("      " + (err && err.message)); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
