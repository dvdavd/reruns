import {post} from './api.js';
import {t} from './i18n.js';

/** Where someone changes their own password. The server asks for the current
    one and ends their other sessions, so this only has to ask for it and the
    new one twice, and say what the server answered. */
export function createPasswordDialog({dialog, form, message, cancel, report}) {
  const fail = text => { message.textContent = text; message.hidden = !text; };
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { form.reset(); fail(''); });
  form.elements.repeat.addEventListener('input', () => fail(''));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const {current, password, repeat} = form.elements;
    if (password.value !== repeat.value) {
      fail(t('password.mismatch'));
      return;
    }
    try {
      await post('/api/auth/password', {current: current.value, password: password.value});
      dialog.close();
      report(t('password.changed'));
    } catch (error) {
      fail(error.message || String(error));
    }
  });
  return {open() { fail(''); dialog.showModal(); form.elements.current.focus(); }};
}
