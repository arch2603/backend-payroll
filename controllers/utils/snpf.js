function calculcationSNPF(grossPay) {

    const employeeRate = 0.05;
    const employerRate = 0.05;

    return {
        employee: parseFloat(( grossPay * employeeRate).toFixed(2)),
        employer: parseFloat((grossPay * employerRate).toFixed(2)),
        total: parseFloat((grossPay * (employeeRate + employerRate)).toFixed(2))
    };
}

module.exports = { calculcationSNPF };