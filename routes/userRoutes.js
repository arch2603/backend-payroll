// routes/userRoutes.js
const express = require('express');
const { listUsers, createUser, updateUser, deleteUser } = require('../controllers/userController');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', authenticateToken, authorizeRoles('admin'), listUsers);
router.post('/', authenticateToken, authorizeRoles('admin'), createUser);
router.put('/:id', authenticateToken, authorizeRoles('admin'), updateUser);
router.delete('/:id', authenticateToken, authorizeRoles('admin'), deleteUser);

module.exports = router;
