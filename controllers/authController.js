const bcrypt = require("bcrypt");
const pool = require("../db"); // database pool
const jwt = require("jsonwebtoken");
const crypto = require("crypto");           // <-- make sure this exists
const nodemailer = require("nodemailer");
const otpDigits = () => String(Math.floor(100000 + Math.random() * 900000));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify()
  .then(() => console.log("[mailer] SMTP ready"))
  .catch(err => console.error("[mailer] SMTP verify failed:", err));

// Register new user (Admin only)
const registerUser = async (req, res) => {

  const { username, password, role = 'employee', employee_id = null } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'username and password required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const queryCreate = `INSERT INTO users (username, password_hash, role, employee_id) 
                         VALUES ($1, $2, $3, $4) 
                         RETURNING user_id, username, role, employee_id, created_at`;
    const vals = [username, hashedPassword, role, employee_id || null];
    const result = await pool.query(queryCreate, vals);

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "username already exists" });
    }
    console.error("Register error:", err);
    return res.status(500).json({ message: "Error registering user" });
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'username & password required' });

  try {
    const q = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (q.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

    const user = q.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ message: 'Invalid credentials' });

    const payload = {
      user_id: user.user_id,
      username: user.username,
      role: user.role,
      employee_id: user.employee_id
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });

    res.json({ token, role: payload.role, user: payload });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ message: 'Login error' });
  }
};

const changePassword = async (req, res) => {
  try {
    // Your JWT payload (from login) uses user_id, not id
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Missing fields" });
    }

    // fetch current hash
    const { rows } = await pool.query(
      `SELECT password_hash FROM users WHERE user_id = $1`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ message: "User not found" });

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ message: "Current password incorrect" });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1 WHERE user_id = $2`,
      [hash, userId]
    );

    console.log("[change-password] OK for user", userId);
    return res.json({ message: "Password updated" });  // ✅ send a response
  } catch (err) {
    console.error("changePassword error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: "token and password required" });
    }

    // Find user with valid non-expired token
    const { rows } = await pool.query(
      `SELECT user_id FROM users WHERE reset_token = $1 AND reset_expires > NOW()`,
      [token]
    );
    if (!rows[0]) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const userId = rows[0].user_id;
    const hash = await bcrypt.hash(password, 10);

    // Update password and clear token
    await pool.query(
      `UPDATE users
         SET password_hash = $1,
             reset_token = NULL,
             reset_expires = NULL
       WHERE user_id = $2`,
      [hash, userId]
    );

    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error("resetPassword error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const requestPasswordReset = async (req, res) => {
  try {
    let { email = "", username = "" } = req.body || {};
    email = String(email || "").trim();
    username = String(username || "").trim();
    if (!email && !username) {
      return res.status(400).json({ message: "email or username required" });
    }

    const { rows } = await pool.query(
      email
        ? `SELECT user_id, email FROM users WHERE email = $1`
        : `SELECT user_id, email FROM users WHERE username = $1`,
      [email || username]
    );

    // Always respond generically to avoid user enumeration
    if (rows.length === 0) {
      return res.json({ message: "If an account exists, a reset link has been sent." });
    }

    const { user_id: userId, email: userEmail } = rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      `UPDATE users SET reset_token = $1, reset_expires = $2 WHERE user_id = $3`,
      [token, expires, userId]
    );

    const resetUrl = `${process.env.FRONTEND_URL || "http://192.168.1.120:3001"}/reset-password?token=${encodeURIComponent(token)}`;

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || "no-reply@localhost",
      to: userEmail || email,
      subject: "Reset your password",
      text: `Click this link to reset your password: ${resetUrl} (valid for 1 hour)`,
      html: `<p>Click this link to reset your password:</p>
             <p><a href="${resetUrl}">${resetUrl}</a></p>
             <p>This link is valid for 1 hour.</p>`
    });

    return res.json({ message: "If an account exists, a reset link has been sent." });
  } catch (err) {
    console.error("requestPasswordReset error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const oneTimePasswordReset = async (req, res) => {

  try {
    let { email = "", username = "" } = req.body || {};
    email = typeof email === "string" ? email.trim() : "";
    username = typeof username === "string" ? username.trim() : "";

    if (!email && !username) {
      return res.status(400).json({ message: "email or username required" });
    }

    const selectSql = email ?
      "SELECT user_id FROM users WHERE email = $1" :
      "SELECT user_id FROM users WHERE username = $1";

    const selectVal = [email || username];

    const { rows } = await pool.query(selectSql, selectVal);

    if (rows.length === 0) {
      return res.json({ message: "If an account exists, a reset link has been sent. " })
    }

    const { user_id: userId, email: userEmail } = rows[0];
    const code = otpDigits();
    const hash = await bcrypt.hash(code, 10);
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      `UPDATE users 
       SET reset_otp_hash = $1, reset_otp_expires = $2, reset_otp_attempts = 0 
      WHERE user_id = $3`, [hash, expires, userId]
    );

    const recipient = userEmail || email;

    if (recipient) {
      try {
        const info = await transporter.sendMail({
          from: process.env.FROM_EMAIL || "no-reply@localhost",
          to: userEmail || email,
          subject: "Your password reset code",
          text: `Your code is ${code}.  It expires in 15 minutes`,
          html: `<p> Your code is <b>${code}</b> It expires in 15 minutes</p>`,
        });

        console.log("[mailer] messageId:", info.messageId);

      } catch (mailErr) {
        console.error("[mailer] sendMail failed:", mailErr?.message || mailErr);
      }
    } else{
      console.warn("[OTP] No email available for userId:", userId);
    }
    return res.json({
      message: "If an account exists, an OTP has been sent.",
      dev_otp: process.env.NODE_ENV === "production" ? undefined : code
    });

  } catch (err) {
    console.error("oneTimePasswordReset error:", err);
    return res.status(500).json({ message: "Server error" });
  }

};

const resetOtpPassword = async (req, res) => {

  try {
    const { emailOrUsername = "", otp = "", password = "" } = req.body || {};
    const idv = String(emailOrUsername).trim();
    if (!idv || !otp || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const { rows } = await pool.query(
      `SELECT user_id, reset_otp_hash, reset_otp_expires, reset_otp_attempts, email, username
         FROM users
        WHERE email = $1 OR username = $1`,
      [idv]
    );
    if (rows.length === 0) {
      // generic to avoid enumeration
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    const u = rows[0];

    // expired?
    if (!u.reset_otp_expires || new Date(u.reset_otp_expires) < new Date()) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    // attempts?
    if ((u.reset_otp_attempts || 0) >= 5) {
      // clear OTP to force restart
      await pool.query(
        `UPDATE users SET reset_otp_hash = NULL, reset_otp_expires = NULL WHERE user_id = $1`,
        [u.user_id]
      );
      return res.status(429).json({ message: "Too many attempts. Request a new code." });
    }
    // compare
    const ok = await bcrypt.compare(String(otp), u.reset_otp_hash || "");
    if (!ok) {
      await pool.query(
        `UPDATE users SET reset_otp_attempts = COALESCE(reset_otp_attempts,0) + 1 WHERE user_id = $1`,
        [u.user_id]
      );
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    // set new password, clear OTP
    const hash = await bcrypt.hash(String(password), 10);
    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              reset_otp_hash = NULL,
              reset_otp_expires = NULL,
              reset_otp_attempts = 0
        WHERE user_id = $2`,
      [hash, u.user_id]
    );

    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error("resetWithOtp error:", err);
    return res.status(500).json({ message: "Server error" });
  }

};

module.exports = { registerUser, login, changePassword, requestPasswordReset, resetPassword, oneTimePasswordReset, resetOtpPassword };
