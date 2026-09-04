/**
 * FileAttachmentManager's constructor/init split (phase 3): the constructor
 * must stay DOM-free (it now runs at features.boot(), before any slot
 * renders); init(button) is called later, at renderSlots() time, and is
 * where the five listeners actually get wired against the static markup.
 *
 * The class already has a CommonJS export guard, so it's required directly
 * rather than loaded into a vm sandbox.
 */
const FileAttachmentManager = require('../../public/file-attachment-manager.js');

function fakeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
}

function fakeEventTarget(extra = {}) {
  const listeners = {};
  return {
    ...extra,
    classList: fakeClassList(),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, evt) { (listeners[type] || []).forEach((fn) => fn(evt)); },
  };
}

function setUpDom() {
  const attachBtn = fakeEventTarget();
  const fileInput = fakeEventTarget({ click: jest.fn(), value: '', files: [] });
  const userInput = fakeEventTarget();
  const attachedFilesEl = fakeEventTarget();
  const elements = { fileInput, userInput, attachedFiles: attachedFilesEl };
  const getElementById = jest.fn((id) => elements[
    id === 'fileInput' ? 'fileInput' : id === 'userInput' ? 'userInput' : id === 'attachedFiles' ? 'attachedFiles' : id
  ]);
  global.document = { getElementById };
  return { attachBtn, fileInput, userInput, attachedFilesEl, getElementById };
}

describe('FileAttachmentManager construction/init split', () => {
  afterEach(() => { delete global.document; });

  it('the constructor touches no DOM', () => {
    const { getElementById } = setUpDom();
    const mgr = new FileAttachmentManager({ get: () => ({}) });
    expect(getElementById).not.toHaveBeenCalled();
    expect(mgr.button).toBeNull();
  });

  it('init() wires the attach button to open the file picker', () => {
    const { attachBtn, fileInput } = setUpDom();
    const mgr = new FileAttachmentManager({ get: () => ({}) });
    mgr.init(attachBtn);

    attachBtn.dispatch('click');
    expect(fileInput.click).toHaveBeenCalledTimes(1);
  });

  it('init() wires drag state and drop to addFiles, and resets the dragover class', () => {
    const { attachBtn, userInput } = setUpDom();
    const mgr = new FileAttachmentManager({ get: () => ({}) });
    mgr.init(attachBtn);
    mgr.addFiles = jest.fn();

    const dragEvt = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
    userInput.dispatch('dragover', dragEvt);
    expect(userInput.classList.contains('dragover')).toBe(true);

    userInput.dispatch('dragleave', dragEvt);
    expect(userInput.classList.contains('dragover')).toBe(false);

    userInput.classList.add('dragover'); // simulate a dragover immediately preceding the drop
    const files = [{ name: 'a.png', type: 'image/png' }];
    userInput.dispatch('drop', { preventDefault: jest.fn(), stopPropagation: jest.fn(), dataTransfer: { files } });

    expect(userInput.classList.contains('dragover')).toBe(false);
    expect(mgr.addFiles).toHaveBeenCalledWith(files);
  });

  it('init() wires the file input change event to addFiles and clears the input', () => {
    const { attachBtn, fileInput } = setUpDom();
    const mgr = new FileAttachmentManager({ get: () => ({}) });
    mgr.init(attachBtn);
    mgr.addFiles = jest.fn();

    const files = [{ name: 'b.txt', type: 'text/plain' }];
    const target = { files, value: 'C:\\fakepath\\b.txt' };
    fileInput.dispatch('change', { target });

    expect(mgr.addFiles).toHaveBeenCalledWith(files);
    expect(target.value).toBe('');
  });

  it('init() wires paste to addFiles only for image clipboard items, tagging a name', () => {
    const { attachBtn, userInput } = setUpDom();
    const mgr = new FileAttachmentManager({ get: () => ({}) });
    mgr.init(attachBtn);
    mgr.addFiles = jest.fn();

    const imageFile = {};
    const items = [
      { type: 'text/plain', getAsFile: () => ({}) },              // must be ignored
      { type: 'image/png', getAsFile: () => imageFile },
    ];
    const evt = { preventDefault: jest.fn(), clipboardData: { items } };
    userInput.dispatch('paste', evt);

    expect(mgr.addFiles).toHaveBeenCalledTimes(1);
    expect(mgr.addFiles).toHaveBeenCalledWith([imageFile]);
    expect(imageFile.customName).toMatch(/^pasted-.*\.png$/);
  });
});
