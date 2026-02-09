# Greenfield Platform API

Analytics platform backend for Greenfield Ventures.

## Setup

```bash
npm install
cp .env.example .env  # Configure database and Redis
npm run dev
```

## Architecture

- Express REST API with PostgreSQL
- Session-based auth (migrating to JWT)
- Redis for session store and caching

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /register | No | Create account |
| POST | /login | No | Authenticate |
| GET | /users/:id | Yes | Get user profile |
| PUT | /users/:id | Yes | Update profile |
| GET | /users/search | Yes | Search users |
| GET | /analytics/dashboard | Yes | Dashboard data |
| POST | /analytics/query | Yes | Custom query |
