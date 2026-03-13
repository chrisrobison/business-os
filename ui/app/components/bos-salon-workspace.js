function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(isoDate) {
  if (!isoDate) return 'No date';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(isoDate) {
  if (!isoDate) return '--:--';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey).split('-').map((v) => Number(v));
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function getMonthBounds(monthKey) {
  const [year, month] = String(monthKey).split('-').map((v) => Number(v));
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return { first, last };
}

function toMonthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

function shiftMonth(monthKey, delta) {
  const [year, month] = monthKey.split('-').map((v) => Number(v));
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return next.toISOString().slice(0, 7);
}

function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'CL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function avatarUrlFor(client) {
  if (client.photo_url) return client.photo_url;
  const seed = encodeURIComponent(client.public_id || client.id || client.name || 'client');
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${seed}`;
}

function viewCopy(view) {
  if (view === 'dashboard') {
    return {
      title: 'Dashboard',
      subtitle: "Welcome back. Here's what's happening today."
    };
  }
  if (view === 'calendar') {
    return {
      title: 'Calendar',
      subtitle: 'Manage your appointments and schedule.'
    };
  }
  if (view === 'clients') {
    return {
      title: 'Clients',
      subtitle: 'Manage your client database.'
    };
  }
  return {
    title: 'Salon Manager',
    subtitle: 'Operations workspace powered by Business OS.'
  };
}

class BosSalonWorkspace extends HTMLElement {
  constructor() {
    super();
    this.state = {
      view: 'dashboard',
      selectedMonth: toMonthKey(Date.now()),
      selectedDate: new Date().toISOString().slice(0, 10),
      clientQuery: '',
      clientView: 'card',
      selectedClientId: null,
      selectedClientProfile: null,
      isEditingClient: false,
      clientDraft: null,
      loading: false,
      dashboard: null,
      calendar: null,
      clients: []
    };

    this.$root = null;
    this.$title = null;
    this.$subtitle = null;
  }

  connectedCallback() {
    this.renderShell();
    this.loadView().catch((error) => this.showError(error));
  }

  set config(value) {
    const next = value || {};
    this.state.view = next.view || 'dashboard';
    if (this.isConnected) {
      this.loadView().catch((error) => this.showError(error));
    }
  }

  get config() {
    return { view: this.state.view };
  }

  emitRuntimeEvent(event, context = {}) {
    this.dispatchEvent(new CustomEvent('bos:runtime-event', {
      detail: { event, context },
      bubbles: true,
      composed: true
    }));
  }

  async fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  renderShell() {
    this.innerHTML = `
      <section class="salon-workspace">
        <header class="salon-header">
          <p class="salon-badge">Salon Manager</p>
          <h2 class="salon-title" data-role="title">Salon Manager</h2>
          <p class="salon-subtle" data-role="subtitle">Operations workspace powered by Business OS.</p>
        </header>
        <div data-role="content" class="salon-content"></div>
      </section>
    `;

    this.$root = this.querySelector('[data-role="content"]');
    this.$title = this.querySelector('[data-role="title"]');
    this.$subtitle = this.querySelector('[data-role="subtitle"]');
    this.updateHeader();
  }

  updateHeader() {
    const copy = viewCopy(this.state.view);
    if (this.$title) this.$title.textContent = copy.title;
    if (this.$subtitle) this.$subtitle.textContent = copy.subtitle;
  }

  showError(error) {
    this.$root.innerHTML = `<div class="salon-empty">${escapeHtml(error.message)}</div>`;
  }

  async loadView() {
    this.state.loading = true;
    this.updateHeader();
    this.$root.innerHTML = '<div class="salon-empty">Loading salon workspace...</div>';

    if (this.state.view === 'dashboard') {
      const data = await this.fetchJson(`/api/modules/salon-module/dashboard?date=${encodeURIComponent(this.state.selectedDate)}`);
      this.state.dashboard = data;
      this.renderDashboard();
      this.emitRuntimeEvent('onLoad', { view: 'dashboard' });
      return;
    }

    if (this.state.view === 'calendar') {
      const data = await this.fetchJson(`/api/modules/salon-module/calendar?month=${encodeURIComponent(this.state.selectedMonth)}&date=${encodeURIComponent(this.state.selectedDate)}`);
      this.state.calendar = data;
      this.renderCalendar();
      this.emitRuntimeEvent('onLoad', { view: 'calendar' });
      return;
    }

    if (this.state.view === 'clients') {
      const query = this.state.clientQuery ? `?q=${encodeURIComponent(this.state.clientQuery)}` : '';
      const data = await this.fetchJson(`/api/modules/salon-module/clients${query}`);
      this.state.clients = data.clients || [];
      this.state.selectedClientId = null;
      this.state.selectedClientProfile = null;
      this.state.isEditingClient = false;
      this.state.clientDraft = null;
      this.renderClients();
      this.emitRuntimeEvent('onLoad', { view: 'clients' });
      return;
    }

    this.$root.innerHTML = `<div class="salon-empty">Unknown salon view '${escapeHtml(this.state.view)}'.</div>`;
  }

  renderMetricCards(metrics = {}) {
    return `
      <section class="salon-metric-grid">
        <article class="salon-card metric-card">
          <p>Today's Appointments</p>
          <strong>${metrics.todayAppointments ?? 0}</strong>
        </article>
        <article class="salon-card metric-card">
          <p>Total Clients</p>
          <strong>${metrics.totalClients ?? 0}</strong>
        </article>
        <article class="salon-card metric-card">
          <p>This Week</p>
          <strong>${metrics.thisWeekAppointments ?? 0}</strong>
        </article>
        <article class="salon-card metric-card">
          <p>Revenue Growth</p>
          <strong>${metrics.revenueGrowthPct >= 0 ? '+' : ''}${metrics.revenueGrowthPct ?? 0}%</strong>
        </article>
      </section>
    `;
  }

  renderDashboard() {
    const data = this.state.dashboard || {};
    const todayRows = (data.todaySchedule || [])
      .map((item) => `
        <li class="salon-list-row">
          <span class="salon-time">${formatTime(item.starts_at || item.start_at)}</span>
          <div>
            <strong>${escapeHtml(item.customer_name || 'Guest')}</strong>
            <p>${escapeHtml(item.appointment || 'Appointment')}</p>
          </div>
          <small>${escapeHtml(item.staff_name || 'Unassigned')} ${item.duration_minutes ? `• ${item.duration_minutes} min` : ''}</small>
        </li>
      `)
      .join('');

    const upcomingRows = (data.upcomingAppointments || [])
      .map((item) => `
        <li class="salon-list-row compact">
          <span class="salon-date">${formatDate(item.starts_at || item.start_at)}</span>
          <div>
            <strong>${escapeHtml(item.customer_name || 'Guest')}</strong>
            <p>${escapeHtml(item.appointment || 'Appointment')}</p>
          </div>
          <small>${escapeHtml(item.status || 'scheduled')}</small>
        </li>
      `)
      .join('');

    const recentClientRows = (data.recentClients || [])
      .map((client) => `
        <li class="salon-client-chip">
          <div>
            <strong>${escapeHtml(client.name || 'Client')}</strong>
            <small>${client.visits || 0} visits</small>
          </div>
          <span>${formatDate(client.lastVisitAt)}</span>
        </li>
      `)
      .join('');

    this.$root.innerHTML = `
      ${this.renderMetricCards(data.metrics || {})}
      <section class="salon-grid-2 salon-dashboard-grid">
        <article class="salon-card">
          <h3>Today's Schedule</h3>
          <p class="salon-subtle">${formatDate(`${data.date}T00:00:00Z`)}</p>
          <ul class="salon-list">${todayRows || '<li class="salon-empty-li">No appointments</li>'}</ul>
        </article>
        <article class="salon-card">
          <h3>Upcoming Appointments</h3>
          <ul class="salon-list">${upcomingRows || '<li class="salon-empty-li">No upcoming appointments</li>'}</ul>
        </article>
        <article class="salon-card salon-wide">
          <h3>Recent Clients</h3>
          <ul class="salon-client-list">${recentClientRows || '<li class="salon-empty-li">No clients yet</li>'}</ul>
        </article>
      </section>
    `;
  }

  renderCalendarGrid() {
    const data = this.state.calendar || { dailyCounts: {} };
    const { first, last } = getMonthBounds(this.state.selectedMonth);
    const startWeekday = first.getUTCDay();
    const daysInMonth = last.getUTCDate();
    const cells = [];

    for (let i = 0; i < startWeekday; i += 1) {
      cells.push('<div class="salon-day muted"></div>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day));
      const key = date.toISOString().slice(0, 10);
      const count = data.dailyCounts?.[key] || 0;
      const active = key === this.state.selectedDate ? 'active' : '';
      cells.push(`
        <button type="button" class="salon-day ${active}" data-date="${key}">
          <span>${day}</span>
          ${count > 0 ? `<small>${count} appt</small>` : ''}
        </button>
      `);
    }

    return cells.join('');
  }

  bindCalendarActions() {
    this.querySelector('[data-action="prev-month"]')?.addEventListener('click', async () => {
      this.state.selectedMonth = shiftMonth(this.state.selectedMonth, -1);
      const firstDay = `${this.state.selectedMonth}-01`;
      this.state.selectedDate = firstDay;
      await this.loadView();
    });

    this.querySelector('[data-action="next-month"]')?.addEventListener('click', async () => {
      this.state.selectedMonth = shiftMonth(this.state.selectedMonth, 1);
      const firstDay = `${this.state.selectedMonth}-01`;
      this.state.selectedDate = firstDay;
      await this.loadView();
    });

    this.querySelectorAll('[data-date]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.state.selectedDate = btn.dataset.date;
        await this.loadView();
      });
    });

    this.querySelector('[data-action="new-appointment"]')?.addEventListener('click', async () => {
      await this.createAppointmentFromPrompt();
    });
  }

  async createAppointmentFromPrompt() {
    const name = window.prompt('Client name for this appointment:');
    if (!name) return;
    const service = window.prompt('Service name:', 'Haircut') || 'Salon Service';
    const time = window.prompt('Start time (HH:MM, 24-hour):', '09:00') || '09:00';
    const [h, m] = time.split(':').map((v) => Number(v));
    const safeHour = Number.isFinite(h) ? h : 9;
    const safeMinute = Number.isFinite(m) ? m : 0;

    const startDate = new Date(`${this.state.selectedDate}T00:00:00`);
    startDate.setHours(safeHour, safeMinute, 0, 0);

    await this.fetchJson('/api/modules/salon-module/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appointment: service,
        start_at: startDate.toISOString(),
        duration_minutes: 60,
        status: 'scheduled',
        notes: `Booked from salon calendar for ${name}`
      })
    });

    this.emitRuntimeEvent('afterSave', {
      view: 'calendar',
      date: this.state.selectedDate
    });

    await this.loadView();
  }

  renderCalendar() {
    const data = this.state.calendar || {};
    const dayRows = (data.daySchedule || [])
      .map((item) => `
        <li class="salon-list-row">
          <span class="salon-time">${formatTime(item.startsAt)}</span>
          <div>
            <strong>${escapeHtml(item.customerName || 'Guest')}</strong>
            <p>${escapeHtml(item.title || 'Appointment')}</p>
          </div>
          <small>${escapeHtml(item.staffName || 'Unassigned')}</small>
        </li>
      `)
      .join('');

    this.$root.innerHTML = `
      <section class="salon-page-header">
        <h3>Calendar</h3>
        <p class="salon-subtle">Manage your appointments and schedule.</p>
      </section>

      <section class="salon-grid-2">
        <article class="salon-card">
          <header class="salon-card-header">
            <h3>${escapeHtml(formatMonthLabel(this.state.selectedMonth))}</h3>
            <div class="salon-inline-actions">
              <button type="button" data-action="prev-month">←</button>
              <button type="button" data-action="next-month">→</button>
            </div>
          </header>
          <div class="salon-weekdays">
            <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
          </div>
          <div class="salon-calendar-grid">${this.renderCalendarGrid()}</div>
        </article>

        <article class="salon-card">
          <header class="salon-card-header">
            <h3>${escapeHtml(formatDate(`${this.state.selectedDate}T00:00:00Z`))}</h3>
            <button type="button" data-action="new-appointment">New Appointment</button>
          </header>
          <ul class="salon-list">${dayRows || '<li class="salon-empty-li">No appointments for this day.</li>'}</ul>
        </article>
      </section>
    `;

    this.bindCalendarActions();
  }

  bindClientActions() {
    this.querySelector('[data-action="search-clients"]')?.addEventListener('click', async () => {
      const q = this.querySelector('[data-role="client-query"]')?.value || '';
      this.state.clientQuery = q;
      await this.loadView();
    });

    this.querySelector('[data-role="client-query"]')?.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const q = this.querySelector('[data-role="client-query"]')?.value || '';
      this.state.clientQuery = q;
      await this.loadView();
    });

    this.querySelector('[data-action="add-client"]')?.addEventListener('click', async () => {
      const firstName = window.prompt('Client first name:');
      if (!firstName) return;
      const lastName = window.prompt('Client last name:') || '';
      const phone = window.prompt('Phone (optional):') || '';
      const email = window.prompt('Email (optional):') || '';

      await this.fetchJson('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: `${firstName} ${lastName}`.trim(),
          first_name: firstName,
          last_name: lastName,
          phone: phone || null,
          email: email || null,
          status: 'active'
        })
      });

      this.emitRuntimeEvent('afterSave', {
        view: 'clients'
      });

      await this.loadView();
    });

    this.querySelectorAll('[data-client-id]').forEach((el) => {
      el.addEventListener('click', async () => {
        const clientId = el.getAttribute('data-client-id');
        if (!clientId) return;
        await this.openClientProfile(clientId);
      });
    });

    this.querySelector('[data-action="client-view-card"]')?.addEventListener('click', () => {
      this.state.clientView = 'card';
      this.renderClients();
    });

    this.querySelector('[data-action="client-view-table"]')?.addEventListener('click', () => {
      this.state.clientView = 'table';
      this.renderClients();
    });
  }

  bindClientProfileActions() {
    this.querySelector('[data-action="back-to-clients"]')?.addEventListener('click', () => {
      this.state.selectedClientId = null;
      this.state.selectedClientProfile = null;
      this.state.isEditingClient = false;
      this.state.clientDraft = null;
      this.renderClients();
    });

    this.querySelector('[data-action="edit-client"]')?.addEventListener('click', () => {
      const client = this.state.selectedClientProfile?.client;
      if (!client) return;
      this.state.isEditingClient = true;
      this.state.clientDraft = {
        first_name: client.first_name || '',
        last_name: client.last_name || '',
        email: client.email || '',
        phone: client.phone || '',
        cell: client.cell || '',
        status: client.status || 'active',
        sms: Boolean(client.sms),
        notes: client.notes || ''
      };
      this.renderClients();
      this.bindClientProfileActions();
    });

    this.querySelector('[data-action="cancel-client-edit"]')?.addEventListener('click', () => {
      this.state.isEditingClient = false;
      this.state.clientDraft = null;
      this.renderClients();
      this.bindClientProfileActions();
    });

    this.querySelector('[data-action="save-client"]')?.addEventListener('click', async () => {
      await this.saveClientProfile();
    });
  }

  async openClientProfile(clientId) {
    this.state.selectedClientId = clientId;
    this.$root.innerHTML = '<div class="salon-empty">Loading client profile...</div>';
    const data = await this.fetchJson(`/api/modules/salon-module/clients/${encodeURIComponent(clientId)}`);
    this.state.selectedClientProfile = data;
    this.state.isEditingClient = false;
    this.state.clientDraft = null;
    this.renderClients();
    this.emitRuntimeEvent('onView', {
      view: 'clients',
      clientId: data?.client?.id || clientId,
      publicId: data?.client?.public_id || null
    });
  }

  async saveClientProfile() {
    const client = this.state.selectedClientProfile?.client;
    if (!client) return;
    const form = this.querySelector('[data-role="client-edit-form"]');
    if (!form) return;
    const values = Object.fromEntries(new FormData(form).entries());

    const payload = {
      customer: `${String(values.first_name || '').trim()} ${String(values.last_name || '').trim()}`.trim() || null,
      first_name: String(values.first_name || '').trim() || null,
      last_name: String(values.last_name || '').trim() || null,
      email: String(values.email || '').trim() || null,
      phone: String(values.phone || '').trim() || null,
      cell: String(values.cell || '').trim() || null,
      status: String(values.status || '').trim() || null,
      sms: values.sms === 'on',
      notes: String(values.notes || '').trim() || null
    };

    await this.fetchJson(`/api/customers/${encodeURIComponent(client.public_id || client.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const refreshed = await this.fetchJson(`/api/modules/salon-module/clients/${encodeURIComponent(client.public_id || client.id)}`);
    this.state.selectedClientProfile = refreshed;
    this.state.isEditingClient = false;
    this.state.clientDraft = null;
    this.renderClients();
    this.bindClientProfileActions();
    this.emitRuntimeEvent('afterSave', {
      view: 'clients',
      clientId: refreshed.client?.id || client.id,
      publicId: refreshed.client?.public_id || null
    });
  }

  renderClientProfile() {
    const profile = this.state.selectedClientProfile || {};
    const client = profile.client || {};
    const appointments = profile.appointments || [];
    const draft = this.state.clientDraft || {};

    const history = appointments
      .map((item) => `
        <li class="salon-history-row">
          <div>
            <strong>${escapeHtml(item.appointment || 'Appointment')}</strong>
            <small>${formatDate(item.starts_at)} ${formatTime(item.starts_at)}</small>
          </div>
          <div>
            <small>${escapeHtml(item.staff_name || 'Unassigned')}</small>
            <small>${item.duration_minutes ? `${item.duration_minutes} min` : ''}</small>
          </div>
          <span class="salon-history-status">${escapeHtml(item.status || 'scheduled')}</span>
        </li>
      `)
      .join('');

    const profileMain = this.state.isEditingClient
      ? `
        <form data-role="client-edit-form" class="salon-client-edit-form">
          <label>First Name<input name="first_name" value="${escapeHtml(draft.first_name || '')}" /></label>
          <label>Last Name<input name="last_name" value="${escapeHtml(draft.last_name || '')}" /></label>
          <label>Email<input name="email" value="${escapeHtml(draft.email || '')}" /></label>
          <label>Phone<input name="phone" value="${escapeHtml(draft.phone || '')}" /></label>
          <label>Cell<input name="cell" value="${escapeHtml(draft.cell || '')}" /></label>
          <label>Status<input name="status" value="${escapeHtml(draft.status || '')}" /></label>
          <label class="salon-edit-checkbox"><input type="checkbox" name="sms" ${draft.sms ? 'checked' : ''} /> SMS Opt-in</label>
          <label class="full">Notes<textarea name="notes">${escapeHtml(draft.notes || '')}</textarea></label>
        </form>
      `
      : `
        <div class="salon-profile-main">
          <h4>${escapeHtml(client.name || 'Client')}</h4>
          <p>${escapeHtml(client.public_id || client.id || '')}</p>
          <p>${escapeHtml(client.email || 'No email')} • ${escapeHtml(client.phone || 'No phone')}</p>
          <p>${escapeHtml(client.status || 'active')}</p>
        </div>
      `;

    return `
      <section class="salon-card salon-client-profile">
        <header class="salon-card-header">
          <div class="salon-inline-actions">
            <button type="button" data-action="back-to-clients">← Back</button>
            ${this.state.isEditingClient
    ? '<button type="button" data-action="save-client">Save</button><button type="button" data-action="cancel-client-edit">Cancel</button>'
    : '<button type="button" data-action="edit-client">Edit</button>'}
          </div>
          <h3>Client Profile</h3>
        </header>

        <section class="salon-profile-hero">
          <div class="salon-profile-photo-wrap">
            <img class="salon-profile-photo" src="${escapeHtml(avatarUrlFor(client))}" alt="${escapeHtml(client.name || 'Client')}" />
            <span class="salon-client-initials">${escapeHtml(initialsFor(client.name))}</span>
          </div>
          ${profileMain}
        </section>

        <section class="salon-profile-stats">
          <article><span>Visits</span><strong>${client.visits || 0}</strong></article>
          <article><span>Completed</span><strong>${client.completedVisits || 0}</strong></article>
          <article><span>Scheduled</span><strong>${client.scheduledVisits || 0}</strong></article>
          <article><span>Upcoming</span><strong>${client.upcomingVisits || 0}</strong></article>
          <article><span>Last Visit</span><strong>${client.lastVisitDate || 'none'}</strong></article>
        </section>

        <section class="salon-profile-notes">
          <h4>Notes</h4>
          <p>${escapeHtml(client.notes || 'No notes on file')}</p>
        </section>

        <section class="salon-profile-history">
          <h4>Appointment History</h4>
          <ul class="salon-history-list">${history || '<li class="salon-empty-li">No appointments yet.</li>'}</ul>
        </section>
      </section>
    `;
  }

  renderClientCards() {
    const cards = this.state.clients
      .map((client) => `
        <li>
          <button type="button" class="salon-client-open salon-client-card" data-client-id="${escapeHtml(client.id)}">
          <div class="salon-client-photo-wrap">
            <img class="salon-client-photo" src="${escapeHtml(avatarUrlFor(client))}" alt="${escapeHtml(client.name || 'Client')}" loading="lazy" />
            <span class="salon-client-initials">${escapeHtml(initialsFor(client.name))}</span>
          </div>
          <div class="salon-client-card-body">
            <strong>${escapeHtml(client.name || 'Client')}</strong>
            <small>${escapeHtml(client.public_id || client.id || '')}</small>
            <p>${escapeHtml(client.email || 'No email')}</p>
            <p>${escapeHtml(client.phone || 'No phone')}</p>
            <div class="salon-client-meta">
              <small>${client.visits || 0} visits</small>
              <small>Last visit: ${client.lastVisitDate || 'none'}</small>
            </div>
          </div>
          </button>
        </li>
      `)
      .join('');

    return `<ul class="salon-client-cards">${cards || '<li class="salon-empty-li">No clients found.</li>'}</ul>`;
  }

  renderClientTable() {
    const rows = this.state.clients
      .map((client) => `
        <li>
          <button type="button" class="salon-client-open salon-client-row" data-client-id="${escapeHtml(client.id)}">
          <div>
            <strong>${escapeHtml(client.name || 'Client')}</strong>
            <small>${escapeHtml(client.public_id || client.id || '')}</small>
          </div>
          <div>
            <small>${escapeHtml(client.email || 'No email')}</small>
            <small>${escapeHtml(client.phone || 'No phone')}</small>
          </div>
          <div>
            <small>${client.visits || 0} visits</small>
            <small>Last visit: ${client.lastVisitDate || 'none'}</small>
          </div>
          </button>
        </li>
      `)
      .join('');

    return `<ul class="salon-client-table">${rows || '<li class="salon-empty-li">No clients found.</li>'}</ul>`;
  }

  renderClients() {
    if (this.state.selectedClientProfile) {
      this.$root.innerHTML = this.renderClientProfile();
      this.bindClientProfileActions();
      return;
    }

    const cardActive = this.state.clientView === 'card' ? 'active' : '';
    const tableActive = this.state.clientView === 'table' ? 'active' : '';

    this.$root.innerHTML = `
      <section class="salon-page-header">
        <h3>Clients</h3>
        <p class="salon-subtle">Manage your client database.</p>
      </section>

      <section class="salon-card">
        <header class="salon-card-header">
          <h3>Client Directory</h3>
          <button type="button" data-action="add-client">Add Client</button>
        </header>

        <div class="salon-inline-actions full-width salon-client-toolbar">
          <input type="search" data-role="client-query" value="${escapeHtml(this.state.clientQuery)}" placeholder="Search clients" />
          <button type="button" data-action="search-clients">Search</button>
          <div class="salon-view-toggle" role="group" aria-label="Client view mode">
            <button type="button" data-action="client-view-card" class="${cardActive}">Card</button>
            <button type="button" data-action="client-view-table" class="${tableActive}">Table</button>
          </div>
        </div>

        ${this.state.clientView === 'card' ? this.renderClientCards() : this.renderClientTable()}
      </section>
    `;

    this.bindClientActions();
  }
}

customElements.define('bos-salon-workspace', BosSalonWorkspace);
