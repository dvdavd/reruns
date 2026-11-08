import {serverMessage} from './i18n.js';

/* What went wrong, in the words the server used. http.server wraps its
   message in a whole error page, so a refusal like "--exec is not allowed"
   would otherwise reach the toast as a page of HTML. */
function reason(body) {
  const message = body.match(/<p>Message: ([^<]*)\.?<\/p>/);
  return (message ? message[1] : body).trim();
}

export async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(serverMessage(reason(await response.text()))
      || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function post(path, body = {}) {
  if (path === '/api/download' && globalThis.rerunsDestination) {
    body = {...body, destination: globalThis.rerunsDestination()};
  }
  return request(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
}

/** One job from the queue, or null once it has gone (cleared after
 *  finishing, or never there). */
export async function fetchJob(id) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(serverMessage(reason(await response.text()))
      || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

const JOB_POLL_MS = 1000;
const FINAL_STATES = new Set(['done', 'failed', 'cancelled']);

/** Resolves with a job once it has finished, or rejects with its reason if it
 *  failed or was cancelled, or `failure` once `giveUpMs` has passed. A job
 *  that has vanished from the list was cleared after finishing. */
export async function jobFinished(job, {failure, giveUpMs = 5 * 60 * 1000}) {
  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    await new Promise(resolve => setTimeout(resolve, JOB_POLL_MS));
    const current = await fetchJob(job.id);
    if (!current) return job;
    if (!FINAL_STATES.has(current.state)) continue;
    if (current.state !== 'done') throw new Error(serverMessage(current.error) || failure);
    return current;
  }
  throw new Error(failure);
}
