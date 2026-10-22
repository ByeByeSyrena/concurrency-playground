const BASE_URL = "http://localhost:3000";

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
  console.log(`[${label}] start, amount: ${amountCents}`);
  const started = Date.now();

  const result = await post("/withdraw", { amountCents });

  console.log(
    `[${label}] done in ${Date.now() - started}ms ->`,
    result.status,
    result.data
  );

  return result;
}

async function main() {
  const reset = await post("/reset");
  console.log("Reset:", reset.data);
  console.log("Balance before:", await getBalance());
  console.log("---");

  const results = await Promise.all([
    withdraw("A", 8000),
    withdraw("B", 8000),
  ]);

  console.log("---");

  const successCount = results.filter((r) => r.status === 200).length;
  const withdrawnTotal = results
    .filter((r) => r.status === 200)
    .reduce((sum, r) => sum + r.data.withdrawnCents, 0);
  const balanceAfter = await getBalance();

  console.log("Successful withdrawals:", successCount);
  console.log("Total withdrawn:", withdrawnTotal);
  console.log("Balance after:", balanceAfter);
  console.log("Expected balance:", 10000 - withdrawnTotal);

  if (balanceAfter !== 10000 - withdrawnTotal || withdrawnTotal > 10000) {
    console.log("❌ RACE CONDITION: гроші видані, але баланс не зійшовся");
  } else {
    console.log("✅ OK: баланс консистентний");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
