const employeeService = require('../service/employeeService');

exports.createEmployee = async (req, res, next) => {
    try {
        const payload = req.body || {};
        if (!payload.first_name || !payload.last_name || !payload.email || !payload.employee_number) {
            return res.status(400).json({ message: 'Missing required employee fields' });
        }

        const employee = await employeeService.createEmployee(payload);
        return res.status(201).json(employee);
    } catch (err) {
        console.error('[employee] createEmployee error:', err);
        if (err.status) return res.status(err.status).json({ message: err.message });
        if (err.code === '23505') return res.status(409).json({ message: 'Employee number or bank account already exists' });
        if (err.code?.startsWith('23')) return res.status(400).json({ message: 'Employee data violates a database rule' });
        next(err);
    }
};

exports.updateEmployee = async (req, res, next) => {
    try {
        const empId = Number(req.params.empId);
        const payload = req.body || {};
        if (!Number.isFinite(empId) || empId <= 0) {
            return res.status(400).json({ message: 'Invalid employee id' });
        }

        const updated = await employeeService.updateEmployee(empId, payload);
        return res.status(200).json(updated);

    } catch (err) {
        console.error('[employee] updateEmployee error', err);
        if (err.status) return res.status(err.status).json({ message: err.message });
        if (err.code === '23505') return res.status(409).json({ message: 'Employee number or bank account already exists' });
        if (err.code?.startsWith('23')) return res.status(400).json({ message: 'Employee data violates a database rule' });
        next(err);
    }
};

exports.getEmployeeById = async (req, res, next) => {
    try {

        const empId = Number(req.params.empId);
        if (!Number.isFinite(empId) || empId <= 0) {
            return res.status(404).json({ message: 'Invalid employee id' });
        }
        const employee = await employeeService.getServiceEmployeeById(empId);
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        return res.status(200).json(employee);
    } catch (err) {
        console.error('[employee] getEmployeeById', err);
        next(err);
    }
}
