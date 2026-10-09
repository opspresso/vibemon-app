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
    if (!this.available()) throw Object.assign(new Error('Unlock the OS secure storage'), { code: 'secure-storage-unavailable' });
    return this.safeStorage.decryptString(Buffer.from(this.store.get('credential'), 'base64'));
  }
  set(token) {
    if (!this.available()) throw new Error('OS secure storage is unavailable; unlock your keychain or secret service');
    this.store.set('credential', this.safeStorage.encryptString(token).toString('base64'));
  }
  clear() { this.store.delete('credential'); }
}
module.exports = { CredentialStore };
