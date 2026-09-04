const runId = decodeURIComponent(location.pathname.match(/^\/execution-review\/([^/]+)/)?.[1] || '');
const params = new URLSearchParams(location.search);
const workspaceRoot = params.get('workspaceRoot') || '';
const token = params.get('token') || '';
const status = document.querySelector('#status');
const tasks = document.querySelector('#tasks');
const selectedByTask = new Map();

function endpoint(suffix) {
  return `/api/executions/${encodeURIComponent(runId)}${suffix}`;
}

function requestOptions(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  };
}

function setStatus(message) { status.textContent = message; }

function candidateList(run) {
  if (Array.isArray(run.candidates)) return run.candidates;
  if (Array.isArray(run.tasks)) return run.tasks.flatMap((task) => task.candidates.map((candidate) => ({ ...candidate, taskId: candidate.taskId || task.id })));
  return [];
}

function normalizedPoint(image, event) {
  const box = image.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
}

async function sendInput(candidateId, input) {
  const response = await fetch(endpoint(`/candidates/${encodeURIComponent(candidateId)}/input`), requestOptions('POST', { workspaceRoot, ...input }));
  if (!response.ok) throw new Error(`Input rejected (${response.status})`);
}

function buttonName(button) { return button === 1 ? 'middle' : button === 2 ? 'right' : 'left'; }

function wireInput(image, candidateId) {
  image.addEventListener('pointermove', (event) => { void sendInput(candidateId, { type: 'pointerMove', ...normalizedPoint(image, event) }).catch(reportError); });
  image.addEventListener('pointerdown', (event) => {
    image.focus();
    image.setPointerCapture(event.pointerId);
    void sendInput(candidateId, { type: 'pointerDown', button: buttonName(event.button), ...normalizedPoint(image, event) }).catch(reportError);
  });
  image.addEventListener('pointerup', (event) => {
    void sendInput(candidateId, { type: 'pointerUp', button: buttonName(event.button), ...normalizedPoint(image, event) }).catch(reportError);
  });
  image.addEventListener('wheel', (event) => {
    event.preventDefault();
    void sendInput(candidateId, { type: 'wheel', ...normalizedPoint(image, event), deltaX: event.deltaX, deltaY: event.deltaY }).catch(reportError);
  }, { passive: false });
  image.addEventListener('keydown', (event) => {
    const printable = event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
    const input = printable
      ? { type: 'insertText', text: event.key }
      : { type: 'keyDown', key: event.key, code: event.code, modifiers: modifiers(event) };
    void sendInput(candidateId, input).catch(reportError);
  });
  image.addEventListener('keyup', (event) => {
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) return;
    void sendInput(candidateId, { type: 'keyUp', key: event.key, code: event.code, modifiers: modifiers(event) }).catch(reportError);
  });
  image.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      event.preventDefault();
      void sendInput(candidateId, { type: 'insertText', text }).catch(reportError);
    }
  });
  image.addEventListener('dragstart', (event) => event.preventDefault());
}

function modifiers(event) {
  return [['altKey', 'Alt'], ['ctrlKey', 'Control'], ['metaKey', 'Meta'], ['shiftKey', 'Shift']].filter(([property]) => event[property]).map(([, name]) => name);
}

function reportError(error) { setStatus(error instanceof Error ? error.message : 'Request failed'); }

function openStream(candidate, image) {
  const url = candidate.url || candidate.targetUrl;
  if (typeof url !== 'string') { setStatus(`Candidate ${candidate.id} has no preview URL.`); return; }
  const query = new URLSearchParams({ workspaceRoot });
  if (token) query.set('token', token);
  const source = new EventSource(`${endpoint(`/candidates/${encodeURIComponent(candidate.id)}/events`)}?${query}`);
  source.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data);
      if (frame.candidateId === candidate.id && frame.mimeType === 'image/jpeg' && typeof frame.data === 'string') {
        image.src = `data:image/jpeg;base64,${frame.data}`;
      }
    } catch { /* Ignore malformed stream events; the next frame can recover. */ }
  };
  source.onerror = () => setStatus(`Candidate ${candidate.id} stream disconnected.`);
}

function selectCandidate(taskId, candidateId) {
  selectedByTask.set(taskId, candidateId);
  document.querySelectorAll(`[data-task-id="${CSS.escape(taskId)}"] .candidate`).forEach((card) => {
    card.classList.toggle('selected', card.dataset.candidateId === candidateId);
  });
}

function render(run) {
  const grouped = new Map();
  for (const candidate of candidateList(run)) {
    const taskId = String(candidate.taskId || run.taskId || 'default');
    const entries = grouped.get(taskId) || [];
    entries.push(candidate);
    grouped.set(taskId, entries);
  }
  tasks.replaceChildren();
  for (const [taskId, candidates] of grouped) {
    const section = document.createElement('section'); section.className = 'task'; section.dataset.taskId = taskId;
    const heading = document.createElement('h2'); heading.textContent = `Task ${taskId}`;
    const grid = document.createElement('div'); grid.className = 'candidate-grid';
    for (const candidate of candidates) {
      const card = document.createElement('article'); card.className = 'candidate'; card.dataset.candidateId = String(candidate.id);
      const header = document.createElement('header'); const label = document.createElement('span'); label.textContent = candidate.name || candidate.id;
      const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Choose'; choose.setAttribute('aria-label', `Choose ${candidate.name || candidate.id} for task ${taskId}`);
      choose.addEventListener('click', () => selectCandidate(taskId, String(candidate.id)));
      const image = document.createElement('img'); image.alt = `Live preview for ${candidate.name || candidate.id}`; image.tabIndex = 0;
      header.append(label, choose); card.append(header, image); grid.append(card);
      wireInput(image, String(candidate.id)); openStream(candidate, image);
      if (candidate.selected) {
        selectedByTask.set(taskId, String(candidate.id));
        card.classList.add('selected');
      }
    }
    section.append(heading, grid); tasks.append(section);
  }
  setStatus('Choose one candidate for each task, then save the selections.');
}

document.querySelector('#apply-selection').addEventListener('click', async () => {
  try {
    for (const [taskId, candidateId] of selectedByTask) {
      const response = await fetch(endpoint('/select'), requestOptions('POST', { workspaceRoot, taskId, candidateId }));
      if (!response.ok) throw new Error(`Selection failed (${response.status})`);
    }
    setStatus('Candidate selections saved. The agent can now open the integrated preview.');
  } catch (error) { reportError(error); }
});

if (!runId || !workspaceRoot) setStatus('Missing run ID or workspace root.');
else fetch(`${endpoint('')}?${new URLSearchParams({ workspaceRoot })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async (response) => {
  if (!response.ok) throw new Error(`Could not load execution (${response.status})`);
  const result = await response.json();
  render(result.run);
}).catch(reportError);
