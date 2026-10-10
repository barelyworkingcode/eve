const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

function approving() {
  const w = worlds.base();
  w.presence = { 'project.grant': 'approve' };
  return w;
}

function withHost() {
  const w = approving();
  w.hosts = [{
    id: 'h_box',
    name: 'testbox',
    target: 'acme@testbox',
    probe: { at: '2026-10-09T10:00:00Z', ok: true, os: 'Linux', arch: 'x86_64', home: '/home/acme', shell: '/bin/bash' },
    agent: 'connected',
  }];
  return w;
}

function withTemplates() {
  const w = approving();
  w.projects[0].chat_templates = [
    { id: 't_review', name: 'Review', model: 'sonnet' },
  ];
  return w;
}

function withNoModelTemplate() {
  const w = approving();
  w.projects[0].chat_templates = [
    { id: 't_plain', name: 'Plain', model: '' },
    { id: 't_other', name: 'Other', model: 'sonnet' },
  ];
  return w;
}

function withBothModeTemplates() {
  const w = withTemplates();
  delete w.projects[0].mode;
  return w;
}

function twoProjects() {
  const w = approving();
  w.projects.push({ id: 'p_beta', name: 'Beta', files: { 'NOTES.md': '# Beta\n' } });
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

async function openNew(eve, page) {
  await eve.open('/');
  await rail(page).getByRole('button', { name: 'New Project' }).click();
  await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
}

async function openEdit(eve, page) {
  await eve.open('/');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Project' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();
}

test.describe('creating a project', () => {
  test.use({ world: approving() });

  test('open the New Project dialog from the Rail @G12.1', async ({ eve, page }) => {
    await openNew(eve, page);
    await expect(page.getByRole('button', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Templates' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Project Name' })).toBeFocused();
  });

  test('name the project and point it at a folder @G12.2 @G12.3', async ({ eve, page }) => {
    await openNew(eve, page);
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Orchard');
    await page.getByRole('textbox', { name: 'Directory Path' }).fill('/home/acme/orchard');
    await expect(page.getByRole('textbox', { name: 'Project Name' })).toHaveValue('Orchard');
    await expect(page.getByRole('textbox', { name: 'Directory Path' })).toHaveValue('/home/acme/orchard');
  });

  test('create the project @G12.4', async ({ eve, relay, page }) => {
    await openNew(eve, page);
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Orchard');
    await page.getByRole('textbox', { name: 'Directory Path' }).fill('/home/acme/orchard');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeHidden();
    await expect(rail(page).getByRole('button', { name: 'Orchard' })).toBeVisible();
    await relay.waitForEvent('project.create', { match: (l) => l.status === 'ok' });
  });

  test('a name or path left empty keeps the dialog open @G12.4.r1', async ({ eve, page }) => {
    await openNew(eve, page);
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Orchard');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Orchard' })).toBeHidden();
  });
});

test.describe('relay refuses a new project', () => {
  test('relay says no @G12.4.r2', async ({ eve, page }) => {
    await openNew(eve, page);
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Orchard');
    await page.getByRole('textbox', { name: 'Directory Path' }).fill('/home/acme/orchard');
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByText(/Failed to save project: /)).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Orchard' })).toBeHidden();
  });
});

test.describe('editing a project', () => {
  test.use({ world: approving() });

  test('save changes to the project @G12.5', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Acme Two');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeHidden();
    await expect(rail(page).getByRole('button', { name: 'Acme Two' })).toBeVisible();
    await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
  });

  test('relay refuses the save @G12.5.r1', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await relay.ctl('fault', 'add', '--route', 'PUT /api/projects/{id}', '--mode', 'error', '--status', '400', '--body', '{"error":"nope"}');
    await page.getByRole('textbox', { name: 'Project Name' }).fill('Acme Two');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Failed to save project: /)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();
  });

  test('see which models the project allows @G12.11', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'General' }).click();
    await expect(page.getByText('Allowed Models')).toBeVisible();
    await expect(page.getByText('All models')).toBeVisible();
    await expect(page.getByText('Set in Relay Settings on your Mac.')).toBeVisible();
  });

  test('leave the dialog with Cancel @G12.12', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeHidden();
    await expect(rail(page).getByRole('button', { name: 'Acme' })).toBeVisible();
  });

  test('close the dialog with its close button @G12.13', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeHidden();
  });

  test('close the dialog with Escape @G12.14', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeHidden();
  });

  test('show the project in Home only @G12.8', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Home', exact: true, pressed: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
    await expect(rail(page).getByRole('button', { name: 'Acme' })).toBeHidden();
  });
});

test.describe('changing the mode', () => {
  test.use({ world: approving() });

  test('show the project in Work only @G12.9', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Work', exact: true, pressed: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
    await page.getByRole('radio', { name: 'Home' }).check();
    await expect(rail(page).getByRole('button', { name: 'Acme' })).toBeHidden();
  });

  test('show the project in both modes @G12.10', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Both', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Both', exact: true, pressed: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
    await page.getByRole('radio', { name: 'Home' }).check();
    await expect(rail(page).getByRole('button', { name: 'Acme' })).toBeVisible();
  });
});

test.describe('a project on a host', () => {
  test.use({ world: withHost() });

  test('put the project on an SSH host @G12.7', async ({ eve, page }) => {
    await openNew(eve, page);
    const mac = page.getByRole('button', { name: 'This Mac' });
    const host = page.getByRole('button', { name: /testbox/ });
    await expect(mac).toHaveAttribute('aria-pressed', 'true');
    await expect(host).toHaveAttribute('aria-pressed', 'false');
    await host.click();
    await expect(page.getByRole('textbox', { name: 'Path on testbox' })).toBeVisible();
    await expect(host).toHaveAttribute('aria-pressed', 'true');
    await expect(mac).toHaveAttribute('aria-pressed', 'false');
  });

  test('list the host choices from Today @G12.33', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'This Mac' })).toBeVisible();
    await expect(page.getByRole('button', { name: /testbox/ })).toBeVisible();
  });

  test('keep the project on this Mac @G12.6', async ({ eve, page }) => {
    await openNew(eve, page);
    const mac = page.getByRole('button', { name: 'This Mac' });
    const host = page.getByRole('button', { name: /testbox/ });
    await host.click();
    await expect(page.getByRole('textbox', { name: 'Path on testbox' })).toBeVisible();
    await mac.click();
    await expect(page.getByRole('textbox', { name: 'Directory Path' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Path on testbox' })).toBeHidden();
    await expect(mac).toHaveAttribute('aria-pressed', 'true');
    await expect(host).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('chat templates', () => {
  test.use({ world: withTemplates() });

  test('the Templates tab lists each template @G12.15', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await expect(page.getByText('Review', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Review' })).toBeVisible();
  });

  test('add a template and keep it @G12.16 @G12.17 @G12.18 @G12.19 @G12.24 @G12.25 @G12.29', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: '+ Add Template' }).click();
    await expect(page.getByRole('button', { name: 'Save Template' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Template Name' }).fill('Triage');
    await expect(page.getByRole('textbox', { name: 'Template Name' })).toHaveValue('Triage');
    await page.getByRole('combobox', { name: 'Model' }).selectOption('haiku');
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('haiku');
    await page.getByRole('radio', { name: 'Text' }).check();
    await expect(page.getByRole('radio', { name: 'Text' })).toBeChecked();
    await page.getByRole('textbox', { name: 'System Prompt' }).fill('Be brief.');
    await expect(page.getByRole('textbox', { name: 'System Prompt' })).toHaveValue('Be brief.');
    await page.getByRole('button', { name: 'Save Template' }).click();
    await expect(page.getByRole('button', { name: 'Edit Triage' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeHidden();
  });

  test('a template with no name is not saved @G12.17.r1 @G12.25.r1', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: '+ Add Template' }).click();
    await page.getByRole('combobox', { name: 'Model' }).selectOption('haiku');
    await page.getByRole('button', { name: 'Save Template' }).click();
    await expect(page.getByRole('textbox', { name: 'Template Name' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Save Template' })).toBeVisible();
  });

  test('go back from the template form @G12.26', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: '+ Add Template' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: '+ Add Template' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Template' })).toBeHidden();
  });

  test('edit a template @G12.27', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: 'Edit Review' }).click();
    await expect(page.getByRole('textbox', { name: 'Template Name' })).toHaveValue('Review');
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('sonnet');
  });

  test('remove a template @G12.28', async ({ eve, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: 'Delete Review' }).click();
    await expect(page.getByRole('button', { name: 'Edit Review' })).toBeHidden();
    await expect(page.getByText('No chat templates yet.')).toBeVisible();
  });

  test.describe('in both modes', () => {
    test.use({ world: withBothModeTemplates() });

    test('make the template the Home Ask preset @G12.22', async ({ eve, relay, page }) => {
      await openEdit(eve, page);
      await page.getByRole('button', { name: 'Templates' }).click();
      await page.getByRole('button', { name: 'Edit Review' }).click();
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Home', exact: true, pressed: true })).toBeVisible();
      await page.getByRole('button', { name: 'Save Template' }).click();
      await expect(page.getByText('Home Ask')).toBeVisible();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
    });
  });

  test('make the template the Work Ask preset @G12.23', async ({ eve, relay, page }) => {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: 'Edit Review' }).click();
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Work', exact: true, pressed: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save Template' }).click();
    await expect(page.getByText('Work Ask')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await relay.waitForEvent('project.update', { match: (l) => l.status === 'ok' });
  });

  test('make the template a voice chat @G12.20', async ({ eve, voice, page }) => {
    void voice;
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: 'Edit Review' }).click();
    await expect(page.getByRole('radio', { name: 'Text' })).toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Default Voice' })).toBeHidden();
    await page.getByRole('radio', { name: 'Voice' }).check();
    await expect(page.getByRole('radio', { name: 'Voice' })).toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Default Voice' })).toBeVisible();
    await expect(page.getByText('Voice preset in')).toBeVisible();
  });

  test('choose the voice a voice template starts with @G12.21', async ({ eve, voice, page }) => {
    void voice;
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: 'Edit Review' }).click();
    await page.getByRole('radio', { name: 'Voice' }).check();
    const picker = page.getByRole('combobox', { name: 'Default Voice' });
    await expect(picker).toBeVisible();
    await picker.selectOption({ label: 'George' });
    await expect(picker).toHaveValue('bm_george');
  });
});

test.describe('deleting a project', () => {
  test.use({ world: twoProjects() });

  async function startDelete(eve, page) {
    await eve.open('/');
    await rail(page).getByRole('button', { name: 'Beta' }).click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete Project' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm Deletion' })).toBeVisible();
  }

  test('delete a project @G12.30', async ({ eve, relay, page }) => {
    await startDelete(eve, page);
    await expect(page.getByText(/Delete 'Beta'\?/)).toBeVisible();
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Delete' }).click();
    await expect(rail(page).getByRole('button', { name: 'Beta' })).toBeHidden();
    await relay.waitForEvent('project.remove', { match: (l) => l.status === 'ok' });
  });

  test('keep a project at the delete question @G12.31', async ({ eve, page }) => {
    await startDelete(eve, page);
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm Deletion' })).toBeHidden();
    await expect(rail(page).getByRole('button', { name: 'Beta' })).toBeVisible();
  });

  test('a failed delete leaves the project @G12.30.r1', async ({ eve, relay, page }) => {
    await startDelete(eve, page);
    await relay.ctl('fault', 'add', '--route', 'DELETE /api/projects/{id}', '--mode', 'error', '--status', '500', '--body', '{"error":"nope"}');
    await page.getByRole('dialog', { name: 'Confirm Deletion' }).getByRole('button', { name: 'Delete' }).click();
    await relay.waitForEvent('fakerelay.fault', { match: (l) => l.action === 'applied' });
    await expect(page.getByRole('dialog', { name: 'Confirm Deletion' })).toBeHidden();
    await expect(rail(page).getByRole('button', { name: 'Beta' })).toBeVisible();
  });
});

test.describe('a template with no model', () => {
  test.use({ world: withNoModelTemplate() });

  const NO_MODEL = 'Template "Plain" has no model. Pick one before saving.';

  async function changeTemplates(eve, page) {
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: 'Delete Other' }).click();
    await expect(page.getByRole('button', { name: 'Edit Other' })).toBeHidden();
  }

  test('Save on General refuses a template with no model @G12.5.r2', async ({ eve, page }) => {
    await changeTemplates(eve, page);
    await page.getByRole('button', { name: 'General' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(NO_MODEL)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();
  });

  test('Save on Templates refuses a template with no model @G12.29.r1', async ({ eve, page }) => {
    await changeTemplates(eve, page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(NO_MODEL)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();
  });
});

test.describe('no model list', () => {
  test.use({ world: withTemplates() });

  test('a template cannot be saved without a model list @G12.18.r1 @G12.25.r2', async ({ eve, relay, page }) => {
    await relay.ctl('fault', 'add', '--route', 'GET /api/models', '--mode', 'down');
    await openEdit(eve, page);
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('button', { name: '+ Add Template' }).click();
    await page.getByRole('textbox', { name: 'Template Name' }).fill('Triage');
    await page.getByRole('button', { name: 'Save Template' }).click();
    await expect(page.getByText('Pick a model for this template.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Template' })).toBeVisible();
  });
});

test.describe('terminal templates', () => {
  test.use({
    world: (() => {
      const w = approving();
      w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
      w.projects[0].allowed_templates = ['shell'];
      return w;
    })(),
  });

  test('a terminal template from relay shows as a card @G12.34', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'New Session' }).click();
    await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Shell', exact: true })).toBeVisible();
  });
});
