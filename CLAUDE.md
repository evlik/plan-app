# plan-app: що де лежить і як працювати

Цей файл для ШІ, якому передали роботу над апкою. Прочитай його повністю, перш ніж щось міняти.

## 1. Що це

Офлайн-планувальник для телефону і компʼютера (PWA). Весь план людини — **один текстовий файл
`.plan`** власного формату. Людина редагує його через інтерфейс, ШІ — як звичайний текст.

| Що | Де |
|---|---|
| Код апки (цей репозиторій, **публічний**) | `github.com/evlik/plan-app` |
| Живий сайт (GitHub Pages з гілки `main`, корінь) | https://evlik.github.io/plan-app/ |
| Дані: `plan.plan` + `FORMAT.md` + `CLAUDE.md` (**приватний**) | `github.com/evlik/plan-data` |
| Специфікація формату | `FORMAT.md` (копія лежить і в `plan-data`, тримай їх однаковими) |

**Заборонено:** класти сюди особисті дані (суми, борги, імена, плани). Репозиторій публічний,
а дані живуть тільки в `plan-data`.

## 2. Файли

| Файл | Роль |
|---|---|
| `index.html` | Уся апка: HTML, CSS, JS в одному файлі (~1900 рядків). Без залежностей, без збірки, без фреймворків |
| `sw.js` | Service worker: network-first з `cache: "no-cache"`, кеш як офлайн-запас. **Після кожної зміни `index.html` підніми `CACHE`** (`plan-v5` → `plan-v6`), інакше телефони тримають стару версію |
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
| Views | `render` → `viewDay`, `viewWeek`, `viewMonth`, `viewGoals`, `viewMoney`, `viewInbox`, `viewFile`, `viewSync` |
| Money | див. розділ 5 |
| Item actions sheet | `openSheet(idx)` / `itemAction` для задач і нотаток: головна, підзадача, перенести на завтра, на сьогодні, видалити |
| Events | один делегований `click` і один `submit` на `#main`. Маршрутизація через `data-*` атрибути (`data-toggle`, `data-edit`, `data-tx`, `data-debt`, `data-bill`, `data-money="tx\|budget\|debt\|bill"` …) |
| Boot | `setText(loadStored() ?? EMPTY_DOC)`, `navigator.storage.persist()`, тригери синхронізації, реєстрація SW |

Вкладки (нижня панель): День, Тиждень, Місяць, Цілі, Гроші, Вхідні, Файл. `state.tab` і `state.cursor`
(дата, яку дивляться День/Тиждень/Місяць/Гроші; стрілки в шапці — `shift(dir)`).

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

Тестового фреймворку немає. Перевірка йде в браузері на ширині телефону (375 px).

```bash
python -m http.server 5173 --bind 127.0.0.1
```

Відкрий `http://localhost:5173`. Порт 8765 на цій машині заблокований Windows, бери 5173.

- Логіку перевіряй з консолі: функції глобальні (`listDebts()`, `upcomingBills(new Date(), 45)`, `parseLine(...)`).
- Щоб завантажити реальний план для тесту, тимчасово поклади копію `plan.plan` поруч і `setText(await (await fetch('/_test.plan')).text(), {persist:false})`. **Видали копію до коміту.**
- GitHub-синхронізацію тестуй, підмінивши `window.fetch` фейком contents API (GET повертає `{sha, content: base64}`, PUT перевіряє `sha`, 409 при розбіжності). Справжній токен у коді чи тестах не використовуй.
- Після тестів: `localStorage.clear()`.
- У вбудованому браузері Claude Desktop service worker реєструється тільки на сервері, запущеному через `preview_start`. Якщо сервер запущено з Bash, реєстрація падає з «unknown error fetching the script», і це проблема середовища, а не коду.

## 7. Викладка

```bash
git add -A
git commit -m "..."
git push
```

Pages перезбирається приблизно за хвилину. Перевірити: `gh api repos/evlik/plan-app/pages/builds/latest --jq .status` → `built`, і `curl -s https://evlik.github.io/plan-app/sw.js | grep plan-v` показує нову версію кешу.

Чекліст перед пушем:
1. Піднято `CACHE` у `sw.js`.
2. Змінився формат → оновлено `FORMAT.md` тут і в `plan-data`, а також `AI_PROMPT`.
3. Немає `_test.plan` і особистих даних.
4. Помилок у консолі немає.

## 8. Стиль коду

- Відступи табами. Кожна функція має однорядковий `/** docstring */`.
- Помилки: `try/catch`, у консоль `[ERROR]`/`[WARNING]`/`[INFO]`, людині — `toast` українською з тим, що робити далі.
- Мережеві виклики з `AbortController` і таймаутом.
- Інтерфейс українською, коротко. Без зовнішніх бібліотек і CDN: апка має працювати офлайн.
- Не рости в «ще один фреймворк»: простий рядковий парсер і `innerHTML` + `esc` — свідомий вибір.

## 9. Відкриті задачі

- **Micro-Sprint → модуль «Слова».** Перенести Android-апку `evlik/micro-sprint-srs` (Kotlin: `MicroDeckScheduler`, `Fsrs`, `WordInput` з тестами, сід-слова, 3832 OGG ≈ 39 МБ) у цю апку. Прогрес — окремим `words.json` у `plan-data`, після сесії автоматично ставити звичку «Фінська: 5 слів». Оцінка 1–2 тижні. **Не раніше 5.12.2026** — так вирішив власник.
- Іконка для iPhone: потрібен PNG `apple-touch-icon` (зараз тільки SVG).
- Кнопка «Відкрити Micro-Sprint» (intent URL, пакет `com.microsprint.srs`) на реальному Android ще не перевірена.
- Залишки `@accounts` оновлюються вручну (людина дає скріншот банку, ШІ правит рядок і дату `станом`).

## 10. Контекст

Інтерфейс і план україномовні. Базова валюта в плані власника — EUR, частина записів в інших валютах.
Цей репозиторій — тільки код. Що в самому плані, дивись у приватному `plan-data` (якщо маєш до нього доступ),
а правила роботи з ним — у його `CLAUDE.md`.
