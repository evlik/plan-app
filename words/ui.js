/* Words tab: the Micro-Sprint learning flow inside the planner.
   Depends on words/core.js (window.WordsCore) and on globals of index.html:
   esc, toast, setHeader, render, state, sectionItems, appendToSection, save, habitList, isoDate,
   scheduleSync, updateSyncBadge, readJson, writeJson, syncConfig, ghContents, ghErrorMessage, syncError, b64encode, b64decode.

   Blocks:
	- Constants & state
	- Course loading            words/course.json, fetched once and kept in memory
	- Progress storage & sync   localStorage + words.json next to the plan in the private repo
	- Audio                     words/audio/*.ogg, slow = 0.75 playback rate
	- Session controller        port of SessionViewModel (fillers, reveal, mini-test, pause)
	- Habit                     ticks the words habit in today's plan
	- HTML helpers              word header, example with colour mapping, input cells
	- Screens                   session, browse, dictionary, word, grammar, topic, stats, settings, known, intro
	- Grammar sheet             tap on a word of a sentence
	- Events                    clicks, typing, keys, swipes, long press
	- Public API                window.Words used by index.html */
"use strict";

(function () {
	const C = window.WordsCore;

	/* ============================================================
	   Constants & state
	   ============================================================ */

	const COURSE_URL = "words/course.json";
	const AUDIO_BASE = "words/audio/";
	const AUDIO_CACHE = "words-audio-v1";
	const PROGRESS_KEY = "words.progress.v1";
	const WSYNC_BASE_KEY = "words.sync.base.v1";
	const WORDS_FILE = "words.json";
	const COURSE_TIMEOUT_MS = 30000;
	const AUDIO_TIMEOUT_MS = 20000;
	const KNOWN_CHECKS_PER_SESSION = 3;
	const KNOWN_CHECK_PASS_DAYS = 30;
	const KNOWN_CHECK_HINT_DAYS = 7;
	const SWIPE_PX = 90;
	const LONG_PRESS_MS = 450;
	const TOPIC_PAGE = 150;
	const PAIR_COLORS = ["#4db6ac", "#ba68c8", "#f0a030", "#64b5f6", "#81c784", "#a1887f"];
	const SECTION_ORDER = ["Sijamuodot", "Verbi", "Nomini", "Rakenne"];
	const SECTION_TITLES = { Sijamuodot: "Sijamuodot — відмінки", Verbi: "Verbi — дієслово", Nomini: "Nomini — іменні форми", Rakenne: "Rakenne — структура речення" };
	const PAUSE_TEXT = "Доступні зараз слова пройдено. Паузи між повтореннями навмисні — так перевіряється довга памʼять, а не коротке відлуння. Сесія продовжиться сама.";

	const W = {
		course: null,          // {words: Map id -> word, order: [ids], topics: Map id -> topic, list: [topics]}
		loading: null,         // Promise while course.json is being fetched
		error: "",
		progress: null,        // see core.js "Progress model"
		screen: "session",     // session | dict | word | grammar | topic | stats | settings | known | intro
		params: {},
		stack: [],
		sess: null,
		dictQuery: "", dictMode: "status",
		knownQuery: "",
		statsMonth: null,
		topicShown: TOPIC_PAGE,
		audioJob: null,        // offline audio download {done, total, failed, cancel}
		dragging: false,
	};

	/* ============================================================
	   Course loading
	   ============================================================ */

	/** Fetch and index course.json once; resolves when W.course is ready. */
	function loadCourse() {
		if (W.course) return Promise.resolve();
		if (W.loading) return W.loading;
		W.error = "";
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), COURSE_TIMEOUT_MS);
		W.loading = fetch(COURSE_URL, { signal: ctrl.signal })
			.then(res => {
				if (!res.ok) throw new Error(`сервер відповів ${res.status}`);
				return res.json();
			})
			.then(data => {
				if (!data || !Array.isArray(data.words) || !Array.isArray(data.topics)) throw new Error("файл курсу пошкоджений");
				const words = new Map(data.words.map(w => [w.id, w]));
				W.course = { words, order: data.words.map(w => w.id), topics: new Map(data.topics.map(t => [t.id, t])), list: data.topics };
				console.info(`[INFO] Words course loaded: ${words.size} words, ${data.topics.length} topics`);
			})
			.catch(err => {
				console.error("[ERROR] Loading course:", err);
				W.error = err.name === "AbortError" ? "Курс не завантажився за 30 с. Перевір мережу і спробуй ще раз." : `Не вдалося завантажити курс (${err.message}). Перевір мережу і спробуй ще раз.`;
			})
			.finally(() => {
				clearTimeout(timer);
				W.loading = null;
				if (state.tab === "words") render();
			});
		return W.loading;
	}

	/** Word by id (throws on unknown ids so bugs surface early). */
	function word(id) {
		const w = W.course.words.get(Number(id));
		if (!w) throw new Error("Невідоме слово " + id);
		return w;
	}

	/* ============================================================
	   Progress storage & sync
	   ============================================================ */

	/** Load progress from localStorage (empty on first run or unreadable storage). */
	function loadProgress() {
		try {
			const raw = localStorage.getItem(PROGRESS_KEY);
			return raw ? C.normalizeProgress(JSON.parse(raw)) : C.emptyProgress();
		} catch (err) {
			console.error("[ERROR] Reading words progress, starting empty:", err);
			toast("Прогрес слів не прочитався — почнемо з нуля, а GitHub підтягне збережений");
			return C.emptyProgress();
		}
	}

	/** Persist progress locally and ask for a sync a bit later. */
	function saveProgress() {
		try {
			localStorage.setItem(PROGRESS_KEY, C.progressToText(W.progress));
		} catch (err) {
			console.error("[ERROR] Saving words progress:", err);
			toast("Не вдалося зберегти прогрес слів у памʼять браузера");
		}
		scheduleSync();
		updateSyncBadge();
	}

	/** Change a setting and stamp the settings time (used when merging devices). */
	function setSetting(key, value) {
		W.progress.settings[key] = value;
		W.progress.su = Date.now();
		saveProgress();
	}

	/** Path of words.json: next to the plan file in the same repo. */
	function wordsPath(cfg) {
		const dir = cfg.path.includes("/") ? cfg.path.slice(0, cfg.path.lastIndexOf("/") + 1) : "";
		return dir + WORDS_FILE;
	}

	/** Base (last synced) words.json for the current repo, or null. */
	function wordsBase(cfg) {
		const b = readJson(WSYNC_BASE_KEY);
		return b && b.repoKey === repoKeyOf(cfg) ? b : null;
	}

	/** Same identity as the plan sync base, plus the words path. */
	function repoKeyOf(cfg) {
		return `${cfg.owner}/${cfg.repo}@${cfg.branch}:${wordsPath(cfg)}`;
	}

	/** True when there is learning data at all (nothing to upload otherwise). */
	function hasData(p) {
		return Object.keys(p.cards).length > 0 || p.su > 0;
	}

	/** True when local progress differs from the last synced words.json. */
	function isDirty() {
		const cfg = syncConfig();
		if (!cfg) return false;
		const progress = W.progress || loadProgress();
		const b = wordsBase(cfg);
		return b ? b.text !== C.progressToText(progress) : hasData(progress);
	}

	/** Write words.json to GitHub; returns the new sha. */
	async function putWords(cfg, text, sha, keepalive) {
		const d = new Date();
		const body = {
			message: `Слова: ${isoDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} (${cfg.device || "пристрій"})`,
			content: b64encode(text),
			branch: cfg.branch,
		};
		if (sha) body.sha = sha;
		const r = await ghContents(cfg, "PUT", wordsPath(cfg), body, keepalive);
		if (r.status === 200 || r.status === 201) return r.data.content.sha;
		if (r.status === 409 || r.status === 422) throw Object.assign(syncError(ghErrorMessage(r.status, r.data), true), { shaConflict: true });
		throw syncError(ghErrorMessage(r.status, r.data), r.status >= 500 || r.status === 429);
	}

	/**
	 * Sync words.json: pull, merge per word (later change wins), push when needed.
	 * Never asks the user: progress of two devices merges without loss. Returns a short status.
	 */
	async function syncProgress(cfg, keepalive = false, attempt = 0) {
		if (!W.progress) W.progress = loadProgress();
		const base = wordsBase(cfg);
		const localText = C.progressToText(W.progress);
		if (keepalive && localText.length > 45000) return "відкладено";   // keepalive bodies are limited to 64 KB
		const g = await ghContents(cfg, "GET", wordsPath(cfg), null, keepalive);
		if (g.status === 404 && !hasData(W.progress)) return "";           // nothing learned anywhere yet
		let remote = null;
		if (g.status === 200) {
			if (!g.data || typeof g.data.content !== "string" || (g.data.size > 0 && !g.data.content)) throw syncError("words.json на GitHub завеликий (> 1 МБ)", false);
			let parsed;
			try {
				parsed = C.normalizeProgress(JSON.parse(b64decode(g.data.content)));
			} catch (err) {
				throw syncError("words.json на GitHub пошкоджено — виправ або видали його в репозиторії", false);
			}
			remote = { sha: g.data.sha, progress: parsed, text: C.progressToText(parsed) };
		} else if (g.status !== 404) {
			throw syncError(ghErrorMessage(g.status, g.data), g.status >= 500 || g.status === 429);
		}
		if (remote && base && remote.sha === base.sha && localText === base.text) return "актуально";

		const merged = remote ? C.mergeProgress(W.progress, remote.progress) : W.progress;
		const mergedText = C.progressToText(merged);
		if (mergedText !== localText) {
			W.progress = merged;
			try { localStorage.setItem(PROGRESS_KEY, mergedText); } catch (err) { console.error("[ERROR] Saving merged words progress:", err); }
		}
		if (remote && mergedText === remote.text) {
			writeJson(WSYNC_BASE_KEY, { repoKey: repoKeyOf(cfg), sha: remote.sha, text: mergedText, at: Date.now() });
			return mergedText !== localText ? "підтягнуто" : "актуально";
		}
		try {
			const sha = await putWords(cfg, mergedText, remote && remote.sha, keepalive);
			writeJson(WSYNC_BASE_KEY, { repoKey: repoKeyOf(cfg), sha, text: mergedText, at: Date.now() });
			return "збережено";
		} catch (err) {
			if (err.shaConflict && attempt < 1) return syncProgress(cfg, keepalive, attempt + 1);
			throw err;
		}
	}

	/* ============================================================
	   Audio
	   ============================================================ */

	let audioEl = null;

	/** Play one clip; missing files and blocked autoplay are ignored (learning goes on). */
	function play(file, slow = false) {
		try {
			if (audioEl) audioEl.pause();
			const a = new Audio(AUDIO_BASE + file);
			a.preservesPitch = true;
			a.defaultPlaybackRate = a.playbackRate = slow ? 0.75 : 1;
			a.play().catch(err => console.warn("[WARNING] Audio not played:", file, err.name));
			audioEl = a;
		} catch (err) {
			console.warn("[WARNING] Audio:", err);
		}
	}

	/** Pronounce a word. */
	function playWord(id) { play(`w${id}.ogg`); }

	/** Pronounce an example sentence (slow = 0.75). */
	function playExample(id, i, slow) { play(`s${id}_${i}.ogg`, slow); }

	/** Fetch with a timeout. */
	async function fetchWithTimeout(url, ms, signal) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), ms);
		const onAbort = () => ctrl.abort();
		signal.addEventListener("abort", onAbort);
		try {
			return await fetch(url, { signal: ctrl.signal });
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Download every clip into the offline audio cache (6 at a time, 2 retries with backoff). */
	async function downloadAudio() {
		if (W.audioJob) return;
		if (!("caches" in window)) return toast("Цей браузер не вміє зберігати файли офлайн");
		const files = [];
		for (const id of W.course.order) files.push(`w${id}.ogg`, `s${id}_0.ogg`);
		const ctrl = new AbortController();
		const job = W.audioJob = { done: 0, total: files.length, failed: 0, cancel: () => ctrl.abort() };
		const update = () => { const el = document.getElementById("wAudioJob"); if (el) el.textContent = audioJobText(); };
		try {
			const cache = await caches.open(AUDIO_CACHE);
			let next = 0;
			const worker = async () => {
				while (next < files.length && !ctrl.signal.aborted) {
					const url = new URL(AUDIO_BASE + files[next++], location.href).href;
					if (!(await cache.match(url))) {
						let ok = false;
						for (let attempt = 0; attempt < 3 && !ok && !ctrl.signal.aborted; attempt++) {
							try {
								if (attempt) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
								const res = await fetchWithTimeout(url, AUDIO_TIMEOUT_MS, ctrl.signal);
								if (res.ok) { await cache.put(url, res); ok = true; }
							} catch (err) {
								if (ctrl.signal.aborted) break;
								console.warn("[WARNING] Audio download retry:", url, err.name);
							}
						}
						if (!ok && !ctrl.signal.aborted) job.failed++;
					}
					job.done++;
					if (job.done % 20 === 0) update();
				}
			};
			await Promise.all([...Array(6)].map(worker));
			const msg = ctrl.signal.aborted ? "Завантаження зупинено" : job.failed ? `Озвучку завантажено, ${job.failed} файлів не вдалося — натисни ще раз` : "Озвучка доступна офлайн";
			console.info("[INFO]", msg, job);
			toast(msg);
		} catch (err) {
			console.error("[ERROR] Audio download:", err);
			toast("Не вдалося зберегти озвучку: " + err.message);
		} finally {
			W.audioJob = null;
			if (state.tab === "words" && W.screen === "settings") redraw();
		}
	}

	/** Progress line of the audio download. */
	function audioJobText() {
		const j = W.audioJob;
		return j ? `Завантажую ${j.done} / ${j.total}${j.failed ? `, помилок ${j.failed}` : ""}…` : "";
	}

	/* ============================================================
	   Session controller
	   ============================================================ */

	/** Local midnight today, ms. */
	function startOfToday() {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	/** Build a new session from the saved progress (restored words first, then new words up to the goal). */
	function startSession() {
		const p = W.progress, now = Date.now(), set = p.settings;
		stopTimers();
		// old "known" words without a check date get their first check
		for (const [id, c] of Object.entries(p.cards)) if (c.st === "KNOWN" && c.due == null) C.passKnownCheck(p, id, now, C.FIRST_KNOWN_CHECK_DAYS);
		const has = id => W.course.words.has(id);
		const graduatedToday = C.graduatedSince(p, startOfToday());
		const restored = C.restoredWords(p).filter(r => has(r.wordId));
		const remaining = Math.max(0, set.goal - graduatedToday - restored.length);
		const s = {
			day: isoDate(new Date()), graduatedToday,
			reviewQueue: C.dueReviewIds(p, now).filter(has),
			knownQueue: C.knownCheckDue(p, now, KNOWN_CHECKS_PER_SESSION).filter(has),
			miniQueue: [], miniWord: null, card: null, input: new C.WordInput(""), peeked: false,
			feedback: null, reveal: null, done: null, history: [], browseDepth: 0, openTr: new Set(),
			pauseTimer: null, autoTimer: null, stepTimer: null,
		};
		const config = { ...C.defaultConfig(), dailyNewWords: set.goal, windowWeightLimit: C.windowLimitForDeckSize(set.deck) };
		s.scheduler = new C.MicroDeckScheduler(C.newWordIds(p, W.course.order, remaining), restored, {
			config,
			fillerSource: () => {
				// due reviews first; known-word checks only when there are no reviews
				if (s.reviewQueue.length) return { wordId: s.reviewQueue.shift(), kind: "REVIEW_DUE" };
				if (s.knownQueue.length) return { wordId: s.knownQueue.shift(), kind: "KNOWN_CHECK" };
				return null;
			},
		});
		W.sess = s;
		saveProgress();
		console.info(`[INFO] Words session: ${remaining} new, ${restored.length} restored, ${s.reviewQueue.length} reviews`);
		advance();
	}

	/** Cancel every pending timer of the session. */
	function stopTimers() {
		const s = W.sess;
		if (!s) return;
		clearInterval(s.pauseTimer);
		clearTimeout(s.autoTimer);
		clearTimeout(s.stepTimer);
		s.pauseTimer = s.autoTimer = s.stepTimer = null;
	}

	/** Id of the card currently on screen (for the history). */
	function currentId(s) {
		if (s.card) return s.card.wordId;
		return s.miniWord ? s.miniWord.id : null;
	}

	/** Remember the word just shown, for the history button. */
	function pushHistory(s) {
		const id = currentId(s);
		if (id != null && s.history[s.history.length - 1] !== id) s.history.push(id);
	}

	/** Go to the next card: scheduler card, mini-test, pause or done. */
	function advance() {
		const s = W.sess;
		stopTimers();
		s.reveal = null;
		s.feedback = null;
		s.peeked = false;
		s.openTr.clear();
		pushHistory(s);
		if (s.miniWord) return redraw();
		const next = s.scheduler.nextCard();
		s.card = next;
		if (next) {
			s.input = new C.WordInput(word(next.wordId).fi);
			if (next.type === "presentation") playWord(next.wordId);
		} else if (s.scheduler.isFinished) {
			return startMiniTest();
		} else {
			startPause();
		}
		redraw();
	}

	/** Pause: everything waits for its time floor; tick every second and continue automatically. */
	function startPause() {
		const s = W.sess;
		clearInterval(s.pauseTimer);
		s.pauseTimer = setInterval(() => {
			if (W.sess !== s) return clearInterval(s.pauseTimer);
			const waits = s.scheduler.activeWait();
			if (!waits.length || waits[0][1] <= 0) return advance();
			const el = document.getElementById("wPause");
			if (el && state.tab === "words") el.innerHTML = pauseInner(waits);
		}, 1000);
	}

	/** Mini-test: every word graduated this session, shuffled, one clean input. */
	function startMiniTest() {
		const s = W.sess;
		if (!s.scheduler.graduated.length) {
			s.done = 0;
			return redraw();
		}
		if (!s.miniQueue.length) s.miniQueue = shuffle(s.scheduler.graduated.slice());
		nextMiniTest();
	}

	/** Fisher-Yates shuffle in place. */
	function shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	/** Next mini-test word, or the done screen. */
	function nextMiniTest() {
		const s = W.sess;
		stopTimers();
		s.reveal = null;
		s.peeked = false;
		s.openTr.clear();
		pushHistory(s);
		const id = s.miniQueue.shift();
		if (id == null) {
			s.miniWord = null;
			if (!s.scheduler.isFinished) return advance();   // the goal grew during the mini-test
			s.done = s.scheduler.graduated.length;
			return redraw();
		}
		s.miniWord = word(id);
		s.card = null;
		s.input = new C.WordInput(s.miniWord.fi);
		redraw();
	}

	/** Typed text changed. */
	function onTyped(value) {
		const s = W.sess;
		if (!s || s.feedback || s.reveal) return syncInputValue();
		s.input = s.input.userChange(value.replace(/\s+/g, ""));
		syncInputValue();
		if (s.input.isComplete) return finishAttempt();
		updateCells();
	}

	/** Hint button: put in the next correct letter. */
	function onHint() {
		const s = W.sess;
		if (!s || s.feedback || s.reveal || s.miniWord) return;
		s.input = s.input.withHint();
		syncInputValue();
		if (s.input.isComplete) return finishAttempt();
		updateCells();
	}

	/** Peek button: show the Finnish word as a watermark (penalised). */
	function onPeek() {
		const s = W.sess;
		if (!s || s.feedback || s.reveal || s.miniWord) return;
		s.peeked = true;
		redraw();
	}

	/** Enter: empty input is ignored, an incomplete one counts as a mistake. */
	function onSubmit() {
		const s = W.sess;
		if (!s) return;
		if (s.reveal) return onRevealAction("TAP");
		if (s.feedback || !s.input.text) return;
		finishAttempt();
	}

	/** Grade the attempt and show feedback or the reveal. */
	function finishAttempt() {
		const s = W.sess, now = Date.now(), p = W.progress;
		if (s.miniWord) {
			const w = s.miniWord;
			if (!(s.input.isComplete || s.input.isNearMiss)) { C.demoteToMicro(p, w.id, now); saveProgress(); }
			return showReveal({ word: w, correct: s.input.isComplete, typed: s.input.text, pendingResult: null, canKeep: false, canGraduate: false, kind: "MINI_TEST" });
		}
		const c = s.card;
		if (!c) return;
		if (c.type === "presentation") {
			// copy-typing encodes the word; short confirmation and on
			const out = s.scheduler.reportResult(C.RESULT.CLEAN);
			C.saveMicroLevel(p, out.wordId, out.level, now);
			saveProgress();
			s.feedback = { correct: true };
			updateCells();
			s.stepTimer = setTimeout(advance, 350);
			return;
		}
		const result = s.input.resultFor(s.peeked);
		if (c.type === "challenge") {
			const correct = s.input.isComplete && (result === C.RESULT.CLEAN || result === C.RESULT.WITH_HINT);
			// the report waits for the reveal: a swipe may replace the result
			return showReveal({
				word: word(c.wordId), correct, typed: s.input.text, pendingResult: result, canKeep: correct,
				canGraduate: correct && c.level === "COOLING" && result === C.RESULT.CLEAN, kind: "SCHEDULED",
			});
		}
		// filler
		const id = c.wordId;
		if (c.kind === "KNOWN_CHECK") {
			// recognition check of a known word: no reveal
			if (s.input.isComplete && result === C.RESULT.CLEAN) C.passKnownCheck(p, id, now, KNOWN_CHECK_PASS_DAYS);
			else if (result === C.RESULT.WITH_HINT) C.passKnownCheck(p, id, now, KNOWN_CHECK_HINT_DAYS);
			else { C.failKnownCheck(p, id, now); s.scheduler.addToPool(id); }
			saveProgress();
			s.feedback = { correct: s.input.isComplete };
			updateCells();
			s.stepTimer = setTimeout(advance, 450);
			return;
		}
		// review filler: implicit FSRS rating (clean GOOD, hint HARD, otherwise AGAIN)
		const rating = result === C.RESULT.CLEAN ? C.RATING.GOOD : result === C.RESULT.WITH_HINT ? C.RATING.HARD : C.RATING.AGAIN;
		C.reviewAnswered(p, id, rating, now);
		saveProgress();
		if (rating === C.RATING.AGAIN) s.scheduler.addToPool(id);
		showReveal({ word: word(id), correct: s.input.isComplete, typed: s.input.text, pendingResult: null, canKeep: false, canGraduate: false, kind: "FILLER" });
	}

	/** Show the reveal; with auto-advance on, move on by itself after N seconds. */
	function showReveal(r) {
		const s = W.sess;
		s.reveal = r;
		stopTimers();
		playWord(r.word.id);
		if (W.progress.settings.auto) {
			s.autoTimer = setTimeout(() => { if (s.reveal === r) onRevealAction("TAP"); }, W.progress.settings.secs * 1000);
		}
		redraw();
	}

	/** Reveal gesture: TAP = next, SWIPE_RIGHT = "still swimming", SWIPE_LEFT = graduate (after a clean cooling). */
	function onRevealAction(action) {
		const s = W.sess, r = s && s.reveal;
		if (!r) return;
		stopTimers();
		if (r.kind === "MINI_TEST") return nextMiniTest();
		if (r.kind === "FILLER") return advance();
		if (action === "SWIPE_LEFT" && !r.canGraduate) return;
		const result = action === "SWIPE_RIGHT" && r.canKeep ? C.RESULT.SWIPE_RIGHT : r.pendingResult;
		const out = s.scheduler.reportResult(result);
		const now = Date.now();
		if (out.graduated) {
			s.graduatedToday++;
			C.graduate(W.progress, out.wordId, now);
		} else {
			C.saveMicroLevel(W.progress, out.wordId, out.level, now);
		}
		saveProgress();
		if (out.graduated) tickHabit(s.graduatedToday);
		advance();
	}

	/** Daily goal changed: shrink or refill the queue of new words, never touching words in work. */
	function adjustPoolToGoal(goal) {
		const s = W.sess;
		if (!s) return;
		const pending = s.scheduler.pendingNewWordIds();
		const committed = s.graduatedToday + s.scheduler.activeCount() + s.scheduler.restoredInPoolCount();
		const desired = Math.max(0, goal - committed);
		if (desired < pending.length) {
			s.scheduler.retainPendingNew(new Set(pending.slice(0, desired)));
		} else if (desired > pending.length) {
			const exclude = new Set([...pending, currentId(s)]);
			C.newWordIds(W.progress, W.course.order, desired + exclude.size)
				.filter(id => !exclude.has(id))
				.slice(0, desired - pending.length)
				.forEach(id => s.scheduler.addToPool(id));
		}
		if (s.done != null && !s.scheduler.isFinished) {
			s.done = null;
			advance();
		}
	}

	/** Remove words just marked "known" from the running session. */
	function refreshKnownExclusions() {
		const s = W.sess;
		if (!s) return;
		const known = new Set(Object.entries(W.progress.cards).filter(([, c]) => c.st === "KNOWN").map(([id]) => Number(id)));
		if (!known.size) return;
		const dropped = s.scheduler.dropWords(known);
		s.reviewQueue = s.reviewQueue.filter(id => !known.has(id));
		if (s.miniWord && known.has(s.miniWord.id)) nextMiniTest();
		else if (dropped || (s.reveal && known.has(s.reveal.word.id))) advance();
	}

	/* ============================================================
	   Habit
	   ============================================================ */

	/** Habit that the words tab ticks: the chosen one, or the first habit about words. */
	function habitName() {
		const habits = habitList();
		const chosen = W.progress.settings.habit;
		if (chosen === "-") return null;
		if (chosen && habits.includes(chosen)) return chosen;
		return habits.find(h => /слів|слова|words|sana/i.test(h)) || null;
	}

	/** Tick the habit in today's plan once enough words graduated today (number in the habit name, else 5). */
	function tickHabit(graduatedToday) {
		const name = habitName();
		if (!name) return;
		const m = name.match(/(\d+)/);
		const threshold = Math.min(m ? Number(m[1]) : 5, W.progress.settings.goal);
		if (graduatedToday < threshold) return;
		const id = isoDate(new Date());
		const line = sectionItems("day", id).find(i => i.el.kind === "habits");
		if (line && line.el.names.includes(name)) return;
		if (line) state.lines[line.idx] = `habits: ${[...line.el.names, name].join(", ")}`;
		else appendToSection("day", id, `habits: ${name}`);
		save();   // no render(): the words screen stays as it is
		toast(`Звичку «${name}» відмічено в плані`);
		console.info("[INFO] Words habit ticked:", name);
	}

	/* ============================================================
	   HTML helpers
	   ============================================================ */

	/** Icon button. */
	function ibtn(icon, action, label, extra = "") {
		return `<button type="button" class="w-ibtn" data-w="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}><i class="wi wi-${icon}"></i></button>`;
	}

	/** Word title (tap = pronounce) and translation chips. */
	function wordHeader(w, accent = false) {
		return `<div class="w-fi ${accent ? "acc" : ""}" data-w="say" data-id="${w.id}">${esc(w.fi)}</div>
			<div class="w-chips">${w.tr.map(t => `<span class="w-chip">${esc(t)}</span>`).join("")}</div>`;
	}

	/** Colour of an alignment pair. */
	function pairColor(i) {
		return PAIR_COLORS[i % PAIR_COLORS.length];
	}

	/** Index of the token that carries the active word form (-1 when not found). */
	function targetIndex(ex, tokens) {
		const form = ex.fp.replace(/\+/g, "");
		return tokens.findIndex(t => C.trimNonLetters(t.text) === form);
	}

	/** Finnish sentence with colour pairs; the active form is bold, its endings underlined; tokens are tappable. */
	function fiSentenceHtml(w, exIndex, ex) {
		const tokens = C.tokenize(ex.fi);
		const tgt = targetIndex(ex, tokens);
		const colors = {};
		C.parseAlignment(ex.al).forEach(([fi], i) => { if (fi !== tgt) colors[fi] = pairColor(i); });
		const form = ex.fp.replace(/\+/g, "");
		return tokens.map((t, i) => {
			const attrs = `class="w-tok ${i === tgt ? "tgt" : ""}" data-w="tok" data-id="${w.id}" data-ex="${exIndex}" data-tok="${i}"`;
			if (i === tgt) {
				const at = Math.max(0, t.text.indexOf(form));
				const inner = C.partRanges(ex.fp).map(([a, b], k) => `<b class="${k ? "e" : ""}">${esc(form.slice(a, b))}</b>`).join("");
				return `<span ${attrs}>${esc(t.text.slice(0, at))}${inner}${esc(t.text.slice(at + form.length))}</span>`;
			}
			const color = colors[i] ? `style="color:${colors[i]}"` : `style="color:var(--muted)"`;
			return `<span ${attrs} ${color}>${esc(t.text)}</span>`;
		}).join(" ");
	}

	/** Translation with the same colour pairs. */
	function uaSentenceHtml(ex) {
		const fiTokens = C.tokenize(ex.fi);
		const tgt = targetIndex(ex, fiTokens);
		const style = {};
		C.parseAlignment(ex.al).forEach(([fi, uas], i) => {
			uas.forEach(u => { style[u] = fi === tgt ? "tgt" : pairColor(i); });
		});
		return C.tokenize(ex.ua).map((t, i) => style[i] === "tgt" ? `<span class="tgt">${esc(t.text)}</span>`
			: style[i] ? `<span style="color:${style[i]}">${esc(t.text)}</span>` : esc(t.text)).join(" ");
	}

	/** One example: audio, coloured sentence, translation slot, sentence topics. */
	function exampleHtml(w, exIndex, openTr) {
		const ex = w.ex[exIndex];
		const key = `${w.id}:${exIndex}`;
		const topics = (ex.st || []).map(id => W.course.topics.get(id)).filter(Boolean);
		return `<div class="w-ex">
			<div class="w-ex-line">${ibtn("audio", "sayex", "Вимова (довге натискання — повільно)", `data-id="${w.id}" data-ex="${exIndex}"`)}<span>${fiSentenceHtml(w, exIndex, ex)}</span></div>
			<div class="w-tr">${openTr.has(key)
				? `<span class="w-tr-text" data-w="trtoggle" data-key="${key}">${uaSentenceHtml(ex)}</span>`
				: ibtn("translate", "trtoggle", "Показати переклад", `data-key="${key}"`)}</div>
			${topics.length ? `<div class="w-topics">${topics.map(t => `<button type="button" data-w="topic" data-topic="${esc(t.id)}">${esc(t.title)}</button>`).join("")}</div>` : ""}
		</div>`;
	}

	/** All examples of a word. */
	function examplesHtml(w, openTr) {
		return w.ex.map((_, i) => exampleHtml(w, i, openTr)).join("");
	}

	/** Input cells: one cell per typed letter plus an empty one (the length is never shown). */
	function cellsHtml() {
		const s = W.sess, inp = s.input;
		const fb = s.feedback;
		const count = inp.text.length + (fb ? 0 : 1);
		const cells = [...inp.text].map((ch, i) => `<span class="w-cell ${inp.hinted[i] ? "h" : ""}">${esc(ch)}</span>`).join("")
			+ (fb ? "" : '<span class="w-cell caret"></span>');
		return `<div id="wCells" class="w-cells ${count > 9 ? "compact" : ""} ${fb ? (fb.correct ? "ok" : "bad") : ""}" data-w="focus">${cells}</div>`;
	}

	/** Typed word with wrong letters struck through. */
	function diffHtml(typed, target) {
		return [...typed].map((ch, i) => i < target.length && ch.toLowerCase() === target[i].toLowerCase() ? esc(ch) : `<s>${esc(ch)}</s>`).join("");
	}

	/** m:ss */
	function fmtWait(ms) {
		const t = Math.max(0, Math.floor(ms / 1000));
		return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
	}

	/** Inner part of the pause screen (re-drawn every second). */
	function pauseInner(waits) {
		return `<div class="w-timer">${fmtWait(waits.length ? waits[0][1] : 0)}</div>
			<div class="w-waits">${waits.slice(0, 7).map(([id, ms]) => `<div><span>${esc(word(id).fi)}</span><span class="w-muted">${fmtWait(ms)}</span></div>`).join("")}</div>`;
	}

	/* ============================================================
	   Screens
	   ============================================================ */

	/** Full HTML of the current screen. */
	function screenHtml() {
		if (W.error) return `<div class="w-stage"><p>${esc(W.error)}</p><button class="primary" data-w="retry">Спробувати ще раз</button></div>`;
		if (!W.course) return '<div class="w-stage w-muted">Завантажую курс…</div>';
		switch (W.screen) {
			case "intro": return introHtml();
			case "dict": return dictHtml();
			case "word": return wordDetailHtml();
			case "grammar": return grammarHtml();
			case "topic": return topicHtml();
			case "stats": return statsHtml();
			case "settings": return settingsHtml();
			case "known": return knownHtml();
			default: return sessionHtml();
		}
	}

	/** Back button for sub-screens. */
	function backBar(extra = "") {
		return `<div class="w-bar">${ibtn("back", "back", "Назад")}<span class="sp"></span>${extra}</div>`;
	}

	/** Session screen: top bar plus the current state. */
	function sessionHtml() {
		const s = W.sess;
		if (!s || s.day !== isoDate(new Date()) && !s.reveal && !s.feedback) startSessionQuiet();
		const ss = W.sess;
		const canBack = ss.history.length > ss.browseDepth;
		const bar = `<div class="w-bar">${ibtn("history", "histback", "Попереднє слово", canBack ? "" : "disabled")}<span class="sp"></span>
			${ibtn("dictionary", "go", "Словник", 'data-to="dict"')}${ibtn("grammar", "go", "Граматика", 'data-to="grammar"')}
			${ibtn("stats", "go", "Статистика", 'data-to="stats"')}${ibtn("settings", "go", "Налаштування", 'data-to="settings"')}</div>`;
		return bar + `<div class="w-stage" id="wStage">${stageHtml(ss)}</div>`;
	}

	/** Start a session without drawing (used while building HTML). */
	function startSessionQuiet() {
		const draw = W.drawing;
		W.drawing = true;
		try { startSession(); } finally { W.drawing = draw; }
	}

	/** The centre of the session screen. */
	function stageHtml(s) {
		const browse = s.browseDepth ? s.history[s.history.length - s.browseDepth] : null;
		if (browse != null) {
			const w = word(browse);
			return `<div class="w-reveal" data-w="browseexit">${wordHeader(w)}<div style="height:20px"></div>${examplesHtml(w, s.openTr)}
				<div class="w-tapme">тап — назад до сесії</div></div>`;
		}
		if (s.reveal) return revealHtml(s.reveal, s);
		if (s.done != null) {
			const goal = W.progress.settings.goal;
			return `<div class="w-done"><i class="wi wi-done"></i><div class="w-big">${s.done}</div>
				<p class="w-muted">${s.graduatedToday >= goal ? "Ціль дня виконано. Повтори прийдуть самі в наступні дні." : "На сьогодні все. Збільш ціль у налаштуваннях, якщо хочеш ще."}</p></div>`;
		}
		if (s.miniWord) {
			return `<div class="w-prompt">${esc(s.miniWord.tr[0])}</div><div class="w-sub" style="margin:8px 0 34px">перевірка сесії</div>${cellsHtml()}`;
		}
		const c = s.card;
		if (!c) {
			return `<div class="w-title">Картки відпочивають</div><p class="w-muted" style="max-width:420px">${esc(PAUSE_TEXT)}</p>
				<div id="wPause">${pauseInner(s.scheduler.activeWait())}</div>`;
		}
		const w = word(c.wordId);
		if (c.type === "presentation") {
			return `${wordHeader(w)}<div style="height:18px"></div>${examplesHtml(w, s.openTr)}<div style="height:20px"></div>${cellsHtml()}
				<div class="w-tools"><span></span>${keysHtml()}<span></span></div>`;
		}
		// challenge or filler: only the Ukrainian word, the input and two tools
		return `<div class="w-prompt ${c.type === "challenge" && c.level === "COOLING" ? "cool" : ""}">${esc(w.tr[0])}</div>
			<div class="w-peekslot">${s.peeked ? esc(w.fi) : ""}</div>
			${cellsHtml()}
			<div class="w-tools">${ibtn("peek", "peek", "Підглянути (штраф)")}${keysHtml()}${ibtn("hint", "hint", "Підставити літеру")}</div>`;
	}

	/** ä / ö buttons for keyboards without Finnish letters. */
	function keysHtml() {
		return `<div class="w-keys"><button type="button" data-w="key" data-ch="ä" tabindex="-1">ä</button><button type="button" data-w="key" data-ch="ö" tabindex="-1">ö</button></div>`;
	}

	/** Reveal after an answer: word, chips, examples; tap = next, swipes as in the app. */
	function revealHtml(r, s) {
		return `<div class="w-reveal" id="wReveal" data-w="revealtap">
			${r.correct ? "" : `<div class="w-diff">${diffHtml(r.typed, r.word.fi)}</div>`}
			${wordHeader(r.word, r.canGraduate)}
			<div style="height:20px"></div>${examplesHtml(r.word, s.openTr)}
			${r.canGraduate ? '<button type="button" class="w-grad" data-w="graduate">← вивчено</button>' : ""}
			<div class="w-tapme">${r.canKeep ? "тап або Enter — далі · свайп вправо — «ще плаваю»" : "тап або Enter — далі"}</div>
		</div>`;
	}

	/** First run: explain the method, offer to mark known words. */
	function introHtml() {
		return `<div class="w-stage">
			<div class="w-title">Tervetuloa!</div>
			<p class="w-muted" style="max-width:440px">${W.course.order.length} найуживаніших фінських слів з прикладами й озвучкою. Ти бачиш українське слово і вводиш фінське. Нові слова крутяться в маленькій колоді з паузами, вивчені повертаються на повторення через дні.</p>
			<div class="row" style="justify-content:center">
				<button data-w="go" data-to="known">Позначити, що вже знаю</button>
				<button class="primary" data-w="introdone">Почати</button>
			</div></div>`;
	}

	/** Dictionary: search plus grouping by status / theme / A–Z. */
	function dictHtml() {
		return `${backBar()}
			<div class="w-search"><i class="wi wi-search"></i><input id="wDictQ" value="${esc(W.dictQuery)}" placeholder="пошук…" autocomplete="off" autocapitalize="off"></div>
			<div class="w-modes" id="wModes" ${W.dictQuery ? 'hidden' : ""}>${[["status", "Статус"], ["theme", "Теми"], ["abc", "А–Я"]].map(([k, t]) =>
				`<button type="button" class="${W.dictMode === k ? "on" : ""}" data-w="dictmode" data-mode="${k}">${t}</button>`).join("")}</div>
			<div id="wList">${dictListHtml()}</div>`;
	}

	/** Stage of a word. */
	function stageOf(id) {
		return C.cardOf(W.progress, id).st;
	}

	/** Groups of the dictionary list. */
	function dictGroups() {
		const all = W.course.order.map(id => word(id)).sort((a, b) => a.fi.localeCompare(b.fi, "fi"));
		const q = W.dictQuery.trim().toLowerCase();
		if (q) {
			const found = all.filter(w => w.fi.toLowerCase().includes(q) || w.tr.some(t => t.toLowerCase().includes(q)));
			return found.length ? [["Знайдено", found]] : [];
		}
		if (W.dictMode === "theme" || W.dictMode === "abc") {
			const key = W.dictMode === "theme" ? (w => w.cat || "Різне") : (w => w.fi[0].toUpperCase());
			const map = new Map();
			all.forEach(w => { const k = key(w); if (!map.has(k)) map.set(k, []); map.get(k).push(w); });
			return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], W.dictMode === "abc" ? "fi" : "uk"));
		}
		const by = st => all.filter(w => st.includes(stageOf(w.id)));
		return [["В роботі", by(["MICRO", "COOLING"])], ["На повторенні", by(["REVIEW"])], ["Вивчені", by(["KNOWN"])], ["Попереду", by(["NEW"])]]
			.filter(([, list]) => list.length);
	}

	/** Dictionary rows (re-drawn on search without touching the search field). */
	function dictListHtml() {
		const groups = dictGroups();
		if (!groups.length) return '<p class="w-muted">Нічого не знайдено</p>';
		return groups.map(([label, list]) => {
			const learned = list.filter(w => ["REVIEW", "KNOWN"].includes(stageOf(w.id))).length;
			return `<div class="w-gh">${esc(label)}<span>${learned ? `${learned} / ${list.length}` : list.length}</span></div>`
				+ list.map(w => `<div class="w-row" data-w="openword" data-id="${w.id}"><span class="w-dot ${stageOf(w.id)}"></span><span>${esc(w.fi)}</span><span class="tr">${esc(w.tr.join(", "))}</span></div>`).join("");
		}).join("");
	}

	/** Word card from the dictionary: stage, chips, examples with the full grammar layer. */
	function wordDetailHtml() {
		const w = word(W.params.wordId);
		const c = C.cardOf(W.progress, w.id);
		const cat = w.cat || "Різне";
		const days = c.due != null ? Math.max(0, Math.floor((c.due - Date.now()) / C.DAY_MS)) : null;
		const stage = {
			NEW: `попереду · тема: ${cat}`, MICRO: `у мікро-колоді · тема: ${cat}`, COOLING: `у мікро-колоді · тема: ${cat}`,
			KNOWN: `вивчено · тема: ${cat}`, REVIEW: days != null ? `на повторенні · наступний повтор через ${days} дн` : "на повторенні",
		}[c.st];
		return `${backBar()}<div style="text-align:center;margin-top:20px">${wordHeader(w)}
			<p class="w-sub">${esc(stage)}</p><div style="height:16px"></div>${examplesHtml(w, W.params.openTr || (W.params.openTr = new Set()))}</div>`;
	}

	/** Topic usage: how many course examples carry the topic. */
	function topicUsageCount(id) {
		let n = 0;
		for (const w of W.course.words.values()) for (const ex of w.ex) if ((ex.st || []).includes(id) || ex.tk.some(t => t.t.includes(id))) n++;
		return n;
	}

	/** Grammar overview by textbook sections with CEFR level and coverage. */
	function grammarHtml() {
		if (!W.topicCounts) W.topicCounts = new Map(W.course.list.map(t => [t.id, topicUsageCount(t.id)]));
		const covered = W.course.list.filter(t => W.topicCounts.get(t.id) > 0).length;
		const groups = new Map();
		W.course.list.forEach(t => { const k = t.section || "Rakenne"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
		const order = k => { const i = SECTION_ORDER.indexOf(k); return i < 0 ? 99 : i; };
		return `${backBar()}<div class="w-title">Kielioppi</div>
			<div class="w-sub">${covered} / ${W.course.list.length} тем у ваших словах · ціль: B1 (YKI 3)</div>
			${[...groups.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([sec, list]) => `<div class="w-gh">${esc(SECTION_TITLES[sec] || sec)}</div>`
				+ list.slice().sort((a, b) => (a.level || "").localeCompare(b.level || "") || (W.topicCounts.get(a.id) === 0) - (W.topicCounts.get(b.id) === 0))
					.map(t => { const n = W.topicCounts.get(t.id); return `<div class="w-trow ${n ? "" : "off"}" data-w="topic" data-topic="${esc(t.id)}"><span class="lv">${esc(t.level || "—")}</span><span class="t">${esc(t.title)}</span><span class="n">${n || "попереду"}</span></div>`; }).join("")).join("")}`;
	}

	/** Topic page: note, rule table and course sentences where the topic appears. */
	function topicHtml() {
		const t = W.course.topics.get(W.params.topicId);
		if (!t) return `${backBar()}<p class="w-muted">Тему не знайдено</p>`;
		const usages = [];
		for (const w of W.course.words.values()) w.ex.forEach((ex, i) => { if ((ex.st || []).includes(t.id) || ex.tk.some(k => k.t.includes(t.id))) usages.push([w, i]); });
		const shown = usages.slice(0, W.topicShown);
		return `${backBar()}<div class="w-title" style="color:var(--accent)">${esc(t.title)}</div>
			<p>${esc(t.note)}</p>
			${t.table.length ? `<div class="w-rule">${t.table.map(([l, r]) => `<div class="l">${esc(l)}</div><div class="r">${esc(r)}</div>`).join("")}</div>` : ""}
			<p class="w-sub" style="margin-top:22px">У ваших словах:</p>
			${usages.length ? "" : '<p class="w-muted">поки немає прикладів — тема зʼявиться з новими словами</p>'}
			${shown.map(([w, i]) => usageHtml(t.id, w, i)).join("")}
			${usages.length > shown.length ? `<button class="w-more" data-w="moretopic">Показати ще (${usages.length - shown.length})</button>` : ""}`;
	}

	/** One sentence on a topic page: tokens carrying the topic are highlighted. */
	function usageHtml(topicId, w, exIndex) {
		const ex = w.ex[exIndex];
		const carriers = ex.tk.filter(k => k.t.includes(topicId));
		const marked = new Set(carriers.map(k => k.i));
		const sentence = C.tokenize(ex.fi).map((tok, i) =>
			`<span class="w-tok ${marked.has(i) ? "carrier" : ""}" data-w="tok" data-id="${w.id}" data-ex="${exIndex}" data-tok="${i}">${esc(tok.text)}</span>`).join(" ");
		return `<div class="w-usage"><div class="s">${sentence}</div><div class="u">${esc(ex.ua)}   ·   ${esc(carriers.map(k => k.l).join(", ") || w.fi)}</div></div>`;
	}

	/** Stats: words graduated per day (14 days), month calendar, streak. */
	function statsHtml() {
		const perDay = new Map();
		Object.values(W.progress.cards).forEach(c => { if (c.grad != null) { const k = isoDate(new Date(c.grad)); perDay.set(k, (perDay.get(k) || 0) + 1); } });
		const goal = W.progress.settings.goal;
		const today = new Date();
		const total = [...perDay.values()].reduce((a, b) => a + b, 0);
		// streak: days in a row with at least one graduated word (today may still be ahead)
		let d = new Date(today), streak = 0;
		if (!perDay.get(isoDate(d))) d.setDate(d.getDate() - 1);
		while (perDay.get(isoDate(d))) { streak++; d.setDate(d.getDate() - 1); }
		const days = [...Array(14)].map((_, i) => { const x = new Date(today); x.setDate(x.getDate() - 13 + i); return x; });
		const max = Math.max(1, ...days.map(x => perDay.get(isoDate(x)) || 0));
		const bars = days.map(x => {
			const n = perDay.get(isoDate(x)) || 0;
			return `<div>${n ? `<span>${n}</span><i class="${n >= goal ? "goal" : ""}" style="height:${Math.round(n / max * 100)}px"></i>` : ""}<span>${x.getDate() % 2 === today.getDate() % 2 ? x.getDate() : "&nbsp;"}</span></div>`;
		}).join("");
		const m = W.statsMonth || (W.statsMonth = new Date(today.getFullYear(), today.getMonth(), 1, 12));
		const first = new Date(m.getFullYear(), m.getMonth(), 1, 12);
		const len = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
		const offset = (first.getDay() + 6) % 7;
		const cells = [...Array(offset)].map(() => '<div class="d"></div>').join("") + [...Array(len)].map((_, i) => {
			const id = isoDate(new Date(m.getFullYear(), m.getMonth(), i + 1, 12)), n = perDay.get(id) || 0;
			return `<div class="d"><span class="${n >= goal && goal > 0 ? "goal" : n ? "act" : ""} ${id === isoDate(today) ? "today" : ""}">${i + 1}</span></div>`;
		}).join("");
		const isCurrent = m.getFullYear() === today.getFullYear() && m.getMonth() === today.getMonth();
		const monthName = m.toLocaleDateString("uk-UA", { month: "long", year: "numeric" }).replace(" р.", "");
		return `${backBar()}<div class="w-title">Статистика</div>
			<div class="w-sub">всього вивчено: ${total} · серія: ${streak} дн</div>
			<p style="margin:24px 0 0">Вивчено за день</p><div class="w-bars">${bars}</div>
			<div class="w-bar" style="margin-top:24px"><button class="ghost" data-w="month" data-dir="-1">‹</button><span class="sp" style="text-align:center">${esc(monthName[0].toUpperCase() + monthName.slice(1))}</span><button class="ghost" data-w="month" data-dir="1" ${isCurrent ? "disabled" : ""}>›</button></div>
			<div class="w-cal">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].map(x => `<div class="dow">${x}</div>`).join("")}${cells}</div>
			<div class="w-legend"><span><i style="background:color-mix(in srgb, var(--accent) 25%, transparent)"></i>було навчання</span><span><i style="background:var(--accent)"></i>ціль дня досягнуто</span></div>`;
	}

	/** Settings: goal, deck size, auto-advance, habit, known words, offline audio. */
	function settingsHtml() {
		const st = W.progress.settings;
		const habits = habitList();
		const auto = habitName();
		const cfg = syncConfig();
		return `${backBar()}<div class="w-title">Налаштування</div>
			<div class="w-set"><div>Ціль на день: <b id="wGoalV">${st.goal}</b> слів</div><div class="w-sub">діє одразу: черга нових слів підлаштовується</div>
				<input type="range" min="5" max="80" step="5" value="${st.goal}" data-wset="goal"></div>
			<div class="w-set"><div>Слів у роботі одночасно: <b id="wDeckV">${st.deck}</b></div><div class="w-sub">більше — менше пауз на таймерах, коли слова даються легко; менше — спокійніший темп</div>
				<input type="range" min="3" max="12" step="1" value="${st.deck}" data-wset="deck"></div>
			<div class="w-set"><label class="lab"><span>Авто-гортання після вводу<br><span class="w-sub">${st.auto ? "картка гортається сама" : "далі — тапом, Enter або свайпом"}</span></span><input type="checkbox" data-wset="auto" ${st.auto ? "checked" : ""}></label></div>
			<div class="w-set" ${st.auto ? "" : 'style="opacity:.5"'}><div>Тривалість показу: <b id="wSecsV">${st.secs}</b> с</div>
				<input type="range" min="1" max="10" step="1" value="${st.secs}" data-wset="secs" ${st.auto ? "" : "disabled"}></div>
			<div class="w-set"><div>Звичка в плані</div><div class="w-sub">відмічається сама, коли за день вивчено стільки слів, скільки в її назві (або 5)</div>
				<select data-wset="habit"><option value="">Автоматично${auto ? ` (${esc(auto)})` : " (не знайдено)"}</option><option value="-" ${st.habit === "-" ? "selected" : ""}>Не відмічати</option>
				${habits.map(h => `<option value="${esc(h)}" ${st.habit === h ? "selected" : ""}>${esc(h)}</option>`).join("")}</select></div>
			<div class="w-set" data-w="go" data-to="known" style="cursor:pointer"><div>Що я вже знаю  →</div><div class="w-sub">позначити відомі слова або скинути прогрес слова</div></div>
			<div class="w-set"><div>Озвучка офлайн</div><div class="w-sub">${W.course.order.length * 2} файлів, близько 40 МБ. Без цього звук грає, коли є мережа, і запамʼятовується по одному файлу.</div>
				<div class="row">${W.audioJob ? '<button data-w="audiostop">Зупинити</button>' : '<button data-w="audio">Завантажити озвучку</button>'}</div><div class="w-sub" id="wAudioJob">${audioJobText()}</div></div>
			<div class="w-set"><div>Синхронізація прогресу</div><div class="w-sub">${cfg ? `прогрес зберігається в ${esc(cfg.repo)}/${esc(wordsPath(cfg))} разом із планом; два пристрої зливаються по кожному слову` : "GitHub не налаштовано — прогрес живе лише на цьому пристрої (вкладка «Файл» → GitHub)"}</div></div>`;
	}

	/** "What I already know": mark words by theme or one by one. */
	function knownHtml() {
		const onboarding = W.params.onboarding;
		const knownCount = Object.values(W.progress.cards).filter(c => c.st === "KNOWN").length;
		return `<div class="w-bar">${onboarding ? "" : ibtn("back", "back", "Назад")}<span class="sp"></span>${onboarding ? '<button class="primary" data-w="knowndone">Готово</button>' : ""}</div>
			<div class="w-bar"><div class="w-title" style="flex:1">Що ви вже знаєте?</div><span class="w-sub" id="wKnownCount" style="color:var(--accent)">відомих: ${knownCount}</span></div>
			<div class="w-search"><i class="wi wi-search"></i><input id="wKnownQ" value="${esc(W.knownQuery)}" placeholder="Пошук слова…" autocomplete="off" autocapitalize="off"></div>
			<div id="wList">${knownListHtml()}</div>`;
	}

	/** Chips of the known-words screen (by theme, or flat search results). */
	function knownListHtml() {
		const chip = w => `<button type="button" class="${stageOf(w.id) === "KNOWN" ? "on" : ""}" data-w="known" data-id="${w.id}">${esc(w.fi)}</button>`;
		const q = W.knownQuery.trim().toLowerCase();
		const all = W.course.order.map(id => word(id));
		if (q) {
			const found = all.filter(w => w.fi.toLowerCase().includes(q) || w.tr.some(t => t.toLowerCase().includes(q)));
			return found.length ? `<div class="w-kchips" style="margin-top:8px">${found.map(chip).join("")}</div>` : '<p class="w-muted" style="text-align:center">Нічого не знайдено</p>';
		}
		const groups = new Map();
		all.forEach(w => { const k = w.cat || "Різне"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); });
		return `<p class="w-sub">Позначте відомі слова — вони не зʼявлятимуться в навчанні. Тап по назві теми позначає всю тему. Змінити можна будь-коли в налаштуваннях.</p>`
			+ [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "uk")).map(([cat, list]) =>
				`<div class="w-cathead" data-w="knowncat" data-cat="${esc(cat)}">${esc(cat)}<span>${list.filter(w => stageOf(w.id) === "KNOWN").length} / ${list.length}</span></div>
				<div class="w-kchips">${list.map(chip).join("")}</div>`).join("");
	}

	/* ============================================================
	   Grammar sheet
	   ============================================================ */

	/** Open the analysis sheet for token `tokIndex` of example `exIndex` of word `id`. */
	function openSheet(id, exIndex, tokIndex) {
		const w = word(id), ex = w.ex[exIndex];
		const tokens = C.tokenize(ex.fi);
		const isTarget = tokIndex === targetIndex(ex, tokens);
		const tk = ex.tk.find(k => k.i === tokIndex);
		if (!isTarget && !tk) return false;
		const deriv = rows => `<div class="w-deriv">${rows.map(r => `<div class="f ${r.form.startsWith("+") ? "end" : ""}">${esc(r.form)}</div><div class="x">${esc(r.explanation)}</div>`).join("")}</div>`;
		let body;
		if (isTarget) {
			body = `<h3>${ex.fp.split("+").map((p, k) => `<b class="${k ? "e" : ""}">${esc(p)}</b>`).join(" + ")}</h3>
				<div><b>${esc(w.fi)}</b> — ${esc(w.tr.join(", "))}</div>
				${deriv(C.buildDerivation(w.fi, ex.fp, tk ? tk.g : [], ex.fn))}`;
		} else {
			body = `<h3>${esc(C.trimNonLetters(tokens[tokIndex].text))}</h3>
				<div><b>${esc(tk.l)}</b>${tk.ua ? " — " + esc(tk.ua) : ""}</div>
				<div class="w-sub" style="margin-top:4px">${esc(tk.n)}</div>
				${deriv(C.buildDerivation(tk.l, tk.p || tk.l, tk.g, C.DERIV.special))}`;
		}
		const topicIds = [...(tk ? tk.t : [])];
		if (isTarget && C.hasGradation(w.fi, ex.fp) && !topicIds.includes("kpt")) topicIds.push("kpt");
		const topics = topicIds.map(t => W.course.topics.get(t)).filter(Boolean);
		const bg = document.createElement("div");
		bg.className = "sheet-bg";
		bg.innerHTML = `<div class="sheet w-sheet" role="dialog" aria-label="Розбір слова">${body}
			${topics.length ? `<div class="w-tchips">${topics.map(t => `<button type="button" data-sheettopic="${esc(t.id)}">${esc(t.title)}</button>`).join("")}</div>` : ""}
			<div class="row" style="justify-content:flex-end"><button data-sheetclose="1">Закрити</button></div></div>`;
		const close = () => { bg.remove(); document.removeEventListener("keydown", onKey); focusInput(); };
		const onKey = e => { if (e.key === "Escape") close(); };
		bg.addEventListener("click", e => {
			if (e.target === bg || e.target.closest("[data-sheetclose]")) return close();
			const t = e.target.closest("[data-sheettopic]");
			if (t) { close(); go("topic", { topicId: t.dataset.sheettopic }); }
		});
		document.addEventListener("keydown", onKey);
		document.body.appendChild(bg);
		return true;
	}

	/* ============================================================
	   Navigation & drawing
	   ============================================================ */

	/** Header title and subtitle for the words tab. */
	function header() {
		const s = W.sess;
		const goal = W.progress ? W.progress.settings.goal : 0;
		setHeader("Слова", W.course && s ? `сьогодні ${s.graduatedToday} / ${goal}` : "фінська", false);
	}

	/** Re-draw the words screen (keeps the hidden input and its focus). */
	function redraw() {
		if (W.drawing || state.tab !== "words") return;
		const root = document.getElementById("wRoot");
		if (!root) return render();
		W.drawing = true;
		let html;
		try {
			html = screenHtml();
		} finally {
			W.drawing = false;
		}
		root.innerHTML = html;
		header();
		focusInput();
	}

	/** Update only the input cells (typing must not re-create the page). */
	function updateCells() {
		const el = document.getElementById("wCells");
		if (el) el.outerHTML = cellsHtml();
		else redraw();
	}

	/** Make the hidden input hold exactly the model text (after hints or filtered spaces). */
	function syncInputValue() {
		const el = document.getElementById("wIn");
		const text = W.sess ? W.sess.input.text : "";
		if (el && el.value !== text) el.value = text;
	}

	/** Keep the keyboard on the session screen. */
	function focusInput() {
		const el = document.getElementById("wIn");
		if (!el) return;
		if (W.screen === "session" && W.course && !document.querySelector(".sheet-bg")) {
			syncInputValue();
			if (document.activeElement !== el) el.focus({ preventScroll: true });
		}
	}

	/** Open a sub-screen. */
	function go(screen, params = {}) {
		if (W.screen === "session") stopTimersForLeave();
		W.stack.push([W.screen, W.params]);
		W.screen = screen;
		W.params = params;
		if (screen === "topic") W.topicShown = TOPIC_PAGE;
		document.getElementById("wIn")?.blur();
		redraw();
		scrollTo(0, 0);
	}

	/** Back to the previous screen. */
	function back() {
		const prev = W.stack.pop() || ["session", {}];
		const from = W.screen;
		[W.screen, W.params] = prev;
		if (W.screen === "session") resumeSession(from);
		redraw();
		scrollTo(0, 0);
	}

	/** Leaving the session screen: stop the auto-advance and the pause tick. */
	function stopTimersForLeave() {
		const s = W.sess;
		if (!s) return;
		clearTimeout(s.autoTimer);
		clearInterval(s.pauseTimer);
		s.autoTimer = s.pauseTimer = null;
	}

	/** Back on the session screen: apply known-word changes, restart the pause tick. */
	function resumeSession(from) {
		const s = W.sess;
		if (!s) return;
		if (from === "known" || from === "settings") refreshKnownExclusions();
		if (W.sess === s && !s.card && !s.miniWord && s.done == null && !s.reveal) advance();
	}

	/* ============================================================
	   Events
	   ============================================================ */

	/** Click actions inside the words tab. */
	function onClick(e) {
		if (state.tab !== "words" || W.dragging) return;
		const el = e.target.closest("[data-w]");
		if (!el) return;
		const a = el.dataset.w, s = W.sess;
		switch (a) {
			case "retry": loadCourse(); redraw(); break;
			case "go": go(el.dataset.to, el.dataset.to === "known" && W.screen === "intro" ? { onboarding: true } : {}); break;
			case "back": back(); break;
			case "introdone": setSetting("introDone", true); W.screen = "session"; W.stack = []; redraw(); break;
			case "knowndone": setSetting("introDone", true); W.screen = "session"; W.stack = []; refreshKnownExclusions(); redraw(); break;
			case "say": e.stopPropagation(); playWord(el.dataset.id); break;
			case "sayex":
				e.stopPropagation();
				if (!el.dataset.long) playExample(el.dataset.id, el.dataset.ex, false);
				delete el.dataset.long;
				break;
			case "trtoggle": {
				e.stopPropagation();
				const set = W.screen === "word" ? W.params.openTr : s.openTr;
				set.has(el.dataset.key) ? set.delete(el.dataset.key) : set.add(el.dataset.key);
				redraw();
				break;
			}
			case "tok": {
				e.stopPropagation();
				if (!openSheet(Number(el.dataset.id), Number(el.dataset.ex), Number(el.dataset.tok)) && W.screen !== "topic") {
					const key = `${el.dataset.id}:${el.dataset.ex}`;
					const set = W.screen === "word" ? W.params.openTr : s.openTr;
					set.has(key) ? set.delete(key) : set.add(key);
					redraw();
				}
				break;
			}
			case "topic": e.stopPropagation(); go("topic", { topicId: el.dataset.topic }); break;
			case "moretopic": W.topicShown += TOPIC_PAGE; redraw(); break;
			case "focus": focusInput(); break;
			case "peek": onPeek(); focusInput(); break;
			case "hint": onHint(); focusInput(); break;
			case "key": {
				const inp = document.getElementById("wIn");
				onTyped((s ? s.input.text : "") + el.dataset.ch);
				inp?.focus({ preventScroll: true });
				break;
			}
			case "revealtap": onRevealAction("TAP"); break;
			case "graduate": e.stopPropagation(); onRevealAction("SWIPE_LEFT"); break;
			case "histback": if (s && s.history.length > s.browseDepth) { s.browseDepth++; stopTimersForLeave(); redraw(); } break;
			case "browseexit": s.browseDepth = 0; if (!s.card && !s.miniWord && s.done == null && !s.reveal) advance(); else redraw(); break;
			case "dictmode": W.dictMode = el.dataset.mode; redraw(); break;
			case "openword": playWord(el.dataset.id); go("word", { wordId: Number(el.dataset.id), openTr: new Set() }); break;
			case "month": {
				const m = W.statsMonth;
				W.statsMonth = new Date(m.getFullYear(), m.getMonth() + Number(el.dataset.dir), 1, 12);
				redraw();
				break;
			}
			case "known": {
				const id = Number(el.dataset.id), on = stageOf(id) !== "KNOWN";
				C.setKnown(W.progress, id, on, Date.now());
				saveProgress();
				redrawKnownList();
				break;
			}
			case "knowncat": {
				const ids = W.course.order.filter(id => (word(id).cat || "Різне") === el.dataset.cat);
				const allKnown = ids.every(id => stageOf(id) === "KNOWN");
				const now = Date.now();
				ids.forEach(id => C.setKnown(W.progress, id, !allKnown, now));
				saveProgress();
				redrawKnownList();
				break;
			}
			case "audio": downloadAudio(); redraw(); break;
			case "audiostop": W.audioJob?.cancel(); break;
			default: console.warn("[WARNING] Unknown words action", a); break;
		}
	}

	/** Re-draw the known-words list and counter, keeping the search field. */
	function redrawKnownList() {
		const list = document.getElementById("wList");
		if (list) list.innerHTML = knownListHtml();
		const count = document.getElementById("wKnownCount");
		if (count) count.textContent = `відомих: ${Object.values(W.progress.cards).filter(c => c.st === "KNOWN").length}`;
	}

	/** Input events: hidden typing field, search fields, settings. */
	function onInput(e) {
		if (state.tab !== "words") return;
		const t = e.target;
		if (t.id === "wIn") return onTyped(t.value);
		if (t.id === "wDictQ") {
			W.dictQuery = t.value;
			document.getElementById("wModes").hidden = !!t.value;
			document.getElementById("wList").innerHTML = dictListHtml();
			return;
		}
		if (t.id === "wKnownQ") {
			W.knownQuery = t.value;
			document.getElementById("wList").innerHTML = knownListHtml();
			return;
		}
		const key = t.dataset.wset;
		if (!key || t.type !== "range") return;
		const v = Number(t.value);
		const label = { goal: "wGoalV", deck: "wDeckV", secs: "wSecsV" }[key];
		if (label) document.getElementById(label).textContent = v;
	}

	/** Committed setting changes (range release, checkbox, select). */
	function onChange(e) {
		if (state.tab !== "words") return;
		const t = e.target, key = t.dataset.wset;
		if (!key) return;
		if (key === "auto") setSetting("auto", t.checked);
		else if (key === "habit") setSetting("habit", t.value || null);
		else {
			const v = Number(t.value);
			const limits = { goal: [5, 80], deck: [3, 12], secs: [1, 10] }[key];
			if (!limits || !Number.isFinite(v)) return;
			setSetting(key, Math.min(limits[1], Math.max(limits[0], Math.round(v))));
			if (key === "goal") adjustPoolToGoal(W.progress.settings.goal);
			if (key === "deck" && W.sess) W.sess.scheduler.updateWindowLimit(C.windowLimitForDeckSize(W.progress.settings.deck));
		}
		redraw();
	}

	/** Keys in the hidden input: Enter submits / goes on, arrows swipe on the reveal. */
	function onKeyDown(e) {
		if (state.tab !== "words" || e.target.id !== "wIn") return;
		const s = W.sess;
		if (e.key === "Enter") { e.preventDefault(); onSubmit(); return; }
		if (s && s.reveal && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
			e.preventDefault();
			if (e.key === "ArrowRight" && s.reveal.canKeep) onRevealAction("SWIPE_RIGHT");
			if (e.key === "ArrowLeft" && s.reveal.canGraduate) onRevealAction("SWIPE_LEFT");
		}
	}

	/** Swipes on the reveal and long press on the sentence audio. */
	function onPointerDown(e) {
		if (state.tab !== "words") return;
		const tool = e.target.closest('[data-w="peek"], [data-w="hint"], [data-w="key"], [data-w="focus"]');
		if (tool) e.preventDefault();   // keep the focus (and the phone keyboard) on the hidden input
		const audio = e.target.closest('[data-w="sayex"]');
		if (audio) {
			const timer = setTimeout(() => { audio.dataset.long = "1"; playExample(audio.dataset.id, audio.dataset.ex, true); }, LONG_PRESS_MS);
			const stop = () => { clearTimeout(timer); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
			window.addEventListener("pointerup", stop);
			window.addEventListener("pointercancel", stop);
			return;
		}
		const card = e.target.closest("#wReveal");
		if (!card || !W.sess || !W.sess.reveal) return;
		const r = W.sess.reveal, x0 = e.clientX, y0 = e.clientY;
		let dx = 0, horizontal = null;
		const move = ev => {
			dx = ev.clientX - x0;
			if (horizontal === null && (Math.abs(dx) > 10 || Math.abs(ev.clientY - y0) > 10)) horizontal = Math.abs(dx) > Math.abs(ev.clientY - y0);
			if (horizontal) card.style.transform = `translateX(${dx * 0.4}px)`;
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			card.style.transform = "";
			if (!horizontal) return;
			W.dragging = true;
			setTimeout(() => { W.dragging = false; }, 50);   // swallow the click that follows the drag
			if (W.sess.reveal !== r) return;
			if (dx > SWIPE_PX && r.canKeep) onRevealAction("SWIPE_RIGHT");
			else if (dx < -SWIPE_PX && r.canGraduate) onRevealAction("SWIPE_LEFT");
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	}

	/** Install listeners once; #main is stable, its content changes. */
	function installEvents() {
		const main = document.getElementById("main");
		main.addEventListener("click", onClick);
		main.addEventListener("input", onInput);
		main.addEventListener("change", onChange);
		main.addEventListener("keydown", onKeyDown);
		main.addEventListener("pointerdown", onPointerDown);
		main.addEventListener("focusin", e => { if (e.target.id === "wIn") { document.body.classList.add("w-typing"); document.getElementById("wRoot")?.classList.remove("w-unfocused"); } });
		main.addEventListener("focusout", e => { if (e.target.id === "wIn") { document.body.classList.remove("w-typing"); document.getElementById("wRoot")?.classList.add("w-unfocused"); } });
	}

	/* ============================================================
	   Public API
	   ============================================================ */

	/** HTML for the words tab (index.html render()). */
	function view() {
		if (!W.progress) W.progress = loadProgress();
		if (!W.course && !W.loading && !W.error) loadCourse();
		if (W.course && W.screen === "session" && !hasData(W.progress) && !W.progress.settings.introDone) W.screen = "intro";
		W.drawing = true;
		let html;
		try {
			html = screenHtml();
		} catch (err) {
			console.error("[ERROR] Words screen:", err);
			html = `<div class="w-stage"><p>Щось пішло не так: ${esc(err.message)}</p><button data-w="back">На початок</button></div>`;
			W.screen = "session";
			W.stack = [];
		} finally {
			W.drawing = false;
		}
		header();
		return `<div class="w" id="wRoot">${html}</div>
			<input id="wIn" class="w-hidden-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Ввід слова">`;
	}

	/** Called by render() for every tab: focus on the words tab, stop timers elsewhere. */
	function afterRender(tab) {
		if (tab === "words") {
			const s = W.sess;
			if (s && W.screen === "session" && !s.card && !s.miniWord && s.done == null && !s.reveal && !s.pauseTimer) advance();
			focusInput();
		} else {
			stopTimersForLeave();
			document.body.classList.remove("w-typing");
		}
	}

	window.Words = { view, afterRender, isDirty, syncProgress, habitName: () => { if (!W.progress) W.progress = loadProgress(); return habitName(); } };
	installEvents();
})();
