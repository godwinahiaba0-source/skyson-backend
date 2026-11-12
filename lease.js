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

// Helper function to auto-distribute daily earnings exactly once per 24 hours
async function processUserEarnings(userId, connection) {
  // Fetch active leases for the user
  const [leases] = await connection.query('SELECT * FROM leases WHERE user_id = ? FOR UPDATE', [userId]);

  for (const lease of leases) {
    if (!lease.last_claim_time) continue;

    const lastClaim = new Date(lease.last_claim_time);
    const now = new Date();
    const dailyIncome = parseFloat(lease.daily_income);

    // Calculate hours passed since last claim
    const hoursPassed = (now - lastClaim) / (1000 * 60 * 60);

    // Credit ONLY ONCE if 24 hours have passed
    if (hoursPassed >= 24) {
      // 1. Add daily income directly to withdrawable balance
      await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [dailyIncome, userId]);

      // 2. Log transaction history for automated earnings
      await connection.query(
        'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
        [userId, 'earnings', `Automated Daily Income (${lease.plan_name})`, dailyIncome, 'success']
      );

      // 3. Update last_claim_time to NOW() so it won't trigger again for another 24 hours
      await connection.query('UPDATE leases SET last_claim_time = NOW() WHERE id = ?', [lease.id]);
    }
  }
}

// Buy Lease (Deducts strictly from deposit_balance & distributes multi-tier referral bonuses)
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
    
    // Create active lease record with last_claim_time set to NOW() so countdown begins immediately
    await connection.query(
      'INSERT INTO leases (user_id, plan_name, price, daily_income, duration, last_claim_time) VALUES (?, ?, ?, ?, ?, NOW())',
      [req.user.id, plan_name, planPrice, daily_income, duration]
    );

    // Log transaction history for the buyer
    await connection.query(
      'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'recharge', `Leased ${plan_name}`, -planPrice, 'success']
    );

    // ==========================================
    // MULTI-TIER REFERRAL COMMISSION PAYOUT
    // Level 1: 8%, Level 2: 3%, Level 3: 1%
    // ==========================================
    const percentages = {
      1: 0.08,
      2: 0.03,
      3: 0.01
    };

    const [ancestors] = await connection.query(
      'SELECT ancestor_user_id, level FROM team_referrals WHERE descendant_user_id = ? AND level BETWEEN 1 AND 3',
      [req.user.id]
    );

    for (const ancestor of ancestors) {
      const rate = percentages[ancestor.level];
      if (rate) {
        const bonusAmount = planPrice * rate;

        if (bonusAmount > 0) {
          // Credit ancestor's withdrawable balance
          await connection.query(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [bonusAmount, ancestor.ancestor_user_id]
          );

          // Log transaction for the ancestor
          await connection.query(
            'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
            [
              ancestor.ancestor_user_id,
              'earnings',
              `Level ${ancestor.level} Referral Commission from User #${req.user.id} (${plan_name})`,
              bonusAmount,
              'success'
            ]
          );
        }
      }
    }
    // ==========================================

    await connection.commit();
    connection.release();

    res.json({ message: `Successfully leased ${plan_name}! Daily revenue will now auto-credit to your withdrawable balance.` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Lease purchase error:', err);
    res.status(500).json({ message: 'Error completing lease purchase.', error: err.message });
  }
});

// Get My Leases (Automatically checks and processes daily earnings strictly once per 24h)
router.get('/my-leases', verifyToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Automatically process pending daily earnings once per 24 hours
    await processUserEarnings(req.user.id, connection);

    await connection.commit();

    const [leases] = await connection.query('SELECT * FROM leases WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    connection.release();
    res.json({ leases });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Error fetching leases:', err);
    res.status(500).json({ message: 'Error fetching active leases.', error: err.message });
  }
});

module.exports = router;