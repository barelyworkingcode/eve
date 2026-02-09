const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const auth = require('../middleware/auth');

// Register -- VULNERABLE: No input validation, mass assignment
router.post('/register', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const user = await db.createUser({
      ...req.body,
      password_hash: hashedPassword
    });
    res.status(201).json(user);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login -- VULNERABLE: No rate limiting
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.getUserByEmail(email);

    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    res.json(user); // VULNERABLE: Leaks password_hash, api_key
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get user -- VULNERABLE: Returns all fields including sensitive data
router.get('/users/:id', auth, async (req, res) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user); // Returns password_hash, api_key, internal_notes
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Search -- VULNERABLE: SQL injection via string interpolation
router.get('/users/search', auth, async (req, res) => {
  try {
    const results = await db.query(
      `SELECT * FROM users WHERE name LIKE '%${req.query.q}%'`
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Update user -- VULNERABLE: No authorization check (any user can update any other)
router.put('/users/:id', auth, async (req, res) => {
  try {
    const updated = await db.updateUser(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
