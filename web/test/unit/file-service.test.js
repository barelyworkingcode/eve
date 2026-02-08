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
});
