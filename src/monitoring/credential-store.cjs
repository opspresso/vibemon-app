const { t } = require('../shared/i18n/locale.cjs');

/** OS-protected encryption; plaintext and Linux basic_text storage are rejected. */
class CredentialStore {
  constructor(store, safeStorage) {
    this.store = store;
    this.safeStorage = safeStorage;
  }
  available() {
    return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  has() { return Boolean(this.store.get('credential')); }
  get() {
    if (!this.has()) return null;
    if (!this.available()) throw Object.assign(new Error(t('connection.secureStorageUnavailable.description')), { code: 'secure-storage-unavailable' });
    try { return this.safeStorage.decryptString(Buffer.from(this.store.get('credential'), 'base64')); }
    catch { throw Object.assign(new Error(t('connection.credentialUnavailable.description')), { code: 'credential-unavailable' }); }
  }
  set(token, origin) {
    if (!this.available()) throw new Error(t('error.secureStorage'));
    const credential = this.safeStorage.encryptString(token).toString('base64');
    // One store transaction keeps a replacement credential bound to its origin.
    if (origin === undefined) this.store.set('credential', credential);
    else this.store.set({ credential, url: origin });
  }
  clear() { this.store.delete('credential'); }
}
module.exports = { CredentialStore };
