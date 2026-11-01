const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// GET Profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, email, balance, referral_code, created_at FROM users WHERE id = ?', 
      [req.user.id]
    );
    
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });
    
    let user = users[0];

    // Auto-generate referral code if missing
    if (!user.referral_code) {
      user.referral_code = `SKY${100000 + user.id}`;
      await pool.query('UPDATE users SET referral_code = ? WHERE id = ?', [user.referral_code, user.id]);
    }
    
    res.json({ user });
  } catch (err) {
    console.error('CRITICAL PROFILE ERROR:', err);
    res.status(500).json({ message: 'Error fetching profile.', error: err.message });
  }
});

// POST Profile Update (Username / Email updates)
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, email, balance, invitation_code, created_at FROM users WHERE id = ?', 
      [req.user.id]
    );
    
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });
    
    let user = users[0];

    // Auto-generate if missing in database
    if (!user.invitation_code) {
      user.invitation_code = `SKY${100000 + user.id}`;
      await pool.query('UPDATE users SET invitation_code = ? WHERE id = ?', [user.invitation_code, user.id]);
    }
    
    res.json({ user });
  } catch (err) {
    console.error('CRITICAL PROFILE ERROR:', err);
    res.status(500).json({ message: 'Error fetching profile.', error: err.message });
  }
});

module.exports = router;