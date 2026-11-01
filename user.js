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
      'SELECT user_id AS id, username, email, balance, invitation_code, created_at FROM users WHERE user_id = ?', 
      [req.user.id]
    );
    
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });
    
    let user = users[0];

    // Auto-generate invitation_code if missing
    if (!user.invitation_code) {
      user.invitation_code = `SKY${100000 + user.id}`;
      await pool.query('UPDATE users SET invitation_code = ? WHERE user_id = ?', [user.invitation_code, user.id]);
    }
    
    res.json({ user });
  } catch (err) {
    console.error('CRITICAL PROFILE ERROR:', err);
    res.status(500).json({ message: 'Error fetching profile.', error: err.message });
  }
});

// POST Profile Update
router.post('/profile', verifyToken, async (req, res) => {
  const { username, email } = req.body;
  try {
    if (username) {
      await pool.query('UPDATE users SET username = ? WHERE user_id = ?', [username, req.user.id]);
    }
    if (email) {
      await pool.query('UPDATE users SET email = ? WHERE user_id = ?', [email, req.user.id]);
    }
    res.json({ success: true, message: 'Profile updated successfully!' });
  } catch (err) {
    console.error('CRITICAL PROFILE UPDATE ERROR:', err);
    res.status(500).json({ message: 'Error updating profile.', error: err.message });
  }
});

// Get user's team members / referrals by level
router.get('/user/team/members', verifyToken, async (req, res) => {
  try {
    const [members] = await pool.query(`
      SELECT 
        u.user_id, 
        u.username, 
        u.email, 
        u.created_at,
        tr.level,
        (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE user_id = u.user_id AND status = 'approved') as total_deposited
      FROM team_referrals tr
      JOIN users u ON tr.descendant_user_id = u.user_id
      WHERE tr.ancestor_user_id = ?
      ORDER BY tr.level ASC, u.created_at DESC
    `, [req.user.id]);

    res.json({ success: true, members });
  } catch (err) {
    console.error('Fetch team members error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch team members.' });
  }
});

module.exports = router;