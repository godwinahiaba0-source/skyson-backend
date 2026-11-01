const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');

// Token verification middleware
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

// Buy Lease (Deducts strictly from deposit_balance & sets last_claim_time to NULL)
router.post('/buy', verifyToken, async (req, res) => {
  const { plan_name, price, daily_income, duration } = req.body;
  if (!plan_name || !price || !daily_income || !duration) {
    return res.status(400).json({ message: 'All plan details are required.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Check if user already owns this exact plan
    const [existingLease] = await connection.query(
      'SELECT id FROM leases WHERE user_id = ? AND plan_name = ?',
      [req.user.id, plan_name]
    );

    if (existingLease.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ message: `You have already leased ${plan_name}. Each plan can only be purchased once.` });
    }

    // Check user's deposit_balance (lease-only funds)
    const [users] = await connection.query('SELECT deposit_balance FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
    if (users.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: 'User not found.' });
    }

    const depositBalance = parseFloat(users[0].deposit_balance || 0);
    const planPrice = parseFloat(price);

    if (depositBalance < planPrice) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ 
        message: `Insufficient lease-only deposit balance. You need GH₵ ${planPrice.toFixed(2)} but have GH₵ ${depositBalance.toFixed(2)}.` 
      });
    }

    // Deduct from deposit_balance
    await connection.query('UPDATE users SET deposit_balance = deposit_balance - ? WHERE id = ?', [planPrice, req.user.id]);
    
    // Create active lease record with last_claim_time set to NULL (unclaimed state)
    await connection.query(
      'INSERT INTO leases (user_id, plan_name, price, daily_income, duration, last_claim_time) VALUES (?, ?, ?, ?, ?, NULL)',
      [req.user.id, plan_name, planPrice, daily_income, duration]
    );

    // Log transaction history
    await connection.query(
      'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'recharge', `Leased ${plan_name}`, -planPrice, 'success']
    );

    await connection.commit();
    connection.release();

    res.json({ message: `Successfully leased ${plan_name}! Daily revenue is ready to claim.` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Lease purchase error:', err);
    res.status(500).json({ message: 'Error completing lease purchase.', error: err.message });
  }
});

// Claim Daily Income (Strictly 1 claim allowed per product lease)
router.post('/claim', verifyToken, async (req, res) => {
  const { leaseId } = req.body;
  if (!leaseId) {
    return res.status(400).json({ message: 'Lease ID is required.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [leases] = await connection.query('SELECT * FROM leases WHERE id = ? AND user_id = ? FOR UPDATE', [leaseId, req.user.id]);
    if (leases.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: 'Active lease not found.' });
    }

    const lease = leases[0];

    // Check if this product has already been claimed (if last_claim_time is NOT NULL)
    if (lease.last_claim_time !== null) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ message: 'You have already claimed the income for this product. Only one claim is allowed per lease.' });
    }

    const dailyEarnings = parseFloat(lease.daily_income);

    // 1. Add daily income directly to withdrawable balance
    await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [dailyEarnings, req.user.id]);

    // 2. Mark as claimed by setting last_claim_time timestamp
    await connection.query('UPDATE leases SET last_claim_time = NOW() WHERE id = ?', [leaseId]);

    // 3. Log transaction history for earnings claim
    await connection.query(
      'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'earnings', `Daily Income Claim (${lease.plan_name})`, dailyEarnings, 'success']
    );

    await connection.commit();
    connection.release();

    res.json({ message: `Successfully claimed GH₵ ${dailyEarnings.toFixed(2)} to your withdrawable balance!` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Claim error:', err);
    res.status(500).json({ message: 'Error processing daily claim.', error: err.message });
  }
});

// Get My Leases
router.get('/my-leases', verifyToken, async (req, res) => {
  try {
    const [leases] = await pool.query('SELECT * FROM leases WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ leases });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching active leases.', error: err.message });
  }
});

module.exports = router;