/** Keep the current page's subject visible in the browser tab. */
export function setPageTitle(subject = '') {
  document.title = subject ? `${subject} · Reruns` : 'Reruns';
}
