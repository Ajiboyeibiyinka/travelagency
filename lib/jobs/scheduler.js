const { PgBoss } = require('pg-boss');
require('dotenv').config();

const JOB_COMPILE_QUOTES = 'compile-quotes';

let boss = null;

/**
 * Initialize pg-boss and register job handlers.
 * Call this once at server startup.
 */
async function startScheduler() {
    boss = new PgBoss({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        database: process.env.DB_NAME || 'travel_agency',
        max: 3, // separate pool for job processing
    });

    boss.on('error', err => console.error('[Scheduler] pg-boss error:', err));

    await boss.start();
    console.log('[Scheduler] pg-boss started.');

    await boss.createQueue(JOB_COMPILE_QUOTES);

    // Register the quote compilation handler
    await boss.work(JOB_COMPILE_QUOTES, async (job) => {
        const { inquiryId } = job.data;
        console.log(`[Scheduler] Running compile-quotes for Inquiry ID: ${inquiryId}`);
        const { compileAndSendQuotes } = require('../flows/quote-compiler');
        await compileAndSendQuotes(inquiryId);
    });

    console.log(`[Scheduler] Worker registered for "${JOB_COMPILE_QUOTES}".`);
}

/**
 * Schedule the quote compiler to run after a delay.
 * The job survives server restarts — pg-boss persists it in the DB.
 *
 * @param {string} inquiryId - UUID of the inquiry
 * @param {number} delayMs - Delay in milliseconds before the job runs
 */
async function scheduleQuoteCompilation(inquiryId, delayMs) {
    if (!boss) {
        throw new Error('[Scheduler] pg-boss is not initialized. Call startScheduler() first.');
    }

    const startAfter = Math.ceil(delayMs / 1000); // pg-boss uses seconds

    const jobId = await boss.send(JOB_COMPILE_QUOTES, { inquiryId }, { startAfter });
    console.log(`[Scheduler] Scheduled compile-quotes for Inquiry ${inquiryId} in ${startAfter}s (job: ${jobId})`);
    return jobId;
}

/**
 * Gracefully shut down the scheduler.
 */
async function stopScheduler() {
    if (boss) {
        await boss.stop();
        console.log('[Scheduler] pg-boss stopped.');
    }
}

module.exports = { startScheduler, scheduleQuoteCompilation, stopScheduler };
