const os = require('os');
const fs = require('fs');
const path = require('path');
const FileService = require('../../file-service');

describe('FileService', () => {
  let fileService;

  beforeEach(() => {
    fileService = new FileService();
  });

  describe('validatePath', () => {
    const projectPath = '/home/user/project';

    it('resolves a simple relative path', () => {
      const result = fileService.validatePath(projectPath, 'src/index.js');
      expect(result).toBe(path.resolve(projectPath, 'src/index.js'));
    });

    it('strips leading slashes from relative path', () => {
      const result = fileService.validatePath(projectPath, '/src/index.js');
      expect(result).toBe(path.resolve(projectPath, 'src/index.js'));
    });

    it('strips multiple leading slashes', () => {
      const result = fileService.validatePath(projectPath, '///src/index.js');
      expect(result).toBe(path.resolve(projectPath, 'src/index.js'));
    });

    it('resolves empty path to project root', () => {
      const result = fileService.validatePath(projectPath, '');
      // Empty string -> '.' -> resolves to projectPath
      expect(result).toBe(path.resolve(projectPath));
    });

    it('blocks path traversal with ../', () => {
      expect(() => {
        fileService.validatePath(projectPath, '../../../etc/passwd');
      }).toThrow('Path traversal not allowed');
    });

    it('blocks path traversal with nested ../', () => {
      expect(() => {
        fileService.validatePath(projectPath, 'src/../../outside');
      }).toThrow('Path traversal not allowed');
    });

    it('allows ../ that stays within project', () => {
      const result = fileService.validatePath(projectPath, 'src/../lib/util.js');
      expect(result).toBe(path.resolve(projectPath, 'lib/util.js'));
    });
  });

  describe('isAllowedFile', () => {
    it('allows common text extensions', () => {
      const allowed = ['file.js', 'file.ts', 'file.py', 'file.json', 'file.md', 'file.html', 'file.css'];
      for (const filename of allowed) {
        expect(fileService.isAllowedFile(filename)).toBe(true);
      }
    });

    it('allows config file extensions', () => {
      const allowed = ['file.yaml', 'file.yml', 'file.toml', 'file.ini', 'file.conf', 'file.config'];
      for (const filename of allowed) {
        expect(fileService.isAllowedFile(filename)).toBe(true);
      }
    });

    it('allows extensionless files', () => {
      expect(fileService.isAllowedFile('Makefile')).toBe(true);
      expect(fileService.isAllowedFile('Dockerfile')).toBe(true);
    });

    it('rejects binary/disallowed extensions', () => {
      const disallowed = ['file.exe', 'file.dll', 'file.so', 'file.png', 'file.jpg', 'file.mp4', 'file.zip'];
      for (const filename of disallowed) {
        expect(fileService.isAllowedFile(filename)).toBe(false);
      }
    });

    it('is case insensitive for extensions', () => {
      expect(fileService.isAllowedFile('file.JS')).toBe(true);
      expect(fileService.isAllowedFile('file.Json')).toBe(true);
      expect(fileService.isAllowedFile('file.PY')).toBe(true);
    });

    it('allows .gitignore extension', () => {
      expect(fileService.isAllowedFile('.gitignore')).toBe(true);
    });

    it('allows .env extension', () => {
      expect(fileService.isAllowedFile('.env')).toBe(true);
    });

    it('allows lock files', () => {
      expect(fileService.isAllowedFile('package-lock.lock')).toBe(true);
    });

    it('allows log files', () => {
      expect(fileService.isAllowedFile('server.log')).toBe(true);
    });
  });

  describe('file I/O operations', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-fs-test-'));
      // Create a subdirectory structure
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log("hello");', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test', 'utf8');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('readFile', () => {
      it('reads an allowed file', async () => {
        const result = await fileService.readFile(tmpDir, 'src/index.js');
        expect(result.content).toBe('console.log("hello");');
        expect(result.size).toBeGreaterThan(0);
      });

      it('throws for nonexistent file', async () => {
        await expect(fileService.readFile(tmpDir, 'nonexistent.js'))
          .rejects.toThrow('File not found');
      });

      it('throws for disallowed file extension', async () => {
        fs.writeFileSync(path.join(tmpDir, 'image.png'), 'fake', 'utf8');
        await expect(fileService.readFile(tmpDir, 'image.png'))
          .rejects.toThrow('File type not allowed');
      });

      it('throws for directory path', async () => {
        await expect(fileService.readFile(tmpDir, 'src'))
          .rejects.toThrow('Path is a directory');
      });

      it('blocks path traversal', async () => {
        await expect(fileService.readFile(tmpDir, '../../etc/passwd'))
          .rejects.toThrow('Path traversal not allowed');
      });
    });

    describe('writeFile', () => {
      it('writes content to a new file', async () => {
        await fileService.writeFile(tmpDir, 'src/new.js', 'const x = 1;');

        const written = fs.readFileSync(path.join(tmpDir, 'src', 'new.js'), 'utf8');
        expect(written).toBe('const x = 1;');
      });

      it('overwrites existing file', async () => {
        await fileService.writeFile(tmpDir, 'src/index.js', 'updated');

        const content = fs.readFileSync(path.join(tmpDir, 'src', 'index.js'), 'utf8');
        expect(content).toBe('updated');
      });

      it('throws for disallowed file extension', async () => {
        await expect(fileService.writeFile(tmpDir, 'bad.exe', 'payload'))
          .rejects.toThrow('File type not allowed');
      });

      it('throws when parent directory does not exist', async () => {
        await expect(fileService.writeFile(tmpDir, 'missing/dir/file.js', 'content'))
          .rejects.toThrow('Directory not found');
      });
    });

    describe('listDirectory', () => {
      it('lists files and directories', async () => {
        const items = await fileService.listDirectory(tmpDir, '');

        const names = items.map(i => i.name);
        expect(names).toContain('src');
        expect(names).toContain('README.md');
      });

      it('sorts directories before files', async () => {
        const items = await fileService.listDirectory(tmpDir, '');
        const dirIndex = items.findIndex(i => i.name === 'src');
        const fileIndex = items.findIndex(i => i.name === 'README.md');
        expect(dirIndex).toBeLessThan(fileIndex);
      });

      it('hides dotfiles', async () => {
        fs.writeFileSync(path.join(tmpDir, '.hidden'), 'secret', 'utf8');
        const items = await fileService.listDirectory(tmpDir, '');

        const names = items.map(i => i.name);
        expect(names).not.toContain('.hidden');
      });

      it('throws for nonexistent directory', async () => {
        await expect(fileService.listDirectory(tmpDir, 'nope'))
          .rejects.toThrow('Directory not found');
      });

      it('returns type and size for files', async () => {
        const items = await fileService.listDirectory(tmpDir, '');
        const readme = items.find(i => i.name === 'README.md');

        expect(readme.type).toBe('file');
        expect(readme.size).toBeGreaterThan(0);

        const src = items.find(i => i.name === 'src');
        expect(src.type).toBe('directory');
      });
    });

    describe('renameFile', () => {
      it('renames a file', async () => {
        const newRelPath = await fileService.renameFile(tmpDir, 'README.md', 'DOCS.md');

        expect(newRelPath).toBe('DOCS.md');
        expect(fs.existsSync(path.join(tmpDir, 'DOCS.md'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'README.md'))).toBe(false);
      });

      it('rejects names with path separators', async () => {
        await expect(fileService.renameFile(tmpDir, 'README.md', 'sub/bad.md'))
          .rejects.toThrow('Name cannot contain path separators');
      });

      it('rejects disallowed extension for files', async () => {
        await expect(fileService.renameFile(tmpDir, 'README.md', 'readme.exe'))
          .rejects.toThrow('File type not allowed');
      });

      it('throws when target already exists', async () => {
        fs.writeFileSync(path.join(tmpDir, 'existing.md'), 'taken', 'utf8');
        await expect(fileService.renameFile(tmpDir, 'README.md', 'existing.md'))
          .rejects.toThrow('already exists');
      });

      it('throws for nonexistent source', async () => {
        await expect(fileService.renameFile(tmpDir, 'ghost.md', 'new.md'))
          .rejects.toThrow();
      });
    });

    describe('moveFile', () => {
      it('moves a file to a subdirectory', async () => {
        const newRelPath = await fileService.moveFile(tmpDir, 'README.md', 'src');

        expect(newRelPath).toBe(path.join('src', 'README.md'));
        expect(fs.existsSync(path.join(tmpDir, 'src', 'README.md'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'README.md'))).toBe(false);
      });

      it('throws when destination is not a directory', async () => {
        await expect(fileService.moveFile(tmpDir, 'README.md', 'src/index.js'))
          .rejects.toThrow('Destination must be a directory');
      });

      it('throws when file already exists at destination', async () => {
        fs.writeFileSync(path.join(tmpDir, 'src', 'README.md'), 'conflict', 'utf8');
        await expect(fileService.moveFile(tmpDir, 'README.md', 'src'))
          .rejects.toThrow('already exists');
      });

      it('prevents moving directory into itself', async () => {
        fs.mkdirSync(path.join(tmpDir, 'src', 'sub'));
        await expect(fileService.moveFile(tmpDir, 'src', 'src/sub'))
          .rejects.toThrow('Cannot move a directory into itself');
      });
    });

    describe('createDirectory', () => {
      it('creates a new directory', async () => {
        const relPath = await fileService.createDirectory(tmpDir, '', 'newdir');

        expect(relPath).toBe('newdir');
        expect(fs.statSync(path.join(tmpDir, 'newdir')).isDirectory()).toBe(true);
      });

      it('throws when directory already exists', async () => {
        await expect(fileService.createDirectory(tmpDir, '', 'src'))
          .rejects.toThrow('Directory already exists');
      });

      it('throws when parent does not exist', async () => {
        await expect(fileService.createDirectory(tmpDir, 'nonexistent', 'child'))
          .rejects.toThrow();
      });

      it('rejects names with path separators', async () => {
        await expect(fileService.createDirectory(tmpDir, '', 'a/b'))
          .rejects.toThrow('Name cannot contain path separators');
      });
    });
  });
});
