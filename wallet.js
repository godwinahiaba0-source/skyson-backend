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

// GET /api/bankcard - Check if user already has a bound card
router.get('/', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM bank_cards WHERE user_id = ?', [req.user.id]);
    
    if (rows.length === 0) {
      return res.json({ card: null });
    }

    res.json({ card: rows[0] });
  } catch (err) {
    console.error('CRITICAL FETCH BANKCARD ERROR:', err);
    res.status(500).json({ message: 'Server error fetching bank card.', error: err.message });
  }
});

// POST /api/bankcard - Bind or update withdrawal card
router.post('/', verifyToken, async (req, res) => {
  try {
    console.log('BIND BANKCARD HIT WITH BODY:', req.body);
    const { channel, official_name, account_number } = req.body;

    if (!channel || !official_name || !account_number) {
      return res.status(400).json({ message: 'All fields are required.' });
    }

    const userId = req.user.id;

    // Insert or update if user already has a card in bank_cards table
    await pool.query(`
      INSERT INTO bank_cards (user_id, channel, official_name, account_number)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        channel = VALUES(channel),
        official_name = VALUES(official_name),
        account_number = VALUES(account_number)
    `, [userId, channel, official_name, account_number]);

    res.json({ message: 'Withdrawal account bound successfully!' });
  } catch (err) {
    console.error('CRITICAL BIND BANKCARD ERROR:', err);
    res.status(500).json({ message: 'Server error during account binding.', error: err.message });
  }
});

module.exports = router;