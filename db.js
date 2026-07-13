const { Pool } = require('pg');

// This connects to the permanent database link you got from Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

const DEFAULT_DATA = {
  users: [], servers: [], members: [], channels: [], messages: [], dms: [], dmMessages: []
};

// This creates the "table" in Postgres if it doesn't exist yet
async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL)`);
  const res = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (res.rowCount === 0) {
    await pool.query('INSERT INTO app_state (data) VALUES ($1)', [DEFAULT_DATA]);
  }
}

async function read() {
  await init();
  const res = await pool.query('SELECT data FROM app_state WHERE id = 1');
  return res.rows[0].data;
}

async function write(data) {
  await pool.query('UPDATE app_state SET data = $1 WHERE id = 1', [data]);
}

let queue = Promise.resolve();
function transact(fn) {
  queue = queue.then(async () => {
    const data = await read();
    const result = fn(data);
    await write(data);
    return result;
  });
  return queue;
}

module.exports = { read, write, transact };
