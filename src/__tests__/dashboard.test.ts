import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML } from '../api/dashboard.js';

describe('dashboard quote fallback', () => {
  it('uses a browser-only current quote when the server quote is unavailable', () => {
    expect(DASHBOARD_HTML).toContain('const browserQuotes=new Map()');
    expect(DASHBOARD_HTML).toContain('https://api.dexscreener.com/token-pairs/v1/');
    expect(DASHBOARD_HTML).toContain('const quoteFor=(s)=>');
    expect(DASHBOARD_HTML).toContain('const currentPriceLabel=');
    expect(DASHBOARD_HTML).toContain('const swarmFacts=');
    // The refresh snapshot must not shadow the mutable header `swaps` counter:
    // assigning to that local const crashed the whole dashboard with
    // "Assignment to constant variable".
    expect(DASHBOARD_HTML).toContain('const [feedSwaps,feedSwarms,feedAlerts]=await Promise.all([');
    expect(DASHBOARD_HTML).toContain('swaps=Math.max(swaps, feedSwaps.length)');
    expect(DASHBOARD_HTML).not.toContain('const [swaps,swarms,alerts]=await Promise.all([');
    expect(DASHBOARD_HTML).toContain('MC (after signal)');
  });
});
