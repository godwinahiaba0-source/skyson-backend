const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// POST Admin Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  try {
    const [admins] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);

    if (admins.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials.' });
    }

    const admin = admins[0];

    let passwordMatch = false;
    if (admin.password && (admin.password.startsWith('$2b$') || admin.password.startsWith('$2a$'))) {
      passwordMatch = await bcrypt.compare(password, admin.password);
    } else {
      passwordMatch = (admin.password === password);
    }

    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials.' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: 'admin' },
      process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026',
      { expiresIn: '24h' }
    );

    res.json({ success: true, token, message: 'Login successful!' });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// Admin Verification Middleware
const verifyAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// GET Admin Overview Statistics
router.get('/stats', verifyAdmin, async (req, res) => {
  try {
    const [usersCount] = await pool.query('SELECT COUNT(*) as total FROM users');
    const [leasesCount] = await pool.query('SELECT COUNT(*) as total FROM leases');
    const [totalRecharged] = await pool.query('SELECT COALESCE(SUM(amount), 0) as total FROM recharges WHERE status = "approved"');
    const [totalWithdrawn] = await pool.query('SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = "approved"');

    res.json({
      success: true,
      stats: {
        totalUsers: usersCount[0].total,
        totalLeases: leasesCount[0].total,
        totalRecharged: parseFloat(totalRecharged[0].total),
        totalWithdrawn: parseFloat(totalWithdrawn[0].total)
      }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch admin statistics.' });
  }
});

// GET All Users with referral metrics & inviter phone
router.get('/users', verifyAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.phone, u.balance, u.deposit_balance, u.vip_level, u.status, u.is_deleted, u.can_withdraw, u.created_at,
             ref.phone as invited_by_phone
      FROM users u
      LEFT JOIN users ref ON u.invited_by = ref.id
      ORDER BY u.created_at DESC
    `);
    res.json({ success: true, users });
  } catch (err) {
    console.error('Admin users fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch users.' });
  }
});

// POST Toggle User Withdrawal Permission (Enable/Disable)
router.post('/users/toggle-withdrawal', verifyAdmin, async (req, res) => {
  const { userId, enabled } = req.body;
  if (userId === undefined || enabled === undefined) {
    return res.status(400).json({ success: false, message: 'Invalid parameters.' });
  }

  try {
    await pool.query('UPDATE users SET can_withdraw = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
    res.json({ success: true, message: `Withdrawal permission ${enabled ? 'enabled' : 'disabled'} for user #${userId}` });
  } catch (err) {
    console.error('Toggle withdrawal error:', err);
    res.status(500).json({ success: false, message: 'Server error updating withdrawal status.' });
  }
});

// POST Soft Delete or Restore User Account
router.post('/users/action', verifyAdmin, async (req, res) => {
  const { userId, action } = req.body;
  if (!userId || !['delete', 'restore'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid parameters.' });
  }

  try {
    const isDeleted = action === 'delete' ? 1 : 0;
    const statusStr = action === 'delete' ? 'deleted' : 'active';

    await pool.query('UPDATE users SET is_deleted = ?, status = ? WHERE id = ?', [isDeleted, statusStr, userId]);
    res.json({ success: true, message: `User account successfully ${action}d!` });
  } catch (err) {
    console.error('User action error:', err);
    res.status(500).json({ success: false, message: 'Server error processing user action.' });
  }
});

// GET User Downline Referral Tree (Level 1, 2, 3)
router.get('/users/:id/referrals', verifyAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    // Fetch Level 1 referrals
    const [lvl1] = await pool.query('SELECT id, phone, balance, created_at FROM users WHERE invited_by = ?', [userId]);
    
    let allTree = [];
    for (let u1 of lvl1) {
      allTree.push({ ...u1, level: 1 });
      // Fetch Level 2 referrals
      const [lvl2] = await pool.query('SELECT id, phone, balance, created_at FROM users WHERE invited_by = ?', [u1.id]);
      for (let u2 of lvl2) {
        allTree.push({ ...u2, level: 2 });
        // Fetch Level 3 referrals
        const [lvl3] = await pool.query('SELECT id, phone, balance, created_at FROM users WHERE invited_by = ?', [u2.id]);
        for (let u3 of lvl3) {
          allTree.push({ ...u3, level: 3 });
        }
      }
    }

    res.json({ success: true, tree: allTree });
  } catch (err) {
    console.error('Fetch referral tree error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch referral tree.' });
  }
});

// GET Recharges
router.get('/recharges', verifyAdmin, async (req, res) => {
  try {
    const [recharges] = await pool.query(`
      SELECT r.id, r.user_id, u.username, r.amount, r.channel, r.reference, r.proof_image, r.status, r.created_at 
      FROM recharges r 
      JOIN users u ON r.user_id = u.id 
      ORDER BY r.created_at DESC
    `);
    res.json({ success: true, recharges });
  } catch (err) {
    console.error('Admin recharges fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch recharges.' });
  }
});

// POST Approve or Reject Recharge
router.post('/recharge/action', verifyAdmin, async (req, res) => {
  const { rechargeId, action } = req.body;
  if (!rechargeId || !['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid parameters.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [recharges] = await connection.query('SELECT * FROM recharges WHERE id = ? FOR UPDATE', [rechargeId]);
    if (recharges.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Recharge record not found.' });
    }

    const recharge = recharges[0];
    if (recharge.status === 'approved' || recharge.status === 'rejected') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: `Recharge is already ${recharge.status}.` });
    }

    await connection.query('UPDATE recharges SET status = ? WHERE id = ?', [action, rechargeId]);

    const refCode = recharge.reference || recharge.channel || 'Manual';

    if (action === 'approved') {
      await connection.query('UPDATE users SET deposit_balance = deposit_balance + ? WHERE id = ?', [recharge.amount, recharge.user_id]);
      await connection.query(
        'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
        [recharge.user_id, 'recharge', `Recharge (${refCode})`, recharge.amount, 'success']
      );
    } else {
      await connection.query(
        'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
        [recharge.user_id, 'recharge', `Recharge (${refCode})`, recharge.amount, 'failed']
      );
    }

    await connection.commit();
    connection.release();

    res.json({ success: true, message: `Recharge successfully ${action}!` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Recharge action error:', err);
    res.status(500).json({ success: false, message: 'Server error processing recharge.' });
  }
});

// GET All Withdrawals for Admin Panel (joined with bank_cards to get official_name)
router.get('/withdrawals', verifyAdmin, async (req, res) => {
  try {
    const [withdrawals] = await pool.query(`
      SELECT w.*, u.username, u.email, bc.official_name, bc.channel as card_channel 
      FROM withdrawals w
      LEFT JOIN users u ON w.user_id = u.id
      LEFT JOIN bank_cards bc ON w.user_id = bc.user_id
      ORDER BY w.created_at DESC
    `);
    res.json({ success: true, withdrawals });
  } catch (err) {
    console.error('Admin fetch withdrawals error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch withdrawals.' });
  }
});

// POST Approve or Reject Withdrawal
router.post('/withdrawal/action', verifyAdmin, async (req, res) => {
  const { withdrawalId, action } = req.body;
  if (!withdrawalId || !['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid parameters.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [withdrawals] = await connection.query('SELECT * FROM withdrawals WHERE id = ? FOR UPDATE', [withdrawalId]);
    if (withdrawals.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
    }

    const withdrawal = withdrawals[0];
    if (withdrawal.status === 'approved' || withdrawal.status === 'rejected') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: `Withdrawal is already ${withdrawal.status}.` });
    }

    // Update status
    await connection.query('UPDATE withdrawals SET status = ? WHERE id = ?', [action, withdrawalId]);

    // Update transaction log
    await connection.query(
      'UPDATE transactions SET status = ? WHERE user_id = ? AND type = "withdrawal" AND amount = ? AND status = "pending" ORDER BY created_at DESC LIMIT 1',
      [action === 'approved' ? 'success' : 'failed', withdrawal.user_id, withdrawal.amount]
    );

    // If rejected, refund user's withdrawable balance
    if (action === 'rejected') {
      await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [withdrawal.amount, withdrawal.user_id]);
    }

    await connection.commit();
    connection.release();

    res.json({ success: true, message: `Withdrawal successfully ${action}!` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Withdrawal action error:', err);
    res.status(500).json({ success: false, message: 'Server error processing withdrawal.' });
  }
});

// POST Manual Balance Adjustment
router.post('/users/balance', verifyAdmin, async (req, res) => {
  const { username, balanceType, type, amount } = req.body;
  if (!username || !balanceType || !type || !amount || isNaN(amount)) {
    return res.status(400).json({ success: false, message: 'Invalid parameters.' });
  }

  const field = balanceType === 'deposit_balance' ? 'deposit_balance' : 'balance';
  const multiplier = type === 'add' ? 1 : -1;
  const changeAmt = parseFloat(amount) * multiplier;

  try {
    const [users] = await pool.query('SELECT id, balance, deposit_balance FROM users WHERE username = ? OR id = ?', [username, username]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const user = users[0];

    await pool.query(`UPDATE users SET ${field} = ${field} + ? WHERE id = ?`, [changeAmt, user.id]);
    
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [user.id, 'admin_adjustment', `Bonus Rewards`, changeAmt, 'success']
    );

    res.json({ success: true, message: `Successfully adjusted user balance!` });
  } catch (err) {
    console.error('Balance adjustment error:', err);
    res.status(500).json({ success: false, message: 'Server error adjusting balance.' });
  }
});

// POST Reset User Password
router.post('/users/reset-password', verifyAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  
  if (!username || !newPassword || newPassword.trim().length < 8) {
    return res.status(400).json({ success: false, message: 'Valid username and new password (min 8 chars) required.' });
  }

  const cleanPassword = newPassword.trim();

  try {
    const [users] = await pool.query('SELECT id, username FROM users WHERE username = ? OR id = ?', [username, username]);
    
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }
    
    const user = users[0];
    const hashedPassword = await bcrypt.hash(cleanPassword, 10);

    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id]);

    res.json({ success: true, message: `Password successfully updated for user "${user.username}"!` });
  } catch (err) {
    console.error('Password reset error:', err);
    res.status(500).json({ success: false, message: 'Server error resetting password.' });
  }
});

module.exports = router;