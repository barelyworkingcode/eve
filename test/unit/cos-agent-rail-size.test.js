// eve#321: what a dragged or typed rail width does. Pure; no DOM.
const CosAgentRail = require('../../public/cos-agent-rail');

describe('CosAgentRail.size', () => {
  test('keeps a width inside 220-480px', () => {
    expect(CosAgentRail.size(300, 1200)).toEqual({ width: 300, folded: false });
    expect(CosAgentRail.size(300.6, 1200)).toEqual({ width: 301, folded: false });
  });

  test('clamps up to 220px from 160px, and down to 480px', () => {
    expect(CosAgentRail.size(160, 1200)).toEqual({ width: 220, folded: false });
    expect(CosAgentRail.size(900, 1200)).toEqual({ width: 480, folded: false });
  });

  test('folds under 160px and keeps no width', () => {
    expect(CosAgentRail.size(159, 1200)).toEqual({ width: null, folded: true });
    expect(CosAgentRail.size(-40, 1200)).toEqual({ width: null, folded: true });
  });

  test('leaves the thread at least 360px, but never makes the rail narrower than 220px', () => {
    expect(CosAgentRail.size(480, 760)).toEqual({ width: 400, folded: false });
    expect(CosAgentRail.size(480, 500)).toEqual({ width: 220, folded: false });
  });

  test('an unknown page width or a bad value falls back safely', () => {
    expect(CosAgentRail.size(400, Infinity)).toEqual({ width: 400, folded: false });
    expect(CosAgentRail.size(400, 0)).toEqual({ width: 400, folded: false });
    expect(CosAgentRail.size(NaN, 1200)).toEqual({ width: 280, folded: false });
  });
});
