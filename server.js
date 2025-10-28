
require("dotenv").config();
const express = require("express");
const cors = require("cors");

//const { prototype } = require("pg/lib/type-overrides");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const employeeRoutes = require("./routes/employeeRoutes");
const historyRoutes = require("./routes/historyRoutes");

const payRunRoutes = require("./routes/payRunRoutes");

const app = express();
const PORT = process.env.PORT || 5000;
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://192.168.1.120:3001",
  "http://192.168.1.100:5173",
  "http://192.168.1.101:5173", // add your actual Vite origin(s)
];

const corsOptions = {
  origin(origin, cb) {
    // allow same-origin tools (curl/postman) and allowed web origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  // exposedHeaders: [], // optional
};


app.use(cors(corsOptions))
// app.options("*", cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// mount routes
app.use('/auth', authRoutes); // /auth/login, /auth/register (admin)
app.use('/api/users', userRoutes); // /api/users GET/POST (admin only)
app.use('/api/dashboard', dashboardRoutes);       // counts, audit
app.use('/api/employees', employeeRoutes);
app.use('/api', historyRoutes);
app.use('/api/pay-runs', payRunRoutes);



app.use((err, req, res, next) => {
  console.error('UNCAUGHT:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: 'Server error', detail: err?.message });
});


app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));