const express = require('express');
const router = express.Router();
const pool = require('./db');
const jwt = require('jsonwebtoken');

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

// GET All Users List
router.get('/users', verifyAdmin, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, username, email, balance, deposit_balance, invitation_code, created_at FROM users ORDER BY created_at DESC');
    res.json({ success: true, users });
  } catch (err) {
    console.error('Admin users fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch users.' });
  }
});

// GET Recharges from the 'recharges' table
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
  const { rechargeId, action } = req.body; // action: 'approved' or 'rejected'
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

    // Update recharge status in the recharges table
    await connection.query('UPDATE recharges SET status = ? WHERE id = ?', [action, rechargeId]);

    const refCode = recharge.reference || recharge.channel || 'Manual';

    if (action === 'approved') {
      // Credit user's deposit_balance (lease-only funds)
      await connection.query('UPDATE users SET deposit_balance = deposit_balance + ? WHERE id = ?', [recharge.amount, recharge.user_id]);
      
      // Log successful transaction with clean format: Recharge (reference)
      await connection.query(
        'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
        [recharge.user_id, 'recharge', `Recharge (${refCode})`, recharge.amount, 'success']
      );
    } else {
      // Log rejected transaction with red status support
      await connection.query(
        'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
        [recharge.user_id, 'recharge', `Recharge (${refCode})`, recharge.amount, 'rejected']
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
    
    // Log transaction history
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, ?, ?, ?, ?)',
      [user.id, 'admin_adjustment', `Admin ${type} GH₵ ${parseFloat(amount).toFixed(2)} to ${field}`, changeAmt, 'success']
    );

    res.json({ success: true, message: `Successfully adjusted user balance!` });
  } catch (err) {
    console.error('Balance adjustment error:', err);
    res.status(500).json({ success: false, message: 'Server error adjusting balance.' });
  }
});

// POST Reset User Password
// POST Reset User Password
router.post('/users/reset-password', verifyAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  
  if (!username || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, message: 'Valid username and new password (min 8 chars) required.' });
  }

  try {
    const [users] = await pool.query('SELECT id, username FROM users WHERE username = ? OR id = ?', [username, username]);
    
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }
    
    const user = users[0];

    // Updates the stored password column in your MySQL database
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [newPassword, user.id]);

    res.json({ success: true, message: `Password successfully updated for user "${user.username}"!` });
  } catch (err) {
    console.error('Password reset error:', err);
    res.status(500).json({ success: false, message: 'Server error updating password.' });
  }
});

module.exports = router;