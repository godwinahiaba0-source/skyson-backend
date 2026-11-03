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

// GET Fund Summary & Active Investments (Linked to wealth_plans table)
router.get('/summary', verifyToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const [activeRows] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as totalActive FROM fund_investments WHERE user_id = ? AND status = "active"',
      [userId]
    );
    const totalActive = parseFloat(activeRows[0].totalActive || 0);

    const [earningRows] = await pool.query(`
      SELECT COALESCE(SUM(fi.amount * (wp.daily_profit_percentage / 100)), 0) as todayEarnings 
      FROM fund_investments fi
      JOIN wealth_plans wp ON fi.plan_id = wp.plan_id
      WHERE fi.user_id = ? AND fi.status = 'active'
    `, [userId]);
    const todayEarnings = parseFloat(earningRows[0].todayEarnings || 0);

    const [investments] = await pool.query(
      'SELECT fi.*, wp.plan_name FROM fund_investments fi LEFT JOIN wealth_plans wp ON fi.plan_id = wp.plan_id WHERE fi.user_id = ? ORDER BY fi.created_at DESC',
      [userId]
    );

    res.json({ success: true, totalActive, todayEarnings, investments });
  } catch (err) {
    console.error('Fund summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch fund summary.' });
  }
});

// POST Submit New Fund Investment (Linked to wealth_plans table)
router.post('/invest', verifyToken, async (req, res) => {
  const { planId, amount } = req.body;
  const userId = req.user.id;

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 50) {
    return res.status(400).json({ success: false, message: 'Minimum investment amount is GH₵ 50.00.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [plans] = await connection.query('SELECT * FROM wealth_plans WHERE plan_id = ?', [planId]);
    if (plans.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Invalid investment plan selected.' });
    }

    const plan = plans[0];
    const minAmt = parseFloat(plan.min_amount || 50);

    if (parsedAmount < minAmt) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: `Minimum investment for ${plan.plan_name} is GH₵ ${minAmt.toFixed(2)}` });
    }

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

    const days = parseInt(plan.duration_days || 3);
    const profitPercent = parseFloat(plan.daily_profit_percentage || 2.0);
    const totalReturn = parsedAmount + (parsedAmount * (profitPercent / 100) * days);

    await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [parsedAmount, userId]);

    await connection.query(
      `INSERT INTO fund_investments (user_id, plan_id, plan_name, amount, days, profit_percent, total_return, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [userId, planId, plan.plan_name, parsedAmount, days, profitPercent, totalReturn]
    );

    await connection.query(
      `INSERT INTO transactions (user_id, type, description, amount, status) VALUES (?, 'investment', ?, ?, 'success')`,
      [userId, `Fund Investment (${plan.plan_name})`, parsedAmount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Investment submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Fund investment error:', err);
    res.status(500).json({ success: false, message: 'Server error processing investment: ' + err.message });
  }
});

module.exports = router;