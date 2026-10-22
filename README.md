# Concurrency Playground

Навчальний проєкт для експериментів з конкурентністю в Node.js + PostgreSQL на прикладі банківського рахунку: два паралельні запити намагаються зняти гроші з одного балансу.

Що тут розібрано:

- race condition на змінній у пам'яті і власний `Mutex` ([mutex.js](mutex.js), [mutex-lock.js](mutex-lock.js))
- lost update у Postgres і atomic conditional update (`UPDATE ... WHERE balance_cents >= $1`)
- pessimistic locking через `SELECT ... FOR UPDATE`
- optimistic locking через колонку `version`
- helper `withTransaction` для `BEGIN / COMMIT / ROLLBACK` на одному client ([transaction.js](transaction.js))

Повний маршрут з наступними кроками (optimistic locking, deadlocks, isolation levels, Redis lock, idempotency тощо) лежить у [TASKS.md](TASKS.md).

## Стек

Node.js 22, Express 5, `pg`, PostgreSQL 17 у Docker.

## Запуск

```bash
npm install
cp .env.example .env          # і вкажи свій пароль у .env
docker compose up -d          # Postgres на localhost:5434
npm start                     # сервер на http://localhost:3000
```

Таблиця, з якою працює сервер (створити один раз через psql):

```sql
CREATE TABLE accounts (
  id            SERIAL PRIMARY KEY,
  balance_cents BIGINT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO accounts (balance_cents) VALUES (10000);
```

```bash
docker exec -it concurrency-playground-postgres-1 psql -U postgres -d concurrency
```

## API

| Метод | Шлях | Що робить |
|---|---|---|
| `GET` | `/balance` | поточний баланс рахунку `id = 1` |
| `POST` | `/withdraw` | зняття через atomic conditional update |
| `POST` | `/withdraw-pessimistic` | зняття через `SELECT ... FOR UPDATE` у транзакції |
| `POST` | `/withdraw-optimistic` | зняття з перевіркою `version`, при конфлікті `409` |
| `POST` | `/reset` | повертає баланс до 10000 |

Тіло для `withdraw`: `{ "amountCents": 8000 }`.

В endpoint-ах навмисно стоять паузи (`setTimeout`), щоб race condition і очікування на lock було легко побачити.

## Як відтворити гонку

```bash
node race.js                         # 2 паралельні запити на /withdraw
node race-pessimistic.js             # те саме для /withdraw-pessimistic
node race-pessimistic.js /withdraw   # будь-який інший endpoint
node race-optimistic.js              # те саме для /withdraw-optimistic
```

Скрипти роблять `/reset`, шлють два паралельні запити і перевіряють, чи баланс зійшовся. `race-pessimistic.js` ще дивиться, чи другий запит чекав на lock, а `race-optimistic.js` — чи один із запитів отримав `409`.

Детальна шпаргалка з тестування, psql-командами і тим, як подивитися lock у `pg_locks`, лежить у [TESTING.md](TESTING.md).

## Порівняння підходів

Три способи не дати двом запитам зняти гроші, яких немає.

**Atomic conditional update** (`/withdraw`): перевірка і запис в одному SQL.
```sql
UPDATE accounts SET balance_cents = balance_cents - $1
WHERE id = $2 AND balance_cents >= $1
```

**Optimistic locking** (`/withdraw-optimistic`): читаємо рядок разом із `version`, рахуємо в JS, пишемо тільки якщо `version` не змінилась.
```sql
UPDATE accounts SET balance_cents = $1, version = version + 1
WHERE id = $2 AND version = $3
```

**Pessimistic locking** (`/withdraw-pessimistic`): у транзакції блокуємо рядок `SELECT ... FOR UPDATE`, решта запитів чекає в черзі до `COMMIT`.

|  | Atomic conditional update | Optimistic locking | Pessimistic locking |
|---|---|---|---|
| **Коли підходить** | Уся перевірка вміщається в один `WHERE`: лічильники, баланс, залишки на складі | Конфлікти рідкісні; логіка між read і write складна або довга (форма, яку людина редагує хвилинами) | Конфлікти часті, а логіка між read і write складніша за один `WHERE` і має відпрацювати з першого разу |
| **Плюси** | Найпростіше і найшвидше: один запит, без транзакції, lock на рядку тримається мілісекунди | Ніхто нікого не блокує під час роботи; добре масштабується; працює навіть між HTTP-запитами (ETag / `If-Match`) | Гарантовано без конфліктів: хто перший взяв lock, той і робить; не треба retries |
| **Мінуси** | Не підходить, якщо рішення залежить від чогось поза SQL | Потрібна колонка `version` і обробка `409` | Транзакція на одному client, `release` на кожному шляху; з'єднання з пулу зайняте весь час, поки тримається lock; ризик deadlock, якщо блокувати кілька рядків у різному порядку |
| **Високий contention** | Добре: запити швидко проходять по черзі, поки вистачає грошей, далі отримують відмову | Погано: більшість запитів отримує `409` і робить роботу вхолосту; retries ще більше розганяють навантаження | Терпимо, але повільно: всі стоять у черзі, час відповіді росте лінійно, пул з'єднань може вичерпатись |
| **Чи потрібні retries** | Ні: `rowCount = 0` означає «грошей немає», це бізнес-відмова, а не конфлікт | Так: після `409` треба перечитати рядок і спробувати знову (з обмеженням спроб і backoff) | Зазвичай ні; лише на deadlock або lock timeout |
| **Складність** | Низька | Середня | Середня–висока |

### А якщо між read і write треба викликати зовнішній сервіс?

Наприклад, перевірити ліміт через антифрод-API перед списанням.

- **Atomic update** не підходить: відповідь зовнішнього сервісу не запхаєш у `WHERE`.
- **Pessimistic** спрацює, але lock і з'єднання з пулу висітимуть увесь час, поки йде мережевий виклик. Повільний сервіс блокує всіх, хто стоїть у черзі за цим рядком, і може вичерпати пул.
- **Optimistic** тут найкращий: під час виклику нічого не заблоковано, а якщо рядок встигли змінити, отримаємо `409` і повторимо. Але зовнішній виклик при retry теж повториться, тож він має бути ідемпотентним (див. завдання 12).

**Коротко:** якщо вміщається в один `WHERE`, бери atomic update. Якщо ні і конфлікти рідкісні, бери optimistic. Якщо ні і конфлікти часті, бери pessimistic, але тримай lock якомога коротше.
