const express = require('express');
const router = express.Router();
const pool = require('./db');
const authenticateToken = require('./auth');

// Buy Lease
router.post('/buy', authenticateToken, async (req, res) => {
  const { plan_name, price, daily_income, duration } = req.body;
  if (!plan_name || !price || !daily_income || !duration) return res.status(400).json({ message: 'All plan details are required.' });

  try {
    const [users] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
    const userBalance = parseFloat(users[0].balance);

    if (userBalance < parseFloat(price)) return res.status(400).json({ message: 'Insufficient balance to purchase this lease.' });

    await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [price, req.user.id]);
    await pool.query(
      'INSERT INTO leases (user_id, plan_name, price, daily_income, duration, last_claim_time) VALUES (?, ?, ?, ?, ?, NOW())',
      [req.user.id, plan_name, price, daily_income, duration]
    );

    res.json({ message: `Successfully leased ${plan_name}! Daily revenue is ready to claim.` });
  } catch (err) {
    res.status(500).json({ message: 'Error completing lease purchase.', error: err.message });
  }
});

// Get My Leases
router.get('/my-leases', authenticateToken, async (req, res) => {
  try {
    const [leases] = await pool.query('SELECT * FROM leases WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ leases });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching active leases.', error: err.message });
  }
});

module.exports = router;