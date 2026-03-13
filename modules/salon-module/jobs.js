module.exports = async function registerSalonJobs({ scheduler, db, logger }) {
  scheduler.addJob('salon-upcoming-appointments', async () => {
    const upcoming = typeof db.listByFilters === 'function'
      ? await db.listByFilters('appointments', {
        filters: [{ column: 'status', op: 'eq', value: 'booked' }],
        limit: 20,
        offset: 0
      })
      : (await db.list('appointments', { limit: 20 })).filter((item) => item.status === 'booked');
    logger.info(`Upcoming booked appointments: ${upcoming.length}`);
  }, 60 * 1000);
};
