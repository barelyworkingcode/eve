const { nodeLauncher } = require('../../ssh-command');

describe('ssh-command nodeLauncher', () => {
  it('runs under node exactly as the remote host would', () => {
    const { execFileSync } = require('child_process');
    const launcher = nodeLauncher("process.stdout.write('ok ' + typeof require)");
    const arg = launcher.match(/^node -e "(.*)"$/)[1];
    expect(execFileSync(process.execPath, ['-e', arg]).toString()).toBe('ok function');
  });
});
