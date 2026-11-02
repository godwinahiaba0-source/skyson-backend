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

// GET Profile & Dashboard Statistics
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, email, balance, deposit_balance, invitation_code, created_at FROM users WHERE id = ?', 
      [req.user.id]
    );
    
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });
    
    let user = users[0];

    if (!user.invitation_code) {
      user.invitation_code = `SKY${100000 + user.id}`;
      await pool.query('UPDATE users SET invitation_code = ? WHERE id = ?', [user.invitation_code, user.id]);
    }
    
    res.json({ 
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: parseFloat(user.balance || 0).toFixed(2),
        deposit_balance: parseFloat(user.deposit_balance || 0).toFixed(2),
        invitation_code: user.invitation_code,
        created_at: user.created_at
      } 
    });
  } catch (err) {
    console.error('CRITICAL PROFILE ERROR:', err);
    res.status(500).json({ message: 'Error fetching profile.', error: err.message });
  }
});

// Dashboard Route (Live dynamic tracking for Today's, Yesterday's, Total Deposits & Balance)
router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch user withdrawable balance and lease-only deposit balance
    const [users] = await pool.query(
      'SELECT balance, deposit_balance FROM users WHERE id = ?', 
      [userId]
    );
    
    if (users.length === 0) return res.status(404).json({ message: 'User not found.' });
    const user = users[0];

    // 2. Count active leases
    const [leaseStats] = await pool.query(
      'SELECT COUNT(*) as active_leases FROM leases WHERE user_id = ?',
      [userId]
    );

    // 3. Today's Earnings (Sum of earnings claimed TODAY from transactions)
    const [todayRows] = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as today_earnings 
      FROM transactions 
      WHERE user_id = ? AND type = 'earnings' AND DATE(created_at) = CURDATE()
    `, [userId]);

    // 4. Yesterday's Earnings (Sum of earnings claimed YESTERDAY from transactions)
    const [yesterdayRows] = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as yesterday_earnings 
      FROM transactions 
      WHERE user_id = ? AND type = 'earnings' AND DATE(created_at) = CURDATE() - INTERVAL 1 DAY
    `, [userId]);

    // 5. Total Approved Deposits Accumulation
    const [depositRows] = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_approved_deposits 
      FROM recharges 
      WHERE user_id = ? AND (status = 'approved' OR status = 'success')
    `, [userId]);

    res.json({
      success: true,
      balance: parseFloat(user.balance || 0), // Withdrawable balance
      deposit_balance: parseFloat(user.deposit_balance || 0),
      totalDeposit: parseFloat(depositRows[0].total_approved_deposits || 0), // Accumulated approved deposits
      activeLeases: leaseStats[0].active_leases || 0,
      todayEarnings: parseFloat(todayRows[0].today_earnings || 0), // Earnings claimed today
      yesterdayEarnings: parseFloat(yesterdayRows[0].yesterday_earnings || 0) // Earnings claimed yesterday
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ message: 'Error fetching dashboard stats.' });
  }
});

// POST User Withdrawal Request
router.post('/withdraw', verifyToken, async (req, res) => {
  const { amount, fundPassword, channel, accountNumber } = req.body;
  const userId = req.user.id;

  if (!amount || isNaN(amount) || amount < 50) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal amount is GH₵ 50.00.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Check user balance
    const [users] = await connection.query('SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (users.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = users[0];
    if (user.balance < amount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Insufficient balance for withdrawal.' });
    }

    // 2. Deduct balance and insert withdrawal record
    const fee = amount * 0.10;
    const netAmount = amount - fee;

    await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);

    await connection.query(
      `INSERT INTO withdrawals (user_id, amount, fee, net_amount, channel, account_number, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, fee, netAmount, channel || 'MTN', accountNumber || 'N/A']
    );

    // 3. Record transaction
    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, 'withdrawal', ?, ?, 'pending')`,
      [userId, `Withdrawal via ${channel || 'MTN'}`, amount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Withdrawal error:', err);
    res.status(500).json({ success: false, message: 'Server error processing withdrawal.' });
  }
});

// GET User Transactions (Queries exclusively from the transactions table)
// GET User Transactions (Synced live with withdrawals & recharges)
router.get('/transactions', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch raw transaction records
    const [records] = await pool.query(
      'SELECT id, type, description, amount, status, created_at as date FROM transactions WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // 2. Fetch live withdrawal statuses to ensure sync
    const [withdrawals] = await pool.query(
      'SELECT id, amount, status, created_at FROM withdrawals WHERE user_id = ?',
      [userId]
    );

    // Map live withdrawal statuses over transaction records if they match
    const syncedRecords = records.map(tx => {
      if (tx.type === 'withdrawal') {
        const match = withdrawals.find(w => Number(w.amount) === Number(tx.amount) && Math.abs(new Date(w.created_at) - new Date(tx.date)) < 120000);
        if (match) {
          if (match.status === 'approved') tx.status = 'success';
          else if (match.status === 'rejected') tx.status = 'rejected';
          else tx.status = 'pending';
        }
      }
      return tx;
    });

    res.json({ success: true, records: syncedRecords });
  } catch (err) {
    console.error('Fetch transactions error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions.', records: [] });
  }
});

// POST Profile Update
router.post('/profile', verifyToken, async (req, res) => {
  const { username, email } = req.body;
  try {
    if (username) {
      await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, req.user.id]);
    }
    if (email) {
      await pool.query('UPDATE users SET email = ? WHERE id = ?', [email, req.user.id]);
    }
    res.json({ success: true, message: 'Profile updated successfully!' });
  } catch (err) {
    console.error('CRITICAL PROFILE UPDATE ERROR:', err);
    res.status(500).json({ message: 'Error updating profile.', error: err.message });
  }
});

// GET Team Report Statistics
router.get('/team/report', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [teamSizeRows] = await pool.query(
      'SELECT COUNT(*) as count FROM team_referrals WHERE ancestor_user_id = ?',
      [userId]
    );
    const teamSize = teamSizeRows[0].count || 0;

    const [rechargeRows] = await pool.query(`
      SELECT COALESCE(SUM(d.amount), 0) as total_recharge 
      FROM deposits d
      JOIN team_referrals tr ON d.user_id = tr.descendant_user_id
      WHERE tr.ancestor_user_id = ? AND d.status = 'approved'
    `, [userId]);
    const teamRecharge = rechargeRows[0].total_recharge || 0;

    const [withdrawRows] = await pool.query(`
      SELECT COALESCE(SUM(w.amount), 0) as total_withdraw 
      FROM withdrawals w
      JOIN team_referrals tr ON w.user_id = tr.descendant_user_id
      WHERE tr.ancestor_user_id = ? AND w.status = 'approved'
    `, [userId]);
    const teamWithdraw = withdrawRows[0].total_withdraw || 0;

    res.json({
      teamRecharge,
      teamWithdraw,
      teamSize,
      firstChargeCount: 0,
      firstPushCount: teamSize,
      newTeamCount: teamSize
    });
  } catch (err) {
    console.error('Fetch team report error:', err);
    res.status(500).json({ message: 'Error fetching team report.' });
  }
});

// Shared handler for fetching team members with debugging logs
const handleFetchTeamMembers = async (req, res) => {
  try {
    console.log(`[TEAM DEBUG] Fetching team members for logged-in User ID: ${req.user.id}`);

    const [members] = await pool.query(`
      SELECT 
        u.id as user_id, 
        u.username, 
        u.email, 
        u.created_at,
        tr.level,
        (SELECT COALESCE(SUM(amount), 0) FROM recharges WHERE user_id = u.id AND status = 'approved') as total_deposited
      FROM team_referrals tr
      JOIN users u ON tr.descendant_user_id = u.id
      WHERE tr.ancestor_user_id = ?
      ORDER BY tr.level ASC, u.created_at DESC
    `, [req.user.id]);

    console.log(`[TEAM DEBUG] Found ${members.length} downline members for User ID ${req.user.id}`);
    res.json({ success: true, members });
  } catch (err) {
    console.error('Fetch team members error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch team members.', members: [] });
  }
};

router.get('/team/members', verifyToken, handleFetchTeamMembers);
router.get('/user/team/members', verifyToken, handleFetchTeamMembers);

module.exports = router;