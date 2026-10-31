const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authenticateToken = require('../middleware/auth');

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, phone, balance, created_at FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });
    res.json({ user: users[0] });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching profile.', error: err.message });
  }
});

module.exports = router;