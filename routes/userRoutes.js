// routes/userRoutes.js
const express = require('express');
const { listUsers, createUser, updateUser, deleteUser } = require('../controllers/userController');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', authenticateToken, authorizeRoles('admin'), listUsers);
router.post('/', authenticateToken, authorizeRoles('admin'), createUser);
router.patch('/:userId', authenticateToken, authorizeRoles('admin'), updateUser);
router.delete('/:userId', authenticateToken, authorizeRoles('admin'), deleteUser);

module.exports = router;
