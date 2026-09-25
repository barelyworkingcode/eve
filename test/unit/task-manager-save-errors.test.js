// task-manager.js and core/constants.js are plain <script> globals, not
// modules, so both run in one vm context the way index.html loads them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGlobals() {
  const context = vm.createContext({ console, window: {}, navigator: { userAgent: '' } });
  for (const file of ['core/constants.js', 'task-manager.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), context);
  }
  return vm.runInContext('({ TaskManager, EVT })', context);
}

describe('TaskManager#updateTask when the scheduler rejects the save', () => {
  it('returns null, logs, and shows the server error in an error toast', async () => {
    const { TaskManager, EVT } = loadGlobals();
    const log = { debug() {}, info() {}, warn() {}, error: jest.fn() };
    const bus = { emit: jest.fn(), on: jest.fn() };
    const values = {
      api: { updateTask: jest.fn().mockRejectedValue(new Error('task "Acme": schedule is invalid')) },
      state: { addTask: jest.fn() },
      logger: { child: () => log },
      bus,
    };
    const manager = new TaskManager({ get: (name) => values[name] });

    const result = await manager.updateTask('t1', { name: 'Acme' });

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalled();
    expect(bus.emit).toHaveBeenCalledWith(EVT.TOAST_SHOW, {
      id: 'task-save-error',
      message: 'Couldn\'t save the task: task "Acme": schedule is invalid',
      type: 'error',
      duration: 8000,
    });
  });
});
