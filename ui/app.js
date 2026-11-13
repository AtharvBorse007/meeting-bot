/* Lecture Recorder dashboard. Plain JavaScript, no build step: the server sends this file as it is. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const dialog = document.getElementById('dialog');
  const $ = (selector, root = document) => root.querySelector(selector);

  const state = {
    user: null,
    subjects: [],            // subjects this user may record for
    info: { active: 0, capacity: 0, youtubeConnected: false },
    lectures: new Map(),     // id -> lecture
    hasMore: false,
    filters: { subjectId: '', instructorId: '' },
    openLogs: new Set(),     // live cards whose activity log is expanded
    logs: new Map(),         // id -> log entries (for expanded cards)
    view: 'record',
    admin: { users: [], subjects: [], system: null },
    events: null,
  };
  const PAGE = 30;
  const isAdmin = () => state.user && state.user.role === 'admin';

  // ---------------------------------------------------------------- helpers

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return `${h ? `${h}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const duration = (ms) => {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  };
  const size = (bytes) => {
    if (bytes == null) return '–';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
    return `${bytes.toFixed(bytes >= 100 ? 0 : 1)} ${units[i]}`;
  };
  const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const hhmmss = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
  const isFinal = (status) => status === 'saved' || status === 'failed' || status === 'cancelled';
  const lectureName = (l) => `${l.subjectName}${l.topic ? ` · ${l.topic}` : ''}`;

  let toastTimer;
  const toast = (message) => {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
  };

  async function api(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const json = await response.json().catch(() => ({}));
    if (response.status === 401 && state.user && !path.startsWith('/api/auth/login')) {
      signedOut();
      throw new Error('Your session has ended. Please sign in again.');
    }
    if (!response.ok || json.success === false) throw new Error(json.error || `Request failed (${response.status})`);
    if (json.warning) toast(json.warning);
    return json.data;
  }

  const randomPassword = () => {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  };

  /** Opens the shared dialog with a form; onSubmit gets the form's values and may throw to show an error. */
  function openDialog(title, bodyHtml, { submitLabel = 'Save', onSubmit, onOpen } = {}) {
    dialog.innerHTML = `
      <form class="dlg" method="dialog" autocomplete="off">
        <h3>${esc(title)}</h3>
        ${bodyHtml}
        <div class="error" role="alert"></div>
        <div class="dlg-actions">
          <button class="btn" type="button" data-close>${onSubmit ? 'Cancel' : 'Close'}</button>
          ${onSubmit ? `<button class="btn primary" type="submit">${esc(submitLabel)}</button>` : ''}
        </div>
      </form>`;
    const form = $('form', dialog);
    $('[data-close]', dialog).addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!onSubmit) { dialog.close(); return; }
      const submit = $('[type=submit]', form);
      submit.disabled = true;
      $('.error', form).textContent = '';
      try {
        const values = Object.fromEntries(new FormData(form).entries());
        values.$checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
        const keepOpen = await onSubmit(values, form);
        if (!keepOpen) dialog.close();
      } catch (error) {
        $('.error', form).textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
    if (dialog.open) dialog.close();
    dialog.showModal();
    if (onOpen) onOpen(form);
  }
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  // ------------------------------------------------------------ sign-in

  function renderLogin(message) {
    app.innerHTML = `
      <form class="auth" id="login">
        <div class="brand"><i></i> Lecture Recorder</div>
        <h1>Sign in</h1>
        <p>Use the account your admin gave you.</p>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" role="alert">${esc(message || '')}</div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>`;
    $('#login').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('button', form);
      button.disabled = true;
      try {
        const data = await api('POST', '/api/auth/login', { email: form.email.value, password: form.password.value });
        state.user = data.user;
        await start();
      } catch (error) {
        $('.error', form).textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function renderNewPassword() {
    app.innerHTML = `
      <form class="auth" id="newpass">
        <div class="brand"><i></i> Lecture Recorder</div>
        <h1>Choose your password</h1>
        <p>Hello ${esc(state.user.name)}. The password you signed in with was temporary. Pick your own (at least 8 characters).</p>
        <label class="field"><span>Temporary password</span><input class="input" name="current" type="password" autocomplete="current-password" required autofocus></label>
        <label class="field"><span>New password</span><input class="input" name="next" type="password" autocomplete="new-password" minlength="8" required></label>
        <div class="error" role="alert"></div>
        <button class="btn primary" type="submit">Save and continue</button>
      </form>`;
    $('#newpass').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const data = await api('POST', '/api/auth/password', { currentPassword: form.current.value, newPassword: form.next.value });
        state.user = data.user;
        await start();
      } catch (error) {
        $('.error', form).textContent = error.message;
      }
    });
  }

  function signedOut(message) {
    if (state.events) state.events.close();
    state.events = null;
    state.user = null;
    state.lectures.clear();
    if (dialog.open) dialog.close();
    renderLogin(message);
  }

  // ------------------------------------------------------------ shell

  const VIEWS = [['record', 'Lectures'], ['instructors', 'Instructors'], ['subjects', 'Subjects'], ['settings', 'Settings']];

  function renderShell() {
    const tabs = isAdmin()
      ? `<nav>${VIEWS.map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? 'on' : ''}">${label}</button>`).join('')}</nav>`
      : '';
    app.innerHTML = `
      <header>
        <div class="brand"><i></i> Lecture Recorder</div>
        ${tabs}
        <div class="who">
          <span id="live" class="live">Connecting…</span>
          <span>${esc(state.user.name)}</span>
          <button class="btn small ghost" id="changePassword">Password</button>
          <button class="btn small ghost" id="signOut">Sign out</button>
        </div>
      </header>
      <main id="view"></main>`;
    app.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    $('#signOut').addEventListener('click', async () => {
      await api('POST', '/api/auth/logout').catch(() => {});
      signedOut();
    });
    $('#changePassword').addEventListener('click', changePasswordDialog);
    setLive(state.events && state.events.readyState === 1);
  }

  function setLive(on) {
    const el = $('#live');
    if (!el) return;
    el.textContent = on ? 'Live' : 'Reconnecting…';
    el.className = `live ${on ? 'on' : 'off'}`;
  }

  function changePasswordDialog() {
    openDialog('Change password', `
      <label class="field"><span>Current password</span><input class="input" name="current" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>New password (at least 8 characters)</span><input class="input" name="next" type="password" autocomplete="new-password" minlength="8" required></label>`, {
      submitLabel: 'Change password',
      onSubmit: async (values) => {
        await api('POST', '/api/auth/password', { currentPassword: values.current, newPassword: values.next });
        toast('Password changed.');
      },
    });
  }

  function showView(view) {
    state.view = isAdmin() ? view : 'record';
    history.replaceState(null, '', state.view === 'record' ? location.pathname : `#${state.view}`);
    app.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('on', button.dataset.view === state.view));
    ({ record: renderRecord, instructors: renderInstructors, subjects: renderSubjects, settings: renderSettings })[state.view]();
  }

  // ------------------------------------------------------------ lectures view

  function renderRecord() {
    const view = $('#view');
    const subjects = state.subjects;
    const start = subjects.length
      ? `<form id="startForm" class="panel" autocomplete="off">
           <div class="form-row">
             <label class="field"><span>Subject</span>
               <select class="input" name="subjectId" required>
                 ${subjects.length > 1 ? '<option value="">Choose a subject…</option>' : ''}
                 ${subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
               </select></label>
             <label class="field"><span>Topic (optional)</span><input class="input" name="topic" maxlength="80" placeholder="e.g. Chapter 4 – Kinematics"></label>
           </div>
           <div class="form-row">
             <label class="field"><span>Google Meet link</span><input class="input" name="url" inputmode="url" spellcheck="false" placeholder="https://meet.google.com/abc-defg-hij" required></label>
             <button class="btn primary" type="submit">Join &amp; record</button>
           </div>
           <div class="error" role="alert"></div>
         </form>`
      : `<div class="empty">${isAdmin()
        ? 'Create a subject first (Subjects tab). Each subject gets its own YouTube playlist.'
        : 'No subjects have been assigned to you yet. Ask the admin to assign your subjects.'}</div>`;

    const filters = isAdmin() ? `
      <div class="filters">
        <select class="input" id="filterSubject"><option value="">All subjects</option></select>
        <select class="input" id="filterInstructor"><option value="">All instructors</option></select>
      </div>` : '';

    view.innerHTML = `
      <div class="start">
        <h1>Record a lecture</h1>
        <p>Pick the subject, paste the meeting link, and the recorder joins. Admit it if the meeting asks. The video goes to the subject's YouTube playlist when the lecture ends.</p>
        ${start}
        <div id="notice"></div>
      </div>
      <section>
        <div class="section-head"><h2>In progress</h2><span id="capacity" class="muted small"></span></div>
        <div id="active" class="cards" aria-live="polite"></div>
      </section>
      <section>
        <div class="section-head"><h2>Past lectures</h2>${filters}</div>
        <div id="history"></div>
        <div class="more"><button class="btn small" id="loadMore" hidden>Show older lectures</button></div>
      </section>`;

    const form = $('#startForm');
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = $('button', form);
        $('.error', form).textContent = '';
        button.disabled = true;
        try {
          const lecture = await api('POST', '/api/lectures', { url: form.url.value, subjectId: Number(form.subjectId.value), topic: form.topic.value });
          upsertLecture(lecture);
          form.url.value = '';
          form.topic.value = '';
        } catch (error) {
          $('.error', form).textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    }

    if (isAdmin()) fillFilters();
    $('#loadMore').addEventListener('click', () => loadLectures(true));
    $('#active').addEventListener('click', onLectureAction);
    $('#history').addEventListener('click', onLectureAction);
    $('#active').addEventListener('toggle', onLogToggle, true);
    renderLectures();
  }

  async function fillFilters() {
    try {
      if (!state.admin.subjects.length) state.admin.subjects = await api('GET', '/api/admin/subjects');
      if (!state.admin.users.length) state.admin.users = await api('GET', '/api/admin/users');
    } catch { return; }
    const subject = $('#filterSubject');
    const instructor = $('#filterInstructor');
    if (!subject || !instructor) return;
    subject.innerHTML = '<option value="">All subjects</option>' + state.admin.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    instructor.innerHTML = '<option value="">All instructors</option>' + state.admin.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    subject.value = state.filters.subjectId;
    instructor.value = state.filters.instructorId;
    const changed = () => {
      state.filters = { subjectId: subject.value, instructorId: instructor.value };
      loadLectures();
    };
    subject.addEventListener('change', changed);
    instructor.addEventListener('change', changed);
  }

  async function loadLectures(older = false) {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (state.filters.subjectId) params.set('subjectId', state.filters.subjectId);
    if (state.filters.instructorId) params.set('instructorId', state.filters.instructorId);
    if (older) {
      const oldest = Math.min(...[...state.lectures.values()].map((l) => l.createdAt));
      if (Number.isFinite(oldest)) params.set('before', String(oldest));
    }
    const list = await api('GET', `/api/lectures?${params}`);
    if (!older) state.lectures.clear();
    list.forEach((lecture) => state.lectures.set(lecture.id, lecture));
    state.hasMore = list.length === PAGE;
    renderLectures();
  }

  const matchesFilters = (l) =>
    (!state.filters.subjectId || String(l.subjectId) === state.filters.subjectId) &&
    (!state.filters.instructorId || String(l.instructorId) === state.filters.instructorId);

  function upsertLecture(lecture) {
    const previous = state.lectures.get(lecture.id);
    state.lectures.set(lecture.id, lecture);
    if (state.view !== 'record') return;
    // A lecture moving between "in progress" and "past" needs both lists redrawn; otherwise just its own element
    if (!previous || isFinal(previous.status) !== isFinal(lecture.status)) {
      renderLectures();
      return;
    }
    const el = document.querySelector(`[data-id="${lecture.id}"]`);
    if (!el) { renderLectures(); return; }
    if (isFinal(lecture.status)) el.outerHTML = rowHtml(lecture);
    else updateCard(el, lecture);
    renderCapacity();
  }

  function renderLectures() {
    const active = $('#active');
    const historyEl = $('#history');
    if (!active || !historyEl) return;
    const all = [...state.lectures.values()].sort((a, b) => b.createdAt - a.createdAt);
    const live = all.filter((l) => !isFinal(l.status));
    const past = all.filter((l) => isFinal(l.status) && matchesFilters(l));

    active.innerHTML = live.length
      ? live.map((l) => `<article class="card${l.status === 'recording' ? ' rec' : ''}" data-id="${l.id}">${cardHtml(l)}</article>`).join('')
      : '<div class="empty">Nothing is being recorded right now.</div>';
    active.querySelectorAll('ol.lines').forEach((ol) => { ol.scrollTop = ol.scrollHeight; });

    historyEl.innerHTML = past.length
      ? `<div class="list">${past.map(rowHtml).join('')}</div>`
      : '<div class="empty">Finished lectures show up here with their YouTube links.</div>';
    $('#loadMore').hidden = !state.hasMore;
    renderCapacity();
  }

  function renderCapacity() {
    const el = $('#capacity');
    if (el && state.info.capacity) el.textContent = `${state.info.active} of ${state.info.capacity} recorders in use`;
    const notice = $('#notice');
    if (notice) {
      notice.innerHTML = state.info.youtubeConnected ? '' : `<div class="banner">YouTube is not connected yet, so recordings are kept on the server and uploaded once it is. ${isAdmin() ? 'Connect it under Settings.' : 'Ask the admin to connect it.'}</div>`;
    }
  }

  // --- live card

  const STEP = { launching: 0, joining: 1, lobby: 2, recording: 3, leaving: 4, saving: 4 };
  const LIVE_LABEL = { launching: 'Starting', joining: 'Joining', lobby: 'Waiting to be admitted', recording: 'Recording', leaving: 'Leaving', saving: 'Saving' };

  const elapsedFor = (l) => Date.now() - (l.status === 'recording' && l.recordingStartedAt ? l.recordingStartedAt : l.createdAt);

  function cardHtml(l) {
    const step = STEP[l.status] ?? 0;
    const segments = [0, 1, 2, 3, 4].map((i) => `<span class="${i < step ? 'done' : i === step ? (l.status === 'recording' ? 'now' : 'done') : ''}"></span>`).join('');
    const recording = l.status === 'recording';
    const detail = l.stopping
      ? (recording ? 'Stopping and saving the recording…' : 'Stopping…')
      : l.status === 'lobby' ? 'Waiting to be let in. If the meeting asks, admit the recorder.' : (l.detail || '');
    const logs = (state.logs.get(l.id) || []).map(logLine).join('');
    return `
      <div class="card-top">
        <span class="title">${esc(lectureName(l))}</span>
        <span class="sub mono">${esc(l.meetingCode || '')}</span>
        ${isAdmin() ? `<span class="sub">${esc(l.instructorName)}</span>` : ''}
        <span class="pill ${recording ? 'red' : 'amber'} pulse" data-pill>${l.stopping ? 'Stopping' : LIVE_LABEL[l.status] || l.status}</span>
      </div>
      <p class="detail" data-detail>${esc(detail)}</p>
      <div class="steps" aria-hidden="true" data-steps>${segments}</div>
      <div class="stats" data-stats>${statsHtml(l)}</div>
      <div class="actions">
        <button class="btn small danger" data-act="stop" ${l.stopping ? 'disabled' : ''}>${l.stopping ? 'Stopping…' : recording ? 'End &amp; save' : 'Cancel'}</button>
      </div>
      <details class="log" ${state.openLogs.has(l.id) ? 'open' : ''}><summary>Activity</summary><ol class="lines">${logs}</ol></details>`;
  }

  function statsHtml(l) {
    const recording = l.status === 'recording';
    return `
      <div class="stat"><small>${recording ? 'Recording' : 'Elapsed'}</small><b data-elapsed>${clock(elapsedFor(l))}</b></div>
      ${recording || l.bytesRecorded ? `<div class="stat"><small>Size</small><b>${size(l.bytesRecorded)}</b></div>` : ''}
      ${l.participants != null ? `<div class="stat"><small>In call</small><b>${l.participants}</b></div>` : ''}`;
  }

  /** Updates a live card in place, so an open activity log and its scroll position survive. */
  function updateCard(el, l) {
    const fresh = document.createElement('div');
    fresh.innerHTML = cardHtml(l);
    el.className = `card${l.status === 'recording' ? ' rec' : ''}`;
    for (const key of ['.card-top', '[data-detail]', '[data-steps]', '[data-stats]', '.actions']) {
      $(key, el).replaceWith($(key, fresh));
    }
  }

  const logLine = (entry) => `<li class="${entry.level}"><time>${hhmmss(entry.t)}</time><span>${esc(entry.message)}</span></li>`;

  async function onLogToggle(event) {
    const details = event.target;
    const card = details.closest && details.closest('[data-id]');
    if (!card || !details.classList.contains('log')) return;
    const id = card.dataset.id;
    if (!details.open) { state.openLogs.delete(id); return; }
    state.openLogs.add(id);
    try {
      state.logs.set(id, await api('GET', `/api/lectures/${id}/logs`));
      const ol = $('ol.lines', card);
      ol.innerHTML = state.logs.get(id).map(logLine).join('');
      ol.scrollTop = ol.scrollHeight;
    } catch { /* the log is optional */ }
  }

  function appendLog(id, entry) {
    if (!state.openLogs.has(id)) return;
    const entries = state.logs.get(id) || [];
    entries.push(entry);
    state.logs.set(id, entries.slice(-200));
    const ol = document.querySelector(`[data-id="${id}"] ol.lines`);
    if (!ol) return;
    const stick = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 8;
    ol.insertAdjacentHTML('beforeend', logLine(entry));
    if (stick) ol.scrollTop = ol.scrollHeight;
  }

  // --- past lecture row

  function outcome(l) {
    if (l.status === 'failed') return { cls: 'red', label: 'Failed' };
    if (l.status === 'cancelled') return { cls: '', label: 'Cancelled' };
    switch (l.uploadStatus) {
      case 'done': return { cls: 'green', label: 'On YouTube' };
      case 'uploading': return { cls: 'amber pulse', label: `Uploading ${Math.round((l.uploadProgress || 0) * 100)}%` };
      case 'pending': return { cls: 'amber', label: state.info.youtubeConnected ? 'Waiting to upload' : 'Waiting for YouTube' };
      case 'retry': return { cls: 'amber', label: 'Upload will retry' };
      case 'failed': return { cls: 'red', label: 'Upload failed' };
      default: return { cls: '', label: 'Saved on server' };
    }
  }

  function rowHtml(l) {
    const result = outcome(l);
    const length = l.recordingStartedAt && l.endedAt ? duration(l.endedAt - l.recordingStartedAt) : null;
    const backup = l.backupInDeepArchive ? 'backup in S3 Deep Archive' : { done: 'backed up in S3', pending: 'backup pending', uploading: 'backing up…', retry: 'backup will retry', failed: 'backup failed' }[l.archiveStatus];
    const meta = [when(l.createdAt), length, l.fileSize ? size(l.fileSize) : null, isAdmin() ? l.instructorName : null, backup].filter(Boolean).join(' · ');
    const notes = [];
    if (l.error) notes.push(`<small class="${l.status === 'failed' ? 'detail err' : 'detail warn'}">${esc(l.error)}</small>`);
    // e.g. 'Recorded by 2 recorders (a recorder was replaced); about 1 min missing'
    if (l.detail) notes.push(`<small>${esc(l.detail)}</small>`);
    if ((l.uploadStatus === 'retry' || l.uploadStatus === 'failed' || l.uploadStatus === 'pending') && l.uploadError) {
      notes.push(`<small class="detail warn">${esc(l.uploadError)}</small>`);
    }
    if (l.backupInDeepArchive && !l.localFileAvailable && isAdmin()) {
      notes.push('<small>The S3 copy is in Glacier Deep Archive: restore it in the S3 console (takes up to 12 hours) to download it. The video stays on YouTube.</small>');
    }
    if ((l.archiveStatus === 'retry' || l.archiveStatus === 'failed') && l.archiveError) {
      notes.push(`<small class="detail warn">Backup: ${esc(l.archiveError)}</small>`);
    }
    const progress = l.uploadStatus === 'uploading'
      ? `<div class="bar"><i style="width:${Math.round((l.uploadProgress || 0) * 100)}%"></i></div>` : '';

    const actions = [];
    if (l.youtubeUrl) actions.push(`<a class="btn small" href="${esc(l.youtubeUrl)}" target="_blank" rel="noopener">Watch</a>`);
    if (l.youtubeUrl) actions.push(`<button class="btn small ghost" data-act="copy" data-link="${esc(l.youtubeUrl)}">Copy link</button>`);
    if (l.inPlaylist && l.playlistUrl) actions.push(`<a class="btn small ghost" href="${esc(l.playlistUrl)}" target="_blank" rel="noopener">Playlist</a>`);
    if (l.fileName && (l.uploadStatus === 'failed' || l.uploadStatus === 'retry')) actions.push('<button class="btn small" data-act="retry">Retry upload</button>');
    if (l.archiveStatus === 'failed' && l.localFileAvailable) actions.push('<button class="btn small" data-act="retry-backup">Retry backup</button>');
    if ((l.localFileAvailable && l.uploadStatus !== 'done') || l.backupAvailable) {
      actions.push(`<a class="btn small ghost" href="/api/lectures/${l.id}/file?download=1">Download</a>`);
    }
    actions.push('<button class="btn small ghost" data-act="activity">Activity</button>');

    return `
      <div class="row" data-id="${l.id}">
        <div class="main">
          <div title="${esc(lectureName(l))}">${esc(lectureName(l))}</div>
          <small>${esc(meta)}</small>
          ${notes.join('')}${progress}
        </div>
        <span class="pill ${result.cls}">${result.label}</span>
        <div class="row-actions">${actions.join('')}</div>
      </div>`;
  }

  async function onLectureAction(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const id = button.closest('[data-id]').dataset.id;
    try {
      if (button.dataset.act === 'stop') {
        button.disabled = true;
        upsertLecture(await api('POST', `/api/lectures/${id}/stop`));
      } else if (button.dataset.act === 'retry') {
        button.disabled = true;
        upsertLecture(await api('POST', `/api/lectures/${id}/retry-upload`));
      } else if (button.dataset.act === 'retry-backup') {
        button.disabled = true;
        upsertLecture(await api('POST', `/api/lectures/${id}/retry-backup`));
      } else if (button.dataset.act === 'copy') {
        await navigator.clipboard.writeText(button.dataset.link);
        toast('Link copied.');
      } else if (button.dataset.act === 'activity') {
        const lecture = state.lectures.get(id);
        const logs = await api('GET', `/api/lectures/${id}/logs`);
        openDialog(lecture ? lectureName(lecture) : 'Activity',
          `<ol class="lines">${logs.map(logLine).join('') || '<li>No activity was recorded.</li>'}</ol>`);
      }
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  }

  // Tick the elapsed timers once a second without redrawing cards
  setInterval(() => {
    for (const lecture of state.lectures.values()) {
      if (isFinal(lecture.status)) continue;
      const el = document.querySelector(`[data-id="${lecture.id}"] [data-elapsed]`);
      if (el) el.textContent = clock(elapsedFor(lecture));
    }
  }, 1000);

  // ------------------------------------------------------------ admin: instructors

  const subjectChecks = (selected) => {
    const subjects = state.admin.subjects.filter((s) => !s.archived);
    if (!subjects.length) return '<p class="muted small">No subjects yet. Create them in the Subjects tab, then assign them here.</p>';
    return `<div class="checks">${subjects.map((s) =>
      `<label><input type="checkbox" name="subjects" value="${s.id}" ${selected.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>`;
  };

  async function renderInstructors() {
    const view = $('#view');
    view.innerHTML = '<div class="start"><h1>Instructors</h1><p>Loading…</p></div>';
    try {
      [state.admin.users, state.admin.subjects] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/subjects')]);
    } catch (error) { toast(error.message); return; }
    if (state.view !== 'instructors') return;

    const subjectName = (id) => (state.admin.subjects.find((s) => s.id === id) || {}).name;
    const rows = state.admin.users.map((u) => `
      <div class="row ${u.active ? '' : 'off'}" data-user="${u.id}">
        <div class="main">
          <div>${esc(u.name)}${u.role === 'admin' ? ' <span class="chip">admin</span>' : ''}${u.active ? '' : ' <span class="chip">switched off</span>'}</div>
          <small>${esc(u.email)} · ${u.lectureCount} lecture${u.lectureCount === 1 ? '' : 's'}${u.mustChangePassword ? ' · has not signed in yet' : ''}</small>
          ${u.role === 'instructor' ? `<div class="chips">${u.subjectIds.map((id) => `<span class="chip">${esc(subjectName(id))}</span>`).join('') || '<span class="chip">no subjects assigned</span>'}</div>` : ''}
        </div>
        <div class="row-actions"><button class="btn small" data-edit>Edit</button></div>
      </div>`).join('');

    view.innerHTML = `
      <div class="start">
        <h1>Instructors</h1>
        <p>Each instructor signs in with their own account and can only record for the subjects you assign.</p>
      </div>
      <section>
        <div class="section-head"><h2>Accounts</h2><button class="btn small primary" id="addUser">Add instructor</button></div>
        <div class="list">${rows}</div>
      </section>`;

    $('#addUser').addEventListener('click', addInstructorDialog);
    view.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
      editUserDialog(state.admin.users.find((u) => String(u.id) === button.closest('[data-user]').dataset.user));
    }));
  }

  function addInstructorDialog() {
    openDialog('Add instructor', `
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="80" required></label>
      <label class="field"><span>Email (used to sign in)</span><input class="input" name="email" type="email" required></label>
      <div class="form-row">
        <label class="field"><span>Temporary password</span><input class="input mono" name="password" minlength="8" required></label>
        <button class="btn" type="button" data-generate>Generate</button>
      </div>
      <label class="field"><span>Subjects</span></label>
      ${subjectChecks([])}`, {
      submitLabel: 'Create account',
      onOpen: (form) => {
        form.password.value = randomPassword();
        $('[data-generate]', form).addEventListener('click', () => { form.password.value = randomPassword(); });
      },
      onSubmit: async (values) => {
        state.admin.users = await api('POST', '/api/admin/users', {
          name: values.name, email: values.email, password: values.password, subjectIds: values.$checked('subjects').map(Number),
        });
        shareCredentials(values.name, values.email, values.password);
        renderInstructors();
        return true;
      },
    });
  }

  /** The only moment the temporary password is visible: hand it to the instructor now. */
  function shareCredentials(name, email, password) {
    const details = `Lecture Recorder sign-in\n${location.origin}\nEmail: ${email}\nTemporary password: ${password}\n(You will be asked to choose your own password.)`;
    openDialog(`Account ready for ${name}`, `
      <p class="muted small">Send these sign-in details to the instructor. The password is temporary and is not shown again.</p>
      <dl class="kv">
        <dt>Address</dt><dd>${esc(location.origin)}</dd>
        <dt>Email</dt><dd>${esc(email)}</dd>
        <dt>Temporary password</dt><dd><code>${esc(password)}</code></dd>
      </dl>
      <div class="actions"><button class="btn small" type="button" data-copy>Copy details</button></div>`, {
      onOpen: (form) => $('[data-copy]', form).addEventListener('click', async () => {
        await navigator.clipboard.writeText(details).catch(() => {});
        toast('Sign-in details copied.');
      }),
    });
  }

  function editUserDialog(user) {
    const self = user.id === state.user.id;
    openDialog(`Edit ${user.name}`, `
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="80" value="${esc(user.name)}" required></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${esc(user.email)}" required></label>
      ${user.role === 'instructor' ? `<label class="field"><span>Subjects</span></label>${subjectChecks(user.subjectIds)}` : ''}
      ${self ? '' : `
        <div class="form-row">
          <label class="field"><span>New temporary password (leave empty to keep the current one)</span><input class="input mono" name="password" minlength="8"></label>
          <button class="btn" type="button" data-generate>Generate</button>
        </div>
        <div class="checks" style="margin-top:14px"><label><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> Account is active (untick to block sign-in)</label></div>`}`, {
      onOpen: (form) => {
        const generate = $('[data-generate]', form);
        if (generate) generate.addEventListener('click', () => { form.password.value = randomPassword(); });
      },
      onSubmit: async (values, form) => {
        const body = { name: values.name, email: values.email };
        if (user.role === 'instructor') body.subjectIds = values.$checked('subjects').map(Number);
        if (!self) {
          body.active = form.active.checked;
          if (values.password) body.password = values.password;
        }
        state.admin.users = await api('PATCH', `/api/admin/users/${user.id}`, body);
        if (self) state.user.name = values.name;
        renderInstructors();
        if (body.password) { shareCredentials(values.name, values.email, body.password); return true; }
        toast('Saved.');
        return false;
      },
    });
  }

  // ------------------------------------------------------------ admin: subjects

  async function renderSubjects() {
    const view = $('#view');
    view.innerHTML = '<div class="start"><h1>Subjects</h1><p>Loading…</p></div>';
    try {
      [state.admin.subjects, state.admin.users] = await Promise.all([api('GET', '/api/admin/subjects'), api('GET', '/api/admin/users')]);
    } catch (error) { toast(error.message); return; }
    if (state.view !== 'subjects') return;

    const rows = state.admin.subjects.map((s) => {
      const playlist = s.playlistUrl
        ? `<a href="${esc(s.playlistUrl)}" target="_blank" rel="noopener">YouTube playlist</a>`
        : (state.info.youtubeConnected ? 'Playlist is created with the first upload' : 'Playlist is created once YouTube is connected');
      return `
        <div class="row ${s.archived ? 'off' : ''}" data-subject="${s.id}">
          <div class="main">
            <div>${esc(s.name)}${s.archived ? ' <span class="chip">archived</span>' : ''}</div>
            <small>${s.lectureCount} lecture${s.lectureCount === 1 ? '' : 's'} · ${s.instructorIds.length} instructor${s.instructorIds.length === 1 ? '' : 's'} · ${playlist}</small>
          </div>
          <div class="row-actions">
            <button class="btn small" data-edit>Edit</button>
            <button class="btn small ghost" data-archive>${s.archived ? 'Restore' : 'Archive'}</button>
          </div>
        </div>`;
    }).join('');

    view.innerHTML = `
      <div class="start">
        <h1>Subjects</h1>
        <p>One subject is one YouTube playlist. Every lecture recorded for a subject is added to its playlist.</p>
        <form id="addSubject" class="panel" autocomplete="off">
          <div class="form-row">
            <label class="field"><span>New subject</span><input class="input" name="name" maxlength="100" placeholder="e.g. Physics – Batch A" required></label>
            <button class="btn primary" type="submit">Add subject</button>
          </div>
          <div class="error" role="alert"></div>
        </form>
      </div>
      <section>
        <div class="section-head"><h2>All subjects</h2></div>
        ${rows ? `<div class="list">${rows}</div>` : '<div class="empty">No subjects yet.</div>'}
      </section>`;

    const form = $('#addSubject');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      $('.error', form).textContent = '';
      try {
        state.admin.subjects = await api('POST', '/api/admin/subjects', { name: form.name.value });
        await refreshMe();
        renderSubjects();
      } catch (error) {
        $('.error', form).textContent = error.message;
      }
    });
    view.querySelectorAll('[data-subject]').forEach((row) => {
      const subject = state.admin.subjects.find((s) => String(s.id) === row.dataset.subject);
      $('[data-edit]', row).addEventListener('click', () => editSubjectDialog(subject));
      $('[data-archive]', row).addEventListener('click', async () => {
        try {
          state.admin.subjects = await api('PATCH', `/api/admin/subjects/${subject.id}`, { archived: !subject.archived });
          await refreshMe();
          renderSubjects();
        } catch (error) { toast(error.message); }
      });
    });
  }

  function editSubjectDialog(subject) {
    openDialog(`Edit ${subject.name}`, `
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="100" value="${esc(subject.name)}" required></label>
      <label class="field"><span>YouTube playlist link (leave empty to let the recorder create one)</span>
        <input class="input" name="playlistId" value="${esc(subject.playlistUrl || '')}" placeholder="https://www.youtube.com/playlist?list=…"></label>
      <p class="muted small">Renaming a subject here does not rename a playlist that already exists on YouTube.</p>`, {
      onSubmit: async (values) => {
        state.admin.subjects = await api('PATCH', `/api/admin/subjects/${subject.id}`, { name: values.name, playlistId: values.playlistId.trim() || null });
        await refreshMe();
        renderSubjects();
        toast('Saved.');
      },
    });
  }

  // ------------------------------------------------------------ admin: settings

  async function renderSettings() {
    const view = $('#view');
    view.innerHTML = '<div class="start"><h1>Settings</h1><p>Loading…</p></div>';
    let system;
    try {
      system = await api('GET', '/api/admin/system');
    } catch (error) { toast(error.message); return; }
    if (state.view !== 'settings') return;
    state.admin.system = system;
    const yt = system.youtube;

    let youtube;
    // The Google OAuth client ("YouTube app"): entered here unless it is set on the server
    const credentialsForm = (intro) => `
      <form id="ytCredentials" autocomplete="off">
        <p class="muted small">${intro}</p>
        <p class="small">Redirect address to register on the OAuth client: <code>${esc(yt.redirectUri)}</code></p>
        <label class="field"><span>Client ID</span><input class="input mono" name="clientId" placeholder="123…-abc.apps.googleusercontent.com" value="${esc(yt.credentialsSource === 'dashboard' ? yt.clientId : '')}" required></label>
        <label class="field"><span>Client secret</span><input class="input mono" name="clientSecret" type="password" placeholder="${yt.credentialsSource === 'dashboard' ? 'saved – enter again to change' : 'GOCSPX-…'}" required></label>
        <div class="error" role="alert"></div>
        <div class="actions"><button class="btn ${yt.configured ? '' : 'primary'}" type="submit">Save YouTube app</button></div>
      </form>`;

    if (!yt.configured) {
      youtube = `
        <p class="muted">Not set up yet. Recordings are kept on the server until it is.</p>
        ${credentialsForm('Create an OAuth client for the YouTube Data API in Google Cloud (docs/SETUP.md, step 5) and paste its ID and secret here.')}`;
    } else if (!yt.connected) {
      youtube = `
        <p class="muted">Ready to connect. Sign in with the Google account that owns the channel where lectures should go.</p>
        <div class="actions"><a class="btn primary" href="/api/admin/youtube/connect">Connect YouTube</a></div>
        <p class="muted small">Redirect address registered on the OAuth client must be <code>${esc(yt.redirectUri)}</code></p>
        ${yt.credentialsSource === 'dashboard' ? `<details class="log"><summary>Change the YouTube app</summary>${credentialsForm(`Saved client: ${esc(yt.clientId)}`)}</details>` : ''}`;
    } else {
      youtube = `
        ${yt.error ? `<div class="banner">${esc(yt.error)}</div>` : ''}
        <dl class="kv">
          <dt>Channel</dt><dd>${yt.channelId ? `<a href="https://www.youtube.com/channel/${esc(yt.channelId)}" target="_blank" rel="noopener">${esc(yt.channelTitle || yt.channelId)}</a>` : '–'}</dd>
          <dt>Connected</dt><dd>${yt.connectedAt ? when(yt.connectedAt) : '–'}</dd>
          <dt>New videos are</dt><dd>${esc(yt.privacy)}</dd>
          <dt>Waiting to upload</dt><dd>${system.waitingUploads}</dd>
        </dl>
        <div class="actions">
          <a class="btn small" href="/api/admin/youtube/connect">Reconnect</a>
          <button class="btn small ghost" id="ytDisconnect">Disconnect</button>
        </div>`;
    }

    const disk = system.disk;
    const archive = system.archive;
    const db = archive.dbBackup;
    const backupPanel = archive.enabled
      ? `${archive.problem ? `<div class="banner">${esc(archive.problem)}</div>` : ''}
        <dl class="kv">
          <dt>Bucket</dt><dd><code>s3://${esc(archive.bucket)}${archive.prefix ? `/${esc(archive.prefix)}` : ''}</code> (${esc(archive.region)})</dd>
          <dt>Recordings backed up</dt><dd>${archive.done}${archive.waiting ? ` · ${archive.waiting} waiting` : ''}${archive.failed ? ` · <span class="detail err">${archive.failed} failed</span>` : ''}</dd>
          <dt>Storage class</dt><dd>${esc(archive.storageClass)}</dd>
          <dt>Last database backup</dt><dd>${db.lastSuccessAt ? when(db.lastSuccessAt) : 'not yet'}${db.lastError ? ` · <span class="detail err">last attempt failed: ${esc(db.lastError)}</span>` : ''}</dd>
        </dl>
        <p class="muted small">Server copies are only deleted once a recording is both on YouTube and in this bucket.</p>`
      : '<p class="muted">Off. Set <code>ARCHIVE_S3_BUCKET</code> on the server to keep a permanent copy of every recording (and a daily database backup) in Amazon S3.</p>';
    view.innerHTML = `
      <div class="start"><h1>Settings</h1><p>YouTube connection and the state of the server.</p></div>
      <div class="panel"><h3>YouTube</h3>${youtube}</div>
      <div class="panel"><h3>Backups (Amazon S3)</h3>${backupPanel}</div>
      <div class="panel">
        <h3>Server</h3>
        <dl class="kv">
          <dt>Recorders</dt><dd>${system.active} of ${system.capacity} in use</dd>
          <dt>Recordings on the server</dt><dd>${size(disk.recordingsBytes)}${disk.freeBytes != null ? ` · ${size(disk.freeBytes)} free on the disk` : ''}</dd>
          <dt>Server copies are kept</dt><dd>${system.settings.retentionDays} days after the video is on YouTube${archive.enabled ? ' and in S3' : ''}</dd>
          <dt>Recorder's name in meetings</dt><dd>${esc(system.settings.botName)}</dd>
          <dt>Longest recording</dt><dd>${system.settings.maxHours} hours</dd>
          <dt>Leaves when alone for</dt><dd>${system.settings.aloneExitMinutes} minutes</dd>
          <dt>Not uploaded if shorter than</dt><dd>${system.settings.minUploadSeconds} seconds</dd>
        </dl>
        <p class="muted small">These are set with environment variables on the server (see .env.example).</p>
      </div>`;

    const credentials = $('#ytCredentials');
    if (credentials) credentials.addEventListener('submit', async (event) => {
      event.preventDefault();
      $('.error', credentials).textContent = '';
      try {
        await api('PUT', '/api/admin/youtube/credentials', {
          clientId: credentials.clientId.value, clientSecret: credentials.clientSecret.value,
        });
        toast('YouTube app saved. Now press Connect YouTube.');
        renderSettings();
      } catch (error) {
        $('.error', credentials).textContent = error.message;
      }
    });

    const disconnect = $('#ytDisconnect');
    if (disconnect) disconnect.addEventListener('click', async () => {
      if (!confirm('Disconnect YouTube? Recordings will wait on the server until you connect again.')) return;
      try {
        await api('POST', '/api/admin/youtube/disconnect');
        await refreshMe();
        renderSettings();
      } catch (error) { toast(error.message); }
    });
  }

  // ------------------------------------------------------------ live updates

  function connectEvents() {
    if (state.events) state.events.close();
    const events = new EventSource('/api/events');
    state.events = events;
    events.onopen = () => setLive(true);
    events.onerror = async () => {
      setLive(false);
      // An expired session looks like a failing stream: check once, and go back to sign-in if so
      const response = await fetch('/api/auth/me', { credentials: 'same-origin' }).catch(() => null);
      if (response && response.status === 401 && state.user) signedOut('Your session has ended. Please sign in again.');
    };
    events.addEventListener('hello', async (event) => {
      state.info = JSON.parse(event.data).info;
      await refreshMe().catch(() => {});
      if (state.view === 'record') loadLectures().catch((error) => toast(error.message));
    });
    events.addEventListener('lecture', (event) => {
      const data = JSON.parse(event.data);
      state.info = data.info;
      // With a filter on, changes to lectures outside it are still tracked (they may be in progress)
      upsertLecture(data.lecture);
    });
    events.addEventListener('log', (event) => {
      const { id, entry } = JSON.parse(event.data);
      appendLog(id, entry);
    });
  }

  async function refreshMe() {
    const data = await api('GET', '/api/auth/me');
    const subjectsChanged = JSON.stringify(data.subjects) !== JSON.stringify(state.subjects);
    state.user = data.user;
    state.subjects = data.subjects;
    state.info = data.info;
    if (subjectsChanged && state.view === 'record' && $('#startForm, #view .empty')) renderRecord();
    else renderCapacity();
  }

  // ------------------------------------------------------------ start-up

  async function start() {
    if (state.user.mustChangePassword) { renderNewPassword(); return; }
    const data = await api('GET', '/api/auth/me');
    state.user = data.user;
    state.subjects = data.subjects;
    state.info = data.info;

    const params = new URLSearchParams(location.search);
    const wanted = location.hash.slice(1);
    state.view = isAdmin() && VIEWS.some(([id]) => id === wanted) ? wanted : 'record';
    renderShell();
    showView(state.view);
    if (params.get('youtube') === 'connected') toast('YouTube is connected. Waiting recordings will upload now.');
    if (params.get('youtube_error')) toast(`YouTube was not connected: ${params.get('youtube_error')}`);
    if (params.has('youtube') || params.has('youtube_error')) history.replaceState(null, '', location.pathname + location.hash);
    connectEvents();
  }

  (async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (response.ok) {
        state.user = (await response.json()).data.user;
        await start();
        return;
      }
    } catch { /* fall through to sign-in */ }
    renderLogin();
  })();
})();
