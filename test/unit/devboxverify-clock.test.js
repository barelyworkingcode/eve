// A VM clock step (sntp) moves Date.now() but not performance.now(). The
// harness's waits must keep their budget when only the wall clock jumps.
const { poll, left, seconds } = require('../../devboxverify/journey-kit');

const STEP_MS = 16 * 60 * 1000;

afterEach(() => jest.restoreAllMocks());

const stepWallClock = () => {
  const real = Date.now();
  return jest.spyOn(Date, 'now').mockReturnValue(real + STEP_MS);
};

describe('devboxverify waits survive a forward wall-clock step', () => {
  it('poll keeps waiting and returns the value fn yields next', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) {
        stepWallClock();
        return null;
      }
      return 'ok';
    };
    await expect(poll(fn, { timeoutMs: 5000, intervalMs: 10 })).resolves.toBe('ok');
  });

  it('left stays near the budget of a deadline set ahead on the monotonic clock', () => {
    const deadline = performance.now() + 10000;
    stepWallClock();
    expect(left(deadline)).toBeGreaterThan(5000);
  });

  it('seconds reads a stamp taken just before as under five seconds', () => {
    const stamp = performance.now();
    stepWallClock();
    expect(seconds(stamp)).toBeLessThan(5);
  });
});
