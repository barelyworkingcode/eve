function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validateRegistration(req, res, next) {
  const { name, email, password } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Name must be at least 2 characters' });
  }

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  next();
}

function validateUpdateUser(req, res, next) {
  const allowed = ['name', 'email', 'avatar_url'];
  const keys = Object.keys(req.body);
  const invalid = keys.filter(k => !allowed.includes(k));

  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid fields: ${invalid.join(', ')}` });
  }

  if (req.body.email && !isValidEmail(req.body.email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  next();
}

module.exports = { isValidEmail, validateRegistration, validateUpdateUser };
