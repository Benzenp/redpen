const runId = decodeURIComponent(location.pathname.match(/^\/execution-preview\/([^/]+)/)?.[1] || '');
const params = new URLSearchParams(location.search);
const workspaceRoot = params.get('workspaceRoot') || '';
const token = params.get('token') || '';
const status = document.querySelector('#status');
const preview = document.querySelector('#preview');
const taskList = document.querySelector('#task-list');
const included = new Set();
let streamId = '';

function endpoint(suffix) { return `/api/executions/${encodeURIComponent(runId)}${suffix}`; }
function headers(json = false) { return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
function setStatus(message) { status.textContent = message; }
function point(event) {
  const box = preview.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
}
async function sendInput(input) {
  const response = await fetch(endpoint(`/candidates/${encodeURIComponent(streamId)}/input`), {
    method: 'POST', headers: headers(true), body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Input rejected (${response.status})`);
}
function report(error) { setStatus(error instanceof Error ? error.message : 'Request failed'); }
function button(button) { return button === 1 ? 'middle' : button === 2 ? 'right' : 'left'; }
function modifiers(event) { return [['altKey', 'Alt'], ['ctrlKey', 'Control'], ['metaKey', 'Meta'], ['shiftKey', 'Shift']].filter(([key]) => event[key]).map(([, value]) => value); }

preview.addEventListener('pointermove', (event) => { void sendInput({ type: 'pointerMove', ...point(event) }).catch(report); });
preview.addEventListener('pointerdown', (event) => { preview.focus(); preview.setPointerCapture(event.pointerId); void sendInput({ type: 'pointerDown', button: button(event.button), ...point(event) }).catch(report); });
preview.addEventListener('pointerup', (event) => { void sendInput({ type: 'pointerUp', button: button(event.button), ...point(event) }).catch(report); });
preview.addEventListener('wheel', (event) => { event.preventDefault(); void sendInput({ type: 'wheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }).catch(report); }, { passive: false });
preview.addEventListener('keydown', (event) => {
  const input = event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey
    ? { type: 'insertText', text: event.key }
    : { type: 'keyDown', key: event.key, code: event.code, modifiers: modifiers(event) };
  void sendInput(input).catch(report);
});
preview.addEventListener('keyup', (event) => {
  if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) return;
  void sendInput({ type: 'keyUp', key: event.key, code: event.code, modifiers: modifiers(event) }).catch(report);
});
preview.addEventListener('dragstart', (event) => event.preventDefault());

function selectedTasks() { return [...included]; }
async function post(suffix, body) {
  const response = await fetch(endpoint(suffix), { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${suffix} failed (${response.status})`);
  return response.json();
}
document.querySelector('#publish').addEventListener('click', () => {
  void post('/publish', { workspaceRoot, includedTaskIds: selectedTasks() })
    .then(({ result }) => {
      setStatus(`Published ${result.targetBranch} at ${result.commit.slice(0, 12)}.`);
      const query = new URLSearchParams(); if (token) query.set('token', token);
      navigator.sendBeacon(`${endpoint('/review-close')}?${query}`);
    })
    .catch(report);
});

if (!runId || !workspaceRoot) setStatus('Missing run ID or workspace root.');
else fetch(`${endpoint('/preview-review')}?${new URLSearchParams({ workspaceRoot })}`, { headers: headers() }).then(async (response) => {
  if (!response.ok) throw new Error(`Could not load preview (${response.status})`);
  const { run, stream, includedTaskIds } = await response.json();
  streamId = stream.candidateId;
  const reviewed = new Set(includedTaskIds);
  for (const task of run.tasks.filter((entry) => reviewed.has(entry.id))) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
    checkbox.addEventListener('change', () => checkbox.checked ? included.add(task.id) : included.delete(task.id));
    included.add(task.id);
    label.append(checkbox, document.createTextNode(` ${task.name}`)); taskList.append(label);
  }
  const query = new URLSearchParams({ workspaceRoot }); if (token) query.set('token', token);
  const source = new EventSource(`${endpoint(`/candidates/${encodeURIComponent(streamId)}/events`)}?${query}`);
  source.onmessage = (event) => {
    try { const frame = JSON.parse(event.data); if (frame.mimeType === 'image/jpeg') preview.src = `data:image/jpeg;base64,${frame.data}`; } catch { /* next frame recovers */ }
  };
  source.onerror = () => setStatus('Preview stream disconnected.');
  setStatus('Review the integrated result and uncheck tasks that should not be published.');
}).catch(report);
