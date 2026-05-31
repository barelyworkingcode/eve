const RateLimiter = require('../../rate-limiter');

describe('RateLimiter', () => {
  it('allows up to max within a window, then rejects', () => {
    let t = 1000;
    const rl = new RateLimiter({ windowMs: 10000, max: 3, now: () => t });
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(false);
    expect(rl.allow()).toBe(false);
  });

  it('resets after the window elapses', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 10000, max: 2, now: () => t });
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(false);
    t += 10000; // window boundary
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(false);
  });

  it('does not reset partway through a window', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 10000, max: 1, now: () => t });
    expect(rl.allow()).toBe(true);
    t += 9999;
    expect(rl.allow()).toBe(false);
  });

  it('rejects invalid configuration', () => {
    expect(() => new RateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => new RateLimiter({ windowMs: 100, max: 0 })).toThrow();
  });
});
