const express = require('express');
const router = express.Router();
const pool = require('./db');
const authenticateToken = require('./auth');

router.post('/claim', authenticateToken, async (req, res) => {
  const { lease_id } = req.body;
  if (!lease_id) return res.status(400).json({ message: 'Lease ID is required.' });

  try {
    const [leases] = await pool.query('SELECT * FROM leases WHERE id = ? AND user_id = ?', [lease_id, req.user.id]);
    if (leases.length === 0) return res.status(404).json({ message: 'Lease plan not found.' });

    const lease = leases[0];
    const now = new Date();
    const lastClaim = lease.last_claim_time ? new Date(lease.last_claim_time) : new Date(lease.created_at);
    const hoursPassed = (now - lastClaim) / (1000 * 60 * 60);

    if (hoursPassed < 24) {
      const hoursRemaining = Math.ceil(24 - hoursPassed);
      return res.status(400).json({ message: `Next claim available in ${hoursRemaining} hour(s).` });
    }

    await pool.query('UPDATE users SET balance = balance + ? WHERE id = ?', [lease.daily_income, req.user.id]);
    await pool.query('UPDATE leases SET last_claim_time = NOW() WHERE id = ?', [lease_id]);

    res.json({ message: `Successfully claimed ${lease.daily_income} daily revenue!`, claimedAmount: lease.daily_income });
  } catch (err) {
    res.status(500).json({ message: 'Error claiming daily revenue.', error: err.message });
  }
});

module.exports = router;