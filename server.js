require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');

const app = express();

// ==========================================
// 1. MIDDLEWARE CONFIGURATION
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname))); // Serve frontend HTML/CSS/JS

// ==========================================
// 2. DATABASE POOL CONNECTION
// ==========================================
const pool = mysql.createPool({
  host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
  user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'skysonsolar',
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Multer Setup for Proof Uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// JWT Verification Middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Access token missing or unauthorized.' });

  jwt.verify(token, process.env.JWT_SECRET || 'skyson_secret_key_2026', (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Token is invalid or expired.' });
    req.user = user;
    next();
  });
};

// ==========================================
// 3. BACKGROUND WORKER: INVESTMENT EXPIRY
// ==========================================
function initInvestmentWorker(dbPool) {
  setInterval(async () => {
    try {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();

        const [expiredInvestments] = await connection.query(
          `SELECT investment_id, user_id, expected_revenue FROM user_investments WHERE status = 'active' AND ends_at <= NOW()`
        );

        for (const inv of expiredInvestments) {
          await connection.query(
            'UPDATE users SET balance = balance + ? WHERE user_id = ?',
            [inv.expected_revenue, inv.user_id]
          );

          await connection.query(
            "UPDATE user_investments SET status = 'completed' WHERE investment_id = ?",
            [inv.investment_id]
          );

          await connection.query(
            `INSERT INTO transactions (user_id, title, category, type, amount, status, created_at) 
             VALUES (?, 'Investment Payout', 'investment', 'yield', ?, 'Completed', NOW())`,
            [inv.user_id, inv.expected_revenue]
          ).catch(() => {});
        }

        await connection.commit();
        connection.release();
      } catch (txErr) {
        await connection.rollback();
        connection.release();
      }
    } catch (err) {
      // Background worker silent catcher
    }
  }, 60 * 1000); // Runs every 1 minute
}
initInvestmentWorker(pool);


// ==========================================
// 4. AUTHENTICATION & REGISTRATION
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  const { username, phone, email, password, invitationCode } = req.body;
  const userPhone = phone || username;

  if (!userPhone || !password) {
    return res.status(400).json({ success: false, message: 'Please provide phone/username and password.' });
  }

  try {
    const [existing] = await pool.query('SELECT user_id FROM users WHERE phone = ?', [userPhone]);
    if (existing.length > 0) return res.status(400).json({ success: false, message: 'Phone number already registered.' });

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const referralCode = 'SKY' + Math.floor(1000 + Math.random() * 9000);

    const [result] = await pool.query(
      'INSERT INTO users (phone, password_hash, referral_code, balance, created_at) VALUES (?, ?, ?, 0.00, NOW())',
      [userPhone, password_hash, referralCode]
    );

    const newUserId = result.insertId;

    // Handle upline referral mapping if invitation code was supplied
    if (invitationCode) {
      const [upline] = await pool.query('SELECT user_id FROM users WHERE referral_code = ?', [invitationCode]);
      if (upline.length > 0) {
        const ancestorId = upline.user_id || upline[0].user_id;
        await pool.query(
          'INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level, created_at) VALUES (?, ?, 1, NOW())',
          [ancestorId, newUserId]
        ).catch(() => {});
      }
    }

    const token = jwt.sign({ id: newUserId, phone: userPhone }, process.env.JWT_SECRET || 'skyson_secret_key_2026', { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: newUserId, phone: userPhone, referral_code: referralCode } });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Registration failed.', details: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, phone, password } = req.body;
  const userPhone = phone || username;

  if (!userPhone || !password) {
    return res.status(400).json({ success: false, message: 'Please enter phone and password.' });
  }

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE phone = ?', [userPhone]);
    if (users.length === 0) return res.status(400).json({ success: false, message: 'Invalid phone or password.' });

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password_hash || user.password);
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid phone or password.' });

    const token = jwt.sign({ id: user.user_id, phone: user.phone }, process.env.JWT_SECRET || 'skyson_secret_key_2026', { expiresIn: '7d' });
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.user_id, 
        phone: user.phone, 
        invitationCode: user.referral_code,
        balance: user.balance 
      } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});


// ==========================================
// 5. USER PROFILE & ACCOUNT SUMMARY API
// ==========================================
app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT user_id, phone, vip_level, avatar_url, balance, fund_password, referral_code FROM users WHERE user_id = ?', 
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    
    const user = rows[0];
    res.json({ 
      success: true, 
      user: {
        id: user.user_id,
        phone: user.phone,
        vip_level: user.vip_level,
        avatar_url: user.avatar_url,
        balance: user.balance,
        hasFundPassword: user.fund_password ? true : false,
        invitationCode: user.referral_code,
        referral_code: user.referral_code
      } 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server database error' });
  }
});

app.get('/api/user/account-summary', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query('SELECT balance, referral_rebate, total_team_benefits, vip_level FROM users WHERE user_id = ?', [userId]);
    const user = rows.length > 0 ? rows[0] : { balance: 0.00, vip_level: 0 };

    const earningTypes = ['yield', 'device_payout', 'payout', 'commission', 'REFERRAL_REBATE', 'earnings'];
    const placeholders = earningTypes.map(() => '?').join(',');

    const getSum = async (dateCondition) => {
      const [resRows] = await pool.query(
        `SELECT SUM(amount) AS total FROM transactions WHERE user_id = ? AND type IN (${placeholders}) AND amount > 0 ${dateCondition}`,
        [userId, ...earningTypes]
      ).catch(() => [{ total: 0 }]);
      return resRows[0]?.total || 0.00;
    };

    const todayEarnings = await getSum(`AND DATE(created_at) = CURDATE()`);
    const yesterdayEarnings = await getSum(`AND DATE(created_at) = CURDATE() - INTERVAL 1 DAY`);

    res.json({
      success: true,
      data: {
        balance: user.balance,
        vipLevel: user.vip_level,
        yesterdayEarnings: parseFloat(yesterdayEarnings).toFixed(2),
        todayEarnings: parseFloat(todayEarnings).toFixed(2)
      },
      balance: user.balance,
      todayEarnings: parseFloat(todayEarnings).toFixed(2),
      yesterdayEarnings: parseFloat(yesterdayEarnings).toFixed(2),
      totalDeposit: 0.00
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ==========================================
// 6. BANK CARDS & WITHDRAWAL ACCOUNTS
// ==========================================
app.get('/api/bankcard', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT channel, official_name, account_number FROM bank_cards WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, card: rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching bank card' });
  }
});

app.post('/api/bankcard', verifyToken, async (req, res) => {
  const { channel, official_name, account_number } = req.body;
  try {
    await pool.query(
      'REPLACE INTO bank_cards (user_id, channel, official_name, account_number) VALUES (?, ?, ?, ?)',
      [req.user.id, channel, official_name, account_number]
    );
    res.json({ success: true, message: 'Withdrawal account bound successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to bind account' });
  }
});


// ==========================================
// 7. TEAM REPORT & DOWNLINES CONTROLLER
// ==========================================
app.get('/api/team/report', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const connection = await pool.getConnection();
  try {
    const [referralRows] = await connection.execute(
      `SELECT descendant_user_id, level FROM team_referrals WHERE ancestor_user_id = ? AND level IN (1, 2, 3)`,
      [userId]
    );

    const level1Ids = referralRows.filter(r => r.level === 1).map(r => r.descendant_user_id);
    const allTeamIds = referralRows.map(r => r.descendant_user_id);
    const totalTeamSize = allTeamIds.length;

    let totalTeamRecharge = 0;
    let totalTeamWithdraw = 0;
    let totalFirstChargeCount = 0;

    if (allTeamIds.length > 0) {
      const placeholders = allTeamIds.map(() => '?').join(',');

      const [globalRecharge] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
        allTeamIds
      );
      totalTeamRecharge = parseFloat(globalRecharge[0].total || 0);

      const [globalWithdraw] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE user_id IN (${placeholders}) AND status = 'approved'`,
        allTeamIds
      );
      totalTeamWithdraw = parseFloat(globalWithdraw[0].total || 0);

      const [firstCharge] = await connection.execute(
        `SELECT COUNT(DISTINCT user_id) as cnt FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
        allTeamIds
      );
      totalFirstChargeCount = parseInt(firstCharge[0].cnt || 0, 10);
    }

    let downlines = [];
    if (level1Ids.length > 0) {
      const placeholders = level1Ids.map(() => '?').join(',');
      const [dRows] = await connection.execute(
        `SELECT phone as username, CONCAT(phone, '@skyson.com') as email, created_at FROM users WHERE user_id IN (${placeholders}) ORDER BY created_at DESC`,
        level1Ids
      );
      downlines = dRows;
    }

    res.json({
      success: true,
      teamRecharge: totalTeamRecharge,
      firstCharges: totalFirstChargeCount,
      firstChargeCount: totalFirstChargeCount,
      teamSize: totalTeamSize,
      teamWithdraw: totalTeamWithdraw,
      firstPushCount: level1Ids.length,
      newTeamCount: totalTeamSize,
      downlines
    });
  } catch (err) {
    console.error('Team report error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate team report' });
  } finally {
    connection.release();
  }
});


// ==========================================
// 8. RECHARGE & PAYMENT GATEWAYS
// ==========================================
app.get('/api/recharge/config', verifyToken, async (req, res) => {
  res.json({
    success: true,
    exchangeRate: 12.5,
    usdtAddress: process.env.USDT_WALLET_ADDRESS || 'TByjYGQHM4H29bngfATXPyQSepdfSKEABn',
    kbNumber: process.env.KB_NUMBER || '0248382103',
    kbName: process.env.KB_NAME || 'ANTONETTE KUMASENU',
    solNumber: process.env.SOL_NUMBER || '0504387431',
    solName: process.env.SOL_NAME || 'GODWIN K. TIMOTHY AHIABA'
  });
});

app.post('/api/recharge/submit', verifyToken, async (req, res) => {
  const { amount, channel, transactionId, reference } = req.body;
  try {
    await pool.query(
      'INSERT INTO deposits (user_id, amount, channel, transaction_id, reference, status, created_at) VALUES (?, ?, ?, ?, ?, "pending", NOW())',
      [req.user.id, amount, channel, transactionId || '', reference || '']
    ).catch(() => {});
    res.json({ success: true, message: 'Recharge request submitted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to process recharge submission' });
  }
});

app.post('/api/recharge/submit-with-proof', verifyToken, upload.single('proofImage'), async (req, res) => {
  const { amount, channel, transactionId } = req.body;
  const proofPath = req.file ? `/uploads/${req.file.filename}` : '';
  try {
    await pool.query(
      'INSERT INTO deposits (user_id, amount, channel, transaction_id, proof_image, status, created_at) VALUES (?, ?, ?, ?, ?, "pending", NOW())',
      [req.user.id, amount, channel, transactionId || '', proofPath]
    ).catch(() => {});
    res.json({ success: true, message: 'Deposit proof uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to upload deposit proof' });
  }
});


// ==========================================
// 9. LEASE & SOLAR PLANS (S1 to S8)
// ==========================================
app.get('/api/lease/my-leases', verifyToken, async (req, res) => {
  try {
    const [leases] = await pool.query('SELECT * FROM leases WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(leases);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching leases.' });
  }
});

app.post('/api/lease/create', verifyToken, async (req, res) => {
  const { planName, price, dailyIncome, duration } = req.body;
  const priceNum = parseFloat(price);

  try {
    const [users] = await pool.query('SELECT balance FROM users WHERE user_id = ?', [req.user.id]);
    if (users.length === 0 || users[0].balance < priceNum) {
      return res.status(400).json({ success: false, message: 'Insufficient balance to lease plan.' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [priceNum, req.user.id]);
    await connection.query(
      'INSERT INTO leases (user_id, plan_name, price, daily_income, duration, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [req.user.id, planName, priceNum, dailyIncome, duration]
    );
    await connection.query(
      'INSERT INTO transactions (user_id, title, category, type, amount, status, created_at) VALUES (?, ?, "lease", "lease_purchase", ?, "Completed", NOW())',
      [req.user.id, `Leased ${planName}`, -priceNum]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: `Successfully leased ${planName}!` });
  } catch (err) {
    console.error('Lease creation error:', err);
    res.status(500).json({ success: false, message: 'Lease creation failed.' });
  }
});


// ==========================================
// 10. FUND SAVINGS & WEALTH PLANS
// ==========================================
app.get('/api/fund/summary', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [investments] = await pool.query(
      `SELECT ui.*, COALESCE(wp.daily_profit_percentage, 2.00) AS daily_profit_percentage, COALESCE(wp.duration_days, 3) AS duration_days, COALESCE(wp.plan_name, 'Investment Plan') AS plan_name 
       FROM user_investments ui 
       LEFT JOIN wealth_plans wp ON ui.plan_id = wp.plan_id 
       WHERE ui.user_id = ? ORDER BY ui.started_at DESC`, 
      [userId]
    );
    
    const [users] = await pool.query('SELECT balance FROM users WHERE user_id = ?', [userId]);

    let activeInvested = 0;
    let todaysEarnings = 0;

    investments.forEach(inv => {
      if (inv.status && inv.status.toLowerCase() === 'active') {
        const invested = parseFloat(inv.invested_amount || 0);
        activeInvested += invested;
        const profitPercent = parseFloat(inv.daily_profit_percentage) || 2.00;
        const durationDays = parseInt(inv.duration_days) || 3;
        todaysEarnings += (invested * (profitPercent / 100)) / durationDays;
      }
    });

    res.json({ 
      success: true, 
      balance: users.length > 0 ? users[0].balance : 0,
      totalActive: activeInvested.toFixed(2),
      activeInvested: activeInvested.toFixed(2),
      todaysEarnings: todaysEarnings.toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching fund summary' });
  }
});

app.post('/api/fund/invest', verifyToken, async (req, res) => {
  const { amount, planId, fundId, expected_revenue, days } = req.body;
  const targetPlanId = planId || fundId || 1;
  const investAmount = parseFloat(amount);

  if (!investAmount || investAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid investment amount' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [userRows] = await connection.query('SELECT balance FROM users WHERE user_id = ? FOR UPDATE', [req.user.id]);
    if (userRows.length === 0 || parseFloat(userRows[0].balance) < investAmount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Insufficient balance for this investment' });
    }

    await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [investAmount, req.user.id]);

    const calculatedRevenue = expected_revenue || (investAmount * 1.5);
    const durationDays = parseInt(days) || 3;

    await connection.query(
      `INSERT INTO user_investments (user_id, plan_id, invested_amount, expected_revenue, status, started_at, ends_at) 
       VALUES (?, ?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [req.user.id, targetPlanId, investAmount, calculatedRevenue, durationDays]
    );

    await connection.query(
      `INSERT INTO transactions (user_id, title, category, type, amount, status, created_at) 
       VALUES (?, 'Fund Investment Purchase', 'investment', 'investment_purchase', ?, 'Completed', NOW())`,
      [req.user.id, -investAmount]
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Investment submitted successfully!' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ success: false, message: 'Server error processing investment' });
  }
});


// ==========================================
// 11. ACCOUNTING & TRANSACTIONS
// ==========================================
app.get('/api/user/transactions', verifyToken, async (req, res) => {
  try {
    const [records] = await pool.query(
      'SELECT type, COALESCE(title, type) as description, amount, status, created_at as date FROM transactions WHERE user_id = ? ORDER BY created_at DESC', 
      [req.user.id]
    );
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching transactions.' });
  }
});


// ==========================================
// 12. WITHDRAWAL PROCESSING
// ==========================================
app.post('/api/user/withdraw', verifyToken, async (req, res) => {
  const { amount, channel, accountNumber, fundPassword } = req.body;
  const withdrawalAmount = parseFloat(amount);

  if (!withdrawalAmount || withdrawalAmount < 20) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal is GH₵ 20.00' });
  }

  try {
    const [userRows] = await pool.query('SELECT balance, fund_password FROM users WHERE user_id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].balance < withdrawalAmount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance.' });
    }

    const fee = withdrawalAmount * 0.10;
    const netAmount = withdrawalAmount - fee;

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [withdrawalAmount, req.user.id]);
    await connection.query(
      'INSERT INTO withdrawals (user_id, amount, fee, net_amount, method, account_info, status, created_at) VALUES (?, ?, ?, ?, ?, ?, "pending", NOW())',
      [req.user.id, withdrawalAmount, fee, netAmount, channel || 'Bank', accountNumber || '']
    );

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Withdrawal failed.' });
  }
});


// ==========================================
// 13. FRONTEND STATIC ROUTING FALLBACK
// ==========================================
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 14. SERVER STARTUP
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Skysonsolar unified backend server running on port ${PORT}`);
});