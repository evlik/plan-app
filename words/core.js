/* Words core: pure learning logic ported from Micro-Sprint (Kotlin), no DOM.
   Runs in the browser (window.WordsCore) and in Node (require) for tests.

   Blocks:
	- Scheduler config     levels, weights, intervals (CONCEPT.md 1.2, 1.4)
	- MicroDeckScheduler   micro-deck v2: time floors, weighted window, fillers, cooling
	- FSRS                 FSRS-4.5 long-term review
	- WordInput            typed word with letter hints and attempt grading
	- Progress model       per-word state, graduation, review, "known", merge between devices
	- Text helpers         tokenize, alignment, form parts, derivation table */
"use strict";

(function (root) {

	/* ============================================================
	   Scheduler config
	   ============================================================ */

	/** Micro-deck levels in order; COOLING is the final check before release. */
	const LEVELS = ["L0", "L1", "L2", "COOLING"];

	/** Answer kinds reported to the scheduler. */
	const RESULT = { CLEAN: "CLEAN", WITH_HINT: "WITH_HINT", PEEKED: "PEEKED", WRONG: "WRONG", SWIPE_RIGHT: "SWIPE_RIGHT" };

	/** Default scheduler constants (one place to tune). */
	function defaultConfig() {
		return {
			dailyNewWords: 40,
			windowWeightLimit: 10,
			penaltyMode: "SOFT",      // SOFT: -1 level, second fail in a row -> L0; HARD: always L0
			penaltyReturnGapCards: 2,
			rules: {
				// L0 has jitter (2..4 cards) so the order does not become a predictable rotation
				L0: { minGapCards: 2, maxGapCards: 4, timeFloorMs: 0, weight: 2.0 },
				L1: { minGapCards: 4, maxGapCards: 6, timeFloorMs: 45000, weight: 1.5 },
				L2: { minGapCards: 9, maxGapCards: 12, timeFloorMs: 120000, weight: 1.0 },
				COOLING: { minGapCards: 15, maxGapCards: 25, timeFloorMs: 300000, weight: 0.5 },
			},
		};
	}

	/** Window weight limit for a "words in work at once" setting (5 x L0 weight 2.0 = 10). */
	function windowLimitForDeckSize(deckSize) {
		return deckSize * 2.0;
	}

	/* ============================================================
	   MicroDeckScheduler
	   ============================================================ */

	/** Level up one step (COOLING stays COOLING). */
	function levelUp(level) {
		return { L0: "L1", L1: "L2", L2: "COOLING", COOLING: "COOLING" }[level];
	}

	/** Penalty step: a failed COOLING goes back to L1, otherwise -1 level. */
	function levelDown(level) {
		return { L0: "L0", L1: "L0", L2: "L1", COOLING: "L1" }[level];
	}

	/**
	 * Micro-deck v2 scheduler.
	 * Invariants: a word never returns before its time floor; the window weight never exceeds the limit;
	 * a word graduates only through a clean COOLING answer.
	 * Card order: ripe word -> new word (if weight allows) -> filler -> word past its time floor -> null (pause / done).
	 */
	class MicroDeckScheduler {
		/** newWords: ids; restored: [{wordId, level}]; options: {config, clock, random, fillerSource}. */
		constructor(newWords, restored = [], { config = defaultConfig(), clock = Date.now, random = Math.random, fillerSource = () => null } = {}) {
			this.config = config;
			this.clock = clock;
			this.random = random;
			this.fillerSource = fillerSource;
			// restored words go first, keep their level and skip the presentation
			this.pool = restored.map(r => ({ wordId: r.wordId, level: r.level, presented: true }))
				.concat(newWords.slice(0, config.dailyNewWords).map(id => ({ wordId: id, level: "L0", presented: false })));
			this.active = [];
			this.graduatedIds = [];
			this.served = 0;
			this.pending = null;
			this.windowLimit = config.windowWeightLimit;
		}

		/** Words graduated in this session (mini-test candidates). */
		get graduated() { return this.graduatedIds; }

		/** True when the pool is empty and nothing is in the micro-deck. */
		get isFinished() { return this.pool.length === 0 && this.active.length === 0; }

		/** Current total weight of the active window. */
		windowWeight() { return this.active.reduce((sum, s) => sum + this.rule(s.level).weight, 0); }

		/** Number of words in the active window. */
		activeCount() { return this.active.length; }

		/** Change the window weight limit during a session (deck size setting). */
		updateWindowLimit(limit) { this.windowLimit = limit; }

		/** Return a word to the pool (failed review / failed known-check). */
		addToPool(wordId) { this.pool.push({ wordId, level: "L0", presented: false }); }

		/** New (never presented) word ids waiting in the pool. */
		pendingNewWordIds() { return this.pool.filter(p => !p.presented).map(p => p.wordId); }

		/** Number of restored words still in the pool. */
		restoredInPoolCount() { return this.pool.filter(p => p.presented).length; }

		/** Keep only the allowed new words in the pool (daily goal lowered). */
		retainPendingNew(allowed) { this.pool = this.pool.filter(p => p.presented || allowed.has(p.wordId)); }

		/** Drop words everywhere (marked "known"); true if the current card was among them. */
		dropWords(ids) {
			if (!ids.size) return false;
			this.pool = this.pool.filter(p => !ids.has(p.wordId));
			this.active = this.active.filter(s => !ids.has(s.wordId));
			this.graduatedIds = this.graduatedIds.filter(id => !ids.has(id));
			const dropped = !!this.pending && ids.has(this.pending.wordId);
			if (dropped) this.pending = null;
			return dropped;
		}

		/** Active words with ms until they may return, nearest first (pause screen). */
		activeWait(now = this.clock()) {
			return this.active.map(s => [s.wordId, Math.max(0, s.dueTime - now)]).sort((a, b) => a[1] - b[1]);
		}

		/** Pick a random element (or null for an empty list). */
		pick(list) {
			return list.length ? list[Math.floor(this.random() * list.length)] : null;
		}

		/** Next card: {type:"presentation"|"challenge", wordId, level} | {type:"filler", wordId, kind} | null. */
		nextCard() {
			if (this.pending) throw new Error("Спочатку поверніть результат попередньої картки через reportResult()");
			const now = this.clock();
			// 1. ripe word (cards and time); random among ripe ones so the order is not memorised
			const ripe = this.pick(this.active.filter(s => this.served >= s.dueCard && now >= s.dueTime));
			if (ripe) return this.serve(ripe);
			// 2. new word if the window weight allows
			const next = this.pool[0];
			if (next && this.windowWeight() + this.rule(next.level).weight <= this.windowLimit) return this.enterNewWord();
			// 3. filler
			const filler = this.fillerSource();
			if (filler) {
				this.served++;
				return { type: "filler", wordId: filler.wordId, kind: filler.kind };
			}
			// 4. time floor passed but the card gap not yet: relax the gap, never the time floor
			const timed = this.pick(this.active.filter(s => now >= s.dueTime));
			if (timed) return this.serve(timed);
			// 5. everything waits for its time floor, or the session is finished
			return null;
		}

		/** Report the answer for the pending card; returns {wordId, level, graduated}. */
		reportResult(result) {
			const slot = this.pending;
			if (!slot) throw new Error("Немає активної картки");
			this.pending = null;
			const now = this.clock();
			let graduatedNow = false;
			switch (result) {
				case RESULT.CLEAN:
					if (!slot.presented) {
						slot.presented = true;           // copy-typing after the presentation encodes, it is not a test
						this.reschedule(slot, now);
					} else if (slot.level === "COOLING") {
						this.active.splice(this.active.indexOf(slot), 1);
						this.graduatedIds.push(slot.wordId);
						graduatedNow = true;
					} else {
						slot.level = levelUp(slot.level);
						slot.failStreak = 0;
						this.reschedule(slot, now);
					}
					break;
				case RESULT.WITH_HINT:
					slot.presented = true;
					this.reschedule(slot, now);          // level neither rises nor falls
					break;
				case RESULT.PEEKED:
				case RESULT.WRONG:
					slot.presented = true;
					slot.failStreak++;
					slot.level = this.config.penaltyMode === "HARD" || slot.failStreak >= 2 ? "L0" : levelDown(slot.level);
					slot.dueCard = this.served + this.config.penaltyReturnGapCards;
					slot.dueTime = now;                  // comes back almost at once
					break;
				case RESULT.SWIPE_RIGHT:
					this.reschedule(slot, now);
					break;
				default:
					throw new Error("Невідомий результат: " + result);
			}
			return { wordId: slot.wordId, level: slot.level, graduated: graduatedNow };
		}

		/** Make a slot the pending card. */
		serve(slot) {
			this.served++;
			this.pending = slot;
			return slot.presented
				? { type: "challenge", wordId: slot.wordId, level: slot.level }
				: { type: "presentation", wordId: slot.wordId, level: slot.level };
		}

		/** Move the first pool entry into the active window and serve it. */
		enterNewWord() {
			const entry = this.pool.shift();
			const slot = { wordId: entry.wordId, level: entry.level, presented: entry.presented, dueCard: 0, dueTime: 0, failStreak: 0 };
			this.active.push(slot);
			return this.serve(slot);
		}

		/** Schedule the next return of a slot by its level rule. */
		reschedule(slot, now) {
			const r = this.rule(slot.level);
			slot.dueCard = this.served + r.minGapCards + Math.floor(this.random() * (r.maxGapCards - r.minGapCards + 1));
			slot.dueTime = now + r.timeFloorMs;
		}

		/** Rule of a level. */
		rule(level) {
			return this.config.rules[level];
		}
	}

	/* ============================================================
	   FSRS-4.5
	   ============================================================ */

	const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
	const FSRS_DECAY = -0.5;
	const FSRS_FACTOR = 19 / 81;
	const FSRS_WEIGHTS = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];

	/** Clamp x into [lo, hi]. */
	function clamp(x, lo, hi) {
		return Math.min(hi, Math.max(lo, x));
	}

	/** FSRS-4.5 scheduler; at retention 0.9 the interval equals the stability. */
	class Fsrs {
		/** w: weights, desiredRetention, maxIntervalDays. */
		constructor(w = FSRS_WEIGHTS, desiredRetention = 0.9, maxIntervalDays = 365) {
			this.w = w;
			this.desiredRetention = desiredRetention;
			this.maxIntervalDays = maxIntervalDays;
		}

		/** First schedule after graduating from the micro-deck. */
		initial(rating) {
			const stability = Math.max(this.w[rating - 1], 0.1);
			return { stability, difficulty: this.initDifficulty(rating), intervalDays: this.interval(stability) };
		}

		/** Next schedule after an answer elapsedDays after the previous review. */
		review(stability, difficulty, elapsedDays, rating) {
			const r = this.retrievability(elapsedDays, stability);
			const nextDifficulty = this.nextDifficulty(difficulty, rating);
			const nextStability = rating === RATING.AGAIN
				? this.failStability(difficulty, stability, r)
				: this.successStability(difficulty, stability, r, rating);
			return { stability: nextStability, difficulty: nextDifficulty, intervalDays: this.interval(nextStability) };
		}

		/** Probability to recall after elapsedDays at a given stability. */
		retrievability(elapsedDays, stability) {
			return Math.pow(1 + FSRS_FACTOR * elapsedDays / stability, FSRS_DECAY);
		}

		/** Interval in days for a stability (Kotlin roundToInt rounds half up). */
		interval(stability) {
			return clamp(Math.floor(stability / FSRS_FACTOR * (Math.pow(this.desiredRetention, 1 / FSRS_DECAY) - 1) + 0.5), 1, this.maxIntervalDays);
		}

		/** Initial difficulty for a rating. */
		initDifficulty(rating) {
			return clamp(this.w[4] - (rating - 3) * this.w[5], 1, 10);
		}

		/** Difficulty after an answer, with mean reversion. */
		nextDifficulty(difficulty, rating) {
			const moved = difficulty - this.w[6] * (rating - 3);
			const target = this.w[4] - this.w[5];
			return clamp(this.w[7] * target + (1 - this.w[7]) * moved, 1, 10);
		}

		/** Stability after a successful answer. */
		successStability(d, s, r, rating) {
			const hardPenalty = rating === RATING.HARD ? this.w[15] : 1;
			const easyBonus = rating === RATING.EASY ? this.w[16] : 1;
			return s * (1 + Math.exp(this.w[8]) * (11 - d) * Math.pow(s, -this.w[9]) * (Math.exp(this.w[10] * (1 - r)) - 1) * hardPenalty * easyBonus);
		}

		/** Stability after a lapse: drops and never exceeds the previous one. */
		failStability(d, s, r) {
			return Math.max(Math.min(this.w[11] * Math.pow(d, -this.w[12]) * (Math.pow(s + 1, this.w[13]) - 1) * Math.exp(this.w[14] * (1 - r)), s), 0.1);
		}
	}

	/* ============================================================
	   WordInput
	   ============================================================ */

	/** Case-insensitive char comparison (ä != a, Ä == ä). */
	function sameChar(a, b) {
		return a.toLowerCase() === b.toLowerCase();
	}

	/** Length of the common prefix of two strings (case-sensitive, like the original). */
	function commonPrefixLength(a, b) {
		let i = 0;
		while (i < a.length && i < b.length && a[i] === b[i]) i++;
		return i;
	}

	/** Immutable typed-word state; hinted[i] is true when letter i was filled in by the hint button. */
	class WordInput {
		/** target: the word to type; text: typed so far; hinted: flags per letter. */
		constructor(target, text = "", hinted = []) {
			this.target = target;
			this.text = text;
			this.hinted = hinted;
		}

		/** Number of hinted letters. */
		get hintedCount() { return this.hinted.filter(Boolean).length; }

		/** Whole word typed correctly. */
		get isComplete() { return this.text.length === this.target.length && this.firstMismatch() === null; }

		/** Same length and exactly one wrong letter (a instead of ä): a soft mistake. */
		get isNearMiss() {
			if (this.text.length !== this.target.length) return false;
			let wrong = 0;
			for (let i = 0; i < this.text.length; i++) if (!sameChar(this.text[i], this.target[i])) wrong++;
			return wrong === 1;
		}

		/** The user changed the text: everything after the common prefix counts as typed by hand. */
		userChange(next) {
			const p = commonPrefixLength(this.text, next);
			return new WordInput(this.target, next, this.hinted.slice(0, p).concat(Array(next.length - p).fill(false)));
		}

		/** Hint: replace the first wrong letter (dropping the tail) or add the next correct letter. */
		withHint() {
			const m = this.firstMismatch();
			if (m !== null) return new WordInput(this.target, this.text.slice(0, m) + this.target[m], this.hinted.slice(0, m).concat(true));
			if (this.text.length < this.target.length) return new WordInput(this.target, this.text + this.target[this.text.length], this.hinted.concat(true));
			return this;
		}

		/** Grade the attempt: clean, with hint (level stays), peeked / too many hints, wrong. */
		resultFor(peeked) {
			if (peeked) return RESULT.PEEKED;
			if (this.isComplete && this.hintedCount === 0) return RESULT.CLEAN;
			if (this.isComplete && this.hintedCount <= Math.max(2, Math.floor(this.target.length / 3))) return RESULT.WITH_HINT;
			if (this.isComplete) return RESULT.PEEKED;
			if (this.isNearMiss) return RESULT.WITH_HINT;
			return RESULT.WRONG;
		}

		/** Index of the first letter that does not match the target, or null. */
		firstMismatch() {
			for (let i = 0; i < this.text.length; i++) {
				if (i >= this.target.length || !sameChar(this.text[i], this.target[i])) return i;
			}
			return null;
		}
	}

	/* ============================================================
	   Progress model
	   Stored as {v, epoch, cards: {id: card}, topics: {id: topic}, practice: [entry], settings, su}. A word without a card is NEW.
	   card: {st, lv, iv, due, s, d, last, grad, lapses, pr, pe, u}  (pr/pe = uses in AI practice: right / with errors;
	         u = last change, ms; used to merge devices)
	   topic: {score 0-100, n sessions, last, u}   practice entry: {id, date, min, mode, words, err, topics: {id: score}, note}
	   ============================================================ */

	const PRACTICE_LOG_MAX = 300;

	const DAY_MS = 86400000;
	const FIRST_KNOWN_CHECK_DAYS = 14;
	const STAGES = ["NEW", "MICRO", "COOLING", "REVIEW", "KNOWN"];

	/** Default learning settings. */
	function defaultSettings() {
		return { goal: 40, deck: 5, auto: false, secs: 3, habit: null, introDone: false };
	}

	/** Empty progress document. `epoch` grows on a deliberate reset/import: a higher epoch replaces, never merges. */
	function emptyProgress() {
		return { v: 1, epoch: 0, cards: {}, topics: {}, practice: [], settings: defaultSettings(), su: 0 };
	}

	/** Validate and normalise a progress object read from storage or GitHub; throws on garbage. */
	function normalizeProgress(p) {
		if (!p || typeof p !== "object" || typeof p.cards !== "object" || p.cards === null) throw new Error("Невідомий формат прогресу");
		const out = emptyProgress();
		out.settings = { ...out.settings, ...(p.settings && typeof p.settings === "object" ? p.settings : {}) };
		out.su = Number(p.su) || 0;
		out.epoch = Number(p.epoch) || 0;
		for (const [id, c] of Object.entries(p.cards)) {
			if (!c || !STAGES.includes(c.st) || !/^\d+$/.test(id)) continue;
			out.cards[id] = {
				st: c.st, lv: Number(c.lv) || 0, iv: Number(c.iv) || 0,
				due: c.due ?? null, s: c.s ?? null, d: c.d ?? null, last: c.last ?? null,
				grad: c.grad ?? null, lapses: Number(c.lapses) || 0,
				pr: Number(c.pr) || 0, pe: Number(c.pe) || 0, u: Number(c.u) || 0,
			};
		}
		for (const [id, t] of Object.entries(p.topics && typeof p.topics === "object" ? p.topics : {})) {
			if (!t || !/^[\w-]+$/.test(id)) continue;
			out.topics[id] = { score: clamp(Math.round(Number(t.score) || 0), 0, 100), n: Number(t.n) || 0, last: t.last ?? null, u: Number(t.u) || 0 };
		}
		out.practice = (Array.isArray(p.practice) ? p.practice : [])
			.filter(e => e && typeof e.id === "string" && typeof e.date === "string")
			.map(e => ({
				id: e.id, date: e.date, min: Number(e.min) || 0, mode: String(e.mode || ""), words: Number(e.words) || 0,
				err: Number(e.err) || 0, topics: e.topics && typeof e.topics === "object" ? e.topics : {}, note: String(e.note || ""),
			}));
		return out;
	}

	/** Card of a word (a NEW placeholder when missing). */
	function cardOf(progress, id) {
		return progress.cards[id] || { st: "NEW", lv: 0, iv: 0, due: null, s: null, d: null, last: null, grad: null, lapses: 0, pr: 0, pe: 0, u: 0 };
	}

	/** Write a card, stamping the change time. */
	function putCard(progress, id, card, now) {
		progress.cards[id] = { ...card, u: now };
	}

	/** Save the micro-deck level after an answer. */
	function saveMicroLevel(progress, id, level, now) {
		const c = cardOf(progress, id);
		putCard(progress, id, { ...c, st: level === "COOLING" ? "COOLING" : "MICRO", lv: LEVELS.indexOf(level) }, now);
	}

	/** Days since the last review (0 when never reviewed). */
	function elapsedDays(last, now) {
		return Math.max(0, (now - (last ?? now)) / DAY_MS);
	}

	/** Graduate into long-term review: first FSRS schedule, or continue from earlier stability. */
	function graduate(progress, id, now, fsrs = new Fsrs()) {
		const c = cardOf(progress, id);
		const next = c.s == null ? fsrs.initial(RATING.GOOD) : fsrs.review(c.s, c.d ?? 5, elapsedDays(c.last, now), RATING.GOOD);
		putCard(progress, id, { ...c, st: "REVIEW", lv: 0, iv: next.intervalDays, due: now + next.intervalDays * DAY_MS, s: next.stability, d: next.difficulty, last: now, grad: now }, now);
	}

	/** Review answer: FSRS update; AGAIN sends the word back to the micro-deck (L1). */
	function reviewAnswered(progress, id, rating, now, fsrs = new Fsrs()) {
		const c = progress.cards[id];
		if (!c) return;
		const next = fsrs.review(c.s ?? 1, c.d ?? 5, elapsedDays(c.last, now), rating);
		if (rating === RATING.AGAIN) {
			putCard(progress, id, { ...c, s: next.stability, d: next.difficulty, last: now, st: "MICRO", lv: 1, lapses: c.lapses + 1 }, now);
		} else {
			putCard(progress, id, { ...c, st: "REVIEW", lv: 0, iv: next.intervalDays, due: now + next.intervalDays * DAY_MS, s: next.stability, d: next.difficulty, last: now }, now);
		}
	}

	/** Failed mini-test: back to the micro-deck at L1. */
	function demoteToMicro(progress, id, now) {
		const c = cardOf(progress, id);
		putCard(progress, id, { ...c, st: "MICRO", lv: 1, lapses: c.lapses + 1 }, now);
	}

	/** Mark a word known (with a recognition check later) or reset it to NEW. */
	function setKnown(progress, id, known, now) {
		const c = cardOf(progress, id);
		if (known) putCard(progress, id, { ...c, st: "KNOWN", lv: 0, iv: FIRST_KNOWN_CHECK_DAYS, due: now + FIRST_KNOWN_CHECK_DAYS * DAY_MS }, now);
		else putCard(progress, id, { ...c, st: "NEW", lv: 0 }, now);
	}

	/** Known-word check passed: stays known, next check in `days`. */
	function passKnownCheck(progress, id, now, days) {
		const c = cardOf(progress, id);
		putCard(progress, id, { ...c, st: "KNOWN", lv: 0, iv: days, due: now + days * DAY_MS }, now);
	}

	/** Known-word check failed: back into learning (MICRO L1). */
	function failKnownCheck(progress, id, now) {
		const c = cardOf(progress, id);
		putCard(progress, id, { ...c, st: "MICRO", lv: 1 }, now);
	}

	/** Words left in the micro-deck by an unfinished session, with their saved level. */
	function restoredWords(progress) {
		return Object.entries(progress.cards)
			.filter(([, c]) => c.st === "MICRO" || c.st === "COOLING")
			.map(([id, c]) => ({ wordId: Number(id), level: LEVELS[c.lv] || "L0" }));
	}

	/** First `limit` NEW word ids in course order (= frequency rank). */
	function newWordIds(progress, wordIds, limit) {
		const out = [];
		for (const id of wordIds) {
			if (out.length >= limit) break;
			if (cardOf(progress, id).st === "NEW") out.push(id);
		}
		return out;
	}

	/** Review words that are due, earliest first. */
	function dueReviewIds(progress, now) {
		return Object.entries(progress.cards)
			.filter(([, c]) => c.st === "REVIEW" && c.due != null && c.due <= now)
			.sort((a, b) => a[1].due - b[1].due)
			.map(([id]) => Number(id));
	}

	/** Known words due for a recognition check, earliest first. */
	function knownCheckDue(progress, now, limit) {
		return Object.entries(progress.cards)
			.filter(([, c]) => c.st === "KNOWN" && c.due != null && c.due <= now)
			.sort((a, b) => a[1].due - b[1].due)
			.slice(0, limit)
			.map(([id]) => Number(id));
	}

	/** Number of words graduated since a moment (daily goal counter). */
	function graduatedSince(progress, since) {
		return Object.values(progress.cards).filter(c => c.grad != null && c.grad >= since).length;
	}

	/**
	 * Merge two progress documents (this device and GitHub): per word the later change wins,
	 * settings follow the later settings change. Nothing is lost when both devices learned different words.
	 * Different epochs: the document with the higher epoch replaces the other as a whole (import / reset).
	 */
	function mergeProgress(a, b) {
		const ea = a.epoch || 0, eb = b.epoch || 0;
		if (ea !== eb) return normalizeProgress(JSON.parse(JSON.stringify(eb > ea ? b : a)));
		const out = emptyProgress();
		out.epoch = ea;
		const ids = new Set([...Object.keys(a.cards), ...Object.keys(b.cards)]);
		for (const id of ids) {
			const x = a.cards[id], y = b.cards[id];
			out.cards[id] = !x ? y : !y ? x : (y.u > x.u ? y : x);
		}
		const tids = new Set([...Object.keys(a.topics || {}), ...Object.keys(b.topics || {})]);
		for (const id of tids) {
			const x = (a.topics || {})[id], y = (b.topics || {})[id];
			out.topics[id] = !x ? y : !y ? x : (y.u > x.u ? y : x);
		}
		const log = new Map();
		[...(a.practice || []), ...(b.practice || [])].forEach(e => log.set(e.id, e));
		out.practice = [...log.values()].sort((x, y) => x.id.localeCompare(y.id)).slice(-PRACTICE_LOG_MAX);
		const newer = (b.su || 0) > (a.su || 0) ? b : a;
		out.settings = { ...newer.settings };
		out.su = newer.su || 0;
		return out;
	}

	/** Stable text form of a progress document (sorted ids) for comparing and saving. */
	function progressToText(p) {
		const cards = {};
		Object.keys(p.cards).sort((x, y) => x - y).forEach(id => { cards[id] = p.cards[id]; });
		const topics = {};
		Object.keys(p.topics || {}).sort().forEach(id => { topics[id] = p.topics[id]; });
		const head = JSON.stringify({ v: 1, epoch: p.epoch || 0, su: p.su, settings: p.settings, topics, practice: p.practice || [] });
		const body = Object.entries(cards).map(([id, c]) => `"${id}":${JSON.stringify(c)}`).join(",\n");
		return `${head.slice(0, -1)},"cards":{${body}}}`;
	}

	/* ============================================================
	   Practice with AI
	   The app builds a prompt; the AI ends the session with a ```plan-practice block:
		PRACTICE 1
		minutes: 20
		mode: розмова
		word: talo | 3 | 1        dictionary form | used right | used with errors
		topic: case-ine | 70 | 5 | 2   topic id | mastery 0-100 | right | errors
		note: short feedback
	   ============================================================ */

	const PRACTICE_TAG = "plan-practice";
	const LEVEL_ORDER = { A1: 0, A2: 1, B1: 2 };
	const MASTERED = 80;

	/** Human status of a topic score. */
	function topicStatus(t) {
		if (!t || !t.n) return { key: "new", label: "не почато" };
		if (t.score >= MASTERED) return { key: "done", label: "засвоєно" };
		if (t.score >= 60) return { key: "almost", label: "майже" };
		return { key: "learning", label: "вчу" };
	}

	/** Words counted as learned for goals: on long-term review or marked known. */
	function learnedCount(progress) {
		return Object.values(progress.cards).filter(c => c.st === "REVIEW" || c.st === "KNOWN").length;
	}

	/** Topic progress of one CEFR level: mastered / total and the average score. */
	function levelStats(progress, topicList, level) {
		const list = topicList.filter(t => t.level === level);
		const scores = list.map(t => (progress.topics[t.id] || {}).score || 0);
		return {
			total: list.length,
			mastered: list.filter(t => (progress.topics[t.id] || {}).score >= MASTERED).length,
			avg: list.length ? Math.round(scores.reduce((a, b) => a + b, 0) / list.length) : 0,
		};
	}

	/**
	 * Topics to work on next: lowest level first, topics already started before new ones,
	 * then the ones with most examples among learned words. usage: Map id -> examples in learned words.
	 */
	function recommendTopics(progress, topicList, usage, n = 3) {
		return topicList
			.filter(t => ((progress.topics[t.id] || {}).score || 0) < MASTERED && ((usage.get(t.id) || 0) > 0 || t.level === "A1"))
			.sort((x, y) => (LEVEL_ORDER[x.level] ?? 9) - (LEVEL_ORDER[y.level] ?? 9)
				|| ((progress.topics[y.id] || {}).n ? 1 : 0) - ((progress.topics[x.id] || {}).n ? 1 : 0)
				|| (usage.get(y.id) || 0) - (usage.get(x.id) || 0))
			.slice(0, n);
	}

	/**
	 * Words for a practice session, by priority: mistakes in earlier practice, overdue reviews,
	 * words in the micro-deck, recently graduated, then the rest of the learned words. NEW words never.
	 */
	function selectPracticeWords(progress, now, count) {
		const entries = Object.entries(progress.cards).filter(([, c]) => c.st !== "NEW").map(([id, c]) => [Number(id), c]);
		const score = c => {
			if (c.pe > c.pr / 2 && c.pe > 0) return 0;
			if (c.st === "REVIEW" && c.due != null && c.due <= now) return 1;
			if (c.st === "MICRO" || c.st === "COOLING") return 2;
			if (c.grad != null && now - c.grad < 14 * DAY_MS) return 3;
			return c.st === "KNOWN" ? 5 : 4;
		};
		return entries
			.sort((a, b) => score(a[1]) - score(b[1]) || (a[1].due ?? Infinity) - (b[1].due ?? Infinity) || a[0] - b[0])
			.slice(0, count)
			.map(([id]) => id);
	}

	/** Ukrainian name of a practice mode with the instruction for the AI. */
	const PRACTICE_MODES = {
		talk: ["розмова", "Веди простий діалог на обрану ситуацію: став мені запитання і реагуй на відповіді, як співрозмовник."],
		translate: ["переклад", "Давай мені короткі українські речення для перекладу на фінську (від простих до складніших)."],
		write: ["письмо", "Дай коротке письмове завдання (повідомлення, лист, опис) на 3–6 речень, потім розбери мій текст і дай наступне."],
		mix: ["мікс", "Чергуй: 2–3 переклади речень, коротка розмова, одне маленьке письмове завдання."],
	};

	/** Build the prompt for one practice session (all text the AI needs, ending with the result format). */
	function buildPracticePrompt({ learned, goal, minutes, mode, situation, topics, words }) {
		const [modeName, modeRule] = PRACTICE_MODES[mode] || PRACTICE_MODES.mix;
		const topicLines = topics.map(t => {
			const st = t.n ? `мій рівень зараз ${t.score}% (${t.n} практ.)` : "ще не тренував";
			const table = t.table && t.table.length ? " Правило: " + t.table.map(([l, r]) => `${l} — ${r}`).join("; ") + "." : "";
			return `- ${t.id} — ${t.title} [${t.level}]: ${t.note}${table} ${st}.`;
		});
		return [
			"Ти — мій викладач фінської. Я україномовний, пояснення давай українською.",
			`Мій рівень: вивчено ${learned} слів, ціль — ${goal}.`,
			`Сесія: ${minutes} хв, режим: ${modeName}.${situation ? ` Ситуація: ${situation}.` : ""}`,
			"",
			"ТЕМИ ГРАМАТИКИ (тренуй саме їх):",
			...topicLines,
			"",
			"СЛОВА ДЛЯ АКТИВНОГО ВЖИВАННЯ (фінська — українська):",
			words.map(w => `${w.fi} — ${w.tr}`).join("; "),
			"",
			"ПРАВИЛА:",
			`1. ${modeRule}`,
			"2. Фінська мого рівня, короткі речення. Слово поза списком — з перекладом у дужках.",
			"3. Одне завдання за раз, чекай моєї відповіді. Не давай готове фінське слово зі списку — давай український підказ, щоб я згадав сам.",
			"4. Після кожної моєї відповіді: якщо є помилка — правильний варіант і одне речення пояснення українською; потім далі.",
			"5. Кожне слово зі списку — щонайменше раз, кожна тема — щонайменше 3 рази. Веди лічильник подумки.",
			`6. Коли я напишу «кінець» або мине ${minutes} хв, виведи підсумок ОДНИМ блоком коду точно в такому форматі, без інших рядків усередині:`,
			"",
			"```" + PRACTICE_TAG,
			"PRACTICE 1",
			`minutes: ${minutes}`,
			`mode: ${modeName}`,
			"word: <слово як у моєму списку> | <скільки разів я вжив правильно> | <скільки разів з помилкою>",
			"topic: <id теми зі списку> | <засвоєння 0-100> | <правильно> | <помилок>",
			"note: <1–2 речення: що виходить, що підтягнути>",
			"```",
			"",
			"У рядках word: лише слова, які я сам вжив хоч раз (у будь-якій формі — пиши словникову форму зі списку). Можна додати й слова поза списком, якщо я їх вживав.",
			"Засвоєння теми: 0 — не можу, 50 — роблю з помилками, 80 — переважно правильно, 100 — вільно. Оцінюй чесно, за моїми відповідями в цій сесії.",
			"Почни з першого завдання.",
		].join("\n");
	}

	/** Non-negative integer from AI text (garbage -> 0). */
	function count(s) {
		const n = parseInt(String(s).replace(/[^\d]/g, ""), 10);
		return Number.isFinite(n) ? Math.min(n, 999) : 0;
	}

	/**
	 * Parse the AI result block. course: {byFi: Map lower fi -> id, topics: [{id, title}]}.
	 * Returns {minutes, mode, note, words: [{fi, id, ok, err}], topics: [{raw, id, score, ok, err}]}; throws when no block found.
	 */
	function parsePracticeResult(text, course) {
		const src = String(text || "");
		const fenced = src.match(new RegExp("```\\s*" + PRACTICE_TAG + "\\s*\\n([\\s\\S]*?)```"));
		const at = src.search(/^\s*PRACTICE\s+\d+/m);
		const body = fenced ? fenced[1] : at >= 0 ? src.slice(at) : "";
		if (!body) throw new Error("Не знайшов блок plan-practice. Скопіюй відповідь ШІ разом із блоком коду в кінці.");
		const out = { minutes: 0, mode: "", note: "", words: [], topics: [] };
		const byTitle = t => course.topics.find(x => x.id === t || x.title.toLowerCase().includes(t.toLowerCase()));
		for (const raw of body.split(/\r?\n/)) {
			const line = raw.trim().replace(/^[-*]\s*/, "");
			const m = line.match(/^(\w+)\s*:\s*(.*)$/);
			if (!m) continue;
			const key = m[1].toLowerCase(), val = m[2].trim();
			const parts = val.split("|").map(s => s.trim());
			if (key === "minutes") out.minutes = Math.min(count(val), 600);
			else if (key === "mode") out.mode = val.slice(0, 40);
			else if (key === "note") out.note = val.slice(0, 400);
			else if (key === "word" && parts[0]) {
				const fi = parts[0].toLowerCase().replace(/[.,!?;:"«»]/g, "");
				const id = course.byFi.get(fi) ?? null;
				const prev = out.words.find(w => w.fi === fi);
				if (prev) { prev.ok += count(parts[1]); prev.err += count(parts[2]); }
				else out.words.push({ fi, id, ok: count(parts[1]), err: count(parts[2]) });
			} else if (key === "topic" && parts[0]) {
				const t = byTitle(parts[0]);
				out.topics.push({ raw: parts[0], id: t ? t.id : null, score: clamp(count(parts[1]), 0, 100), ok: count(parts[2]), err: count(parts[3]) });
			}
		}
		if (!out.words.length && !out.topics.length) throw new Error("У блоці немає рядків word: чи topic: — попроси ШІ вивести підсумок у форматі з промту.");
		return out;
	}

	/**
	 * Apply a parsed practice to the progress. Errors pull a learned word to the next session;
	 * an overdue review word used only correctly counts as a successful review. Returns a summary.
	 */
	function applyPractice(progress, result, now, date, fsrs = new Fsrs()) {
		const summary = { words: 0, reviewed: 0, flagged: 0, topics: 0, err: 0 };
		for (const w of result.words) {
			if (w.id == null) continue;
			summary.words++;
			summary.err += w.err;
			const before = cardOf(progress, w.id);
			if (w.err > 0 && w.err >= w.ok && (before.st === "REVIEW" || before.st === "KNOWN")) {
				putCard(progress, w.id, { ...before, due: now }, now);
				summary.flagged++;
			} else if (w.ok > 0 && w.err === 0 && before.st === "REVIEW" && before.due != null && before.due <= now) {
				reviewAnswered(progress, w.id, RATING.GOOD, now, fsrs);
				summary.reviewed++;
			}
			const c = cardOf(progress, w.id);
			putCard(progress, w.id, { ...c, pr: (c.pr || 0) + w.ok, pe: (c.pe || 0) + w.err }, now);
		}
		const scores = {};
		for (const t of result.topics) {
			if (!t.id) continue;
			const prev = progress.topics[t.id];
			const score = prev && prev.n ? Math.round(prev.score * 0.4 + t.score * 0.6) : t.score;
			progress.topics[t.id] = { score, n: (prev ? prev.n : 0) + 1, last: now, u: now };
			scores[t.id] = score;
			summary.topics++;
		}
		progress.practice = [...(progress.practice || []), {
			id: String(now), date, min: result.minutes, mode: result.mode, words: summary.words, err: summary.err, topics: scores, note: result.note,
		}].slice(-PRACTICE_LOG_MAX);
		return summary;
	}

	/* ============================================================
	   Text helpers
	   ============================================================ */

	/** Whitespace tokens of a sentence with their [start, end) offsets (matches the course markup). */
	function tokenize(s) {
		const out = [];
		const re = /\S+/g;
		let m;
		while ((m = re.exec(s))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
		return out;
	}

	/** "0-0,1;1-2" -> [[fiIndex, [uaIndex, ...]], ...]; malformed pairs are skipped. */
	function parseAlignment(alignment) {
		return String(alignment || "").split(";").filter(p => p.trim()).map(pair => {
			const [fi, ua] = pair.split("-");
			return [Number(fi), String(ua || "").split(",").map(Number)];
		}).filter(([fi, ua]) => Number.isInteger(fi) && ua.every(Number.isInteger));
	}

	/** Ranges [start, end) of the parts of "piene+ssä" relative to the start of the form. */
	function partRanges(formParts) {
		let offset = 0;
		return formParts.split("+").map(part => {
			const r = [offset, offset + part.length];
			offset += part.length;
			return r;
		});
	}

	/** Strip non-letter characters from both ends of a token. */
	function trimNonLetters(s) {
		return s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
	}

	/** Ukrainian labels of the derivation table (same as Micro-Sprint strings.xml). */
	const DERIV = {
		infinitive: "інфінітив", dictform: "словникова форма", verbType: n => `тип дієслова ${n} (verbityyppi)`,
		classSi: "si-слово", classNen: "nen-слово", classE: "e-слово", classIrregular: "неправильне",
		stem: "основа", kpt: "KPT-чергування", ending: "закінчення", special: "особлива форма",
		leng3sg: "3-тя особа однини — подовження голосної",
		stemruleSi: "-si → -de-/-te-", stemruleNen: "-nen → -se-", stemruleE: "кінцеве -i → -e-",
		verbStemRule: { 1: "відкинь -a/-ä", 2: "відкинь -da/-dä", 3: "відкинь останній склад, додай -e", 4: "відкинь -t-", 5: "додай -tse", 6: "додай -ne" },
	};
	const V = { s1: "1-ша особа однини — «я»", s2: "2-га особа однини — «ти»", p1: "1-ша особа множини — «ми»", p2: "2-га особа множини — «ви»", p3: "3-тя особа множини — «вони»", q: "питальна частка — «чи…?»", past: "минулий час (imperfekti)" };
	const VERB_ENDING = { n: V.s1, t: V.s2, mme: V.p1, tte: V.p2, vat: V.p3, "vät": V.p3, ko: V.q, "kö": V.q, i: V.past, si: V.past };
	const N = {
		gen: "«кого/чого» або повний об'єкт (genetiivi)", plural: "множина (monikko)", par: "частковий (partitiivi)",
		ine: "«у, всередині» (inessiivi)", ade: "«на; засіб; час» (adessiivi)", all: "«на, комусь» (allatiivi)",
		ela: "«з, зсередини» (elatiivi)", abl: "«від, у когось» (ablatiivi)", ill: "«до, в» (illatiivi)",
		illPl: "«до, в», множина (illatiivi)", ess: "«у стані, у момент» (essiivi)", tra: "«стати ким/чим» (translatiivi)",
		poss1sg: "присвійний суфікс «мій» (possessiivisuffiksi)", pluralMarker: "показник множини",
	};
	const NOMINAL_ENDING = {
		n: N.gen, t: N.plural, a: N.par, "ä": N.par, ta: N.par, "tä": N.par, tta: N.par, "ttä": N.par,
		ssa: N.ine, "ssä": N.ine, lla: N.ade, "llä": N.ade, lle: N.all, sta: N.ela, "stä": N.ela, lta: N.abl, "ltä": N.abl,
		an: N.ill, en: N.ill, in: N.ill, ihin: N.illPl, na: N.ess, "nä": N.ess, ksi: N.tra, ni: N.poss1sg, j: N.pluralMarker,
	};

	/** Step-by-step derivation rows [{form, explanation}]: dictionary form -> stem rule -> one row per ending. */
	function buildDerivation(lemma, formParts, tags, fallbackNote) {
		const parts = formParts.split("+");
		const isVerb = tags.some(t => t === "pos:VERB" || t === "pos:AUX");
		const vt = tags.find(t => t.startsWith("vtype:"));
		const verbType = vt ? parseInt(vt.split(":")[1], 10) : null;
		const has = t => tags.includes(t);
		const rows = [];
		let first = isVerb ? DERIV.infinitive : DERIV.dictform;
		if (Number.isInteger(verbType)) first += " · " + DERIV.verbType(verbType);
		if (has("stem:si")) first += " · " + DERIV.classSi;
		else if (has("stem:nen")) first += " · " + DERIV.classNen;
		else if (has("stem:e")) first += " · " + DERIV.classE;
		else if (has("irregular")) first += " · " + DERIV.classIrregular;
		rows.push({ form: lemma, explanation: first });

		const stem = parts[0];
		const lowerLemma = lemma.toLowerCase(), lowerStem = stem.toLowerCase();
		const hasGradation = !lowerLemma.startsWith(lowerStem) && lowerStem !== lowerLemma;
		if (parts.length === 1) {
			if (lowerStem !== lowerLemma) rows.push({ form: stem, explanation: fallbackNote });
			return rows;
		}
		let stemText = DERIV.stem;
		const rule = Number.isInteger(verbType) ? DERIV.verbStemRule[verbType]
			: has("stem:si") ? DERIV.stemruleSi : has("stem:nen") ? DERIV.stemruleNen : has("stem:e") ? DERIV.stemruleE : null;
		if (rule) stemText += ": " + rule;
		if (hasGradation) stemText += " · " + DERIV.kpt;
		rows.push({ form: stem + "-", explanation: stemText });

		for (const ending of parts.slice(1)) {
			const key = ending.toLowerCase();
			let meaning;
			if (isVerb && key in VERB_ENDING) meaning = VERB_ENDING[key];
			else if (!isVerb && key in NOMINAL_ENDING) meaning = NOMINAL_ENDING[key];
			else if (isVerb && key.length === 1 && "aeiouyäö".includes(key)) meaning = DERIV.leng3sg;
			else if (!isVerb && key in VERB_ENDING) meaning = VERB_ENDING[key];
			else meaning = DERIV.ending;
			rows.push({ form: "+ " + ending, explanation: meaning });
		}
		return rows;
	}

	/** True when the stem changed by more than dropping an ending (consonant gradation). */
	function hasGradation(lemma, formParts) {
		const stem = formParts.split("+")[0].toLowerCase(), l = lemma.toLowerCase();
		return !l.startsWith(stem) && stem !== l;
	}

	const api = {
		LEVELS, RESULT, RATING, DAY_MS, FIRST_KNOWN_CHECK_DAYS, DERIV,
		defaultConfig, windowLimitForDeckSize, MicroDeckScheduler, Fsrs, WordInput,
		defaultSettings, emptyProgress, normalizeProgress, cardOf, saveMicroLevel, graduate, reviewAnswered,
		demoteToMicro, setKnown, passKnownCheck, failKnownCheck, restoredWords, newWordIds, dueReviewIds,
		knownCheckDue, graduatedSince, mergeProgress, progressToText,
		PRACTICE_TAG, PRACTICE_MODES, MASTERED, topicStatus, learnedCount, levelStats, recommendTopics, selectPracticeWords,
		buildPracticePrompt, parsePracticeResult, applyPractice,
		tokenize, parseAlignment, partRanges, trimNonLetters, buildDerivation, hasGradation,
	};
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.WordsCore = api;
})(typeof self !== "undefined" ? self : this);
