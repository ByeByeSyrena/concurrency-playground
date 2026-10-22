# Як тестувати — шпаргалка

## 0. Підняти оточення

```bash
# Postgres (порт 5434 на хості → 5432 у контейнері)
docker compose up -d
docker ps                       # має бути concurrency-playground-postgres-1

# Сервер (окремий термінал). Після КОЖНОЇ зміни в коді: Ctrl+C → запустити знову
node --env-file=.env index.js   # або npm start
```

> Перед запуском перевір, що файл збережений (`Ctrl+S`, на вкладці немає ●).

## 1. Зайти в psql

```bash
docker exec -it concurrency-playground-postgres-1 psql -U postgres -d concurrency
```

Корисне всередині psql:

| Команда | Що робить |
|---|---|
| `\pset pager off` | вимкнути пейджер (`~` і `(END)`), виконати раз за сесію |
| `\x` | вертикальний вивід для широких таблиць (ще раз `\x`, щоб вимкнути) |
| `q` | вийти з пейджера, якщо він таки відкрився |
| `\q` | вийти з psql |
| `\d accounts` | структура таблиці |

```sql
SELECT * FROM accounts ORDER BY id;                         -- баланси
UPDATE accounts SET balance_cents = 10000 WHERE id = 1;     -- ручний reset
```

## 2. Race-скрипти

```bash
node race.js                                # /withdraw
node race-pessimistic.js                    # /withdraw-pessimistic (за замовчуванням)
node race-pessimistic.js /withdraw          # будь-який інший endpoint
```

Скрипт сам робить `/reset` (баланс 10000) і шле 2 паралельні запити по 8000.

| Що в кінці виводу | Значення |
|---|---|
| ✅ OK | баланс зійшовся |
| ❌ RACE CONDITION | видано більше, ніж було, або баланс не зійшовся |
| 🔒 | повільніший запит чекав > 1 с довше: видно lock |
| ⚠️ | обидва завершились приблизно одночасно: ніхто не чекав |

## 3. Pessimistic locking: три варіанти паузи

Пауза: `await new Promise((resolve) => setTimeout(resolve, 5000));`
(не `setTimeout(() => {}, 5000)`, бо такий варіант не зупиняє код)

| Де пауза | Очікування | Висновок |
|---|---|---|
| **після** `FOR UPDATE` | A ≈ 5 с, B ≈ 10 с, ✅ 🔒 | lock тримається під час паузи, B стоїть у черзі |
| **перед** `FOR UPDATE` | A ≈ 5 с, B ≈ 5 с, ✅ ⚠️ | обидва сплять паралельно, lock тримається ~20 мс |
| після SELECT **без** `FOR UPDATE` | обидва 200, ❌ | однієї транзакції недостатньо, буде lost update |

## 4. Подивитися lock у Postgres

1. Пауза після `FOR UPDATE` ~20 с, перезапусти сервер.
2. `node race-pessimistic.js`
3. Поки A спить, у psql:

```sql
-- хто що робить (свою psql-сесію відфільтровуємо)
SELECT pid, state, wait_event_type, wait_event, left(query, 60) AS query
FROM pg_stat_activity
WHERE datname = 'concurrency' AND pid <> pg_backend_pid();

-- хто тримає lock, а хто чекає
SELECT pid, locktype, relation::regclass, mode, granted
FROM pg_locks
WHERE pid IN (SELECT pid FROM pg_stat_activity WHERE datname = 'concurrency')
ORDER BY granted DESC;
```

Як читати:

| state | wait_event_type / wait_event | Хто це |
|---|---|---|
| `idle in transaction` | `Client` / `ClientRead` | **A**: тримає lock, спить у Node, Postgres чекає від нього наступну команду |
| `active` | `Lock` / `transactionid` | **B**: чекає, поки транзакція A завершиться |
| `idle` | `Client` / `ClientRead` | інша psql-сесія, не чіпати |

`transactionid` означає, що B чекає не «на рядок», а на **кінець транзакції A**: lock живе до `COMMIT`/`ROLLBACK`.

Додатково: поки A тримає lock, зроби `GET http://localhost:3000/balance`. Чи блокується? (MVCC)

## 5. Вбити транзакцію (обрив з'єднання)

```sql
-- вбити A (того, хто тримає lock), без копіювання pid вручну
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'concurrency' AND state = 'idle in transaction';

-- або конкретний pid (перевір, що копіюєш з АКТУАЛЬНОГО виводу)
SELECT pg_terminate_backend(<pid>);
```

Результат `t` означає, що вбили, `f` + `WARNING: ... is not a PostgreSQL backend process` означає, що такого pid немає (одруківка або старий pid).

Що має статися:

- у терміналі сервера одразу `[pessimistic catch listener] ... 57P01`, і **сервер живий**;
- Postgres відкотив транзакцію A і зняв lock, тож **B одразу продовжує**;
- A прокидається, падає на UPDATE і йде в `catch` → 500;
- B → 200, баланс 2000.

Без `client.on('error', ...)` сервер **падає** з `Unhandled 'error' event`.

## 6. Розбір помилок

| Помилка | Причина |
|---|---|
| `password authentication failed` | на порту сидить **інший** Postgres (інший проєкт) або не той пароль. `docker ps` |
| `ECONNREFUSED ...:5433` | на цьому порту ніхто не слухає: порт у `db.js` ≠ порт у `docker-compose.yml`, або контейнер не запущений |
| `fetch failed` / `ECONNRESET` у race-скрипті | **сервер упав**, причину дивись у терміналі `node index.js` |
| `Unhandled 'error' event` ... `57P01` | з'єднання обірвали, а на `client` немає слухача `'error'` |
| `operator is not unique: unknown - unknown` | Postgres не може вивести тип параметрів (`$2 - $1`). Рахуй у JS або роби cast `::bigint` |
| `(intermediate value) is not iterable` | `const [rows] = ...` — синтаксис MySQL. У `pg` треба `const { rows } = ...` |
| Запит завис назавжди, в `pg_stat_activity` висить `idle in transaction` | транзакцію не закрили (немає `ROLLBACK` на гілці з `return`) або не зробили `release()`. Перезапусти Node або `pg_terminate_backend` |
| Усі запити зависли після ~10 викликів | пул вичерпаний: десь немає `client.release()` |
| `~` і `(END)` у psql | це пейджер: `q`, потім `\pset pager off` |

Як відрізнити **свій** лог від краш-звіту Node: у краша є `throw er;`, `Emitted 'error' event on ...` і `Node.js vXX` в кінці, після чого процес завершується.
