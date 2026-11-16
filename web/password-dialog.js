import {post} from './api.js';
import {showModalOverPage} from './drawer.js';
import {t} from './i18n.js';
import {createPasswordField} from './password-field.js';

/** Where a password is changed in the app: your own, or an admin setting
    someone else's. Each asks for only the fields it needs, and none asks
    twice: the reveal button shows what was typed instead. The server's
    refusal is shown here rather than as a toast, so it sits beside the field
    it is about and the form stays filled in. Adding an account asks in the
    Accounts drawer instead, as adding anything else does. */
export function createPasswordDialog({dialog, form, message, cancel, report}) {
  const title = dialog.querySelector('#password-dialog-title');
  const submitButton = form.querySelector('[type="submit"]');
  const rows = Object.fromEntries([...form.querySelectorAll('[data-field]')].map(row => [row.dataset.field, row]));
  const fields = [rows.current, rows.password].map(row => createPasswordField(row));
  let asked = null;

  const fail = text => { message.textContent = text; message.hidden = !text; };
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    form.reset();
    fail('');
    for (const field of fields) field.hide();
    asked = null;
  });
  form.addEventListener('input', () => fail(''));

  function show(name, shown) {
    rows[name].hidden = !shown;
    // A hidden required field would still block the submit.
    for (const input of rows[name].querySelectorAll('input')) input.disabled = !shown;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    submitButton.disabled = true;
    try {
      await asked.send(values);
      const done = asked.done;
      dialog.close();
      if (done) report(done);
    } catch (error) {
      fail(error.message || String(error));
    } finally {
      submitButton.disabled = false;
    }
  });

  /** Open for one use. `with` names the extra rows it shows; the new
      password is always asked. `send` throws the server's refusal, and
      `done` is the toast once it has gone through. */
  function ask(use) {
    asked = use;
    title.textContent = use.title;
    submitButton.textContent = use.submit;
    show('current', use.with.includes('current'));
    for (const field of fields) field.sync();
    fail('');
    showModalOverPage(dialog);
    form.querySelector('input:not(:disabled)').focus();
  }

  return {
    ask,
    /** Your own: the server asks for the current one and ends your other sessions. */
    open() {
      ask({
        with: ['current'],
        title: t('password.title'),
        submit: t('password.change'),
        send: ({current, password}) => post('/api/auth/password', {current, password}),
        done: t('password.changed'),
      });
    },
  };
}
