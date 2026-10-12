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
