jest.mock('electron', () => ({
  Tray: jest.fn(), Menu: { buildFromTemplate: jest.fn(template => ({ template })) },
  nativeImage: { createFromBitmap: jest.fn(() => ({ image: true })), createFromBuffer: jest.fn() },
  BrowserWindow: jest.fn(), screen: {}, dialog: {}, shell: {}
}));

const { t, initLocale, setLocale, currentLocale, rendererLanguage } = require('../src/shared/i18n/locale.cjs');
const { attentionAreas, attentionNotices } = require('../src/shared/attention.cjs');
const { TrayManager } = require('../src/modules/tray-manager.cjs');
const { buildFieldPayload } = require('../src/modules/bubble-window-manager.cjs');
const { describeFailure } = require('../src/shared/install-result.cjs');

afterEach(() => setLocale('en'));

describe('initLocale', () => {
  test('uses the first supported OS language', () => {
    expect(initLocale({ getPreferredSystemLanguages: () => ['fr-FR', 'ko-KR', 'en-US'], getLocale: () => 'en-US' })).toBe('ko');
    expect(currentLocale()).toBe('ko');
    expect(initLocale({ getPreferredSystemLanguages: () => ['ja-JP'], getLocale: () => 'ko' })).toBe('ja');
  });

  test('falls back to the app locale when the OS reports no language', () => {
    expect(initLocale({ getPreferredSystemLanguages: () => [], getLocale: () => 'ja' })).toBe('ja');
  });

  test('uses English for unsupported languages', () => {
    expect(initLocale({ getPreferredSystemLanguages: () => ['de-DE', 'fr'], getLocale: () => 'de' })).toBe('en');
    expect(t('nav.overview')).toBe('Overview');
  });
});

test('the renderer receives its locale with the English fallback only', () => {
  expect(rendererLanguage()).toEqual({ locale: 'en', messages: { en: expect.objectContaining({ 'nav.overview': 'Overview', 'state.ok': 'Healthy' }) } });
  setLocale('ja');
  const { locale, messages } = rendererLanguage();
  expect(locale).toBe('ja');
  expect(Object.keys(messages).sort()).toEqual(['en', 'ja']);
  expect(messages.ja['state.standby']).toBe('待機');
});

test('Korean notices and tray menu use the shared terms', () => {
  setLocale('ko');
  const notices = attentionNotices(attentionAreas({
    status: 'token-expired',
    sources: [{ kind: 'host', needsAttention: true }],
    accounts: [{ needsAttention: true }, { needsAttention: true }]
  }, {
    hooks: [{ name: 'Claude Code', present: true, broken: true }, { name: 'Codex CLI', present: true, changed: true }],
    vibemonConfig: { status: {} }, cloudDelivery: { status: 'error' }, update: { status: 'downloaded', version: '9.9.9' }
  }));
  expect(notices).toEqual({
    dashboard: '리소스 1개, 코딩 계정 2개 확인 필요',
    resources: '리소스 1개 확인 필요',
    accounts: '코딩 계정 2개 확인 필요',
    where: '리소스 1개 · 계정 2개',
    connection: '읽기 토큰 거부됨',
    integrations: 'Claude Code 복구 필요 · Codex CLI 업데이트 있음 · 클라우드 전송 확인 실패',
    update: '버전 9.9.9 설치 준비됨'
  });
  const tray = new TrayManager({ getProjectIds: () => [], isCompanionShown: () => false }, { getVersion: () => '1.2.3', quit: jest.fn() });
  tray.setAttention(notices);
  const labels = tray.buildMenuTemplate().filter(item => item.label).map(item => item.label.split(' — ')[0]);
  expect(labels).toEqual(['VibeMon 1.2.3', '대시보드', '컴패니언 보기', '설정…', '연동…', 'VibeMon 정보', 'VibeMon 종료']);
  expect(tray.attentionReasons()[0]).toBe('읽기 토큰 거부됨 — 설정 열기');
});

test('Japanese speech bubbles use the shared bubble and tool texts', () => {
  setLocale('ja');
  const status = state => buildFieldPayload(state, { status: true }).status.text;
  expect(status({ state: 'idle' })).toBe('準備OK');
  expect(status({ state: 'working', tool: 'Bash' })).toBe('実行中');
  expect(status({ state: 'working', tool: 'unknown-tool' })).toBe('作業中');
  expect(status({ state: 'custom' })).toBe('Custom');
});

test('installation failures follow the App language', () => {
  setLocale('ja');
  expect(describeFailure({ reason: 'download-failed', statusCode: 503 })).toBe('インストールスクリプトをダウンロードできませんでした（HTTP 503）');
  setLocale('en');
  expect(describeFailure({ reason: 'download-failed', statusCode: 503 })).toBe('Failed to download install script (HTTP 503)');
});
