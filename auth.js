const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

// Register
// Register Route with Strict Invitation Code Requirement & Validation
router.post('/register', async (req, res) => {
  const { username, email, password, invitationCode, invitation_code } = req.body;
  const rawInviteCode = invitationCode || invitation_code;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required.' });
  }

  // 1. Strict check: Invitation code must be provided
  if (!rawInviteCode || rawInviteCode.trim() === '') {
    return res.status(400).json({ message: 'A valid invitation code is required to register.' });
  }

  const inviteCode = rawInviteCode.trim();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 2. Strict check: Verify invitation code exists and belongs to a user in the database
    const [inviterRows] = await connection.query(
      'SELECT id FROM users WHERE invitation_code = ?',
      [inviteCode]
    );

    if (inviterRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ message: 'Invalid invitation code. Code does not exist.' });
    }

    const level1AncestorId = inviterRows[0].id;

    // 3. Check for existing username or email
    const [existing] = await connection.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    
    if (existing.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ message: 'Username or email already registered.' });
    }

    // Hash password and generate new user's invitation code
    const hashedPassword = await bcrypt.hash(password, 10);
    const generatedInviteCode = `SKY${Math.floor(100000 + Math.random() * 900000)}`;

    const [result] = await connection.query(
      'INSERT INTO users (username, email, password, invitation_code) VALUES (?, ?, ?, ?)',
      [username, email, hashedPassword, generatedInviteCode]
    );

    const newUserId = result.insertId;

    // 4. Link Level 1 referral
    await connection.query(
      'INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 1)',
      [level1AncestorId, newUserId]
    );

    // 5. Link Level 2 referral (if inviter has an ancestor)
    const [level2Rows] = await connection.query(
      'SELECT ancestor_user_id FROM team_referrals WHERE descendant_user_id = ? AND level = 1',
      [level1AncestorId]
    );

    if (level2Rows.length > 0) {
      const level2AncestorId = level2Rows[0].ancestor_user_id;
      await connection.query(
        'INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 2)',
        [level2AncestorId, newUserId]
      );

      // 6. Link Level 3 referral (if level 2 has an ancestor)
      const [level3Rows] = await connection.query(
        'SELECT ancestor_user_id FROM team_referrals WHERE descendant_user_id = ? AND level = 1',
        [level2AncestorId]
      );

      if (level3Rows.length > 0) {
        const level3AncestorId = level3Rows[0].ancestor_user_id;
        await connection.query(
          'INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 3)',
          [level3AncestorId, newUserId]
        );
      }
    }

    await connection.commit();
    connection.release();

    const token = jwt.sign(
      { id: newUserId, username, email },
      process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User registered successfully!',
      token,
      user: { id: newUserId, username, email, invitation_code: generatedInviteCode }
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('CRITICAL REGISTER ERROR:', err);
    res.status(500).json({ message: 'Server error during registration.', error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const identifier = username || req.body.email;

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Username/Email and password are required.' });
    }

    const [users] = await pool.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [identifier, identifier]
    );

    if (users.length === 0) {
      return res.status(400).json({ message: 'Invalid username or password.' });
    }

    const user = users[0];

    // BLOCK DELETED OR SUSPENDED USERS
    if (user.status === 'deleted' || user.is_deleted === 1) {
      return res.status(403).json({ message: 'This account has been suspended or deleted by administration.' });
    }

    const validPassword = await bcrypt.compare(password, user.password || user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ message: 'Invalid username or password.' });
    }

    // Ensure user has an invitation code
    let inviteCode = user.invitation_code;
    if (!inviteCode) {
      inviteCode = `SKY${100000 + user.id}`;
      await pool.query('UPDATE users SET invitation_code = ? WHERE id = ?', [inviteCode, user.id]);
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance || 0,
        invitation_code: inviteCode
      }
    });
  } catch (err) {
    console.error('CRITICAL LOGIN ERROR:', err);
    res.status(500).json({ message: 'Server error during login.', error: err.message });
  }
});

module.exports = router;