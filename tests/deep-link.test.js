const { dashboardPage } = require('../src/workspace/deep-link.cjs');

describe('dashboardPage', () => {
  test('widget links open their workspace page', () => {
    expect(dashboardPage('vibemon://dashboard/resources')).toBe('resources');
    expect(dashboardPage('vibemon://dashboard/agents')).toBe('agents');
    expect(dashboardPage('vibemon://dashboard/overview')).toBe('overview');
  });

  test('other links are rejected', () => {
    for (const link of ['vibemon://dashboard/connections', 'vibemon://dashboard/', 'vibemon://settings/resources', 'https://dashboard/resources', 'vibemon:dashboard/agents', 'not a url', '']) {
      expect(dashboardPage(link)).toBeNull();
    }
  });
});
