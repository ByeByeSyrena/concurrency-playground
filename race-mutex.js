// Запуск: node race-mutex.js [portA] [portB] [path]
//   node race-mutex.js              -> A на 3000, B на 3001 (два процеси, mutex не допоможе)
//   node race-mutex.js 3000 3000    -> обидва на один процес (mutex має спрацювати)
const PORT_A = process.argv[2] || "3000";
const PORT_B = process.argv[3] || "3001";
// Слеш на початку необовʼязковий: Git Bash перетворює "/path" на Windows-шлях, тож пиши просто withdraw-pessimistic
const ENDPOINT = "/" + (process.argv[4] || "withdraw-mutex").replace(/^\/+/, "");
const START_BALANCE = 10000;
const AMOUNT = 8000;

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(5)}ms`;
const url = (port, path) => `http://localhost:${port}${path}`;

async function post(port, path, body) {
  const res = await fetch(url(port, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, data: await res.json() };
}

async function getBalance() {
  const res = await fetch(url(PORT_A, "/balance"));
  const data = await res.json();
  return data.balanceCents;
}

async function withdraw(label, port, amountCents) {
  const started = Date.now();
  console.log(`${ts()} [${label} → :${port}] start, amount: ${amountCents}`);

  const result = await post(port, ENDPOINT, { amountCents });
  const duration = Date.now() - started;

  console.log(`${ts()} [${label} → :${port}] done in ${duration}ms ->`, result.status, result.data);

  return { label, port, duration, ...result };
}

async function main() {
  console.log(`Endpoint: ${ENDPOINT}, A → :${PORT_A}, B → :${PORT_B}`);
  console.log(PORT_A === PORT_B ? "Режим: один процес" : "Режим: два процеси");

  const reset = await post(PORT_A, "/reset");
  console.log("Reset:", reset.data);

  if (reset.status !== 200) {
    console.log("⛔ /reset не спрацював — тест не має сенсу. Перевір, що Postgres запущений (docker ps) і подивись лог сервера.");
    process.exit(1);
  }
  console.log("Balance before:", await getBalance());
  console.log("---");

  const results = await Promise.all([
    withdraw("A", PORT_A, AMOUNT),
    withdraw("B", PORT_B, AMOUNT),
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

  if (results.some((r) => r.status === 500)) {
    console.log("⚠️  Є 500 — подивись лог сервера, результат нижче може бути неточним");
  }

  if (withdrawnTotal > START_BALANCE || balanceAfter !== START_BALANCE - withdrawnTotal) {
    console.log("❌ RACE CONDITION: видано більше, ніж було, або баланс не зійшовся");
  } else {
    console.log("✅ OK: баланс консистентний");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
