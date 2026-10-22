const express = require('express');
const pool = require('./db');
const { Mutex } = require('./mutex');
const withTransaction = require('./transaction');
const { InsufficientFundsError } = require('./errors');

const app = express();
app.use(express.json());

// let balance = 100; mutex-lock
// const mutex = new Mutex();

app.get('/balance', async (req, res) => {
  try {
    const result = await pool.query('SELECT balance_cents FROM accounts WHERE id = $1', [1]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Account not found'
      });
    }

    res.json({
      balanceCents: Number(result.rows[0].balance_cents)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// app.post('/withdraw-pessimistic', async (req, res) => {
//   const { amountCents } = req.body;

//   if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
//     return res.status(400).json({
//       error: 'amountCents must be a positive integer'
//     });
//   }

//   const client = await pool.connect();

//   function onError (err){
//     console.error('[pessimistic catch listener]', err);
//   }
//   client.on('error', onError);
//   let rollbackErr = null;

//   try {
//     await client.query('BEGIN TRANSACTION');
//     const { rows } = await client.query('SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE', [1]);

//     // Спеціально залишаємо паузу, щоб легко побачити лок
//     await new Promise((resolve) => setTimeout(resolve, 50000));

//     const balance = Number(rows[0].balance_cents);

//     console.log('rows', balance);

//     if (balance < amountCents) {
//       await client.query('ROLLBACK');
//       return res.status(400).json({
//         error: 'Not enough money'
//       });
//     }

//     const updatedBalance = balance - amountCents;
//     const resultUpdate = await client.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2 RETURNING balance_cents', [updatedBalance, 1]);

//     console.log(resultUpdate);
//     await client.query('COMMIT');
//     const newBalance = Number(resultUpdate.rows[0].balance_cents);

//     res.json({
//       success: true,
//       withdrawnCents: amountCents,
//       balanceCents: newBalance
//     });
//   } catch (error) {
//     console.error('[pessimistic catch]', error);

//     try {
//       await client.query('ROLLBACK');
//     } catch (err) {
//       rollbackErr = err;
//     }

//     res.status(500).json({
//       error: 'Internal server error'
//     });
//   } finally {
//     client.off('error', onError);
//     client.release(rollbackErr);
//   }
// });

app.post('/withdraw-pessimistic', async (req, res) => {
  const { amountCents } = req.body;

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({
      error: 'amountCents must be a positive integer'
    });
  }

  async function updateBalance(client) {
    const { rows } = await client.query('SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE', [1]);

    // Спеціально залишаємо паузу, щоб легко побачити лок
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const balance = Number(rows[0].balance_cents);

    if (balance < amountCents) {
      throw new InsufficientFundsError('Not enough money');
    }

    const updatedBalance = balance - amountCents;
    const resultUpdate = await client.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2 RETURNING balance_cents', [updatedBalance, 1]);

    return Number(resultUpdate.rows[0].balance_cents);
  }

  try {
    const newBalance = await withTransaction(updateBalance);

    res.json({
      success: true,
      withdrawnCents: amountCents,
      balanceCents: newBalance
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return res.status(400).json({
        error: 'Not enough money'
      });
    }

    console.error(err);

    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

app.post('/withdraw', async (req, res) => {
  const { amountCents } = req.body;

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({
      error: 'amountCents must be a positive integer'
    });
  }

  try {
    // Тільки для логу, на логіку не впливає
    const result = await pool.query('SELECT balance_cents FROM accounts WHERE id = $1', [1]);

    const balance = Number(result.rows[0].balance_cents);

    console.log('Read balance:', balance);
    console.log('Trying to withdraw:', amountCents);

    // Спеціально залишаємо паузу, щоб легко отримати race condition
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const resultAfterUpdate = await pool.query('UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2 AND balance_cents >= $1 RETURNING balance_cents', [amountCents, 1]);

    if (!resultAfterUpdate.rowCount) {
      return res.status(400).json({
        error: 'Not enough money'
      });
    }

    const newBalance = Number(resultAfterUpdate.rows[0].balance_cents);

    res.json({
      success: true,
      withdrawnCents: amountCents,
      balanceCents: newBalance
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

app.post('/reset', async (req, res) => {
  try {
    await pool.query('UPDATE accounts SET balance_cents = $1 WHERE id = $2', [10000, 1]);

    res.json({
      balanceCents: 10000
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
