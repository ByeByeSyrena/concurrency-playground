# Concurrency Playground

Навчальний проєкт для експериментів з конкурентністю в Node.js + PostgreSQL на прикладі банківського рахунку: два паралельні запити намагаються зняти гроші з одного балансу.

Що тут розібрано:

- race condition на змінній у пам'яті і власний `Mutex` ([mutex.js](mutex.js), [mutex-lock.js](mutex-lock.js))
- lost update у Postgres і atomic conditional update (`UPDATE ... WHERE balance_cents >= $1`)
- pessimistic locking через `SELECT ... FOR UPDATE`
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
  balance_cents BIGINT NOT NULL
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
| `POST` | `/reset` | повертає баланс до 10000 |

Тіло для `withdraw`: `{ "amountCents": 8000 }`.

В endpoint-ах навмисно стоять паузи (`setTimeout`), щоб race condition і очікування на lock було легко побачити.

## Як відтворити гонку

```bash
node race.js                         # 2 паралельні запити на /withdraw
node race-pessimistic.js             # те саме для /withdraw-pessimistic
node race-pessimistic.js /withdraw   # будь-який інший endpoint
```

Скрипт робить `/reset`, шле два запити по 8000 при балансі 10000 і перевіряє, чи баланс зійшовся і чи другий запит чекав на lock.

Детальна шпаргалка з тестування, psql-командами і тим, як подивитися lock у `pg_locks`, лежить у [TESTING.md](TESTING.md).

## Порівняння підходів

_TODO (завдання 4 з [TASKS.md](TASKS.md)): atomic conditional update / optimistic locking / pessimistic locking._
