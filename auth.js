const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

// Register
router.post('/register', async (req, res) => {
  const { username, email, password, invitationCode, invitation_code } = req.body;
  const inviteCode = invitationCode || invitation_code;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ message: 'Username or email already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const generatedInviteCode = `SKY${Math.floor(100000 + Math.random() * 900000)}`;

    const [result] = await connection.query(
      'INSERT INTO users (username, email, password, invitation_code) VALUES (?, ?, ?, ?)',
      [username, email, hashedPassword, generatedInviteCode]
    );

    const newUserId = result.insertId;
    console.log(`New user registered: ID ${newUserId}, Username: ${username}, Used Invite Code: ${inviteCode || 'None'}`);

    // If an invitation code was used during signup, process multi-level team referrals (Levels 1, 2, and 3)
    if (inviteCode && inviteCode.trim() !== '') {
      const [directAncestorRows] = await connection.query(
        'SELECT user_id FROM users WHERE invitation_code = ?',
        [inviteCode.trim()]
      );

      if (directAncestorRows.length > 0) {
        const level1AncestorId = directAncestorRows[0].user_id;

        // 1. Insert Level 1 relationship
        await connection.query(
          'INSERT INTO team_referrals (ancestor_user_id, descendant_user_id, level) VALUES (?, ?, 1)',
          [level1AncestorId, newUserId]
        );
        console.log(`Linked Level 1: Descendant ${newUserId} -> Ancestor ${level1AncestorId}`);

        // 2. Check for Level 2 ancestor (who invited level1AncestorId)
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
          console.log(`Linked Level 2: Descendant ${newUserId} -> Ancestor ${level2AncestorId}`);

          // 3. Check for Level 3 ancestor (who invited level2AncestorId)
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
            console.log(`Linked Level 3: Descendant ${newUserId} -> Ancestor ${level3AncestorId}`);
          }
        }
      } else {
        console.warn(`Warning: Invitation code ${inviteCode} was not found in users table.`);
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
    const validPassword = await bcrypt.compare(password, user.password || user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ message: 'Invalid username or password.' });
    }

    // Ensure user has an invitation code
    let inviteCode = user.invitation_code;
    if (!inviteCode) {
      inviteCode = `SKY${100000 + user.user_id}`;
      await pool.query('UPDATE users SET invitation_code = ? WHERE user_id = ?', [inviteCode, user.user_id]);
    }

    const token = jwt.sign(
      { id: user.user_id, username: user.username, email: user.email },
      process.env.JWT_SECRET || 'skyson_secure_super_secret_key_2026',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.user_id,
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