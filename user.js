const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

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

// POST User Withdrawal Request with Fund Password, Permission & Pending Check
router.post('/withdraw', verifyToken, async (req, res) => {
  const { amount, fundPassword, channel, accountNumber } = req.body;
  const userId = req.user.id;

  if (!amount || isNaN(amount) || amount < 50) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal amount is GH₵ 50.00.' });
  }

  if (!fundPassword) {
    return res.status(400).json({ success: false, message: 'Please enter your fund password.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Fetch user balance, permissions, and password fields
    const [users] = await connection.query(
      'SELECT balance, can_withdraw, fund_password, password FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (users.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = users[0];

    // Block users with disabled withdrawals
    if (user.can_withdraw === 0 || user.can_withdraw === false) {
      await connection.rollback();
      connection.release();
      return res.status(403).json({ success: false, message: 'Withdrawal function not enabled.' });
    }

    // Block users if there is already a pending withdrawal request
    const [pendingWithdrawals] = await connection.query(
      'SELECT id FROM withdrawals WHERE user_id = ? AND status = "pending"',
      [userId]
    );

    if (pendingWithdrawals.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'You already have a pending withdrawal request. Please wait for it to be processed.' });
    }

    // 🛑 STRICT FUND PASSWORD VALIDATION
    const targetPasswordHash = user.fund_password || user.password;
    let isPasswordValid = false;

    if (targetPasswordHash && (targetPasswordHash.startsWith('$2b$') || targetPasswordHash.startsWith('$2a$'))) {
      isPasswordValid = await bcrypt.compare(fundPassword, targetPasswordHash);
    } else {
      isPasswordValid = (targetPasswordHash === fundPassword);
    }

    if (!isPasswordValid) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Incorrect fund password.' });
    }

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

// GET Team Report Statistics (Fixed Team Withdraw Query)
router.get('/team/report', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [teamSizeRows] = await pool.query(
      'SELECT COUNT(*) as count FROM team_referrals WHERE ancestor_user_id = ?',
      [userId]
    );
    const teamSize = teamSizeRows[0].count || 0;

    // Team Recharge calculation
    const [rechargeRows] = await pool.query(`
      SELECT COALESCE(SUM(r.amount), 0) as total_recharge 
      FROM recharges r
      JOIN team_referrals tr ON r.user_id = tr.descendant_user_id
      WHERE tr.ancestor_user_id = ? AND (r.status = 'approved' OR r.status = 'success')
    `, [userId]);
    const teamRecharge = rechargeRows[0].total_recharge || 0;

    // Team Withdraw calculation (Fixed to include 'success' and 'approved')
    const [withdrawRows] = await pool.query(`
      SELECT COALESCE(SUM(w.amount), 0) as total_withdraw 
      FROM withdrawals w
      JOIN team_referrals tr ON w.user_id = tr.descendant_user_id
      WHERE tr.ancestor_user_id = ? AND (w.status = 'approved' OR w.status = 'success')
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

// POST Claim Bonus Code
router.post('/claim-bonus', verifyToken, async (req, res) => {
  const { code } = req.body;
  const userId = req.user.id;

  if (!code || !code.trim()) {
    return res.status(400).json({ success: false, message: 'Please enter a valid bonus code.' });
  }

  const cleanCode = code.trim().toUpperCase();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Check if bonus code exists and lock row
    const [codes] = await connection.query(
      'SELECT * FROM bonus_codes WHERE code = ? FOR UPDATE',
      [cleanCode]
    );

    if (codes.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Invalid bonus code.' });
    }

    const bonus = codes[0];

    // 2. Ensure single-use enforcement
    if (bonus.status === 'claimed') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'This bonus code has already been claimed.' });
    }

    const bonusAmount = parseFloat(bonus.amount);

    // 3. Mark code as claimed
    await connection.query(
      'UPDATE bonus_codes SET status = "claimed", claimed_by = ?, claimed_at = NOW() WHERE id = ?',
      [userId, bonus.id]
    );

    // 4. Credit user's withdrawable balance
    await connection.query(
      'UPDATE users SET balance = balance + ? WHERE id = ?',
      [bonusAmount, userId]
    );

    // 5. Log in transaction history (shows up green as an earning)
    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status, created_at) VALUES (?, 'earnings', ?, ?, 'success', NOW())`,
      [userId, `Bonus Code Claimed (${cleanCode})`, bonusAmount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: `Successfully claimed GH₵ ${bonusAmount.toFixed(2)} bonus!` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Claim bonus error:', err);
    res.status(500).json({ success: false, message: 'Server error processing bonus claim.' });
  }
});

// POST Update Fund Password (verifying with Account Login Password)
router.post('/update-fund-password', verifyToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Account password and new PIN are required.' });
  }

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = users[0];

    // Verify against the MAIN ACCOUNT LOGIN PASSWORD
    let isPasswordValid = false;
    const storedPassword = user.password || user.password_hash;
    
    if (storedPassword && (storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2a$'))) {
      isPasswordValid = await bcrypt.compare(currentPassword, storedPassword);
    } else {
      isPasswordValid = (storedPassword === currentPassword);
    }

    if (!isPasswordValid) {
      return res.status(400).json({ success: false, message: 'Incorrect account login password.' });
    }

    // Save the new fund password hashed
    const hashedNewPin = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET fund_password = ? WHERE id = ?', [hashedNewPin, userId]);

    res.json({ success: true, message: 'Fund password updated successfully!' });
  } catch (err) {
    console.error('Update fund password error:', err);
    res.status(500).json({ success: false, message: 'Server error updating fund password.' });
  }
});

// GET Fund Summary & Active Investments
router.get('/fund/summary', verifyToken, async (tokenReq, res) => {
  const userId = tokenReq.user.id;
  try {
    // 1. Calculate total active invested amount
    const [activeRows] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as totalActive FROM fund_investments WHERE user_id = ? AND status = "active"',
      [userId]
    );
    const totalActive = parseFloat(activeRows[0].totalActive || 0);

    // 2. Calculate today's earnings from fund investments (if any)
    const [earningRows] = await pool.query(`
      SELECT COALESCE(SUM(amount * (daily_profit_percent / 100)), 0) as todayEarnings 
      FROM fund_investments 
      WHERE user_id = ? AND status = 'active'
    `, [userId]);
    const todayEarnings = parseFloat(earningRows[0].todayEarnings || 0);

    // 3. Fetch list of investments for records modal
    const [investments] = await pool.query(
      'SELECT * FROM fund_investments WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json({
      success: true,
      totalActive,
      todayEarnings,
      investments
    });
  } catch (err) {
    console.error('Fund summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch fund summary.' });
  }
});

// POST Submit New Fund Investment
router.post('/fund/invest', verifyToken, async (req, res) => {
  const { planId, amount } = req.body;
  const userId = req.user.id;

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 50) {
    return res.status(400).json({ success: false, message: 'Minimum investment amount is GH₵ 50.00.' });
  }

  // Define plans mapping matching savings.html
  const plans = {
    1: { name: '3 Days Cycle', days: 3, profitPercent: 2.0, min: 50 },
    2: { name: '7 Days Cycle', days: 7, profitPercent: 5.0, min: 100 },
    3: { name: '200 Days Cycle', days: 200, profitPercent: 250.0, min: 1000 }
  };

  const plan = plans[planId];
  if (!plan) {
    return res.status(400).json({ success: false, message: 'Invalid investment plan selected.' });
  }

  if (parsedAmount < plan.min) {
    return res.status(400).json({ success: false, message: `Minimum investment for ${plan.name} is GH₵ ${plan.min.toFixed(2)}` });
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

    const userBalance = parseFloat(users[0].balance || 0);
    if (userBalance < parsedAmount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Insufficient balance for investment.' });
    }

    // 2. Deduct user balance
    await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [parsedAmount, userId]);

    // 3. Insert fund investment record
    await connection.query(
      `INSERT INTO fund_investments (user_id, plan_id, amount, daily_profit_percent, duration_days, status) VALUES (?, ?, ?, ?, ?, 'active')`,
      [userId, planId, parsedAmount, plan.profitPercent, plan.days]
    );

    // 4. Log transaction
    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, 'investment', ?, ?, 'success')`,
      [userId, `Fund Investment (${plan.name})`, parsedAmount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Investment submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Fund investment error:', err);
    res.status(500).json({ success: false, message: 'Server error processing investment.' });
  }
});

// GET Fund Summary & Active Investments
router.get('/fund/summary', verifyToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const [activeRows] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as totalActive FROM fund_investments WHERE user_id = ? AND status = "active"',
      [userId]
    );
    const totalActive = parseFloat(activeRows[0].totalActive || 0);

    const [earningRows] = await pool.query(`
      SELECT COALESCE(SUM(amount * (daily_profit_percent / 100)), 0) as todayEarnings 
      FROM fund_investments 
      WHERE user_id = ? AND status = 'active'
    `, [userId]);
    const todayEarnings = parseFloat(earningRows[0].todayEarnings || 0);

    const [investments] = await pool.query(
      'SELECT * FROM fund_investments WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json({ success: true, totalActive, todayEarnings, investments });
  } catch (err) {
    console.error('Fund summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch fund summary.' });
  }
});

// POST Submit New Fund Investment
router.post('/fund/invest', verifyToken, async (req, res) => {
  const { planId, amount } = req.body;
  const userId = req.user.id;

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 50) {
    return res.status(400).json({ success: false, message: 'Minimum investment amount is GH₵ 50.00.' });
  }

  const plans = {
    1: { name: '3 Days Cycle', days: 3, profitPercent: 2.0, min: 50 },
    2: { name: '7 Days Cycle', days: 7, profitPercent: 5.0, min: 100 },
    3: { name: '200 Days Cycle', days: 200, profitPercent: 250.0, min: 1000 }
  };

  const plan = plans[planId];
  if (!plan) {
    return res.status(400).json({ success: false, message: 'Invalid investment plan selected.' });
  }

  if (parsedAmount < plan.min) {
    return res.status(400).json({ success: false, message: `Minimum investment for ${plan.name} is GH₵ ${plan.min.toFixed(2)}` });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [users] = await connection.query('SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (users.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const userBalance = parseFloat(users[0].balance || 0);
    if (userBalance < parsedAmount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Insufficient balance for investment.' });
    }

    await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [parsedAmount, userId]);

    await connection.query(
      `INSERT INTO fund_investments (user_id, plan_id, amount, daily_profit_percent, duration_days, status) VALUES (?, ?, ?, ?, ?, 'active')`,
      [userId, planId, parsedAmount, plan.profitPercent, plan.days]
    );

    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, 'investment', ?, ?, 'success')`,
      [userId, `Fund Investment (${plan.name})`, parsedAmount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Investment submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Fund investment error:', err);
    res.status(500).json({ success: false, message: 'Server error processing investment.' });
  }
});

module.exports = router;