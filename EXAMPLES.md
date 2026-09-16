# pi-delegate — Usage examples · Примеры использования

**[English](#english)** · **[Русский](#русский)**

---

## English

### What this gives a team lead

In plain terms: one person commands a whole team of AI workers. You describe the outcome
in an ordinary chat message; the work runs in parallel waves — research, build, review,
QA, final verification — and you are woken only when a decision is needed. Quality is
checked three times by independent roles: code review, end-to-end QA, and a final
"fresh eyes" verifier who compares the result against the original requirement, knowing
nothing about how it was built. You stay the decision point; the machinery does the
standing around. The rest of this document shows what that looks like from the operator's
seat — no internals required to read it.

### Rule zero — delegation is explicit

I learned this on the first try: if I just describe a task, the agent does everything
itself, alone. `delegate` is not an autopilot — a multi-agent run is expensive, so the
decision to use one stays with me. One word is enough — "delegate this", "use a team of
workers" — and the fleet starts. I do not have to spell out the work scheme; the
orchestrator builds it.

### Demo 1 — one-level fan-out: a sum computed by three workers

I needed a quick sanity check that the whole thing works, so I picked the most boring task
imaginable and wrote a single message:

> Delegate this: ask three workers; each should return one number from 1 to 9 in its
> report (its own choice). Take the numbers from the reports and add them up with
> python. Tell me the total and which worker returned which number.

A couple of minutes later I got:

```
part-1: 7 · part-2: 2 · part-3: 9 → python: 7+2+9 = 18
```

I never saw the intermediate machinery: the orchestrator wrote the workers' briefs, spawned
all three in parallel, waited for their reports (each returned its number in a report
field) and ran one line of python to add them up — deterministic arithmetic belongs to
code, not to the model's head.

### Demo 2 — two-level fan-out: a sum via sub-orchestrators

Same task, one level deeper — to check that delegation can nest:

> Delegate this: launch two orchestrator workers. Each of them asks its own two workers
> to return a number from 1 to 9, adds its workers' numbers with python, and returns
> that partial sum in its report. Your job: add the two partial sums with python and
> tell me the total.

The answer:

```
lead-left: 12 (5+7) · lead-right: 11 (3+8) → python: 12+11 = 23
```

Each orchestrator worker did exactly what the top orchestrator did in Demo 1: collected
its workers' numbers from their reports, summed them with python, returned the partial.
The depth was invisible to me — wrapped into a single request. A further level is simply
a worker whose brief says "you are the orchestrator".

### A real-world example, the way one actually writes — a "habit tracker" prototype

Then I gave it something real: a product slice with frontend, backend, and a quality gate.
I wrote it the way I actually think — no prompt engineering:

> delegate this: build me a habit tracker prototype, frontend and backend — with a team of
> workers. You should be able to add a habit, check it off, and see stats. First have
> someone research how apps like this are built, then have teams build it, then have
> someone look at it with fresh eyes — as the customer, not as a programmer. Whatever is
> wrong — have them fix it and check again. At the end tell me what's done, where it
> lives, and what didn't make it.

That was enough. The orchestrator unfolded it into a fleet that worked in waves:

```
1  research:      UX/UI research · tech research          (in parallel)
2  build:         backend team · frontend team            (in parallel;
                   each led by its own orchestrator worker
                   with its own workers)
3  review:        backend review · frontend review ·
                   API-contract cross-check               (in parallel)
4  QA:            end-to-end scenario on a running build
5  return loop:   review/QA findings go back to the teams,
                   fixes, QA runs again
6  verification:  a brand-new worker, told only the original
                   requirement, checks the prototype "as the
                   customer" — then fixes, then it checks again
```

I came back to:

```
Status: prototype built, verified.
  backend:   3 reports pass — REST API 5 endpoints, migrations, service layer
  frontend:  2 reports pass — screens: list/create/stats
  contract:  pass — a "date" field mismatch → fixed in review round 2
  qa:        pass (2nd run; the 1st caught a 500 on an empty list — fixed)
  verifier:  pass (2nd run; the 1st found 2 requirement mismatches —
             "no confirmation after creating a habit", "stats do not
             refresh without a reload" — both fixed by the teams)
  open:      authentication — out of prototype scope, see research
  where:     checkout paths, branches, the full list of reports
```

The wave I find most valuable is the last one. The reviewers and QA see the code in the
context of what the teams *intended* to build; the verifier knows only what was *ordered*
and looks at what *came out*. Every "we meant to do it this way" stays outside the door —
only the requirement versus the artifact is compared.

### The professional version — the work scheme spelled out in the prompt

The short prompt above left the organizing to the orchestrator. That is a choice, not a
limitation: the tool supports a fully prescribed scheme, and when the cost of a redo is
high, I write the prompt as a mini specification. Same task, professional style:

> **Task.** A prototype of a habit tracker: add a habit, check it off, see statistics.
>
> **Scope.** REST API (Spring Boot) and a web frontend (React). Out of scope:
> authentication, deployment, mobile.
>
> **Work scheme — follow the order:**
> 1. Research, in parallel: UX/UI (which screens and scenarios a habit tracker needs, best
>    practices to borrow) and tech (API schema, data model, stack versions).
> 2. Build teams, in parallel, based on the research reports: a backend team and a
>    frontend team, each led by its own orchestrator worker that splits the work among its
>    own workers.
> 3. Review, in parallel, after both teams deliver: backend review, frontend review, and
>    an API-contract cross-check between the two.
> 4. QA: bring up both services and run the end-to-end scenario "create a habit → check it
>    off → see the stats".
> 5. Return loop: every review or QA finding goes back to the responsible team, fixes are
>    made, QA runs again.
> 6. Final verification: a brand-new worker that took no part in the development receives
>    only the original requirement (this Task section) and the built prototype — not the
>    teams' reports. It verifies "as the customer", from scratch: runs the app, walks the
>    scenarios, lists every "ordered vs delivered" gap. Gaps go back to the teams, and its
>    verification repeats.
>
> **Done when:** the end-to-end scenario passes AND the final verification passed with no
> open gaps.
>
> **Report:** status; what was built (per team); where it lives (paths, branches); what is
> open and why; the verifier's findings history.

Nothing in this prompt is exotic, and every line maps onto something the tool does
natively: "in parallel" becomes parallel delegate calls; "each led by its own orchestrator
worker" becomes delegation nesting; "a brand-new worker … not the teams' reports" is
isolated verification by construction; "findings go back to the teams" rides the mailbox
without re-spawning; "Done when" is enforced the only way the tool knows — validated
reports on disk, never a worker's word. And the entry threshold does not move: this
structure is optional. When the redo cost is low, I still write the short version from the
previous example — the machinery produces the same waves either way.

### Two prompt styles

| | Short (as one thinks) | Structured spec (professional) |
|---|---|---|
| Delegation | explicit — a single "delegate this" is enough | explicit ("work like this: ...") |
| What I specify | the goal + the "done" criterion | goal, scope, the scheme wave by wave, quality gates, report format |
| Who invents the organization | the orchestrator | me (the orchestrator executes) |
| When I use it | routine tasks, cheap to redo | expensive redo, many roles, the order of waves matters |

Both styles work on the same machinery. The short prompt is not a toy version of the long
one — it is the same delegation with the organizing delegated too.

---

## Русский

### Что это даёт руководителю

По-простому: один человек командует целой командой AI-воркеров. Вы описываете результат
обычным сообщением в чате; работа идёт параллельными волнами — исследования, сборка, ревью,
QA, финальная проверка — а вас будят, только когда нужно решение. Качество проверяется три
раза независимыми ролями: ревью кода, сквозной QA и финальный верификатор «свежим глазом»,
который сверяет результат с исходным требованием, не зная, как его строили. Вы остаётесь
точкой принятия решений; стоять над душой машинерия не заставляет. Дальше в документе — как
это выглядит из кресла оператора; internals для чтения не нужны.

### Правило ноль — делегирование явное

Я понял это с первой попытки: если просто описать задачу, агент сделает всё сам, в
одиночку. `delegate` — не автопилот: мультагентный прогон дорог, поэтому решение о нём
остаётся за человеком. Достаточно одного слова — «делегируй», «командой воркеров» — и флот
заводится. Расписывать схему работы не обязательно: оркестратор построит её сам.

### Демо 1 — одноуровневый fan-out: сумма тремя воркерами

Мне нужна была быстрая проверка, что вся машинерия вообще заводится, поэтому я взял самую
скучную задачу на свете и написал одно сообщение:

> Делегируй: опроси трёх воркеров, пусть каждый вернёт в отчёте число от 1 до 9 (какое
> сам выберет). Числа достань из отчётов и сложи с помощью python. Скажи итог и кто какое
> число вернул.

Через пару минут получил:

```
part-1: 7 · part-2: 2 · part-3: 9 → python: 7+2+9 = 18
```

Промежуточную машинерию я не видел: оркестратор сам написал воркерам задания, запустил
всех троих параллельно, дождался отчётов (каждый вернул своё число в поле отчёта) и
сложил числа одной строкой на python — детерминированная арифметика принадлежит коду,
а не голове модели.

### Демо 2 — двухуровневый fan-out: сумма через суб-оркестраторов

Та же задача на уровень глубже — проверить, что делегирование вкладывается:

> Делегируй: запусти двух воркеров-оркестраторов. Пусть каждый опросит своих двух
> исполнителей — каждый исполнитель вернёт число от 1 до 9 — сложит их числа с помощью
> python и вернёт эту частичную сумму в своём отчёте. Тебе — сложить две частичные суммы
> (тоже python) и сказать итог.

Ответ:

```
lead-left: 12 (5+7) · lead-right: 11 (3+8) → python: 12+11 = 23
```

Каждый воркер-оркестратор сделал ровно то же, что верхний оркестратор в демо 1: собрал
числа своих исполнителей из отчётов, сложил их с помощью python, вернул частичную сумму.
Глубину я не видел — она завёрнута в один запрос. Каждый следующий уровень — это просто
воркер, которому в задании сказали «ты оркестратор».

### Боевой пример, как пишут на самом деле — прототип «трекер привычек»

Потом я дал что-то настоящее: продуктовый срез с фронтом, бэком и контуром качества.
Написал так, как реально думаю — без промпт-инженерии:

> делегируй: сделай прототип трекера привычек, фронт и бэк — командой воркеров. чтобы
> привычку можно было добавить, отметить и статистику посмотреть. сначала пусть кто-то
> погуглит как такие делают, потом команды делают, потом кто-то свежим глазом глянет как
> заказчик, не программист. что не так — пусть переделают и проверят ещё раз. в конце
> скажи что готово, где лежит и что не успело.

Этого хватило. Оркестратор развернул это во флот, работавший волнами:

```
1  исследования:  UX/UI-ресёрч · техресёрч              (параллельно)
2  сборка:        бэкенд-команда · фронтенд-команда      (параллельно;
                   каждую ведёт свой воркер-оркестратор
                   со своими исполнителями)
3  ревью:         ревью бэка · ревью фронта ·
                   сверка API-контракта                  (параллельно)
4  QA:            сквозной сценарий на поднятой сборке
5  возврат:       находки ревью и QA уходят командам,
                   правки, QA повторяется
6  верификация:   совершенно новый воркер, которому дали
                   только исходное требование, проверяет
                   прототип «как заказчик» — затем правки,
                   затем он проверяет снова
```

Я вернулся к этому:

```
Статус: прототип собран, верифицирован.
  backend:   3 отчёта pass — REST API 5 endpoints, миграции, service-слой
  frontend:  2 отчёта pass — экраны: список/создание/статистика
  contract:  pass — расхождение поля date → исправлено во 2-м ревью
  qa:        pass (2-й прогон; 1-й поймал 500 на пустом списке — исправлено)
  verifier:  pass (2-й прогон; 1-й нашёл 2 несоответствия требованию —
             «нет подтверждения после создания привычки», «статистика
             не обновляется без перезагрузки» — оба исправлены командами)
  не решено: аутентификация — вне скоупа прототипа, см. исследования
  где:       пути к чекаутам, ветки, полный список отчётов
```

Самая ценная для меня волна — последняя. Ревьюеры и QA видят код в контексте того, что
команды *собирались* сделать; верификатор знает только, что было *заказано*, и смотрит на
то, что *получилось*. Всё «мы так и задумывали» остаётся за дверью — сверяются только
требование и артефакт.

### Профессиональная версия — схема работы, расписанная в промпте

Короткий промпт выше оставил организацию на оркестраторе. Это выбор, а не ограничение:
инструмент поддерживает полностью прописанную схему, и когда цена переделки высока, я
пишу промпт как мини-спеку. Та же задача, профессиональный стиль:

> **Задача.** Прототип трекера привычек: добавить привычку, отметить выполнение, посмотреть
> статистику.
>
> **Скоуп.** REST API (Spring Boot) и веб-фронт (React). Вне скоупа: аутентификация,
> деплой, мобильные.
>
> **Схема работы — соблюдай порядок:**
> 1. Исследования, параллельно: UX/UI (какие экраны и сценарии нужны трекеру привычек,
>    что взять из лучших практик) и техресёрч (схема API, модель данных, версии стека).
> 2. Команды сборки, параллельно, по отчётам исследований: бэкенд-команда и
>    фронтенд-команда, каждую ведёт свой воркер-оркестратор, который сам делит работу
>    между своими исполнителями.
> 3. Ревью, параллельно, после сдачи кода обеими командами: ревью бэка, ревью фронта,
>    сверка API-контракта между ними.
> 4. QA: поднять оба сервиса, прогнать сквозной сценарий «создать привычку → отметить
>    выполнение → увидеть статистику».
> 5. Цикл возврата: каждая находка ревью или QA уходит ответственной команде, вносятся
>    правки, QA повторяется.
> 6. Финальная верификация: совершенно новый воркер, не участвовавший в разработке,
>    получает только исходное требование (эту секцию «Задача») и собранный прототип — без
>    отчётов команд. Проверяет «как заказчик», с нуля: запускает приложение, проходит
>    сценарии, перечисляет все расхождения «заказал — получил». Расхождения уходят
>    командам, его проверка повторяется.
>
> **Готово, когда:** сквозной сценарий проходит И финальная верификация пройдена без
> открытых расхождений.
>
> **Отчёт:** статус; что собрано (по командам); где лежит (пути, ветки); что открыто и
> почему; история находок верификатора.

В этом промпте нет ничего экзотического, и каждая строка ложится на то, что инструмент
делает нативно: «параллельно» превращается в параллельные вызовы delegate; «каждую ведёт
свой воркер-оркестратор» — во вложенное делегирование; «совершенно новый воркер … без
отчётов команд» — это изолированная верификация по построению; «находки уходят командам» —
почтовый ящик без пересоздания воркеров; «готово, когда» гарантируется единственным известным
инструменту способом — валидированные отчёты на диске, а не слово воркера. И порог
вхождения не меняется: эта структура необязательна. Когда цена переделки низка, я по-прежнему
пишу короткую версию из предыдущего примера — машинерия выдаст те же волны в обоих случаях.

### Два стиля промпта

| | Короткий (как думаю) | Структурированная спека (профессиональный стиль) |
|---|---|---|
| Делегирование | явное — достаточно одного «делегируй» | явное («работай так: …») |
| Что я задаю | цель + критерий «готово» | цель, скоуп, схему по волнам, гейты качества, формат отчёта |
| Кто придумывает организацию | оркестратор | я (оркестратор исполняет) |
| Когда использую | рутинные задачи, дёшево переделать | дорогая переделка, много ролей, важен порядок волн |

Оба стиля работают на одной машинерии. Короткий промпт — не игрушечная версия
структурированной спеки:
это то же делегирование, в котором делегирована и организация.
