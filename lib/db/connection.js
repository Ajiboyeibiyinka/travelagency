const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'travel_agency',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

console.log(`[DB] Pool initialized for database: ${process.env.DB_NAME || 'travel_agency'} on ${process.env.DB_HOST || '127.0.0.1'}`);

/**
 * Execute a query against the database
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('[DB] Query executed', { text: text.substring(0, 80), duration: `${duration}ms`, rows: result.rowCount });
  return result;
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

/**
 * Close the database pool
 */
async function close() {
  await pool.end();
  console.log('[DB] Connection pool closed');
}

module.exports = { query, getClient, close, pool };
