const { accountProfile, validateAccountProfile } = require('../src/monitoring/account-profile.cjs');

const identity = { provider: 'google', label: 'reader@example.com', primary: true };

test('projects only displayable sign-in metadata', () => {
  expect(validateAccountProfile({ identities: [{ ...identity, secret: 'must not cross IPC' }], extra: 'ignored' }))
    .toEqual({ identities: [identity] });
  expect(validateAccountProfile({ identities: [] })).toEqual({ identities: [] });
});

test.each([null, {}, { identities: {} }, { identities: [null] }, { identities: [{ ...identity, primary: 'yes' }] },
  { identities: [{ ...identity, label: '\n' }] }, { identities: [{ ...identity, provider: 'unknown' }] },
  { identities: [{ ...identity, label: 'x'.repeat(321) }] }, { identities: Array(65).fill(identity) }])('rejects malformed account metadata: %p', value => {
  expect(() => validateAccountProfile(value)).toThrow();
});

test('requests the account of the saved connection without exposing raw credentials', async () => {
  const monitoring = { generation: 1, request: jest.fn().mockResolvedValue({ identities: [identity] }) };
  expect(await accountProfile(monitoring)).toEqual({ identities: [identity] });
  expect(monitoring.request).toHaveBeenCalledWith('/api/v1/account');
});

test('discards an account response after the connection is replaced or removed', async () => {
  let resolve;
  const monitoring = { generation: 1, request: () => new Promise(done => { resolve = done; }) };
  const pending = accountProfile(monitoring);
  const rejected = expect(pending).rejects.toThrow();
  monitoring.generation++;
  resolve({ identities: [identity] });
  await rejected;
});
