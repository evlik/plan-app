# plan-app: що де лежить і як працювати

Цей файл для ШІ, якому передали роботу над апкою. Прочитай його повністю, перш ніж щось міняти.

## 1. Що це

Офлайн-планувальник для телефону і компʼютера (PWA). Весь план людини — **один текстовий файл
`.plan`** власного формату. Людина редагує його через інтерфейс, ШІ — як звичайний текст.

| Що | Де |
|---|---|
| Код апки (цей репозиторій, **публічний**) | `github.com/evlik/plan-app` |
| Живий сайт (GitHub Pages з гілки `main`, корінь) | https://evlik.github.io/plan-app/ |
| Дані: `plan.plan` + `words.json` (прогрес слів) + `FORMAT.md` + `CLAUDE.md` (**приватний**) | `github.com/evlik/plan-data` |
| Джерело курсу слів (Android-апка Micro-Sprint, **приватний**) | `github.com/evlik/micro-sprint-srs` |
| Специфікація формату | `FORMAT.md` (копія лежить і в `plan-data`, тримай їх однаковими) |

**Заборонено:** класти сюди особисті дані (суми, борги, імена, плани). Репозиторій публічний,
а дані живуть тільки в `plan-data`.

## 2. Файли

| Файл | Роль |
|---|---|
| `index.html` | Планувальник: HTML, CSS, JS в одному файлі (~1900 рядків). Без залежностей, без збірки, без фреймворків |
| `words/core.js` | Логіка вкладки «Слова» без DOM: планувальник мікро-колоди, FSRS, ввід з підказками, модель прогресу, злиття пристроїв, таблиця словотвору. Працює і в браузері (`window.WordsCore`), і в Node |
| `words/ui.js` | Екрани і події вкладки «Слова» (`window.Words`) |
| `words/words.css` | Стилі вкладки, на змінних кольорів з `index.html` |
| `words/course.json` | Згенерований курс: 1916 слів, приклади з розміткою, 39 тем граматики. **Руками не правити** — див. `tools/build_course.py` |
| `words/audio/` | 3832 OGG: `w{id}.ogg` — слово, `s{id}_0.ogg` — приклад. Незмінні, кешуються окремо |
| `words/icons/` | Одноколірні SVG, тонуються через CSS `mask` |
| `tools/build_course.py` | Перебудова курсу з вихідників Micro-Sprint: `python tools/build_course.py --src <клон micro-sprint-srs> [--copy-audio]` |
| `tools/test_words_core.js` | Юніт-тести `words/core.js` (порт Kotlin-тестів + прогрес і злиття): `node tools/test_words_core.js` |
| `sw.js` | Service worker: network-first з `cache: "no-cache"`, кеш як офлайн-запас; озвучка — cache-first в окремому `words-audio-v1`, який не видаляється при оновленні. **Після кожної зміни `index.html` або `words/*` підніми `CACHE`** (`plan-v6` → `plan-v7`), інакше телефони тримають стару версію |
| `manifest.webmanifest`, `icon.svg` | Встановлення на головний екран |
| `.nojekyll` | Без нього Pages пропускає файли через Jekyll, `FORMAT.md` не віддається, і офлайн-кеш не встановлюється. Не видаляти |
| `README.md` | Інструкція для людини: встановлення, токен, синхронізація |
| `FORMAT.md` | Формат `.plan`: секції, задачі, гроші |

## 3. Архітектура `index.html`

**Головний принцип:** джерело правди — `state.lines`, масив рядків файлу. Жодної іншої моделі даних
немає. Кожен рендер заново розбирає потрібні рядки. Кожна зміна:

```js
mutate(() => { /* змінити state.lines */ });  // → save() → localStorage + звʼязаний файл + scheduleSync() → render()
```

Рядки, яких апка не розуміє, зберігаються як є (round-trip без втрат). Так ШІ може дописувати
що завгодно, нічого не ламаючи. Не перебудовуй файл із розібраної моделі: міняй тільки ті рядки, які чіпаєш.

Блоки коду йдуть по порядку, кожен починається коментарем `/* ===== Назва ===== */`:

| Блок | Ключові функції |
|---|---|
| Constants | `STORAGE_KEY`, `EMPTY_DOC`, `AI_PROMPT` (правила формату для кнопки «Копіювати для ШІ», онови при зміні формату) |
| Date helpers | `isoDate`, `parseDate` (опівдні, щоб не ловити DST), `isoWeek` (ISO 8601), `weekStart`, `monthId` |
| Format: lines | `parseLine` → `{kind: task\|note\|habits\|blank\|comment\|raw}`, `taskToLine`, `taskFromInput` («! 10:00 текст») |
| Format: sections | `listSections`, `findSection(type,id)`, `sectionItems` → `[{idx, el}]`, `ensureSection` (вставляє, сортуючи за id), `appendToSection` |
| Persistence | `save`, `mutate`, `setText`, `exportFile` (на телефоні через Web Share), `importFile`, `linkFile`/`checkLinkedFile` (File System Access, тільки десктоп Chrome/Edge) |
| GitHub sync | див. розділ 4 |
| UI helpers | `esc` (**усе, що йде в innerHTML, через `esc`**), `toast`, `renderItems`, `addForm`, `setHeader` |
| Views | `render` → `viewDay`, `viewWeek`, `viewMonth`, `viewGoals`, `Words.view`, `viewMoney`, `viewInbox`, `viewFile`, `viewSync`; після рендеру `Words.afterRender(tab)` |
| Money | див. розділ 5 |
| Item actions sheet | `openSheet(idx)` / `itemAction` для задач і нотаток: головна, підзадача, перенести на завтра, на сьогодні, видалити |
| Events | один делегований `click` і один `submit` на `#main`. Маршрутизація через `data-*` атрибути (`data-toggle`, `data-edit`, `data-tx`, `data-debt`, `data-bill`, `data-money="tx\|budget\|debt\|bill"` …) |
| Boot | `setText(loadStored() ?? EMPTY_DOC)`, `navigator.storage.persist()`, тригери синхронізації, реєстрація SW |

Вкладки (нижня панель): День, Тиждень, Місяць, Цілі, Слова, Гроші, Вхідні, Файл. `state.tab` і `state.cursor`
(дата, яку дивляться День/Тиждень/Місяць/Гроші; стрілки в шапці — `shift(dir)`).

### Вкладка «Слова» (`words/`)

Порт Android-апки Micro-Sprint. Концепція — `docs/CONCEPT.md` у `micro-sprint-srs`; поведінка збігається з Kotlin-кодом
(`MicroDeckScheduler`, `Fsrs`, `WordInput`, `SessionViewModel`). Не міняй правила навчання без потреби: вони вивірені тестами.

- **Прогрес** — `localStorage["words.progress.v1"]` = `{v, su, settings, cards: {id: {st, lv, iv, due, s, d, last, grad, lapses, u}}}`.
  Слова без запису — NEW. `st`: MICRO/COOLING/REVIEW/KNOWN, `lv` — рівень мікро-колоди (0–3), `s`/`d` — FSRS, `grad` — час випуску
  (для цілі дня і статистики), `u` — час останньої зміни картки (за ним зливаються пристрої), `su` — те саме для `settings`.
  Усі зміни — через функції core.js (`saveMicroLevel`, `graduate`, `reviewAnswered`, `setKnown`…), потім `saveProgress()`.
- **Сесія** (`startSession` → `advance` → `finishAttempt` → `showReveal` → `onRevealAction`) живе в памʼяті; рівні пишуться після
  кожної відповіді, тож перезавантаження продовжує зі збережених рівнів (`restoredWords`).
- **Рендер**: `Words.view()` повертає `#wRoot` + приховане `<input id="wIn">`. Внутрішні зміни малюють лише `#wRoot` (`redraw`),
  ввід — лише `#wCells` (`updateCells`), тому фокус і клавіатура телефона не стрибають. Не перемальовуй увесь `#main` під час сесії.
- **Звичка**: `tickHabit` додає звичку (обрана в налаштуваннях або перша з «слів/слова» в назві) у `habits:` сьогоднішнього дня
  через `appendToSection` + `save()` без `render()`, коли за день випущено стільки слів, скільки число в назві (або 5).
- Курс вантажиться лише при відкритті вкладки (`loadCourse`); озвучка — `new Audio()`, повільно = `playbackRate 0.75`.

## 4. Синхронізація з GitHub

- Налаштування в `localStorage["plan.sync.v1"]`: `{owner, repo, branch, path, token, device}`. Токен — fine-grained, доступ тільки до `plan-data`, Contents: Read and write. Зберігається тільки на пристрої.
- `localStorage["plan.sync.base.v1"]` = остання синхронізована версія `{repoKey, sha, text, at}`. Порівнюючи local, base і remote, апка вирішує, що робити (`syncOnce`):
  - remote.sha == base.sha і local змінено → PUT (один коміт);
  - remote змінено, local == base → підтягнути;
  - змінено обидва → `chooseDialog`: взяти GitHub (local зберігається в `conflicts/plan-<дата>-<ts>.plan`) або залишити своє (версія з GitHub лишається в історії). Тихого перезапису немає;
  - на новому пристрої з порожнім `EMPTY_DOC` remote підтягується без питань.
- Тригери: старт, повернення у вкладку, подія `online`, 2 хв після останньої зміни (`SYNC_DEBOUNCE_MS`), вихід з апки (`keepalive`), кнопка. Помилки мережі: експоненційний повтор 30 с → 10 хв. 401/403/404 — без повтору, з поясненням.
- Синхронізація не стартує, коли відкрито діалог (`.sheet-bg`) або сфокусовано сирий редактор.
- Переноси рядків з GitHub нормалізуються в `\n` (Windows-клон може віддати CRLF).
- Після плану той самий `syncNow` викликає `Words.syncProgress(cfg)`: `words.json` лежить поруч із `plan.plan`. Конфліктів тут
  немає: `mergeProgress` по кожному слову бере пізнішу зміну (`u`), тож діалог не потрібен. Пошкоджений `words.json` на GitHub
  не перезаписується — синхронізація слів зупиняється з поясненням. Коміти слів мають префікс «Слова:».

## 5. Гроші

Усе в секціях файлу (формат — `FORMAT.md`, розділ «Гроші»):

| Секція | Функції | Що показує |
|---|---|---|
| `@rates` (`base EUR`, `UAH 0.020134`) | `getRates`, `toBase`, `updateRates` (open.er-api.com, таймаут 10 с) | перерахунок у базову валюту |
| `@accounts` | `listAccounts`, `moneyNow` | «Мої гроші зараз» = рахунки (без `кредит`) + записи `@money` після найпізнішої дати `станом` |
| `@budget YYYY-MM` | `budgetFor` (бере найближчий попередній, якщо свого нема), `ensureOwnBudget`, `editBudget` | смуги по категоріях; «Вистачить ≈ N міс» = гроші зараз / бюджет поточного місяця |
| `@money YYYY-MM` | `parseMoney`, `moneyToLine`, `moneyFromInput` («350 Їжа Сільпо», без знака = витрата) | дохід, витрати, записи |
| `@bills` | `listBills`, `billDates`, `upcomingBills`, `payBill` | календар на 45 днів, нагадування за 2 дні у вкладці «День» |
| `@debts` | `listDebts`, `monthlyRate`, `debtForecast`, `debtActions` | залишок, відсотки на місяць, ріст без платежів, платіж для закриття за 6/12/24 міс, «гасити першим» (найвищий %) |
| `@goals` поле `ціна:` | `goalCosts` | скільки відкладати на місяць до дедлайну цілі |

## 6. Як перевіряти

Логіка слів має юніт-тести без залежностей: `node tools/test_words_core.js` (має бути `32/32 passed` або більше).
Решта перевіряється в браузері на ширині телефону (375 px).

```bash
python -m http.server 5173 --bind 127.0.0.1
```

Відкрий `http://localhost:5173`. Порт 8765 на цій машині заблокований Windows, бери 5173.

- Логіку перевіряй з консолі: функції глобальні (`listDebts()`, `upcomingBills(new Date(), 45)`, `parseLine(...)`).
- Щоб завантажити реальний план для тесту, тимчасово поклади копію `plan.plan` поруч і `setText(await (await fetch('/_test.plan')).text(), {persist:false})`. **Видали копію до коміту.**
- GitHub-синхронізацію тестуй, підмінивши `window.fetch` фейком contents API (GET повертає `{sha, content: base64}`, PUT перевіряє `sha`, 409 при розбіжності). Справжній токен у коді чи тестах не використовуй.
- Сесію слів до кінця (інтервали 45 с – 5 хв) проганяй, підмінивши годинник **до** відкриття вкладки:
  `const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off;`, а на екрані паузи збільшуй `__off`.
  Планувальник бере `Date.now` при створенні сесії, тому підміна після старту сесії не діє.
- Після тестів: `localStorage.clear()`, видали кеші (`caches.keys()` → `caches.delete`) — озвучка займає ~40 МБ.
- У вбудованому браузері Claude Desktop service worker реєструється тільки на сервері, запущеному через `preview_start`. Якщо сервер запущено з Bash, реєстрація падає з «unknown error fetching the script», і це проблема середовища, а не коду.

## 7. Викладка

```bash
git add -A
git commit -m "..."
git push
```

Pages перезбирається приблизно за хвилину. Перевірити: `gh api repos/evlik/plan-app/pages/builds/latest --jq .status` → `built`, і `curl -s https://evlik.github.io/plan-app/sw.js | grep plan-v` показує нову версію кешу.

Чекліст перед пушем:
1. Піднято `CACHE` у `sw.js`. Новий файл у `words/` (крім аудіо) → додано в `ASSETS`.
2. Змінився формат → оновлено `FORMAT.md` тут і в `plan-data`, а також `AI_PROMPT`.
3. Немає `_test.plan` і особистих даних.
4. Помилок у консолі немає. Міняв `words/core.js` → `node tools/test_words_core.js` проходить.

## 8. Стиль коду

- Відступи табами. Кожна функція має однорядковий `/** docstring */`.
- Помилки: `try/catch`, у консоль `[ERROR]`/`[WARNING]`/`[INFO]`, людині — `toast` українською з тим, що робити далі.
- Мережеві виклики з `AbortController` і таймаутом.
- Інтерфейс українською, коротко. Без зовнішніх бібліотек і CDN: апка має працювати офлайн.
- Не рости в «ще один фреймворк»: простий рядковий парсер і `innerHTML` + `esc` — свідомий вибір.

## 9. Відкриті задачі

- **Слова на справжньому телефоні**: перевірити клавіатуру (поле лишається у фокусі між картками), свайпи, озвучку і завантаження озвучки офлайн. У браузерному тесті все працює.
- Озвучка в OGG Opus: Safari на iPhone старших версій її не грає (Android і Chrome — так). Якщо знадобиться iPhone — додати MP3 через `tools/build_course.py`.
- Не перенесено з Micro-Sprint навмисно: Premium / оплату, мови інтерфейсу й англійський пакет контенту, аналітику.
- Іконка для iPhone: потрібен PNG `apple-touch-icon` (зараз тільки SVG).
- Залишки `@accounts` оновлюються вручну: правиться рядок рахунку і дата `станом`.

## 10. Контекст

Інтерфейс україномовний. Базова валюта задається в секції `@rates` плану, записи можуть бути в різних валютах.
Цей репозиторій — тільки код. Що в самому плані, дивись у приватному `plan-data` (якщо маєш до нього доступ),
а правила роботи з ним — у його `CLAUDE.md`.
