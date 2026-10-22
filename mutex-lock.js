const mutex = new Mutex();

let balance = 100;

async function withdraw(name, amount) {
  await mutex.lock();

  console.log(`${name}: LOCK ACQUIRED`);

  try {
    console.log(`${name}: current balance = ${balance}`);

    if (balance < amount) {
      console.log(`${name}: not enough money`);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    balance -= amount;

    console.log(`${name}: withdrew ${amount}`);
    console.log(`${name}: balance = ${balance}`);
  } finally {
    mutex.unlock();

    console.log(`${name}: LOCK RELEASED`);
  }
}

async function main() {
  await Promise.all([
    withdraw("Request A", 80),
    withdraw("Request B", 50),
  ]);

  console.log("FINAL BALANCE:", balance);
}

main();