const fs = require('fs');
const path = require('path');

class SessionStore {
  constructor(dataDir) {
    this.sessionsDir = path.join(dataDir, 'sessions');
    this.ensureDirectory();
  }

  ensureDirectory() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  getFilePath(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  load(sessionId) {
    try {
      const filePath = this.getFilePath(sessionId);
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`Error loading session ${sessionId}:`, err);
      return null;
    }
  }

  save(session) {
    try {
      const sessionData = {
        sessionId: session.sessionId,
        projectId: session.projectId || null,
        name: session.name || null,
        directory: session.directory,
        model: session.model,
        createdAt: session.createdAt,
        messages: session.messages || [],
        stats: session.stats || {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0
        },
        providerState: session.providerState || null
      };

      const filePath = this.getFilePath(session.sessionId);
      fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
    } catch (err) {
      console.error(`Error saving session ${session.sessionId}:`, err);
    }
  }

  delete(sessionId) {
    try {
      const filePath = this.getFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error(`Error deleting session ${sessionId}:`, err);
    }
  }

  loadAll() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        return [];
      }

      const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
      const sessions = [];

      for (const file of files) {
        const filePath = path.join(this.sessionsDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          sessions.push({
            sessionId: data.sessionId,
            projectId: data.projectId,
            name: data.name || null,
            directory: data.directory,
            model: data.model,
            createdAt: data.createdAt,
            stats: data.stats,
            messages: data.messages || [],
            providerState: data.providerState || null
          });
        } catch (err) {
          console.error(`Error loading session file ${file}:`, err);
        }
      }

      return sessions;
    } catch (err) {
      console.error('Error loading all sessions:', err);
      return [];
    }
  }
}

module.exports = SessionStore;
