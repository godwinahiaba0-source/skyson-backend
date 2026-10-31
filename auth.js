const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = './db'; // handled via server or passed down, let's use db directly
const pool = require('./db');

// Register
router.post('/register', async (req, res) => {
  const { phone, password, invitation_code } = req.body;
  if (!phone || !password) return res.status(400).json({ message: 'Phone and password are required.' });

  try {
    const [existing] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (existing.length > 0) return res.status(400).json({ message: 'Phone number already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (phone, password, invitation_code) VALUES (?, ?, ?)',
      [phone, hashedPassword, invitation_code || null]
    );

    const token = jwt.sign({ id: result.insertId, phone }, process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026', { expiresIn: '7d' });
    res.status(201).json({ message: 'User registered successfully!', token, userId: result.insertId });
  } catch (err) {
    res.status(500).json({ message: 'Server error during registration.', error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ message: 'Phone and password are required.' });

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (users.length === 0) return res.status(400).json({ message: 'Invalid phone or password.' });

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ message: 'Invalid phone or password.' });

    const token = jwt.sign({ id: user.id, phone: user.phone }, process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026', { expiresIn: '7d' });
    res.json({ message: 'Login successful!', token, user: { id: user.id, phone: user.phone, balance: user.balance } });
  } catch (err) {
    res.status(500).json({ message: 'Server error during login.', error: err.message });
  }
});

module.exports = router;