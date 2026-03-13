function parseLimit(value, fallback = 50, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseOffset(value, fallback = 0, max = 5000) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function dateKey(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function fullName(record, singular) {
  if (!record) return null;
  if (record.first_name || record.last_name) {
    return [record.first_name, record.last_name].filter(Boolean).join(' ').trim();
  }
  return record[singular] || null;
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function toMinuteDiff(startAt, endAt) {
  const start = startAt ? new Date(startAt).getTime() : NaN;
  const end = endAt ? new Date(endAt).getTime() : NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.round((end - start) / (60 * 1000));
}

function beginOfWeekUtc(inputDate) {
  const d = new Date(`${inputDate}T00:00:00.000Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfWeekUtc(inputDate) {
  const start = beginOfWeekUtc(inputDate);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function computeRevenueGrowth(payments) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const currentWindowStart = now - (14 * oneDay);
  const previousWindowStart = now - (28 * oneDay);

  let currentTotal = 0;
  let previousTotal = 0;

  for (const payment of payments) {
    if (payment.status !== 'received') continue;
    const paidAt = new Date(payment.paid_at || payment.modified || payment.created).getTime();
    if (Number.isNaN(paidAt)) continue;
    const amount = Number(payment.amount || 0);
    if (paidAt >= currentWindowStart && paidAt <= now) {
      currentTotal += amount;
      continue;
    }
    if (paidAt >= previousWindowStart && paidAt < currentWindowStart) {
      previousTotal += amount;
    }
  }

  if (previousTotal <= 0) {
    return currentTotal > 0 ? 100 : 0;
  }

  return Number((((currentTotal - previousTotal) / previousTotal) * 100).toFixed(1));
}

function withinDateRange(isoDate, fromDate, toDate) {
  if (!isoDate) return false;
  if (fromDate && isoDate < fromDate) return false;
  if (toDate && isoDate > toDate) return false;
  return true;
}

function buildVisitStats(appointments) {
  const statsByCustomer = new Map();

  for (const appointment of appointments) {
    if (!appointment.customer_id) continue;
    const current = statsByCustomer.get(appointment.customer_id) || {
      visits: 0,
      completedVisits: 0,
      scheduledVisits: 0,
      upcomingVisits: 0,
      lastVisitAt: null
    };

    current.visits += 1;
    if (appointment.status === 'completed') current.completedVisits += 1;
    if (appointment.status === 'scheduled' || appointment.status === 'booked') current.scheduledVisits += 1;

    const startAt = toIso(appointment.start_at);
    if (startAt && (!current.lastVisitAt || startAt > current.lastVisitAt)) {
      current.lastVisitAt = startAt;
    }

    const startsMs = startAt ? new Date(startAt).getTime() : NaN;
    if (!Number.isNaN(startsMs) && startsMs >= Date.now()) {
      current.upcomingVisits += 1;
    }

    statsByCustomer.set(appointment.customer_id, current);
  }

  return statsByCustomer;
}

function summarizeClient(customer, stats) {
  const name = fullName(customer, 'customer') || customer.customer || '(unnamed)';
  const current = stats || {
    visits: 0,
    completedVisits: 0,
    scheduledVisits: 0,
    upcomingVisits: 0,
    lastVisitAt: null
  };

  return {
    id: customer.id,
    public_id: customer.public_id || null,
    name,
    first_name: customer.first_name || null,
    last_name: customer.last_name || null,
    email: customer.email || null,
    phone: customer.phone || customer.cell || null,
    cell: customer.cell || null,
    sms: customer.sms || false,
    status: customer.status || null,
    notes: customer.notes || null,
    photo_url: customer.photo_url || null,
    visits: current.visits,
    completedVisits: current.completedVisits,
    scheduledVisits: current.scheduledVisits,
    upcomingVisits: current.upcomingVisits,
    lastVisitAt: current.lastVisitAt,
    lastVisitDate: current.lastVisitAt ? current.lastVisitAt.slice(0, 10) : null
  };
}

module.exports = async function registerSalonRoutes(router, { db, eventBus }) {
  async function listAppointmentsByFilters(filters, { limit = 500, offset = 0 } = {}) {
    if (typeof db.listByFilters === 'function') {
      return db.listByFilters('appointments', {
        filters,
        limit,
        offset,
        orderBy: 'start_at',
        orderDirection: 'ASC'
      });
    }
    return db.list('appointments', { limit, offset });
  }

  async function listPaymentsByFilters(filters, { limit = 1000, offset = 0 } = {}) {
    if (typeof db.listByFilters === 'function') {
      return db.listByFilters('payments', {
        filters,
        limit,
        offset,
        orderBy: 'paid_at',
        orderDirection: 'DESC'
      });
    }
    return db.list('payments', { limit, offset });
  }

  async function fetchReferenceData() {
    const [customers, staffUsers] = await Promise.all([
      db.list('customers', { limit: 500, offset: 0 }),
      db.list('users', { limit: 500, offset: 0 })
    ]);

    const customerById = new Map(customers.map((row) => [row.id, row]));
    const staffById = new Map(staffUsers.map((row) => [row.id, row]));

    return { customers, customerById, staffById };
  }

  function hydrateAppointment(item, { customerById, staffById }) {
    const customer = customerById.get(item.customer_id);
    const staff = staffById.get(item.staff_user_id);
    const startAt = toIso(item.start_at);
    const endAt = toIso(item.end_at);
    const customerName = fullName(customer, 'customer');
    const staffName = fullName(staff, 'user');

    return {
      ...item,
      customer_name: customerName,
      customer_public_id: customer?.public_id || null,
      staff_name: staffName,
      staff_public_id: staff?.public_id || null,
      starts_at: startAt,
      ends_at: endAt,
      duration_minutes: toMinuteDiff(startAt, endAt)
    };
  }

  async function resolveEntityId(entity, identifier) {
    if (!identifier) return null;
    const value = String(identifier).trim();
    if (!value) return null;
    return db.resolveId(entity, value);
  }

  router.get('/appointments', async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit, 100, 500);
      const offset = parseOffset(req.query.offset, 0, 5000);
      const fromDate = req.query.from ? String(req.query.from) : null;
      const toDate = req.query.to ? String(req.query.to) : null;
      const rows = req.query.q
        ? await db.list('appointments', {
          q: req.query.q,
          limit,
          offset
        })
        : await listAppointmentsByFilters([
          ...(fromDate ? [{ column: 'start_at', op: 'gte', value: `${fromDate}T00:00:00.000Z` }] : []),
          ...(toDate ? [{ column: 'start_at', op: 'lte', value: `${toDate}T23:59:59.999Z` }] : [])
        ], { limit, offset });

      const { customerById, staffById } = await fetchReferenceData();

      const hydrated = rows
        .map((item) => hydrateAppointment(item, { customerById, staffById }))
        .filter((item) => {
          const key = dateKey(item.starts_at || item.start_at);
          if (!fromDate && !toDate) return true;
          return withinDateRange(key, fromDate, toDate);
        });

      res.json(hydrated);
    } catch (error) {
      next(error);
    }
  });

  router.post('/appointments', async (req, res, next) => {
    try {
      const startAt = toIso(req.body.start_at || req.body.scheduled_at || req.body.starts_at || null);
      const durationMinutes = Number(req.body.duration_minutes || 0);
      const computedEnd = startAt && durationMinutes > 0
        ? new Date(new Date(startAt).getTime() + (durationMinutes * 60 * 1000)).toISOString()
        : null;

      const customerId = await resolveEntityId('customers',
        req.body.customer_id || req.body.customerId || req.body.customer_public_id || req.body.customerPublicId
      );

      const staffId = await resolveEntityId('users',
        req.body.staff_user_id || req.body.staffUserId || req.body.staff_public_id || req.body.staffPublicId
      );

      const payload = {
        ...req.body,
        appointment: req.body.appointment || req.body.service || req.body.name || 'Salon Appointment',
        start_at: startAt,
        end_at: toIso(req.body.end_at || req.body.ends_at || computedEnd),
        customer_id: customerId || null,
        staff_user_id: staffId || null,
        status: req.body.status || 'scheduled'
      };

      const appointment = await db.create('appointments', payload);
      await eventBus.publish('appointment.booked', {
        appointmentId: appointment.id,
        customerId: appointment.customer_id || null,
        startAt: appointment.start_at || null,
        scheduledAt: appointment.start_at || null,
        record: appointment
      });

      const { customerById, staffById } = await fetchReferenceData();
      const hydrated = hydrateAppointment(appointment, { customerById, staffById });
      res.status(201).json(hydrated);
    } catch (error) {
      next(error);
    }
  });

  router.get('/calendar', async (req, res, next) => {
    try {
      const month = req.query.month ? String(req.query.month).slice(0, 7) : null;
      const selectedDate = req.query.date ? String(req.query.date).slice(0, 10) : null;
      const rows = month
        ? await listAppointmentsByFilters([{ column: 'start_at', op: 'like', value: `${month}%` }], { limit: 1000, offset: 0 })
        : await listAppointmentsByFilters([], { limit: 1000, offset: 0 });
      const { customerById, staffById } = await fetchReferenceData();

      const events = rows
        .map((item) => hydrateAppointment(item, { customerById, staffById }))
        .filter((item) => item.starts_at)
        .filter((item) => {
          if (!month) return true;
          return item.starts_at.slice(0, 7) === month;
        })
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
        .map((item) => ({
          id: item.id,
          title: item.appointment || 'Appointment',
          startsAt: item.starts_at,
          endsAt: item.ends_at,
          status: item.status,
          customerId: item.customer_id || null,
          customerName: item.customer_name || null,
          staffName: item.staff_name || null,
          durationMinutes: item.duration_minutes
        }));

      const dailyCounts = {};
      for (const event of events) {
        const key = event.startsAt.slice(0, 10);
        dailyCounts[key] = (dailyCounts[key] || 0) + 1;
      }

      const scheduleDate = selectedDate || dateKey(new Date().toISOString());
      const daySchedule = events.filter((event) => event.startsAt.slice(0, 10) === scheduleDate);

      res.json({
        month,
        selectedDate: scheduleDate,
        events,
        dailyCounts,
        daySchedule
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/clients', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const [customers, appointments] = await Promise.all([
        db.list('customers', { limit: 500, offset: 0 }),
        listAppointmentsByFilters([], { limit: 1000, offset: 0 })
      ]);

      const visitsByCustomer = buildVisitStats(appointments);

      const clients = customers
        .map((customer) => summarizeClient(customer, visitsByCustomer.get(customer.id)))
        .filter((client) => {
          if (!q) return true;
          const haystack = [
            client.public_id,
            client.name,
            client.email,
            client.phone,
            client.status
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(q);
        })
        .sort((a, b) => {
          if (a.lastVisitAt && b.lastVisitAt) {
            return b.lastVisitAt.localeCompare(a.lastVisitAt);
          }
          if (a.lastVisitAt) return -1;
          if (b.lastVisitAt) return 1;
          return b.visits - a.visits;
        });

      res.json({ clients });
    } catch (error) {
      next(error);
    }
  });

  router.get('/clients/:identifier', async (req, res, next) => {
    try {
      const customer = await db.getByIdentifier('customers', req.params.identifier);
      if (!customer) {
        return res.status(404).json({ error: 'Client not found' });
      }

      const [allAppointments, staffUsers] = await Promise.all([
        listAppointmentsByFilters([{ column: 'customer_id', op: 'eq', value: customer.id }], { limit: 1000, offset: 0 }),
        db.list('users', { limit: 500, offset: 0 })
      ]);

      const clientAppointments = allAppointments;
      const visitStats = buildVisitStats(clientAppointments).get(customer.id);
      const staffById = new Map(staffUsers.map((row) => [row.id, row]));
      const customerById = new Map([[customer.id, customer]]);

      const appointments = clientAppointments
        .map((item) => hydrateAppointment(item, { customerById, staffById }))
        .sort((a, b) => String(b.starts_at || '').localeCompare(String(a.starts_at || '')))
        .slice(0, 100);

      return res.json({
        client: summarizeClient(customer, visitStats),
        appointments
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/dashboard', async (req, res, next) => {
    try {
      const targetDate = req.query.date ? String(req.query.date).slice(0, 10) : dateKey(new Date().toISOString());
      const weekStart = beginOfWeekUtc(targetDate).toISOString().slice(0, 10);
      const weekEnd = endOfWeekUtc(targetDate).toISOString().slice(0, 10);

      const [appointments, customers, users, payments] = await Promise.all([
        listAppointmentsByFilters([
          { column: 'start_at', op: 'gte', value: `${weekStart}T00:00:00.000Z` },
          { column: 'start_at', op: 'lte', value: `${weekEnd}T23:59:59.999Z` }
        ], { limit: 2000, offset: 0 }),
        db.list('customers', { limit: 500, offset: 0 }),
        db.list('users', { limit: 500, offset: 0 }),
        listPaymentsByFilters([
          { column: 'status', op: 'eq', value: 'received' }
        ], { limit: 2000, offset: 0 })
      ]);

      const customerById = new Map(customers.map((row) => [row.id, row]));
      const staffById = new Map(users.map((row) => [row.id, row]));
      const hydratedAppointments = appointments
        .map((row) => hydrateAppointment(row, { customerById, staffById }))
        .filter((row) => row.starts_at)
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));

      const todaySchedule = hydratedAppointments.filter((row) => dateKey(row.starts_at) === targetDate);
      const weekAppointments = hydratedAppointments.filter((row) => {
        const rowDate = dateKey(row.starts_at);
        return rowDate && rowDate >= weekStart && rowDate <= weekEnd;
      });
      const upcomingAppointments = hydratedAppointments
        .filter((row) => new Date(row.starts_at).getTime() >= Date.now())
        .slice(0, 8);

      const visitsByCustomer = new Map();
      for (const row of hydratedAppointments) {
        if (!row.customer_id) continue;
        const current = visitsByCustomer.get(row.customer_id) || { visits: 0, lastVisitAt: null };
        current.visits += 1;
        if (!current.lastVisitAt || row.starts_at > current.lastVisitAt) {
          current.lastVisitAt = row.starts_at;
        }
        visitsByCustomer.set(row.customer_id, current);
      }

      const recentClients = [...visitsByCustomer.entries()]
        .map(([customerId, stats]) => {
          const customer = customerById.get(customerId);
          return {
            id: customerId,
            public_id: customer?.public_id || null,
            name: fullName(customer, 'customer') || '(unknown customer)',
            visits: stats.visits,
            lastVisitAt: stats.lastVisitAt
          };
        })
        .sort((a, b) => b.lastVisitAt.localeCompare(a.lastVisitAt))
        .slice(0, 8);

      res.json({
        date: targetDate,
        metrics: {
          todayAppointments: todaySchedule.length,
          totalClients: customers.length,
          thisWeekAppointments: weekAppointments.length,
          revenueGrowthPct: computeRevenueGrowth(payments)
        },
        todaySchedule,
        upcomingAppointments,
        recentClients
      });
    } catch (error) {
      next(error);
    }
  });
};
