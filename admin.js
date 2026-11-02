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

// GET All Users with safe column checking & inviter username resolution
router.get('/users', verifyAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username, u.email, u.balance, u.deposit_balance, u.vip_level, 
             COALESCE(u.status, 'active') as status, 
             COALESCE(u.is_deleted, 0) as is_deleted, 
             COALESCE(u.can_withdraw, 1) as can_withdraw, 
             u.created_at,
             ref.username as invited_by_username
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

// POST Toggle User Withdrawal Permission
router.post('/users/toggle-withdrawal', verifyAdmin, async (req, res) => {
  const { userId, enabled } = req.body;
  try {
    await pool.query('UPDATE users SET can_withdraw = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
    res.json({ success: true, message: `Withdrawal permission updated for user #${userId}` });
  } catch (err) {
    console.error('Toggle withdrawal error:', err);
    res.status(500).json({ success: false, message: 'Server error updating withdrawal status.' });
  }
});

// POST Soft Delete or Restore User Account
router.post('/users/action', verifyAdmin, async (req, res) => {
  const { userId, action } = req.body;
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

// POST Reset Bound Payment Account (Bank Card) via username or user ID
router.post('/bankcard/reset', verifyAdmin, async (req, res) => {
  const { userId, username } = req.body;
  try {
    let targetUserId = userId;
    if (!targetUserId && username) {
      const [users] = await pool.query('SELECT id FROM users WHERE username = ? OR id = ?', [username, username]);
      if (users.length > 0) targetUserId = users[0].id;
    }

    if (!targetUserId) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    await pool.query('DELETE FROM bank_cards WHERE user_id = ?', [targetUserId]);
    res.json({ success: true, message: 'Payment account details reset successfully.' });
  } catch (err) {
    console.error('Bank reset error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset bank card details.' });
  }
});

// GET User Downline Referral Tree using team_referrals table
router.get('/users/:id/referrals', verifyAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const [tree] = await pool.query(`
      SELECT u.id, u.username, u.balance, u.created_at, tr.level 
      FROM team_referrals tr
      JOIN users u ON tr.descendant_user_id = u.id
      WHERE tr.ancestor_user_id = ?
      ORDER BY tr.level ASC, tr.created_at DESC
    `, [userId]);

    res.json({ success: true, tree });
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
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [recharges] = await connection.query('SELECT * FROM recharges WHERE id = ? FOR UPDATE', [rechargeId]);
    if (recharges.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Recharge not found.' });
    }
    const recharge = recharges[0];
    await connection.query('UPDATE recharges SET status = ? WHERE id = ?', [action, rechargeId]);

    if (action === 'approved') {
      await connection.query('UPDATE users SET deposit_balance = deposit_balance + ? WHERE id = ?', [recharge.amount, recharge.user_id]);
    }
    await connection.commit();
    connection.release();
    res.json({ success: true, message: `Recharge ${action}!` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ success: false, message: 'Server error processing recharge.' });
  }
});

// GET All Withdrawals
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
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [withdrawals] = await connection.query('SELECT * FROM withdrawals WHERE id = ? FOR UPDATE', [withdrawalId]);
    if (withdrawals.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Withdrawal not found.' });
    }
    const withdrawal = withdrawals[0];
    await connection.query('UPDATE withdrawals SET status = ? WHERE id = ?', [action, withdrawalId]);

    if (action === 'rejected') {
      await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [withdrawal.amount, withdrawal.user_id]);
    }
    await connection.commit();
    connection.release();
    res.json({ success: true, message: `Withdrawal ${action}!` });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ success: false, message: 'Server error processing withdrawal.' });
  }
});

// POST Manual Balance Adjustment
router.post('/users/balance', verifyAdmin, async (req, res) => {
  const { username, balanceType, type, amount } = req.body;
  const field = balanceType === 'deposit_balance' ? 'deposit_balance' : 'balance';
  const changeAmt = parseFloat(amount) * (type === 'add' ? 1 : -1);

  try {
    const [users] = await pool.query('SELECT id FROM users WHERE username = ? OR id = ?', [username, username]);
    if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });
    
    await pool.query(`UPDATE users SET ${field} = ${field} + ? WHERE id = ?`, [changeAmt, users[0].id]);
    res.json({ success: true, message: 'Balance adjusted successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error adjusting balance.' });
  }
});

// POST Reset User Password
router.post('/users/reset-password', verifyAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  try {
    const [users] = await pool.query('SELECT id FROM users WHERE username = ? OR id = ?', [username, username]);
    if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });
    
    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, users[0].id]);
    res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error resetting password.' });
  }
});

module.exports = router;