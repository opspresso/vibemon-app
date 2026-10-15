const { attentionAreas, attentionNotices } = require('../src/shared/attention.cjs');

const cloud = (overrides = {}) => ({ status: 'connected', sources: [], accounts: [], ...overrides });
const settings = (overrides = {}) => ({
  hooks: [], vibemonConfig: { status: {} }, cloudDelivery: { status: 'verified' }, update: { status: 'current', version: null }, ...overrides
});

test('a quiet workspace has no notices', () => {
  const areas = attentionAreas(cloud(), settings());
  expect(attentionNotices(areas)).toEqual({ dashboard: null, resources: null, accounts: null, where: '', connection: null, integrations: null, update: null });
});

test.each(['connected', 'connecting', 'not-configured'])('%s is not a connection issue', status => {
  expect(attentionAreas(cloud({ status }), settings()).connection).toBeNull();
});

test('each issue is assigned to the page that resolves it', () => {
  const areas = attentionAreas(cloud({
    status: 'token-expired',
    sources: [{ kind: 'host', needsAttention: true }, { kind: 'agent', needsAttention: true }, { kind: 'cluster', needsAttention: false }],
    accounts: [{ needsAttention: true }, { needsAttention: true }]
  }), settings({
    hooks: [
      { name: 'Claude Code', present: true, broken: true, changed: false },
      { name: 'Codex CLI', present: true, broken: false, changed: true },
      { name: 'Kiro', present: false, broken: true, changed: true }
    ],
    vibemonConfig: { status: { error: 'Invalid field types' } },
    cloudDelivery: { status: 'error' },
    update: { status: 'downloaded', version: '9.9.9' }
  }));
  expect(attentionNotices(areas)).toEqual({
    // Agent sources count once, through their account.
    dashboard: '1 resource · 2 coding accounts need attention',
    resources: '1 resource needs attention',
    accounts: '2 coding accounts need attention',
    where: '1 resource · 2 accounts',
    connection: 'Read token rejected',
    // A tool that is not installed cannot be repaired here.
    integrations: 'Claude Code needs repair · Codex CLI has an update · Local delivery settings need repair · Cloud delivery check failed',
    update: 'Version 9.9.9 is ready to install'
  });
});

test('a single item reads in the singular', () => {
  const notices = attentionNotices(attentionAreas(cloud({ accounts: [{ needsAttention: true }] }), settings({ update: { status: 'available', version: '1.0.0' } })));
  expect(notices.dashboard).toBe('1 coding account needs attention');
  expect(notices.update).toBe('Version 1.0.0 is available');
});

test('an unknown connection problem still names Connections', () => {
  expect(attentionNotices(attentionAreas(cloud({ status: 'connection-error' }), settings())).connection).toBe('Cloud connection interrupted');
});
