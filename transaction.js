const pool = require('./db');

function onError(err) {
  console.error('[withTransaction listener]', err);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  client.on('error', onError);
  let rollbackErr = null;

  try {
    await client.query('BEGIN TRANSACTION');
    const result = await fn(client);
    await client.query('COMMIT');

    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (err) {
      rollbackErr = err;
    }

    throw error;
  } finally {
    client.off('error', onError);
    client.release(rollbackErr);
  }
}

module.exports = withTransaction;
