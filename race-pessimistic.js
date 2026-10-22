// Запуск: node race-pessimistic.js [path]
// За замовчуванням б'є в /withdraw-pessimistic, можна передати інший endpoint для порівняння.
const BASE_URL = "http://localhost:3000";
const ENDPOINT = process.argv[2] || "/withdraw-pessimistic";
const START_BALANCE = 10000;
const AMOUNT = 8000;

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(5)}ms`;

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, data: await res.json() };
}

async function getBalance() {
  const res = await fetch(`${BASE_URL}/balance`);
  const data = await res.json();
  return data.balanceCents;
}

async function withdraw(label, amountCents) {
  const started = Date.now();
  console.log(`${ts()} [${label}] start, amount: ${amountCents}`);

  const result = await post(ENDPOINT, { amountCents });
  const duration = Date.now() - started;

  console.log(`${ts()} [${label}] done in ${duration}ms ->`, result.status, result.data);

  return { label, duration, ...result };
}

async function main() {
  console.log("Endpoint:", ENDPOINT);
  const reset = await post("/reset");
  console.log("Reset:", reset.data);

  if (reset.status !== 200) {
    console.log("⛔ /reset не спрацював — тест не має сенсу. Перевір, що Postgres запущений (docker ps) і подивись лог сервера.");
    process.exit(1);
  }
  console.log("Balance before:", await getBalance());
  console.log("---");

  const results = await Promise.all([
    withdraw("A", AMOUNT),
    withdraw("B", AMOUNT),
  ]);

  console.log("---");

  const ok = results.filter((r) => r.status === 200);
  const withdrawnTotal = ok.reduce((sum, r) => sum + r.data.withdrawnCents, 0);
  const balanceAfter = await getBalance();

  console.log("Statuses:", results.map((r) => `${r.label}=${r.status}`).join(", "));
  console.log("Successful withdrawals:", ok.length);
  console.log("Total withdrawn:", withdrawnTotal);
  console.log("Balance after:", balanceAfter);
  console.log("Expected balance:", START_BALANCE - withdrawnTotal);

  if (balanceAfter !== START_BALANCE - withdrawnTotal || withdrawnTotal > START_BALANCE) {
    console.log("❌ RACE CONDITION: гроші видані, але баланс не зійшовся");
  } else {
    console.log("✅ OK: баланс консистентний");
  }

  // Головне для pessimistic locking: другий запит має ЧЕКАТИ на lock першого.
  const [fast, slow] = [...results].sort((a, b) => a.duration - b.duration);
  console.log("---");
  console.log(`Faster: ${fast.label} (${fast.duration}ms), slower: ${slow.label} (${slow.duration}ms)`);

  // Різниця в десятки мс — це шум. Чекання на lock видно лише коли в endpoint є пауза під lock-ом.
  if (slow.duration - fast.duration > 1000) {
    console.log("🔒 Другий запит чекав на першого — схоже на роботу lock-а");
  } else {
    console.log("⚠️  Обидва запити завершились приблизно одночасно — ніхто ні на кого не чекав");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
