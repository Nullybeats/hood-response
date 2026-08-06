import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML } from '../api/dashboard.js';

describe('dashboard quote fallback', () => {
  it('uses a browser-only current quote when the server quote is unavailable', () => {
    expect(DASHBOARD_HTML).toContain('const browserQuotes=new Map()');
    expect(DASHBOARD_HTML).toContain('https://api.dexscreener.com/token-pairs/v1/');
    expect(DASHBOARD_HTML).toContain('const quoteFor=(s)=>');
    expect(DASHBOARD_HTML).toContain('const currentPriceLabel=');
    expect(DASHBOARD_HTML).toContain('MC (after signal)');
  });
});
