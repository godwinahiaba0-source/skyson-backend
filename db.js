const initDb = async () => {
  try {
    const connection = await pool.getConnection();
    console.log("Connected to MySQL Database.");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        referral_code VARCHAR(50) UNIQUE,
        phone VARCHAR(20),
        balance DECIMAL(10,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS team_referrals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ancestor_user_id INT,
        descendant_user_id INT,
        level INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    connection.release();
    console.log("Database tables initialized successfully!");
  } catch (err) {
    console.error("Database initialization failed details:", err.message);
  }
};

initDb();