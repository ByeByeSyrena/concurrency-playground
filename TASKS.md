# Concurrency Playground — маршрут завдань

> Правило: не переходь до Redis / Kubernetes, поки не закриєш **FOR UPDATE + optimistic locking + 2 processes**.

## ✅ Вже зроблено

- [x] Race condition на `let balance`
- [x] Custom mutex
- [x] Підключення Postgres
- [x] Відтворення lost update
- [x] Atomic conditional update (`UPDATE ... WHERE balance_cents >= $1`)

---

## Завдання 1. Pessimistic locking (`SELECT ... FOR UPDATE`)

**Мета:** другий конкурентний запит чекає, поки перший не завершить транзакцію.

- [x] Створи окремий endpoint `POST /withdraw-pessimistic`
- [x] Візьми окремий client з пулу (`pool.connect()`)
- [x] `BEGIN`
- [x] `SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE`
- [x] Затримка 5 сек **після** захоплення lock
- [x] Перевір balance у JS (якщо грошей не вистачає, поверни 400)
- [x] `UPDATE` балансу
- [x] `COMMIT`
- [x] `ROLLBACK` при помилці
- [x] `client.release()` у `finally`

**Підказки:**
- ⚠️ `pool.query` бере **будь-який** вільний connection, тож `BEGIN`, `SELECT` і `COMMIT` можуть потрапити в різні з'єднання. Транзакція має йти через **один** `client`.
- ⚠️ Гілка «грошей не вистачає» теж має закрити транзакцію. Інакше connection повернеться в пул з відкритою транзакцією, а lock на рядку лишиться висіти.
- Подивись у документації `pg`, що повертає `pool.connect()` і чим `client.query` відрізняється від `pool.query`.
- Питання собі: у яких гілках коду транзакція має явно закриватися? Рахуй не лише `catch`.
- `release()` має викликатися **рівно один раз** на будь-якому шляху: успіх, 400, помилка.
- `ROLLBACK` теж може кинути помилку, наприклад якщо з'єднання вже мертве. Подивись, що робить `client.release(err)`.
- Перевірка `balance >= amount` тепер робиться **в JS**, а не у `WHERE`, як в atomic update. Подумай, чому тут read → check → write безпечний, а в найпершому `/withdraw` він ламався.

**Готово, коли:** 2 паралельні запити на 70 при балансі 100 дають один успіх і один `400`, а другий відповідає приблизно через 10 сек, а не через 5.

---

## Завдання 1.5. Винести транзакцію в helper `withTransaction`

**Мета:** не повторювати в кожному endpoint `connect → on('error') → BEGIN → COMMIT / ROLLBACK → off → release`. Це знадобиться вже в завданні 7 (`/transfer`) і далі.

- [x] Створи окремий файл (наприклад, `transaction.js`) з функцією `withTransaction(fn)`
- [x] Helper сам:
  - бере client з пулу
  - вішає слухача `'error'` і знімає його перед `release`
  - робить `BEGIN`
  - викликає `fn(client)` і **повертає її результат**
  - робить `COMMIT`, якщо `fn` завершилась успішно
  - робить `ROLLBACK`, якщо `fn` кинула помилку, і **прокидає помилку далі** (`throw`)
  - робить `release(rollbackErr)` у `finally`
- [x] Перепиши `/withdraw-pessimistic` через helper. В endpoint лишаються тільки `SELECT ... FOR UPDATE`, перевірка, `UPDATE` і HTTP-відповідь
- [x] Перевір, що `race-pessimistic.js` дає той самий результат, що й до рефакторингу (✅ 🔒)

**Підказки:**
- Як `fn` має сказати «грошей не вистачає, відкоти все»? `return res.status(400)` зсередини `fn` не підходить: helper не знає, що це відмова, і зробить `COMMIT`. Подумай про **власний клас помилки** (`class InsufficientFundsError extends Error`): `fn` кидає його, helper робить `ROLLBACK` і прокидає далі, а endpoint у `catch` перетворює його на `400`, а все інше на `500`.
- Helper **не повинен** знати про `req`/`res`. Він працює тільки з БД. HTTP-відповіді лишаються в endpoint.
- `fn` — це `async`-функція, тож `await fn(client)`.
- Чому `ROLLBACK` помилку треба саме **прокинути далі**, а не проковтнути? Що інакше отримає endpoint?

**Готово, коли:** endpoint став коротшим, в ньому немає жодного `BEGIN`/`COMMIT`/`ROLLBACK`/`release`, а поведінка не змінилась.

---

## Завдання 2. Подивитися на lock руками

**Мета:** побачити послідовність `A acquires lock → B waits → A commits → B continues` і зрозуміти, що lock живе до `COMMIT`/`ROLLBACK`.

- [x] Додай логи з timestamp: перед `FOR UPDATE`, після нього («lock acquired»), перед `COMMIT` і після нього
- [x] Кинь 2 запити паралельно і порівняй логи
- [x] Поки A тримає lock, подивись у `psql`:
  - `pg_stat_activity`: **хто що робить** (кожне з'єднання до БД, його стан і чого воно чекає)
  - `pg_locks`: **хто які lock-и тримає і хто чекає** (`granted = false`)
  - Готові запити й пояснення, як читати результат, є в [TESTING.md](TESTING.md), розділ 4

**Питання, на які треба відповісти:**
- [x] На якому саме запиті зависає B: на `SELECT ... FOR UPDATE` чи на `UPDATE`?
- [x] Поки A тримає lock, зроби `GET /balance`. Він блокується? Чому? (ключове слово: **MVCC** - Multi-Version Concurrency Control, тобто «керування конкурентністю через кілька версій»)
- [x] Який balance бачить B після очікування: старий чи вже оновлений? (це місток до завдання 8: READ COMMITTED)
- [x] Тимчасово прибери `COMMIT`. Що станеться з наступними запитами? Так наочно видно, що lock живе до кінця транзакції.

---

## Завдання 3. Optimistic locking

**Мета:** без блокувань ловити конфлікт через версію рядка.

- [x] Додай колонку: `ALTER TABLE accounts ADD COLUMN version INTEGER NOT NULL DEFAULT 0;`
- [x] Endpoint `POST /withdraw-optimistic`:
  1. `SELECT balance_cents, version`
  2. затримка (щоб два запити прочитали одну й ту саму version)
  3. перевірка balance у JS
  4. update з умовою за версією:
     ```sql
     UPDATE accounts
     SET balance_cents = $1, version = version + 1
     WHERE id = $2 AND version = $3
     ```
  5. `rowCount = 0` → конфлікт (наприклад, `409 Conflict`)

**Підказки:**
- Тут **не потрібні** `BEGIN` і `FOR UPDATE`. Подумай, чому вистачає одного атомарного `UPDATE`.
- `balance_cents = $1` — це **нове значення, пораховане в JS**, а не `balance_cents - $1`. Саме тому без `version` тут був би lost update.

**Готово, коли:** два паралельні запити на 10 → один `200`, другий `409`, а баланс зменшився рівно на 10.

---

## Завдання 4. Порівняти три рішення в README

- [x] Створи `README.md` з таблицею: **atomic conditional update / optimistic locking / pessimistic locking**
- [x] Для кожного опиши:
  - коли підходить
  - плюси
  - мінуси
  - що відбувається при високому contention
  - чи потрібні retries
  - складність

**Підказка:** подумай, що з цього працює, якщо логіка перевірки не вміщається в один `WHERE` (наприклад, треба викликати зовнішній сервіс між read і write).

---

## Завдання 5. Два Node.js instances + local mutex

**Мета:** побачити, що local mutex не захищає shared DB state.

- [x] Зроби порт конфігурованим (`process.env.PORT || 3000`)
- [x] Поверни endpoint з local mutex, але щоб він читав і писав баланс у **БД** (read → delay → write, без atomic SQL)
- [x] Запусти 2 процеси: `3000` і `3001`
- [x] Кинь по одному запиту на кожен порт одночасно

**Питання:**
- [x] Чому mutex не допоміг? (process A має свій mutex A, process B має свій mutex B)
- [x] Що буде, якщо обидва запити кинути на один порт?

**Підказка:**
- ⚠️ Ліміт з'єднань множиться на кількість процесів. У `pg` пул за замовчуванням має `max: 10`, тож 2 процеси × 10 = 20 з'єднань до Postgres, а 5 replicas у k8s (завдання 14) = 50. Порівняй з `SHOW max_connections;`.

---

## Завдання 6. DB locking між процесами

- [х] Ті самі 2 сервери, але запити на `/withdraw-pessimistic`
- [х] Переконайся, що B на іншому процесі чекає на A

**Підказка:** кожен процес тримає власний пул, тож з'єднань до БД тепер удвічі більше (див. підказку в завданні 5).

**Висновок, який треба сформулювати своїми словами:** DB lock працює між різними Node-процесами, бо lock живе в Postgres, а не в RAM конкретного сервера.

---

## Завдання 7. Deadlock demo

- [ ] Додай другий акаунт (`id = 2`)
- [ ] Endpoint `POST /transfer` (`from`, `to`, `amount`) з `FOR UPDATE` на обидва рядки
- [ ] Між захопленням першого і другого lock додай затримку
- [ ] Паралельно: A = `1 → 2`, B = `2 → 1`
- [ ] Подивись помилку Postgres (`deadlock detected`, код `40P01`) і що сталося з кожною транзакцією
- [ ] Виправ: захоплюй lock-и **в однаковому порядку** (наприклад, за зростанням id)

**Підказка:** скільки часу Postgres чекає, перш ніж шукати deadlock? Знайди параметр `deadlock_timeout`.

---

## Завдання 8. Isolation levels

Можна робити прямо у двох вікнах `psql`, без Node.

- [ ] **READ COMMITTED**: відтвори *non-repeatable read* (у транзакції A два однакові `SELECT` повертають різні значення, бо B закомітив зміну між ними)
- [ ] **REPEATABLE READ**: повтори той самий сценарій. Що бачить A тепер? Що буде, якщо A спробує зробити `UPDATE` того самого рядка?
- [ ] **SERIALIZABLE**: отримай *serialization failure* (код `40001`)

**Підказка для SERIALIZABLE:** класичний сценарій — дві транзакції читають суму по кількох рядках і на її основі пишуть різні рядки (write skew).

---

## Завдання 9. Retry strategy

- [ ] Для `/withdraw-optimistic` додай retry при конфлікті
- [ ] Максимум N спроб (наприклад, 3), після них поверни помилку
- [ ] Між спробами зроби невелику затримку (подумай про backoff + jitter)
- [ ] (Опційно) те саме для SERIALIZABLE і помилки `40001`

**Питання:**
- [ ] Що треба перечитувати на кожній новій спробі?
- [ ] Чому retry теж частина concurrency strategy, а не просто обробка помилок?
- [ ] Що станеться з 50 паралельними запитами без jitter?

---

## Завдання 10. Redis distributed lock

- [ ] Додай Redis у `docker-compose.yml`
- [ ] Зроби простий lock: `SET key value NX PX <ttl>`
- [ ] Знімай lock безпечно: тільки якщо value твоє (Lua-скрипт)
- [ ] Подивись на Redlock і подумай, коли він потрібен

**Питання:**
- [ ] Що буде, якщо процес помре, тримаючи lock? Навіщо TTL?
- [ ] Що буде, якщо робота триває довше за TTL? (ключове слово: **fencing token**)
- [ ] Для яких задач із попередніх кроків distributed lock був би **зайвим**?

> ⚠️ Не використовуй distributed lock автоматично там, де достатньо atomic SQL або DB-транзакції.

---

## Завдання 11. BullMQ / workers

```
API → BullMQ → multiple workers → same shared resource
```

- [ ] API кладе job «withdraw» у чергу замість прямого списання
- [ ] Запусти кілька workers (окремі процеси і/або `concurrency > 1`)
- [ ] Відтвори race condition на рівні workers
- [ ] Виправ одним із вивчених способів

---

## Завдання 12. Idempotency

**Мета:** дубль job / повторний webhook / retry не списує гроші двічі.

- [ ] Додай `idempotency_key` до запиту / job
- [ ] Таблиця оброблених операцій з `UNIQUE` на ключ
- [ ] Запис ключа і списання мають бути **в одній транзакції**
- [ ] Перевір: один і той самий запит 5 разів паралельно → списання рівно одне

**Питання:**
- [ ] Чому «спочатку перевірю, чи є ключ, потім вставлю» — це знову race condition?
- [ ] Що повернути клієнту на повторний запит?

---

## Завдання 13. Docker Compose

- [ ] Підніми разом: `api`, `worker`, `postgres`, `redis`
- [ ] Винеси конфіг БД у env-змінні (зараз він захардкоджений у `db.js`)
- [ ] `docker compose up --scale worker=3`, щоб отримати кілька workers

---

## Завдання 14. Kubernetes / Minikube

- [ ] Задеплой API і worker з кількома replicas
- [ ] Повтори демо з local mutex і з DB/Redis-координацією

**Підказка:**
- ⚠️ 5 replicas × пул на 10 = 50 з'єднань, і число росте з кожним scale-up. Через це на проді перед Postgres ставлять **PgBouncer**.
- PgBouncer у transaction mode ламає сесійний стан (`SET`, prepared statements), бо наступна транзакція може потрапити на інше серверне з'єднання. Це вже окрема тема.

**Фінальний висновок:**
```
local mutex        != distributed protection
DB / Redis coordination = shared
```
